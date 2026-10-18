// // Desktop-main side manager for the cron scheduler process.
// // Owns spawn/teardown of the resident scheduler; routes dispatch requests to a local host (as CronRun) and
// feeds CronRunResults back for settlement. The scheduler touches tasks-index only; createTask runs in the host domain.
import { utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import { buildHostProcessEnv, schedulerModulePath } from "./desktopRuntimeEnv.js";
import { ingestSchedulerSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { registerSchedulerProcess, unregisterSchedulerProcess } from "./resourceManagerWindow.js";
import type {
  MainToSchedulerMessage,
  SchedulerToMainMessage,
} from "../scheduler/schedulerProtocol.js";

export interface CronRunResultPayload {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

/* /** host-to-main off-peak dispatch result (independent of cron messages). */
export interface OffPeakRunResultPayload {
  offPeakTaskId: string;
  ok: boolean;
  conversationId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

interface CronSchedulerDeps {
  hostProcessLocalEnv: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /* /** Picks a host able to run local workspace dispatch; null when none (scheduler backs off and retries). */
  resolveDispatchHost: () => ElectronUtilityProcess | null;
  /* /** Off-peak running-count changes (keep-awake: main toggles powerSaveBlocker per this plus settings). */
  onOffPeakActiveCountChanged?: (count: number) => void;
}

export interface CronSchedulerHandle {
  /* /** Called on host dispatch results; forwards to the scheduler for settlement. */
  handleCronRunResult: (result: CronRunResultPayload) => void;
  /* /** Called on off-peak dispatch results; forwards to the scheduler for settlement. */
  handleOffPeakRunResult: (result: OffPeakRunResultPayload) => void;
  /* /** Wakes the scheduler as soon as a manual run persists, skipping the next poll. */
  wake: (automationId: string) => void;
  /* /** Graceful shutdown: release claims, close the DB, force-kill as the fallback. */
  dispose: () => Promise<void>;
}

const DISPOSE_FORCE_KILL_MS = 1_500;

export function spawnCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {
  const child = electronUtilityProcess.fork(schedulerModulePath, [], {
    serviceName: "zcode-cron-scheduler",
    execArgv: ["--no-warnings"],
    env: {
      ...buildHostProcessEnv(deps.hostProcessLocalEnv),
      ZCODE_PROCESS_LABEL: "scheduler",
    },
  });

  deps.logger.info(`[cron-scheduler] forked scheduler process pid=${child.pid}`);
  // Only the spawn point knows the scheduler role pid; register it in the process-role table here.
  registerSchedulerProcess(child);
  let isDisposing = false;
  let disposePromise: Promise<void> | null = null;

  const postToScheduler = (message: MainToSchedulerMessage): void => {
    try {
      child.postMessage(message);
    } catch (error) {
      deps.logger.warn("[cron-scheduler] postMessage to scheduler failed:", error);
    }
  };

  child.on("message", (raw: unknown) => {
    const msg = raw as SchedulerToMainMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "scheduler-log") {
      const level = msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info";
      deps.logger[level](`[cron-scheduler] ${msg.message}`);
      return;
    }

    if (msg.type === "offpeak-active-count") {
      deps.onOffPeakActiveCountChanged?.(msg.count);
      return;
    }

    // Scheduler self-samples: main takes heap only, for the scheduler-role event dim;
    // invalid samples drop at the ingress by schema.
    if (msg.type === "scheduler-resource-sample") {
      ingestSchedulerSelfResourceSample(msg.sample);
      return;
    }

    if (msg.type === "cron-dispatch-request") {
      if (isDisposing) {
        // During shutdown Cron and Host wind down in parallel; dispatching after disposing sends new tasks
        // to a dying Host. Reject explicitly instead of adding 1.5s of exit delay for serialization.
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "app is shutting down",
        });
        return;
      }
      const host = deps.resolveDispatchHost();
      if (!host) {
        // No dispatchable local host (no window/not ready): ack transient; the scheduler backs off and retries.
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.CronRun,
          automationId: msg.automationId,
          runId: msg.runId,
          prompt: msg.prompt,
          targetTaskId: msg.targetTaskId,
          modelSelection: msg.modelSelection,
          mode: msg.mode,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward CronRun to host failed:", error);
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (msg.type === "offpeak-dispatch-request") {
      const host = deps.resolveDispatchHost();
      if (!host) {
        // No host: transient ack; the off-peak backoff retries later without dropping the task.
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.OffPeakRun,
          offPeakTaskId: msg.offPeakTaskId,
          prompt: msg.prompt,
          permissionMode: msg.permissionMode,
          modelSelection: msg.modelSelection,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          serverTicketId: msg.serverTicketId,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward OffPeakRun to host failed:", error);
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  child.on("exit", (code) => {
    unregisterSchedulerProcess(child);
    deps.logger.info(`[cron-scheduler] scheduler process exited code=${code}`);
  });

  return {
    handleCronRunResult(result) {
      postToScheduler({ type: "cron-dispatch-result", ...result });
    },
    handleOffPeakRunResult(result) {
      postToScheduler({ type: "offpeak-dispatch-result", ...result });
    },
    wake(automationId) {
      if (isDisposing) return;
      postToScheduler({ type: "scheduler-wake", automationId });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      isDisposing = true;
      postToScheduler({ type: "scheduler-dispose" });
      disposePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Ignore.
          }
          done();
        }, DISPOSE_FORCE_KILL_MS);
        child.once("exit", done);
      });
      return disposePromise;
    },
  };
}
