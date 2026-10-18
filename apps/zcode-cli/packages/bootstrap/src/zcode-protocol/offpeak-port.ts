import type { OffPeakPort, OffPeakTaskSummary } from "@zcode/contracts";
import {
  zcodeOffPeakCreateResultSchema,
  zcodeOffPeakListResultSchema,
  zcodeProtocolMethods,
  type ZCodeOffPeakTaskProtocolSnapshot,
} from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export const OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR =
  "Cannot create an idle-time task while running an idle-time task.";
export const OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR =
  "This session already has a pending idle-time task. Wait for it to finish (or cancel it in Automations) before creating another one here.";
export const OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR =
  "Cannot verify whether this session already has a pending idle-time task; try again later.";

const OFF_PEAK_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * The Off-Peak protocol port. Trade-offs vs automation-port:
 * - Guards only "off-peak round recursive creation" (activeOffPeakTaskId); activeAutomationId is not checked -- cron rounds
 *   let OffPeakCreate through (scheduled derivation of off-peak tasks).
 * - In-session creation binds the current session (aligned with CronCreate targetTaskId) and resumes it on dispatch.
 *   The binding guard rejects only "this session already has a non-terminal off-peak task" (two unattended prompts racing one session); once it ends, creation is allowed again,
 *   unlike cron's permanent one-task-per-session. The check reuses the minimal offPeak/list snapshot (sessionId/status),
 *   failing closed on query errors. The real scale protection remains the server-side ticket quota (POST /ticket 3103).
 * - No runtimeModel/mode/thoughtLevel injection: defaults resolve host-side
 *   (yolo / last of allowed_models / highest tier); session runtime state is unrelated to the off-peak allowlist.
 * - Never freeze the session title: the bound session is the user's working session; its title is not the task's to rewrite.
 */
export function createProtocolOffPeakPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession?: () => ZCodeProtocolSessionRecord | undefined,
): OffPeakPort {
  return {
    async create(input, createContext) {
      const activeSession =
        resolveOwnSession?.() ??
        (createContext?.sessionId ? context.sessions.get(createContext.sessionId) : undefined);
      if (activeSession?.activeOffPeakTaskId?.trim()) {
        // This turn was already dispatched by an off-peak task; creating another inside the round is recursive self-derivation -- reject.
        // A third defense layer beyond the turn denylist and the handler's offPeakTurn.
        throw new Error(OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR);
      }
      const boundSessionId = createContext?.sessionId ?? activeSession?.app.sessionId;
      if (boundSessionId) {
        let bound: boolean;
        try {
          const listed = await context.requestClient(
            zcodeProtocolMethods.offPeakList,
            {},
            zcodeOffPeakListResultSchema,
          );
          bound = listed.tasks.some(
            (task) =>
              task.sessionId === boundSessionId && !OFF_PEAK_TERMINAL_STATUSES.has(task.status),
          );
        } catch (error) {
          context.logger?.warn("Failed to check bound idle-time tasks before OffPeakCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "offpeak.create.bound_session_check.failed",
            sessionId: boundSessionId,
          });
          // Unknown must not mean unbound: a transient host/database failure must not reopen "two tasks per session".
          throw new Error(OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR);
        }
        if (bound) throw new Error(OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR);
      }
      const result = await context.requestClient(
        zcodeProtocolMethods.offPeakCreate,
        {
          title: input.title,
          prompt: input.prompt,
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
          // Bind the current session; workspace is still injected host-side from the current session (mirroring automation/create).
          ...(boundSessionId ? { boundSessionId } : {}),
        },
        zcodeOffPeakCreateResultSchema,
      );
      if (!result.ok) {
        // Failure classes pass through for the handler to translate; never degrade to a message string at the port layer.
        return {
          ok: false,
          failureStage: result.failureStage,
          errorCategory: result.errorCategory,
          errorCode: result.errorCode,
        };
      }
      return { ok: true, task: toOffPeakTaskSummary(result.task) };
    },
    async list() {
      const result = await context.requestClient(
        zcodeProtocolMethods.offPeakList,
        {},
        zcodeOffPeakListResultSchema,
      );
      return result.tasks.map(toOffPeakTaskSummary);
    },
  };
}

function toOffPeakTaskSummary(input: ZCodeOffPeakTaskProtocolSnapshot): OffPeakTaskSummary {
  return {
    offPeakTaskId: input.offPeakTaskId,
    title: input.title,
    status: input.status,
    queuePosition: input.queuePosition,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
  };
}
