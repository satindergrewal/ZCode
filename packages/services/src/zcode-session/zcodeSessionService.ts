/* eslint-disable max-lines -- zcodeSessionService aggregates desktop-continuous session ops, draft lifecycle, and task-index sync boundaries; splitting needs its own design. */
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "#src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createSessionTraceId,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type {
  IZCodeSessionService,
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionReadWorkspacePresentationParams,
  ZCodeSessionResumeParams,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "#src/zcode-session/zcodeSession.js";
import { formatModelPickerValue } from "#src/zcode-agent/zcodeConfigOptions.js";
import { createZCodeSessionApiRetryRuntimeTracker } from "#src/zcode-session/zcodeSessionApiRetry.js";
import { appendWorkspaceToFilesystemMcpServers } from "#src/session/mcpWorkspaceScope.js";
import { repairEmptyImportedClaudeSessionSnapshot } from "#src/zcode-session/importedClaudeSessionRepair.js";
import { createZCodeDeferredDraftRegistry } from "#src/zcode-session/zcodeSessionDraftRegistry.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";

const logger = createServiceLogger("zcode-session-service");

interface CreateZCodeSessionServiceOptions {
  agentService: IZCodeAgentService;
  /**
   * Background task-index sqlite syncer. Once injected, every create/resume/prompt/subscribe
   * notifies it to maintain shadow subscriptions, keeping sqlite converged on the desktop-continuous path;
   * after any session-mutating op it also pushes the latest snapshot to sqlite and broadcasts
   * workspace_task_list_changed, so the sidebar reorders by first_input title and updatedAt instantly.
   * (continuation)
   */
  taskIndexSyncer?: ZCodeTaskIndexSyncer;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

export function createZCodeSessionService({
  agentService,
  taskIndexSyncer,
  cuaProductMcpServerResolver,
}: CreateZCodeSessionServiceOptions): IZCodeSessionService {
  const { withApiRetryRuntime } = createZCodeSessionApiRetryRuntimeTracker();
  const deferredDraftSessions = createZCodeDeferredDraftRegistry();

  function notifySyncer(
    target: ZCodeTaskTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void {
    if (!taskIndexSyncer) {
      return;
    }
    taskIndexSyncer.ensureSessionSubscription(
      {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.sessionId,
      },
      options,
    );
  }

  function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
    // Diagnostics cannot assume mocks/partial snapshots always carry messages/pendingRequestIds.
    // readSession results are already agent-validated; this layer only records observability fields, and a logging failure must never break
    // desktop-continuous snapshot restore. Tally diagnostics into empty arrays only; never mutate the snapshot returned to the UI.
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const pendingRequestIds = Array.isArray(snapshot.runtime.pendingRequestIds)
      ? snapshot.runtime.pendingRequestIds
      : [];
    return {
      activeTurnId: snapshot.runtime.activeTurnId ?? null,
      eventSeq: snapshot.runtime.eventSeq,
      messageCount: messages.length,
      pendingRequestCount: pendingRequestIds.length,
      sessionStatus: snapshot.session.status,
      stateRevision: snapshot.runtime.stateRevision,
    };
  }

  function readSnapshotAvailableThoughtLevels(
    snapshot: ZCodeSessionStateSnapshot,
  ): Set<string> | null {
    const thoughtLevel = snapshot.settings.thoughtLevel;
    if (!thoughtLevel.enabled) {
      return new Set();
    }
    const available = Array.isArray(thoughtLevel.available)
      ? (thoughtLevel.available as readonly unknown[])
      : [];
    if (available.length === 0) {
      return null;
    }
    const values = available
      .map((option) => {
        if (typeof option === "string") {
          return option.trim();
        }
        if (typeof option === "object" && option !== null && "value" in option) {
          const value = (option as { value?: unknown }).value;
          return typeof value === "string" ? value.trim() : "";
        }
        return "";
      })
      .filter((value) => value.length > 0);
    return values.length > 0 ? new Set(values) : null;
  }

  function canReplayThoughtLevelFromResumeSnapshot(params: {
    snapshot: ZCodeSessionStateSnapshot;
    thoughtLevel: string;
  }): boolean {
    const availableThoughtLevels = readSnapshotAvailableThoughtLevels(params.snapshot);
    return availableThoughtLevels === null || availableThoughtLevels.has(params.thoughtLevel);
  }

  // zcodeSessionService is the desktop-continuous mainline: after any state change it must
  // broadcast a snapshot, or sqlite sticks at createSession's New session and the sidebar never sees
  // workspace_task_list_changed. Legacy write paths (send/steer/fork/compact/rewind pass-through)
  // are gone; only lifecycle/config ops (createSession/resumeSession/setModel) call this.
  async function broadcastSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    tag: string,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      /** Design fix: required; emitters must declare the change kind. */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<void> {
    if (!taskIndexSyncer) {
      return;
    }
    try {
      // Trace log (sidebar refreshing on input ops): names the lifecycle op (setModel/createSession/resumeSession) behind the broadcast.
      logger.debug(
        undefined,
        `[list-refresh-trace] broadcastSnapshot tag=${tag} taskId=${snapshot.session.sessionId}`,
      );
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, options);
    } catch (error) {
      logger.warn(
        undefined,
        `[zcode-session-service] ${tag} syncSnapshotAndBroadcast failed taskId=${snapshot.session.sessionId}`,
        error,
      );
    }
  }

  async function repairEmptyImportedClaudeSession(
    snapshot: ZCodeSessionStateSnapshot,
    params: ZCodeSessionResumeParams | ZCodeSessionReadParams,
  ): Promise<ZCodeSessionStateSnapshot> {
    return withApiRetryRuntime(
      await repairEmptyImportedClaudeSessionSnapshot({
        agentService,
        snapshot,
        target: params,
      }),
    );
  }

  async function withResolvedMcpServers<
    T extends ZCodeSessionCreateParams | ZCodeSessionResumeParams,
  >(params: T): Promise<T> {
    const mcpServers = appendWorkspaceToFilesystemMcpServers(
      params.mcpServers,
      params.workspacePath,
    );
    const resolvedMcpServers = cuaProductMcpServerResolver
      ? await cuaProductMcpServerResolver.resolveMcpServers(mcpServers, {
          workspacePath: params.workspacePath,
        })
      : mcpServers;
    if (resolvedMcpServers === params.mcpServers) {
      return params;
    }
    // The desktop-continuous path bypasses the legacy task adapter and used to skip
    // filesystem MCP workspace injection, leaving first sends without project grants.
    // Patch only the runtime-bound params, never user config, keeping cross-workspace MCP settings clean;
    // the CUA broker socket/token inject into runtime params only.
    return { ...params, mcpServers: resolvedMcpServers };
  }

  return {
    async initializeWorkspace(params: ZCodeSessionWorkspaceTarget) {
      const result = await agentService.initialize(params);
      // The task index's v4 intake (sessions-index/workspace-config) is a
      // workspace-level resident subscription. The v4 command path (createSession/sendText via v4/command)
      // bypasses this service, so the subscription must exist at workspace warmup
      // or v4-only terminals/titles/config never reach sqlite or the workspace broadcast.
      if (result.available && taskIndexSyncer) {
        taskIndexSyncer.ensureWorkspaceSubscription({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
      }
      return result;
    },

    getWorkspaceRuntimeIdentity(params: ZCodeSessionWorkspaceTarget) {
      return agentService.getWorkspaceRuntimeIdentity(params);
    },

    readWorkspacePresentation(params: ZCodeSessionReadWorkspacePresentationParams) {
      return agentService.readWorkspacePresentation(params);
    },

    async createSession(params: ZCodeSessionCreateParams) {
      const startedAt = Date.now();
      const sessionTraceId = params.sessionTraceId ?? createSessionTraceId();
      const agentParams = await withResolvedMcpServers({ ...params, sessionTraceId });
      logger.info(sessionTraceId, "[zcode-session-service] createSession assigned session trace", {
        persistence: agentParams.persistence,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      const snapshot = await agentService.createSession(agentParams);
      logger.info(sessionTraceId, "[zcode-session-service] createSession agent returned", {
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        persistence: agentParams.persistence,
        snapshotTraceId: snapshot.session.traceId ?? null,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      if (agentParams.persistence === "deferred") {
        // Pre-send draft sessions only align toolbar and runtime state.
        // They must not enter the task index sqlite, or sidebar/search fill with input-less sessions.
        // Track the draft so later setModel-style changes stay out of the index too.
        deferredDraftSessions.remember(agentParams, snapshot);
        return snapshot;
      }
      // The desktop-continuous path never sees the ZCode task adapter; the index lives on
      // syncer shadow subscriptions. Ensure immediately after createSession so the subscription
      // is ready before the first runtime event
      notifySyncer({
        workspacePath: snapshot.session.workspace.workspacePath,
        workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
        sessionId: snapshot.session.sessionId,
      });
      // Also push the initial snapshot to sqlite and broadcast so the row appears at once.
      // Continuous first-sends skip legacy createTask, so seed the grouped-top ordering here.
      const snapshotWithRuntime = withApiRetryRuntime(snapshot);
      const broadcastStartedAt = Date.now();
      await broadcastSnapshot(snapshotWithRuntime, "createSession", {
        moveGroupedTaskToTop: true,
        // First-send broadcast keeps the legacy task_meta_changed semantic (rare, once per task);
        // promoting it to task_created means reworking optimistic-insert dedupe too.
        broadcastReason: "task_meta_changed",
      });
      logger.info(
        sessionTraceId,
        "[zcode-session-service] createSession task index sync complete",
        {
          broadcastDurationMs: Date.now() - broadcastStartedAt,
          durationMs: Date.now() - startedAt,
          sessionId: snapshot.session.sessionId,
          workspaceIdentity: params.workspaceIdentity,
          workspacePath: params.workspacePath,
        },
      );
      return snapshotWithRuntime;
    },

    async resumeSession(params: ZCodeSessionResumeParams) {
      const startedAt = Date.now();
      const { broadcastSnapshot: shouldBroadcastSnapshot = true, ...resumeParams } = params;
      const agentParams = await withResolvedMcpServers(resumeParams);
      let snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.resumeSession(agentParams)),
        agentParams,
      );
      const requestedThoughtLevelOverride = agentParams.thoughtLevel?.trim();
      let thoughtLevelOverride = requestedThoughtLevelOverride;
      if (
        requestedThoughtLevelOverride &&
        snapshot.settings.thoughtLevel.current !== requestedThoughtLevelOverride
      ) {
        if (
          !canReplayThoughtLevelFromResumeSnapshot({
            snapshot,
            thoughtLevel: requestedThoughtLevelOverride,
          })
        ) {
          // Restored tasks switch to the task-local model, but stale task config
          // can carry the previous model's thoughtLevel (GLM-5-Turbo handed max).
          // snapshot.settings.thoughtLevel.available is the capability truth; never replay unsupported levels.
          thoughtLevelOverride = undefined;
          logger.warn(
            undefined,
            "[zcode-session-service] resumeSession skipped unsupported task thinking level",
            {
              availableThoughtLevels: Array.from(
                readSnapshotAvailableThoughtLevels(snapshot) ?? [],
              ),
              requestedThoughtLevel: requestedThoughtLevelOverride,
              sessionId: agentParams.sessionId,
              snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
              workspaceIdentity: agentParams.workspaceIdentity ?? null,
              workspacePath: agentParams.workspacePath,
            },
          );
        }
      }
      if (thoughtLevelOverride && snapshot.settings.thoughtLevel.current !== thoughtLevelOverride) {
        logger.info(
          undefined,
          "[zcode-session-service] resumeSession reapplied task thinking level",
          {
            requestedThoughtLevel: thoughtLevelOverride,
            sessionId: agentParams.sessionId,
            snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
            workspaceIdentity: agentParams.workspaceIdentity ?? null,
            workspacePath: agentParams.workspacePath,
          },
        );
        // A resume snapshot can still carry the workspace draft's latest thinking level.
        // Replay the task-local level for this session, then broadcast the corrected snapshot;
        // otherwise syncer/UI write the draft's high over an active task set to max.
        snapshot = await repairEmptyImportedClaudeSession(
          withApiRetryRuntime(
            await agentService.setThoughtLevel({
              workspacePath: agentParams.workspacePath,
              workspaceIdentity: agentParams.workspaceIdentity,
              sessionId: agentParams.sessionId,
              thoughtLevel: thoughtLevelOverride,
            }),
          ),
          agentParams,
        );
      }
      const agentDurationMs = Date.now() - startedAt;
      notifySyncer(agentParams, { includeSnapshot: shouldBroadcastSnapshot });
      const broadcastStartedAt = Date.now();
      const modelOverride = agentParams.model
        ? formatModelPickerValue(agentParams.model)
        : undefined;
      const syncOptions =
        modelOverride || thoughtLevelOverride
          ? {
              ...(modelOverride ? { modelOverride } : {}),
              ...(thoughtLevelOverride ? { thoughtLevelOverride } : {}),
            }
          : undefined;
      if (shouldBroadcastSnapshot) {
        // Open/resume is snapshot convergence and never touches pin/archive/unread;
        // the default task_meta_changed would refetch memberships on every open.
        await broadcastSnapshot(snapshot, "resumeSession", {
          ...syncOptions,
          broadcastReason: "task_status_changed",
        });
      } else if (modelOverride && taskIndexSyncer) {
        await taskIndexSyncer.syncTaskModel(
          {
            workspacePath: agentParams.workspacePath,
            workspaceIdentity: agentParams.workspaceIdentity,
            sessionId: agentParams.sessionId,
          },
          modelOverride,
        );
      }
      logger.info(undefined, "[zcode-session-service] resumeSession restore complete", {
        agentDurationMs,
        broadcastDurationMs: shouldBroadcastSnapshot ? Date.now() - broadcastStartedAt : 0,
        broadcastSnapshot: shouldBroadcastSnapshot,
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        sessionId: agentParams.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: agentParams.workspaceIdentity ?? null,
        workspacePath: agentParams.workspacePath,
      });
      return snapshot;
    },

    listSessions(params: ZCodeSessionListParams) {
      return agentService.listSessions(params);
    },

    async readSession(params: ZCodeSessionReadParams) {
      const startedAt = Date.now();
      const snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.readSession(params)),
        params,
      );
      logger.info(undefined, "[zcode-session-service] readSession history snapshot loaded", {
        deliveryKind: params.deliveryKind,
        durationMs: Date.now() - startedAt,
        messageLimit: params.messageLimit ?? null,
        sessionId: params.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return snapshot;
    },

    readSessionMessages(params: ZCodeSessionMessagesParams) {
      return agentService.readSessionMessages(params);
    },

    readSessionEvents(params: ZCodeSessionEventsParams) {
      return agentService.readSessionEvents(params);
    },

    promoteDeferredDraftSession(params: ZCodeTaskTarget) {
      const wasDeferredDraft = deferredDraftSessions.has(params);
      deferredDraftSessions.forget(params);
      if (!wasDeferredDraft) {
        return Promise.resolve();
      }
      // Phone-replayable first sends consume deferred drafts via the task facade; clear the draft mark
      // and sync the index so desktop control of the same task no longer defers.
      notifySyncer(params);
      logger.info(undefined, "[zcode-session-service] deferred draft promoted to task", {
        sessionId: params.sessionId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return Promise.resolve();
    },

    closeSession(params: ZCodeTaskTarget) {
      deferredDraftSessions.forget(params);
      return agentService.closeSession(params).then(() => undefined);
    },

    async closeDeferredDraftSession(params: ZCodeTaskTarget) {
      try {
        const closed = await agentService.closeSession({
          ...params,
          expectedPersistence: "deferred",
        });
        if (closed) {
          deferredDraftSessions.forget(params);
        }
        return closed;
      } catch (error) {
        // Legacy agents reject expectedPersistence. Degrade by keeping the session and drafting anew,
        // never unconditional close, which could kill a just-promoted active task.
        logger.warn(
          undefined,
          "[zcode-session-service] conditional deferred-draft close failed; keeping the old session",
          {
            error: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspacePath: params.workspacePath,
          },
        );
        return false;
      }
    },

    async setModel(params: ZCodeSessionSetModelParams) {
      const isDeferredDraft = deferredDraftSessions.has(params);
      if (!isDeferredDraft) {
        notifySyncer(params);
      }
      const snapshot = withApiRetryRuntime(await agentService.setModel(params));
      if (isDeferredDraft) {
        // Deferred drafts live in runtime memory; setModel returns a message-less snapshot.
        // Subscribing/writing the index here leaves unresolvable Session-not-found rows after restarts.
        return snapshot;
      }
      await broadcastSnapshot(snapshot, "setModel", {
        modelOverride: formatModelPickerValue(params.model),
        // Model switches are config-only: broadcast task_model_changed,
        // not the default task_meta_changed, which reads as membership-related and
        // triggers global membership refetches plus full sidebar refreshes.
        broadcastReason: "task_model_changed",
      });
      return snapshot;
    },

    async setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams) {
      return withApiRetryRuntime(await agentService.setThoughtLevel(params));
    },

    async setMode(params: ZCodeSessionSetModeParams) {
      return withApiRetryRuntime(await agentService.setMode(params));
    },

    respondProviderRuntimeHeaders(params) {
      return agentService.respondProviderRuntimeHeaders(params);
    },

    // M5 wave 2: onDynamicSessionEvent (legacy renderer subscription surface) is gone.
    // v4 session events flow through agentService conversation frames; no subscriptions
    // to agentService.onDynamicSessionEvent remain here.
  };
}
