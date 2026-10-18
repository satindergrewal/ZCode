/* eslint-disable max-lines -- zcodeSessionService owns desktop-continuous session ops, draft lifecycle, and the task-index sync boundary; splitting needs its own design */
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
   * notifies the syncer to maintain shadow subscriptions so sqlite converges with runtime state on
   * the desktop-continuous path; state-changing ops also push the latest snapshot to sqlite and
   * broadcast workspace_task_list_changed
   * so sidebar order (first_input title, updatedAt) refreshes immediately.
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
    // Log diagnostics cannot assume mocks/partial snapshots carry messages/pendingRequestIds:
    // readSession results are validated in the agent layer and a logging failure must not break
    // the desktop-continuous snapshot restore. Count against empty arrays only.
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

  // zcodeSessionService is the desktop-continuous main path: after any state change it must
  // broadcast the snapshot or sqlite stays at the createSession "New session" row and the sidebar
  // misses workspace_task_list_changed. Legacy write pass-throughs are gone; only lifecycle and
  // config ops (createSession/resumeSession/setModel-style) call this.
  async function broadcastSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    tag: string,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      /** Design fix: required - every emit declares its change category. */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<void> {
    if (!taskIndexSyncer) {
      return;
    }
    try {
      // Trace log (sidebar refresh on input ops): which lifecycle op
      // (setModel/createSession/resumeSession) triggered the snapshot broadcast.
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
    // The desktop-continuous session path bypasses the legacy task adapter and used to skip
    // filesystem MCP workspace injection, so first direct-session sends lacked project grants.
    // Patch only runtime-bound params, never user config, avoiding cross-workspace pollution;
    // the CUA broker socket/token is likewise runtime-only.
    return { ...params, mcpServers: resolvedMcpServers };
  }

  return {
    async initializeWorkspace(params: ZCodeSessionWorkspaceTarget) {
      const result = await agentService.initialize(params);
      // Task-index v4 ingestion (sessions-index/workspace-config) is a workspace-lifetime
      // subscription. The v4 command path (createSession/sendText via v4/command) bypasses this
      // service, so the workspace warmup must own the subscription or pure-v4 terminal
      // states/titles/config never reach sqlite or the workspace broadcast.
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
        // A pre-send draft session only shares state between toolbar and agent runtime;
        // keep it out of the task index sqlite or sidebar/search fill with input-less sessions.
        // Later setModel-style changes on the draft stay out of the index too.
        deferredDraftSessions.remember(agentParams, snapshot);
        return snapshot;
      }
      // The desktop-continuous path never hits the legacy task adapter, so the sqlite index
      // lives on the syncer's shadow subscriptions; ensure right after createSession so the
      // subscription is ready before the first runtime event.
      notifySyncer({
        workspacePath: snapshot.session.workspace.workspacePath,
        workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
        sessionId: snapshot.session.sessionId,
      });
      // Also push the initial snapshot to sqlite and broadcast so the new row shows at once;
      // the first send never passes legacy createTask, so grouped-top ordering is written here.
      const snapshotWithRuntime = withApiRetryRuntime(snapshot);
      const broadcastStartedAt = Date.now();
      await broadcastSnapshot(snapshotWithRuntime, "createSession", {
        moveGroupedTaskToTop: true,
        // Keep legacy task_meta_changed semantics for the first broadcast (low frequency, once);
        // task_created (insert-active) needs the optimistic-insert dedup changed too.
        broadcastReason: "task_meta_changed",
      });
      logger.info(sessionTraceId, "[zcode-session-service] createSession task index sync done", {
        broadcastDurationMs: Date.now() - broadcastStartedAt,
        durationMs: Date.now() - startedAt,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: params.workspaceIdentity,
        workspacePath: params.workspacePath,
      });
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
          // On resume the model is task-local again, but stale task config may carry the previous
          // model's thoughtLevel (e.g. GLM-5-Turbo saved as max).
          // snapshot.settings.thoughtLevel.available is the truth; never replay unsupported levels.
          thoughtLevelOverride = undefined;
          logger.warn(
            undefined,
            "[zcode-session-service] resumeSession skipping unsupported task thought level",
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
          "[zcode-session-service] resumeSession re-applied task thought level",
          {
            requestedThoughtLevel: thoughtLevelOverride,
            sessionId: agentParams.sessionId,
            snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
            workspaceIdentity: agentParams.workspaceIdentity ?? null,
            workspacePath: agentParams.workspacePath,
          },
        );
        // A resumed snapshot may still carry the draft's latest thoughtLevel for this workspace;
        // re-apply the task-local level and broadcast the corrected snapshot, or the syncer/UI
        // write the draft's high over an active task that is max.
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
        // Open/resume is snapshot convergence: do not touch pin/archive/unread, or the default
        // task_meta_changed triggers a global membership refetch on every open.
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
      logger.info(undefined, "[zcode-session-service] resumeSession history restore done", {
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
      // Phone-replayable first send consumes the deferred draft via the task facade: clear the
      // draft flag and notify the index sync, or desktop control of the task keeps skipping sync.
      notifySyncer(params);
      logger.info(undefined, "[zcode-session-service] deferred draft session promoted to task", {
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
        // Older agents reject expectedPersistence. Degrade safely: keep the old session and create
        // a new draft; an unconditional close could kill a just-promoted active task.
        logger.warn(
          undefined,
          "[zcode-session-service] conditional deferred-draft close failed; keeping old session",
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
        // A deferred draft lives only in runtime memory; setModel returns a message-less snapshot.
        // Indexing it leaves unresumable "Session not found" rows after a restart.
        return snapshot;
      }
      await broadcastSnapshot(snapshot, "setModel", {
        modelOverride: formatModelPickerValue(params.model),
        // Model switches are pure config: broadcast task_model_changed.
        // The previous default (task_meta_changed) read as ownership-related and triggered
        // a global membership refetch plus full sidebar refreshes.
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

    // onDynamicSessionEvent (legacy renderer session/subscribe) is removed:
    // v4 UI session events flow through agentService conversation frames;
    // this service no longer subscribes to agentService.onDynamicSessionEvent.
  };
}
