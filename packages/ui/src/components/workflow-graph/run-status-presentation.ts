import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

/**
 * Every shape and color of the status dot. Consumers bring their own size and
 * `rounded-full`; this only supplies the shape differences (pulse / solid / halo / empty
 * ring) and colors. Shared by the timeline station lights, sidebar lists, the run
 * directory, and the task list — one feature, one way to draw "running".
 *
 * running uses warning (the activity color) rather than primary: primary inverts across
 * themes (near-black in light mode) and reads as "emphasis", not "moving"; activity
 * colors are reserved for things actually moving (lights, marching dashes, spinners).
 */
export const STATUS_DOT: Record<StepRunStatus, string> = {
  done: "bg-success",
  failed: "bg-destructive ring-2 ring-destructive/30",
  pending: "border-[1.5px] border-foreground-subtlest bg-transparent",
  running: "animate-pulse bg-warning motion-reduce:animate-none",
};

/**
 * Empty-ring dot for the compile-feedback row. Same empty-ring shape as "compiled" and
 * stations waiting to start: nothing has run. Color only says whether attention is still
 * open — `open` is the lineage's latest draft (loop alive, or the model stopped there);
 * `settled` is a draft superseded by a newer one. Never destructive: in this feature red
 * belongs to errored runs only.
 */
export const DRAFT_FEEDBACK_DOT = {
  open: "border-[1.5px] border-warning bg-transparent",
  settled: STATUS_DOT.pending,
} as const;

/**
 * Visual vocabulary for the run's **overall** status (five values), derived from the
 * four-value `STATUS_DOT` (terminal = completed / errored / stopped).
 * `stopped` takes the neutral color, not destructive: stopping (user cancel, process
 * death, model-side error) is a recoverable state, not a script fault; only `errored`
 * is destructive.
 */
export const RUN_STATUS_DOT: Record<WorkflowRunState["status"], string> = {
  pending: STATUS_DOT.pending,
  running: STATUS_DOT.running,
  completed: STATUS_DOT.done,
  errored: STATUS_DOT.failed,
  stopped: STATUS_DOT.pending,
};

/** Semantic color of the status word. Same judgments as the dot, on the text channel (status always has a word, never color alone). */
export const RUN_STATUS_TEXT: Record<WorkflowRunState["status"], string> = {
  pending: "text-foreground-subtle",
  running: "text-warning",
  completed: "text-success",
  errored: "text-destructive",
  stopped: "text-foreground-subtle",
};

/**
 * Reason words for `stopped` (reuse of the canceled presentation + one reason line). The
 * read-side object may be a projected run, a discovery-query summary, or a tool-card
 * display — three schemas evolving in different protocol layers — so this reads one
 * optional key structurally instead of binding to one type.
 */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  // Stopped and replaced by an AmendWorkflow:
  // the light stays stopped's neutral empty ring; the word and the link to the successor differ.
  "superseded",
] as const;
export type WorkflowRunStopReason = (typeof WORKFLOW_RUN_STOP_REASONS)[number];

export function readWorkflowRunStopReason(run: {
  status?: string;
  stopReason?: unknown;
}): WorkflowRunStopReason | undefined {
  if (run.status !== "stopped") return undefined;
  const reason = run.stopReason;
  return typeof reason === "string" &&
    (WORKFLOW_RUN_STOP_REASONS as readonly string[]).includes(reason)
    ? (reason as WorkflowRunStopReason)
    : undefined;
}

/** i18n keys of the reason words (`chat.toolCall.workflow.run.stopReason.*`). */
export function workflowRunStopReasonMessageId(reason: WorkflowRunStopReason): string {
  return `chat.toolCall.workflow.run.stopReason.${reason}`;
}

/** Whether a revision stopped and replaced the run: cards and the detail page switch the kind word, hide Resume, and link to the successor. */
export function isWorkflowRunSuperseded(run: { status?: string; stopReason?: unknown }): boolean {
  return readWorkflowRunStopReason(run) === "superseded";
}
