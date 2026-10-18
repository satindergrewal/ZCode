// The CLI-side reduction of the sessions-index topic: derives each session's
// ConversationSnapshot under one workspace into a SessionSummary, maintaining the conflated latest state + upsert/remove deltas.
// Pure reduction, no I/O; the publisher (sessions-index-publisher) owns seq accounting and frame building,
// while event subscription and flush scheduling belong to the gateway (v4-gateway).
import {
  deriveSessionWorkflowActivity,
  type ConversationSnapshot,
  type SessionSummary,
  type SessionsIndexDelta,
  type SessionsIndexSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/** The session-level metadata (store record / event instants) needed to derive one summary, beyond the snapshot. */
export interface SessionSummaryDeriveExtra {
  workspaceId: string;
  createdAt: number;
  lastActivityAt: number;
  parentSessionId?: string;
}

const MAX_PREVIEW_CHARS = 120;

/** Derives SessionSummary from ConversationSnapshot + session meta (pure; golden-testable). */
function deriveSessionSummary(
  snapshot: ConversationSnapshot,
  extra: SessionSummaryDeriveExtra,
): SessionSummary {
    // The last assistantText row's text as the preview (<=120 chars).
  let lastAssistantPreview: string | undefined;
  const rows = snapshot.rows.window;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (
      !lastAssistantPreview &&
      row &&
      row.kind === "assistantText" &&
      row.text.trim().length > 0
    ) {
      lastAssistantPreview = row.text.slice(0, MAX_PREVIEW_CHARS);
    }
    if (lastAssistantPreview) break;
  }
  const hasBackgroundWork = snapshot.backgroundWorks.some((work) => work.status === "running");
    // Data for the sidebar's workflow-run rows:
    // derived from the same snapshot's workflowRuns + backgroundWorks, so the sidebar never subscribes to run progress.
  const workflowActivity = deriveSessionWorkflowActivity({
    workflowRuns: snapshot.workflowRuns,
    backgroundWorks: snapshot.backgroundWorks,
  });
    // workspaceHookReview renders in Hooks Settings, never degraded into a permission/userInput sidebar badge.
  const pending = snapshot.pendingInteractions.find(
    (interaction) => interaction.kind === "permission" || interaction.kind === "userInput",
  );
  const permissionCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "permission",
  ).length;
  const userInputCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "userInput",
  ).length;
    // Tolerate trimmed snapshots from migrated stores or reduction tests: a new lightweight toolName projection
    // must not block the whole task list when a legacy pending interaction lacks its payload.
  const pendingPayload = pending?.payload;
  const pendingToolName =
    pendingPayload && "toolName" in pendingPayload ? pendingPayload.toolName : undefined;
  const pendingInteraction =
    pending &&
    pendingPayload &&
    (pendingPayload.kind === "permission" || pendingPayload.kind === "userInput")
      ? {
          interactionId: pending.interactionId,
          kind: pendingPayload.kind,
          ...(pendingToolName ? { toolName: pendingToolName } : {}),
          ...(pending.autoResolution ? { autoResolution: pending.autoResolution } : {}),
        }
      : undefined;
  return {
    sessionId: snapshot.sessionId,
    workspaceId: extra.workspaceId,
    ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}),
    title: snapshot.meta.title,
    titleSource: snapshot.meta.titleSource,
    phase: snapshot.control.phase,
        // Pass control.sessionEnded through faithfully (semantics: true once a turn closes successfully; not deleted).
    sessionEnded: snapshot.control.sessionEnded,
    hasBackgroundWork,
    ...(workflowActivity === undefined ? {} : { workflowActivity }),
    ...(pendingInteraction ? { pendingInteraction } : {}),
    ...(permissionCount > 0 || userInputCount > 0
      ? {
          pendingInteractionSummary: {
            permissionCount,
            userInputCount,
          },
        }
      : {}),
    ...(snapshot.goal ? { goalStatus: snapshot.goal.status } : {}),
    lastActivityAt: extra.lastActivityAt,
    ...(lastAssistantPreview ? { lastAssistantPreview } : {}),
    createdAt: extra.createdAt,
  };
}

/** Whether two summaries are equivalent (conflation: equal means no delta). */
function summariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.workspaceId === b.workspaceId &&
    a.parentSessionId === b.parentSessionId &&
    a.title === b.title &&
    a.titleSource === b.titleSource &&
    a.phase === b.phase &&
    a.sessionEnded === b.sessionEnded &&
    a.hasBackgroundWork === b.hasBackgroundWork &&
        // Phase flips / settlement / running-subagent-count changes are never eaten by conflation; conversely, node-only events compare equal here
        // (in real systems they still frame via lastActivityAt -- an activity fact, semantics unchanged).
    JSON.stringify(a.workflowActivity ?? null) === JSON.stringify(b.workflowActivity ?? null) &&
    JSON.stringify(a.pendingInteraction ?? null) === JSON.stringify(b.pendingInteraction ?? null) &&
    a.pendingInteractionSummary?.permissionCount === b.pendingInteractionSummary?.permissionCount &&
    a.pendingInteractionSummary?.userInputCount === b.pendingInteractionSummary?.userInputCount &&
    a.goalStatus === b.goalStatus &&
    a.lastActivityAt === b.lastActivityAt &&
    a.lastAssistantPreview === b.lastAssistantPreview &&
    a.createdAt === b.createdAt
  );
}

/**
  * One workspace's sessions-index reduction state: Map<sessionId, SessionSummary> +
  * upsert/remove delta generation (conflation key = sessionId).
 */
export class SessionsIndexProjection {
  private readonly summaries = new Map<string, SessionSummary>();

  constructor(
    readonly workspaceId: string,
    readonly logEpoch: string,
  ) {}

    /** Updates a session's summary from its latest snapshot; a change yields an upsert delta, else empty. */
  upsertFromConversation(
    snapshot: ConversationSnapshot,
    extra: Omit<SessionSummaryDeriveExtra, "workspaceId">,
  ): SessionsIndexDelta[] {
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: this.workspaceId,
      ...extra,
    });
    const prev = this.summaries.get(summary.sessionId);
        // Degradation defense (stored->live switchover): before hydration completes the cold live projection's
        // meta, title is empty and record times may be reset by resume -- the store seed's
        // stable fields must not be overwritten by degraded values (else the sidebar shows "old session gone, new task appeared").
    if (prev) {
            // Readers must distinguish a stored/protocol physical title from a user rename.
            // Before hydration the cold live projection may hold only default/generated titles; if the legacy seed was
            // custom, auto titles must not downgrade it, or the sidebar flashes the user's title back to generated.
      if (prev.titleSource === "custom" && summary.titleSource !== "custom") {
        summary.title = prev.title;
        summary.titleSource = prev.titleSource;
      } else if (!summary.title && prev.title) {
        summary.title = prev.title;
                // The legacy store seed's titleSource may be absent; the cold projection's
                // default is transient. Preserving the title preserves "field absent", or
                // summariesEqual emits an upsert with no product change.
        if (prev.titleSource === undefined) {
          delete summary.titleSource;
        } else {
          summary.titleSource = prev.titleSource;
        }
      }
      if (prev.createdAt > 0 && summary.createdAt > prev.createdAt) {
        summary.createdAt = prev.createdAt;
      }
      if (!summary.lastAssistantPreview && prev.lastAssistantPreview) {
        summary.lastAssistantPreview = prev.lastAssistantPreview;
      }
            // Before hydration completes, the cold live projection's phase is the initial draft.
            // A session with real content never returns to draft; covering a non-draft baseline with it
            // broadcasts a pure-degrade completedSuccess->draft delta on opening a historical task,
            // clearing the row state and re-querying the workspace list ("clicking reloads the list").
            // phase/sessionEnded/goalStatus share the window and source; keep the baseline for all.
      if (summary.phase === "draft" && prev.phase !== "draft") {
        summary.phase = prev.phase;
        summary.sessionEnded = prev.sessionEnded;
        if (summary.goalStatus === undefined && prev.goalStatus !== undefined) {
          summary.goalStatus = prev.goalStatus;
        }
      }
    }
    if (prev && summariesEqual(prev, summary)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

    /** Inserts one summary directly (cold-start / no-live-projection store sessions). */
  seed(summary: SessionSummary): void {
    this.summaries.set(summary.sessionId, summary);
  }

  /**
      * The post-migration store re-read only backfills missing summaries; live/seed states must not be overwritten by cold-store defaults.
      * Returns the delta for the publisher's seq advance and notifies live list subscribers.
   */
  insertSeedIfMissing(summary: SessionSummary): SessionsIndexDelta[] {
    if (this.summaries.has(summary.sessionId)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

    /** Removes a session; a hit returns the remove delta. */
  remove(sessionId: string): SessionsIndexDelta[] {
    if (!this.summaries.has(sessionId)) return [];
    this.summaries.delete(sessionId);
    return [{ op: "session.removed", sessionId }];
  }

  has(sessionId: string): boolean {
    return this.summaries.has(sessionId);
  }

    /** The full current snapshot (unordered; sorting is the client's job). */
  getSnapshot(): SessionsIndexSnapshot {
    return {
      protocolVersion: 1,
      workspaceId: this.workspaceId,
      logEpoch: this.logEpoch,
      sessions: [...this.summaries.values()],
    };
  }
}
