import type { IZCodeSessionService, IZCodeTaskService } from "@zcode/services";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeSessionStateSnapshot,
  ZCodeTaskSnapshot,
} from "@zcode/shared";
import {
  zcodeSessionSettingsToConfigOptions,
  zcodeSessionSnapshotToZCodeTaskSnapshot,
} from "@/lib/zcodeSessionProjection.js";
import { normalizeZCodeUiError, type ZCodeUiError } from "@/lib/zcodeUiError.js";
import { logger } from "@/logger.js";

export type ZCodeSessionRestoreService = Pick<
  IZCodeSessionService,
  "readSession" | "resumeSession"
>;
export type ZCodeLegacyTaskSnapshotRestoreService = Pick<IZCodeTaskService, "getTaskSnapshot">;

export interface DesktopContinuousSessionRestoreSnapshot {
  snapshot: ZCodeTaskSnapshot;
  restoreWarning?: ZCodeUiError;
  resumedSessionSnapshot?: ZCodeSessionStateSnapshot;
  usedLegacySnapshot?: boolean;
}

function isSessionMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\bSession (not found|is not active):/i.test(message);
}

function isRuntimeModelUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ZCODE_RUNTIME_MODEL_UNAVAILABLE"
  );
}

function getRuntimeModelUnavailableDiagnostics(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return {};
  }
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return {};
  }
  const model = "model" in data ? (data as { model?: unknown }).model : undefined;
  return {
    errorData: data,
    errorModel:
      typeof model === "object" && model !== null
        ? {
            modelId: "modelId" in model ? (model as { modelId?: unknown }).modelId : null,
            providerId:
              "providerId" in model ? (model as { providerId?: unknown }).providerId : null,
          }
        : null,
  };
}

function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
  return {
    activeTurnId: snapshot.runtime.activeTurnId ?? null,
    eventSeq: snapshot.runtime.eventSeq,
    messageCount: snapshot.messages.length,
    pendingRequestCount: snapshot.runtime.pendingRequestIds.length,
    sessionStatus: snapshot.session.status,
    stateRevision: snapshot.runtime.stateRevision,
  };
}

export async function readDesktopContinuousSessionRestoreSnapshot(params: {
  zcodeSessionService: ZCodeSessionRestoreService;
  zcodeTaskService?: ZCodeLegacyTaskSnapshotRestoreService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  messageLimit?: number;
  model?: ModelSelection;
  thoughtLevel?: string;
}): Promise<DesktopContinuousSessionRestoreSnapshot> {
  // Bugfix: session/read reaches only the runtime's active session.
  // A history task's first open must resume-activate first, then read rate-limited snapshots per desktop continuous.
  const startedAt = Date.now();
  let resumedSessionSnapshot: ZCodeSessionStateSnapshot;
  try {
    const resumeStartedAt = Date.now();
    resumedSessionSnapshot = await params.zcodeSessionService.resumeSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.sessionId,
      // Bugfix: a history task's first open must carry the task meta's model
      // plus the task-local thoughtLevel, so draft/workspace defaults never pollute a same-model active task.
      ...(params.model ? { model: params.model } : {}),
      ...(params.thoughtLevel ? { thoughtLevel: params.thoughtLevel } : {}),
    });
    logger.info("[zcodeSessionRestore] desktop resumeSession completed", {
      durationMs: Date.now() - resumeStartedAt,
      messageLimit: params.messageLimit ?? null,
      sessionId: params.sessionId,
      snapshot: getSessionSnapshotDiagnostics(resumedSessionSnapshot),
      totalDurationMs: Date.now() - startedAt,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
  } catch (error) {
    if (
      !params.zcodeTaskService ||
      (!isSessionMissingError(error) && !isRuntimeModelUnavailableError(error))
    ) {
      throw error;
    }

    const runtimeModelUnavailable = isRuntimeModelUnavailableError(error);
    if (runtimeModelUnavailable) {
      logger.info(
        "[zcodeSessionRestore][diag:model-unavailable] desktop resumeSession model unavailable",
        {
          messageLimit: params.messageLimit ?? null,
          requestedModelId: params.model?.modelId ?? null,
          requestedProviderId: params.model?.providerId ?? null,
          sessionId: params.sessionId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
          ...getRuntimeModelUnavailableDiagnostics(error),
        },
      );
    }
    // Bugfix: legacy ACP tasks without a protocol session, or history models dropped from the registry, must not
    // keep faking an active session. Fall back to the task facade's snapshot read, restoring display only;
    // real continues wait for an explicit usable-model choice.
    const legacyStartedAt = Date.now();
    const legacySnapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.sessionId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      ...(typeof params.messageLimit === "number" ? { messageLimit: params.messageLimit } : {}),
      clientMode: "desktop-continuous",
    });
    if (!legacySnapshot) {
      throw error;
    }
    logger.info("[zcodeSessionRestore] desktop legacy snapshot read completed", {
      durationMs: Date.now() - legacyStartedAt,
      messageCount: legacySnapshot.messages.length,
      messageLimit: params.messageLimit ?? null,
      sessionId: params.sessionId,
      totalDurationMs: Date.now() - startedAt,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
    return {
      snapshot: legacySnapshot,
      ...(runtimeModelUnavailable
        ? {
            restoreWarning: normalizeZCodeUiError(error, {
              fallbackCode: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
              taskId: params.sessionId,
            }),
          }
        : {}),
      usedLegacySnapshot: true,
    };
  }
  const readStartedAt = Date.now();
  const readSessionSnapshot = await params.zcodeSessionService.readSession({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    sessionId: params.sessionId,
    deliveryKind: "desktop-continuous",
    ...(typeof params.messageLimit === "number" ? { messageLimit: params.messageLimit } : {}),
  });
  const readDurationMs = Date.now() - readStartedAt;
  const projectionStartedAt = Date.now();
  const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot(readSessionSnapshot);
  logger.info("[zcodeSessionRestore] desktop readSession snapshot conversion completed", {
    durationMs: Date.now() - startedAt,
    messageLimit: params.messageLimit ?? null,
    projectionDurationMs: Date.now() - projectionStartedAt,
    readDurationMs,
    sessionId: params.sessionId,
    snapshot: {
      history: snapshot.history ?? null,
      messageCount: snapshot.messages.length,
      status: snapshot.meta.status,
    },
    workspaceIdentity: params.workspaceIdentity ?? null,
    workspacePath: params.workspacePath,
  });
  return {
    resumedSessionSnapshot,
    snapshot,
  };
}

export async function readWebRemoteReplayableSessionConfigOptions(params: {
  zcodeSessionService: ZCodeSessionRestoreService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  model?: ModelSelection;
  thoughtLevel?: string;
}): Promise<ZCodeConfigOption[] | null> {
  const startedAt = Date.now();
  try {
    if (params.model) {
      const resumeStartedAt = Date.now();
      // Bugfix: the mobile replayable config read lands before the later resumeTask.
      // Activate with the history model first, or readSession sees default-polluted settings/context.
      const resumed = await params.zcodeSessionService.resumeSession({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: params.sessionId,
        model: params.model,
        ...(params.thoughtLevel ? { thoughtLevel: params.thoughtLevel } : {}),
      });
      logger.info("[zcodeSessionRestore] resumeSession completed before the replay config read", {
        durationMs: Date.now() - resumeStartedAt,
        requestedModelId: params.model.modelId,
        requestedProviderId: params.model.providerId,
        sessionId: params.sessionId,
        snapshot: getSessionSnapshotDiagnostics(resumed),
        totalDurationMs: Date.now() - startedAt,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
    }
    const snapshot = await params.zcodeSessionService.readSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.sessionId,
      deliveryKind: "web-remote-replayable",
      messageLimit: 1,
    });
    const options = zcodeSessionSettingsToConfigOptions(snapshot.settings);
    logger.info("[zcodeSessionRestore] replayable task config read completed", {
      configOptionCount: options.length,
      durationMs: Date.now() - startedAt,
      sessionId: params.sessionId,
      snapshot: getSessionSnapshotDiagnostics(snapshot),
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
    return options;
  } catch (error) {
    if (isSessionMissingError(error)) {
      logger.info("[zcodeSessionRestore] replayable task config read skipped; session inactive", {
        durationMs: Date.now() - startedAt,
        sessionId: params.sessionId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return null;
    }
    throw error;
  }
}
