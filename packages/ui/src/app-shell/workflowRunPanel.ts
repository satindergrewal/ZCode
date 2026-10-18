/**
 * Pure logic for the workflow run detail page: Cancel availability, result/failure panel
 * decisions, event log line summaries.
 *
 * Extracted as pure functions because these are the only "rules" in the detail page, and all of
 * them are exhaustively unit-testable without rendering a React Flow canvas. Components only paste
 * the results computed here onto the DOM.
 */
import {
  readWorkflowRunStopReason,
  type WorkflowRunStopReason,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunActor, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunConcurrencyEventLine } from "@/app-shell/workflowRunThrottle.js";

/** Cap on raw fallback text for unknown event kinds: the event log never dumps a whole journal into the DOM. */
const UNKNOWN_PAYLOAD_MAX_LENGTH = 200;

/**
 * Cancel is only available on `running`.
 *
 * Cancellation reuses the existing v4 `cancelBackgroundWork {workId: runId}` (three entries, one
 * implementation, no second cancel RPC), which is a noop for already-settled tasks anyway, so
 * disabling the button in terminal states exists to avoid a control that does nothing when clicked,
 * not as a fallback. A run missing from the projection (evicted by the 8-run cap or not yet
 * projected during cold start) is equally non-cancellable: we know nothing about its in-flight state.
 */
export function isWorkflowRunCancellable(run: WorkflowRunState | undefined): boolean {
  return run?.status === "running";
}

/**
 * Resume availability. Single source of truth: the projected run's `resumable` flag, computed by
 * the CLI on the `run-settled` payload with the same predicate as the resume gate (one minting path
 * for live and cold replay); the UI never re-derives it from status + failureCode (two predicates
 * drift: button lit but command rejected).
 *
 * A run missing from the projection (evicted by the 8-run cap) is never resumable: prefer one
 * button fewer over a control that is guaranteed to be rejected.
 */
export function isWorkflowRunResumable(run: WorkflowRunState | undefined): boolean {
  return run?.resumable === true;
}

type WorkflowRunResultView =
  /** Run absent from the projection: no result to speak of. */
  | { kind: "absent" }
  /** pending / running: no result panel yet. */
  | { kind: "none" }
  /**
   * Completed. `preview` is always absent at this stage, script artifacts live only in
   * `RunSettlement.artifact`, neither on the `run-settled` event (status + error only) nor in the
   * journal. So the completed state can only point at the session's background result ring, never
   * fabricate a result view. The schema keeps the field; render it faithfully when populated.
   */
  | { kind: "completed"; preview?: string }
  /**
   * errored / stopped. `message` is the preformatted text from the projection (a plain string in
   * the schema); `stopReason` is present only when stopped and the projection carries the key.
   */
  | {
      kind: "error";
      status: "errored" | "stopped";
      stopReason?: WorkflowRunStopReason;
      message?: string;
    };

export function workflowRunResultView(run: WorkflowRunState | undefined): WorkflowRunResultView {
  if (!run) return { kind: "absent" };
  if (run.status === "errored" || run.status === "stopped") {
    const stopReason = readWorkflowRunStopReason(run);
    return {
      kind: "error",
      status: run.status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(run.error ? { message: run.error } : {}),
    };
  }
  if (run.status === "completed") {
    return { kind: "completed", ...(run.resultPreview ? { preview: run.resultPreview } : {}) };
  }
  return { kind: "none" };
}

/** One event log input (= an item from the v4 query result). */
export interface WorkflowRunEventItem {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
}

export interface WorkflowRunEventLine {
  sequence: number;
  type: string;
  /** Localized primary label. */
  label: string;
  /** Identity and data (site instance, actor name, log body, raw error); never localized. */
  detail?: string;
  /** Failed/cancelled tint; everything else stays default (no new visual words beyond the overlay's four-value vocabulary). */
  tone: "default" | "failed";
  truncated?: boolean;
}

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{siteId, ordinal}` → `site@ordinal` (same shape as the engine's refToString, for log cross-referencing). */
function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/** Non-empty string, else undefined (joinDetail drops it entirely rather than keeping an empty separator). */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === "string" && value.message.length > 0 ? value.message : undefined;
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Short digest of a report entry in the event log (not the full preview in the Results section).
 *
 * Deliberately flattened to one line here: event log rows are monospace one-liners and multi-line
 * JSON would blow the log into a second artifact view. The full form (raw string / pretty JSON for
 * objects) is computed CLI-side into `workflowRuns.reports[].preview`; the Results section renders that.
 */
function reportItemSummary(item: unknown): string | undefined {
  if (item === undefined) return undefined;
  if (typeof item === "string") {
    return item.length > 0 ? truncate(item, UNKNOWN_PAYLOAD_MAX_LENGTH) : undefined;
  }
  try {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? undefined : truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
  } catch {
    // The payload is normalized to JSON-serializable shape CLI-side; if it still fails, do not take down the whole log page.
    return undefined;
  }
}

/** Unknown-kind fallback: type + truncated JSON. Neither crashes nor pretends to know it. */
function unknownDetail(payload: Record<string, unknown>): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // The payload is normalized to JSON-serializable shape CLI-side; if it still fails, one log line must not take down the panel.
    return undefined;
  }
  if (serialized === undefined || serialized === "{}") return undefined;
  return truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
}

const EVENT_KEY_PREFIX = "chat.toolCall.workflow.run.event.";

/**
 * Engine event → readable line.
 *
 * The vocabulary mirrors what the engine actually emits: run-started / actor-created / node-queued /
 * node-dispatched / node-repairing / node-nudged / node-settled / usage-updated / log /
 * import-cache-closed / report / escalation-raised / escalation-resolved / run-settled, plus the
 * adaptive-concurrency node-waiting / node-executing / concurrency-changed (the default branch hands
 * off to the sibling module). Those last two are emitted by the driver at the ask boundary (the
 * engine core is unaware of escalations) but travel the exact same two tracks, so they are treated
 * like the rest here. `payload` is the event object minus `type` (the run service mapping contract),
 * so this reads the engine's field names directly, without reshaping.
 *
 * Every branch reads the shape defensively: payloads are bounded, deep fields may be trimmed, and
 * one unreadable event must never take down the whole event log.
 */
export function workflowRunEventLines(
  events: readonly WorkflowRunEventItem[],
  formatMessage: FormatMessage,
): WorkflowRunEventLine[] {
  return events.map((event) => {
    const { payload } = event;
    const base = {
      sequence: event.sequence,
      type: event.type,
      ...(event.truncated ? { truncated: event.truncated as true } : {}),
    };
    const key = (suffix: string) => ({ id: `${EVENT_KEY_PREFIX}${suffix}` });

    switch (event.type) {
      case "run-started":
        // caps stay off this line: concurrency is not actionable.
        return { ...base, label: formatMessage(key("runStarted")), tone: "default" };

      case "actor-created": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        return {
          ...base,
          label: formatMessage(key("actorCreated")),
          ...(joinDetail(name, refText(payload.actor)) === undefined
            ? {}
            : { detail: joinDetail(name, refText(payload.actor))! }),
          tone: "default",
        };
      }

      case "node-queued": {
        const kind = typeof payload.kind === "string" ? payload.kind : undefined;
        const detail = joinDetail(refText(payload.instance), kind);
        return {
          ...base,
          label: formatMessage(key("nodeQueued")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-dispatched":
      case "node-nudged": {
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key(event.type === "node-nudged" ? "nodeNudged" : "nodeDispatched")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-repairing": {
        const attempt = typeof payload.attempt === "number" ? String(payload.attempt) : "?";
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key("nodeRepairing"), { attempt }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-settled": {
        const outcome =
          payload.outcome === "ok" ||
          payload.outcome === "failed" ||
          payload.outcome === "cancelled"
            ? payload.outcome
            : undefined;
        const outcomeLabel = outcome
          ? formatMessage({ id: `chat.toolCall.workflow.run.outcome.${outcome}` })
          : "";
        const detail = joinDetail(refText(payload.instance), errorMessage(payload.error));
        return {
          ...base,
          label: formatMessage(key(payload.cached === true ? "nodeSettledCached" : "nodeSettled"), {
            outcome: outcomeLabel,
          }),
          ...(detail === undefined ? {} : { detail }),
          // failed vs cancelled differ in the journal, but this row only needs "this step did not land".
          tone: outcome === "failed" || outcome === "cancelled" ? "failed" : "default",
        };
      }

      case "usage-updated": {
        // The event carries the spent total directly; the authoritative value lives in the status header's usage row.
        const spentTokens =
          typeof payload.spentTokens === "number" ? payload.spentTokens : undefined;
        return {
          ...base,
          label: formatMessage(key("usageUpdated")),
          ...(spentTokens === undefined
            ? {}
            : { detail: `${spentTokens.toLocaleString()} tokens` }),
          tone: "default",
        };
      }

      case "log": {
        const message = typeof payload.message === "string" ? payload.message : undefined;
        return {
          ...base,
          label: formatMessage(key("log")),
          ...(message === undefined ? {} : { detail: message }),
          tone: "default",
        };
      }

      /** Control flow crossed a `phase("…")` marker: name + entry ordinal (replay exports reuse this formatter). */
      case "import-cache-closed": {
        // amend-resume import cache closing: whoever made the first write closed it.
        // detail = subagent name (when present) + instance; a world.run-closed gate has no name, only the instance.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(actorName, refText(payload.instance));
        return {
          ...base,
          label: formatMessage(key("importCacheClosed")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "phase-entered": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 1;
        return {
          ...base,
          label: formatMessage(key("phaseEntered")),
          ...(name === undefined ? {} : { detail: ordinal >= 2 ? `${name} · ${ordinal}` : name }),
          tone: "default",
        };
      }

      /**
       * report and log are both fire-and-forget, but report carries site identity (`report#N@k` enters
       * the journal), so the row shows the instance. The entry body has its own stage (the full preview in
       * Results); this is only a short digest, the event log's job is "what the engine emitted, when",
       * not a second artifact view.
       */
      case "report": {
        const detail = joinDetail(refText(payload.instance), reportItemSummary(payload.item));
        return {
          ...base,
          label: formatMessage(key("report")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      /**
       * Escalation Q&A: an actor hits a real blocker, escalates the question to the main agent and
       * waits inside its own ask; once the main agent answers by qid, it resumes in place.
       *
       * Both rows lead with the qid even though the raised row's subject is "who asked what": the qid is
       * the only correlation key between the two events, and in the log they are usually dozens of lines
       * apart (waiting is the entire feature). Without it, an "answered" row cannot say which question above it answers.
       *
       * Body truncated per the detail-column convention (same cap as the report digest): the event log is
       * one line per row; the full question body lives in the pending-questions section above.
       */
      case "escalation-raised": {
        const question = typeof payload.question === "string" ? payload.question : undefined;
        // With the actor name absent (anonymous actor), fall back to the site instance: the row must say who, even as `actor#1@1`.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          actorName ?? refText(payload.actor),
          question === undefined ? undefined : truncate(question, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationRaised")),
          ...(detail === undefined ? {} : { detail }),
          // Escalation is not failure: the actor did not error, it is waiting for an answer. Keep tint for rows that truly failed.
          tone: "default",
        };
      }

      case "escalation-resolved": {
        const answer = typeof payload.answer === "string" ? payload.answer : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          answer === undefined ? undefined : truncate(answer, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationResolved")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "run-settled": {
        const status =
          typeof payload.status === "string" && payload.status.length > 0
            ? payload.status
            : undefined;
        const statusLabel = status
          ? formatMessage({ id: `chat.toolCall.workflow.run.status.${status}` })
          : "";
        const detail = errorMessage(payload.error);
        return {
          ...base,
          label: formatMessage(key("runSettled"), { status: statusLabel }),
          ...(detail === undefined ? {} : { detail }),
          tone: status === "errored" || status === "stopped" ? "failed" : "default",
        };
      }

      default: {
        // The four concurrency events (node-waiting / node-executing / concurrency-changed / run-caps-changed)
        // live in sibling workflowRunThrottle.ts (max-lines gate).
        const concurrencyLine = workflowRunConcurrencyEventLine(event, formatMessage);
        if (concurrencyLine !== undefined) return concurrencyLine;
        // e.g. the engine-reserved `compaction` for long-context compression (never emitted in v1). When it
        // appears, this must still produce an informative line, not blank.
        const detail = unknownDetail(payload);
        return {
          ...base,
          label: formatMessage(key("unknown"), { type: event.type }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }
    }
  });
}

// ── Transcript entry: step card → actor instance ──

/**
 * An openable actor instance.
 *
 * `siteId` + `ordinal` are the identity (journal keys); `name` is display only. `sessionId` is the
 * id of the real persisted session and the only thing the nested read-only SessionPane needs.
 *
 * `sessionId` is optional (schema-optional): progress events may arrive before the actor session is
 * persisted, old runs may have none at all, and not-yet-started slots never do. Absent instances still
 * open a tab, tab identity is (runId, siteId, ordinal) and the session id is just the subscription
 * target; when absent the tab shows a "not started" placeholder.
 */
export interface WorkflowActorInstance {
  siteId: string;
  ordinal: number;
  name?: string;
  sessionId?: string;
  status: WorkflowRunActor["status"];
}

// ── actor not-started gate ──

/**
 * The three situations an actor transcript tab can be in relative to "does the session exist yet".
 *
 * `unknown` is not an error branch but the most common long-lived state: tabs are deliberately not
 * GC'd and outlive the 8-run projection eviction.
 */
type WorkflowActorStartState = "notStarted" | "started" | "unknown";

/** Identity the actor transcript tab hands the gate: slot + session id known at open time (optional). */
export interface WorkflowActorSlotRef {
  runId: string;
  siteId: string;
  ordinal: number;
  actorSessionId?: string;
}

/** The gate's verdict: situation + session id to subscribe (absent = nothing to subscribe, panel can only placeholder). */
interface WorkflowActorGate {
  state: WorkflowActorStartState;
  sessionId?: string;
}

/**
 * Slot → whether the actor has started, and which session to subscribe.
 *
 * Actor sessions are created lazily: the engine only runs `createActorSession` when the first ask is
 * dispatched, so subscribing earlier always ends in `fault.subscribe.sessionNotFound`, and once the
 * projection store fails it sits in `error` awaiting a manual retry, a dead panel. This selector is that gate.
 *
 * The decision is race-free: `createActorSession` awaits session persistence before the first dispatch
 * (the ordering is pinned by workflow-driver.ts tests), so dispatched-in-projection ⇒ the session row
 * exists ⇒ the subscription hits. Conversely `queued` does not count as started: the persistence
 * guarantee is pinned pre-dispatch and queued nodes are no evidence a session exists.
 *
 * Lookup is by (runId, siteId, ordinal): a tab may open before the actor exists (the not-started
 * pill), when there is no session id to reverse-lookup. Within the three values, the `unknown` vs
 * `notStarted` boundary is the one that matters:
 *
 * - actor absent from the projection, tab HAS a session id → `unknown`, never block. After the run is
 *   evicted by the 8-run cap or a cold restore leaves the projection empty, direct subscription is the
 *   only path to the transcript; blocking it seals off the settled run's only persistent view.
 * - actor absent, tab has NO session id → `notStarted`: nothing to subscribe, the placeholder is the
 *   honest state (the script has not reached `agent()`; if the run was evicted, this slot indeed never started).
 * - actor present with no non-`queued` node → `notStarted`; otherwise `started`, subscribing to the
 *   projection's session id with the tab-open value as fallback. The gate reads the live projection, so
 *   the first dispatched node heals it.
 *
 * A cache hit is another path through the gate: it emits `node-settled` directly, without
 * `ensureSession`, so no session is created that time. The gate still opens, because the projection's
 * actor `sessionId` is the transcript-holding session (shared workflow-runs-actor-session.ts): a plain
 * resume hit points back at the session this run created earlier, a revision's import hit points at the
 * predecessor session that was read. Only older journals (the hit does not name the subagent) cannot be
 * attributed, and the gate stays notStarted, that hit proves no session either way.
 */
export function workflowActorStartState(
  runs: readonly WorkflowRunState[] | undefined,
  slot: WorkflowActorSlotRef,
): WorkflowActorGate {
  const run = runs?.find((candidate) => candidate.runId === slot.runId);
  const actor = run?.actors.find(
    (candidate) => candidate.siteId === slot.siteId && candidate.ordinal === slot.ordinal,
  );
  const sessionId = actor?.sessionId ?? slot.actorSessionId;
  const withSession = sessionId === undefined ? {} : { sessionId };
  if (run === undefined || actor === undefined) {
    return { state: sessionId === undefined ? "notStarted" : "unknown", ...withSession };
  }
  // Attribution compares `siteId` + `ordinal` (the journal keys): a wrong ordinal is a different
  // instance, and world-read nodes lack both fields, so they never open the gate for anyone.
  const started = run.nodes.some(
    (node) =>
      node.actorSiteId === actor.siteId &&
      node.actorOrdinal === actor.ordinal &&
      // `queued` is the only phase that does NOT prove the session exists. Taking the complement rather
      // than listing dispatched/repairing/nudged/settled keeps future phases default-open, same stance as
      // `unknown` never blocking.
      node.phase !== "queued",
  );
  return { state: started ? "started" : "notStarted", ...withSession };
}
