// Control-message protocol between the scheduler (utilityProcess) and main. Both sit in Electron via parentPort.postMessage.
// Unlike the host-main CronRun/CronRunResult pair (see @zcode/shared channels + validation),
// this is the private channel between main and the resident cron scheduler; main translates dispatch requests into CronRun for the host.
import type { ModelSelection, NodeSelfResourceSample } from "@zcode/shared";

/** scheduler → main */
export type SchedulerToMainMessage =
  | {
      type: "cron-dispatch-request";
      automationId: string;
      runId: string;
      prompt: string;
      targetTaskId?: string;
      modelSelection?: ModelSelection;
      mode?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      // Off-peak dispatch, independent of the cron pair. First runs omit conversationId/sessionId so
      // host createTask starts a session; resumes/recoveries carry both to rejoin it.
      type: "offpeak-dispatch-request";
      offPeakTaskId: string;
      prompt: string;
      permissionMode: string;
      modelSelection: ModelSelection;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      type: "scheduler-log";
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      // Off-peak running-count changes; main combines this with keepAwakeWhileRunning
      // to decide on a powerSaveBlocker, reporting the value after each tick (idempotent).
      type: "offpeak-active-count";
      count: number;
    }
  | {
      // The scheduler process's 60s self-sample.
      // main takes heap only for the scheduler-role event dim; CPU/RSS stay with getAppMetrics.
      type: "scheduler-resource-sample";
      sample: NodeSelfResourceSample;
    };

/** main → scheduler */
export type MainToSchedulerMessage =
  | {
      type: "cron-dispatch-result";
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // Off-peak dispatch result; late results settle by offPeakTaskId alone (no inFlight ctx needed, idempotent).
      type: "offpeak-dispatch-result";
      offPeakTaskId: string;
      ok: boolean;
      conversationId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // main asks the scheduler to wind down gracefully before exit (release claims, close DB).
      type: "scheduler-dispose";
    }
  | {
      // A manual run persisted; trigger one tick now. automationId is log-correlation only.
      type: "scheduler-wake";
      automationId: string;
    };
