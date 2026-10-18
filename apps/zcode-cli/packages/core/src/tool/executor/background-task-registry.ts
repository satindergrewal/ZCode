import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
} from "@zcode/contracts";
import type {
  ExecutionPort,
  DynamicWorkflowRunSnapshot,
  SubagentTaskSnapshot,
  WorkflowTaskSnapshot,
} from "@zcode/contracts";
import {
  isTerminalRuntimeTask,
  type RuntimeTaskSnapshot,
  type RuntimeTaskType,
} from "../../runtime-task/registry.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import { serializeWorkflowArtifact } from "./workflow-artifact.js";

type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // A workflow run snapshot keeps the WorkflowTaskSnapshot shape but widens output to unknown (the payload is
  // whatever the script returns at top level), so it is not a WorkflowTaskSnapshot subtype and needs its own branch.
  | DynamicWorkflowRunSnapshot;

/**
 * Name-dispatch predicate for dwf runs: CreateWorkflow = fresh start / ResumeWorkflowRun = resume -- the two
 * entries of one run lifecycle; snapshot/wait/cancel/notify/registry all behave identically.
 *
 * Note: CreateWorkflow's confirmation-window Refine special case (product-projection.ts / turn-control.ts)
 * deliberately does **not** use this predicate -- ResumeWorkflowRun's confirm window has no causalityGraph and
 * no graph refine and falls back to plain ask; adding its name there would grow a graph-less Refine option.
 */
export function isDynamicWorkflowRunDispatchToolName(name: string): boolean {
  return (
    name === CREATE_WORKFLOW_TOOL_NAME ||
    name === AMEND_WORKFLOW_TOOL_NAME ||
    name === RESUME_WORKFLOW_RUN_TOOL_NAME
  );
}

export function registerRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  output: Record<string, unknown>,
  turnId?: RuntimeTaskSnapshot["turnId"],
): void {
  const taskType = runtimeTaskTypeForToolCall(toolCall);
  if (!taskType || !deps.runtimeTaskRegistry) return;
  const existing = deps.runtimeTaskRegistry.get(taskId);
  const description = runtimeTaskDescription(toolCall, output) ?? defaultRuntimeTaskDescription(taskType);
  const outputFile = backgroundTaskOutputMetadata(output).outputFile;
  // Same-process cancel terminal -> resume without restart (dwf re-arm; the v4 command path and the tool path
  // converge in trackBackgroundTask): the surviving entry still carries the previous round's claimed
  // notified:true; keeping it through the rebuild would make claimRuntimeBackgroundTaskNotification reject --
  // swallowing the resumed run's terminal model notification. Leftover error/completedAt/resultText would also
  // keep stale failure/completion/payload values alive via updateRuntimeBackgroundTask's `?? current.*` chain.
  // So a re-arm resets the whole **settlement face** (notified/completedAt/error/exitCode/resultText/pid);
  // the **identity face** stays existing??new untouched (agentId/agentType/parentToolCallId/turnId/description/
  // startedAt) -- parentToolCallId is the anchor keeping the tool-card -> detail link across resume; swapping in
  // the re-arm descriptor id would break that join.
  //
  // The reset must be bounded by re-arm: only dwf dispatch names reuse one runId to start a new lifecycle on a
  // terminal entry (re-arm), so the previous round's notified belongs to the old lifecycle and must be voided.
  // Single-lifecycle tasks (Bash/Agent) discard their task id after one round, but a late-attaching tracker's
  // register can also land on a claimed (notified:true) terminal entry -- that claim token belongs to the
  // **same** lifecycle, so a blanket reset would re-enqueue one terminal notification. "Defect names
  // irrelevant" means the reachable path (the v4 command path re-arms under the CreateWorkflow name too).
  //
  // outputFile is intentionally **not** reset with the settlement face: workflow runs never write outputFile and
  // existing is passthrough reserved for payload externalization; re-decide it with that feature's semantics.
  const rearm = isDynamicWorkflowRunDispatchToolName(toolCall.name);
  // New life = re-arm on a **terminal** entry. It must go through register(), not update(): register restamps
  // branchGeneration from activeBranchGeneration, while update's {...existing} would carry the previous
  // life's branch generation into the new one -- after cancel -> rewind (generation +1) -> resume, the new
  // life's task events would be dropped wholesale by runtime-command-generation stale-branch fencing
  // (terminal notification lost again). A still-running entry is no new life: keep update's merge and its generation.
  const newLife = rearm && existing !== undefined && isTerminalRuntimeTask(existing);
  const next: RuntimeTaskSnapshot = {
    ...existing,
    agentId: existing?.agentId ?? taskId,
    agentType: existing?.agentType ?? taskType,
    description: existing?.description ?? description,
    isBackgrounded: true,
    outputFile: outputFile ?? existing?.outputFile,
    parentToolCallId: existing?.parentToolCallId ?? toolCall.id,
    startedAt: existing?.startedAt ?? new Date(),
    status: "running",
    taskId,
    taskType,
    type: taskType,
    turnId: existing?.turnId ?? turnId,
    // -- settlement reset (re-arm only = new lifecycle; non-re-arm re-mounts keep the existing settlement) --
    notified: rearm ? false : (existing?.notified ?? false),
    completedAt: rearm ? undefined : existing?.completedAt,
    error: rearm ? undefined : existing?.error,
    exitCode: rearm ? undefined : existing?.exitCode,
    resultText: rearm ? undefined : existing?.resultText,
    pid: rearm ? undefined : existing?.pid,
    // Who stopped the previous round is irrelevant to the new life.
    stopInitiator: rearm ? undefined : existing?.stopInitiator,
  };
  if (existing && !newLife) {
    deps.runtimeTaskRegistry.update(taskId, () => next);
    return;
  }
  // First registration or new life: strip the inherited branchGeneration; register stamps the active one.
  const { branchGeneration: _previousLife, ...fresh } = next;
  deps.runtimeTaskRegistry.register(fresh);
}

export function updateRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot?: BackgroundTaskSnapshot,
): void {
  const taskType = runtimeTaskTypeForToolCall(toolCall);
  if (!taskType || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.update(taskId, (current) => ({
    ...(isTerminalRuntimeTask(current)
      ? current
      : {
          ...current,
          completedAt: runtimeTaskCompletedAt(status, snapshot) ?? current.completedAt,
          description:
            runtimeTaskDescription(toolCall, undefined, snapshot) ?? current.description,
          error: runtimeTaskError(snapshot) ?? current.error,
          exitCode: runtimeTaskExitCode(snapshot) ?? current.exitCode,
          isBackgrounded: true,
          outputFile: backgroundTaskOutputMetadata(snapshot).outputFile ?? current.outputFile,
          pid: runtimeTaskPid(snapshot) ?? current.pid,
          // `?? current.resultText`: undefined must never clear a stored payload (mid-run snapshots
          // and terminals without payload both reach here).
          resultText: runtimeTaskResultText(toolCall, status, snapshot) ?? current.resultText,
          status: normalizeRuntimeTaskStatus(status),
          taskType,
          type: taskType,
        }),
  }));
}

/**
 * Payload text of a workflow run. Taken only from **terminal** snapshots of the dwf dispatch names
 * (CreateWorkflow/ResumeWorkflowRun): the TaskOutput projection sees only the registry entry (dwf never
 * writes outputFile), so a payload missing there is unreachable after restart.
 *
 * legacy `Workflow` deliberately stays out -- its result flows through `output.response` on the existing path, contract unchanged.
 */
function runtimeTaskResultText(
  toolCall: ExecutableToolCall,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (!isDynamicWorkflowRunDispatchToolName(toolCall.name)) return undefined;
  if (status === "running") return undefined;
  if (!snapshot || !("output" in snapshot)) return undefined;
  return serializeWorkflowArtifact(snapshot.output);
}

export function claimRuntimeBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): boolean {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return true;
  let claimed = false;
  const task = deps.runtimeTaskRegistry.update(taskId, (current) => {
    if (current.notified) return current;
    claimed = true;
    return { ...current, notified: true };
  });
  return task === undefined ? true : claimed;
}

export function releaseRuntimeBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): void {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.update(taskId, (current) =>
    current.notified ? { ...current, notified: false } : current,
  );
}

export function removeRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): void {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.remove(taskId);
}

function runtimeTaskTypeForToolCall(toolCall: ExecutableToolCall): RuntimeTaskType | undefined {
  switch (toolCall.name) {
    case "Bash":
      return "local_bash";
    case "Workflow":
      return "local_workflow";
    default:
      // Both dwf entries (CreateWorkflow/ResumeWorkflowRun) share one taskType: without it
      // registerRuntimeBackgroundTask returns early -- losing the recycling guard and TaskOutput visibility.
      return isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? "local_dynamic_workflow"
        : undefined;
  }
}

function defaultRuntimeTaskDescription(taskType: RuntimeTaskType): string {
  switch (taskType) {
    case "local_bash":
      return "Bash background command";
    case "local_workflow":
      return "Workflow background task";
    case "local_dynamic_workflow":
      return "Dynamic workflow run";
    case "local_agent":
      return "Agent background task";
    case "monitor_mcp":
      return "Monitor background task";
  }
}

function normalizeRuntimeTaskStatus(status: string): RuntimeTaskSnapshot["status"] {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
      return "killed";
    case "lost":
      return "lost";
    default:
      return "failed";
  }
}

function runtimeTaskDescription(
  toolCall: ExecutableToolCall,
  output?: Record<string, unknown>,
  snapshot?: BackgroundTaskSnapshot,
): string | undefined {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  if (snapshot && "description" in snapshot && typeof snapshot.description === "string") {
    return snapshot.description;
  }
  if (snapshot && "name" in snapshot && typeof snapshot.name === "string") return snapshot.name;
  if (output && typeof output.name === "string") return output.name;
  if (typeof input.description === "string") return input.description;
  if (typeof input.command === "string") return input.command;
  if (typeof input.name === "string") return input.name;
  if (typeof input.scriptPath === "string") return input.scriptPath;
  return undefined;
}

function runtimeTaskCompletedAt(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): Date | undefined {
  if (status === "running") return undefined;
  return snapshot?.completedAt ?? new Date();
}

function runtimeTaskError(snapshot: BackgroundTaskSnapshot | undefined): string | undefined {
  if (!snapshot || !("error" in snapshot)) return undefined;
  const error = snapshot.error;
  return typeof error === "string" ? error : error?.message;
}

function runtimeTaskExitCode(snapshot: BackgroundTaskSnapshot | undefined): number | undefined {
  if (!snapshot || !("result" in snapshot)) return undefined;
  return snapshot.result?.exitCode;
}

function runtimeTaskPid(snapshot: BackgroundTaskSnapshot | undefined): number | undefined {
  if (!snapshot || !("pid" in snapshot)) return undefined;
  return snapshot.pid;
}
