// ============================================================
// ListWorkflowRuns Tool Handler
// ============================================================
// Enumerate workflow runs for this project (= session working directory), across sessions.
//
// The handler is deliberately **thin**: labels, attribution, status synthesis, timestamps all arrive
// pre-cooked from the run service (the port's DynamicWorkflowRunListItem comment explains why raw facts
// stay behind the boundary). Three things happen here: take the port, pin cwd to this session's dir,
// project the result into the contract shape.
import {
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsInputJsonSchema,
  ListWorkflowRunsInputSchema,
  ListWorkflowRunsOutputJsonSchema,
  ListWorkflowRunsOutputSchema,
  type ListWorkflowRunsInput,
  type ListWorkflowRunsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  formatWorkflowRunTimestamp,
  workflowIntrospectionUnavailableFailure,
  workflowRunAttribute,
} from "./workflow-run-introspection.js";

const LIST_WORKFLOW_RUNS_TIMEOUT_MS = 10_000;
/** Like CreateWorkflow: the list stays light (one SQL row count answers); 24k fits 50 rows with headroom. */
const LIST_WORKFLOW_RUNS_MODEL_BYTES = 24_000;

const LIST_WORKFLOW_RUNS_DESCRIPTION = [
  "Lists this project's dynamic-workflow runs (the session's working directory is the project key), most recently updated first. Includes runs started by other sessions — the run journal is per-project, not per-session.",
  "",
  WORKFLOW_RUN_INTROSPECTION_STEERING,
  "",
  "- Each row gives the run ID, its label, lifecycle status, whether this session started it, tokens spent, and timestamps.",
  '- `possibly_interrupted="true"` means this session cannot confirm the run is still alive: it may be a leftover from a process that exited, or a sibling session\'s run still in flight. It is an annotation, not a verdict — do not report it as a failure.',
  "- Pass a run ID to GetWorkflowRun for progress detail, the log tail, the final result, or the failure.",
  "- Three terminal states: `completed`; `errored` (the script itself failed); `stopped` with `stop_reason` — `user` (cancelled on purpose: resume only when the user asks), `model` (your own TaskStop), `provider` (a provider-side error stopped it: read GetWorkflowRun for the cause, resolve it with the user, then resume), `interrupted` (the owning process exited: continuing it is usually what the user wants), `superseded` (an AmendWorkflow replaced it; `superseded_by` names the live successor — never resume a superseded run).",
  "- Any stopped run other than a superseded one can be continued with ResumeWorkflowRun — no rebuild needed, same run ID, same script. An errored run cannot.",
  "- ANY run here — completed, stopped, errored, or still running — can instead be revised with AmendWorkflow: pass its run ID and the corrected script; the new run imports the old one's finished work as a warm cache (and stops it first if it is still running). A run whose script errored is the case to reach for it — fix the script instead of rewriting the workflow from scratch. `resumed_from` on a row names the run it was amended from.",
].join("\n");

const listWorkflowRunsHandler: ToolHandler = async (input, context) => {
  const parsed = ListWorkflowRunsInputSchema.parse(input) as ListWorkflowRunsInput;

  const port = context.dynamicWorkflowRunPort;
  // "Port absent" and "port present, method absent" yield one business failure: to the model it is the
// same fact. Optional members probed via typeof (precedent: `cancel` in the port contract).
  if (port === undefined || typeof port.listRuns !== "function") {
    return workflowIntrospectionUnavailableFailure();
  }

  const result = await port.listRuns({
    // cwd is always this session's working directory: no cross-project scans; also the precondition of
// `sideEffectScope: "none"`. Literal-equality match, no path normalization -- written raw, queried raw;
// normalizing would create one-sided misses.
    // The limit is clamped to [1, 50] by the input schema (preprocess); the port never sees an unbounded scan.
    limit: parsed.limit,
    ...(parsed.statuses === undefined ? {} : { statuses: parsed.statuses }),
  });

  return {
    runs: result.runs.map((item) => ({
      runId: item.runId,
      label: item.label,
      labelSource: item.labelSource,
      status: item.status,
      ...(item.stopReason === undefined ? {} : { stopReason: item.stopReason }),
      ...(item.resumedFrom === undefined ? {} : { resumedFrom: item.resumedFrom }),
      ...(item.supersededBy === undefined ? {} : { supersededBy: item.supersededBy }),
      ownedByThisSession: item.ownedByThisSession,
      // Present only when true: `false` would hang a noise field on every row.
      ...(item.possiblyInterrupted ? { possiblyInterrupted: true } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      spentTokens: item.spentTokens,
    })),
    ...(result.truncated ? { truncated: true } : {}),
  } satisfies ListWorkflowRunsOutput;
};

/**
 * Model face: one XML-ish container, **one run per row**.
 *
 * Why not TaskOutput-style per-field elements: that is the single-object detail shape; 50 rows x 8 elements
 turns one list into hundreds of lines nearing the 24k budget at unchanged density. The attribute-per-row
 style keeps the same XML-ish tag convention (the model parses it reliably) while 50 rows stay 50 rows.
 */
function formatListWorkflowRunsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListWorkflowRunsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListWorkflowRuns returned an invalid result.";

  const { runs, truncated } = parsed.data;
  const header = [
    workflowRunAttribute("count", runs.length),
    ...(truncated ? [workflowRunAttribute("truncated", true)] : []),
  ].join(" ");

  if (runs.length === 0) {
    // "No workflow ever ran in this project" must be one sentence: an empty container reads as tool failure.
    return `<workflow_runs ${header}>\nNo workflow runs recorded for this project.\n</workflow_runs>`;
  }

  const rows = runs.map((run) =>
    [
      "<run",
      workflowRunAttribute("id", run.runId),
      workflowRunAttribute("status", run.status),
      ...(run.stopReason === undefined
        ? []
        : [workflowRunAttribute("stop_reason", run.stopReason)]),
      ...(run.resumedFrom === undefined
        ? []
        : [workflowRunAttribute("resumed_from", run.resumedFrom)]),
      ...(run.supersededBy === undefined
        ? []
        : [workflowRunAttribute("superseded_by", run.supersededBy)]),
      workflowRunAttribute("label", run.label),
      workflowRunAttribute("label_source", run.labelSource),
      workflowRunAttribute("owned_by_this_session", run.ownedByThisSession),
      ...(run.possiblyInterrupted ? [workflowRunAttribute("possibly_interrupted", true)] : []),
      workflowRunAttribute("spent_tokens", run.spentTokens),
      workflowRunAttribute("created_at", formatWorkflowRunTimestamp(run.createdAt)),
      workflowRunAttribute("updated_at", formatWorkflowRunTimestamp(run.updatedAt)),
      "/>",
    ].join(" "),
  );

  return [`<workflow_runs ${header}>`, ...rows, "</workflow_runs>"].join("\n");
}

export const listWorkflowRunsToolEntry: ToolEntry = {
  capability: "List this project's dynamic-workflow runs, including runs from other sessions",
  metadata: {
    name: LIST_WORKFLOW_RUNS_TOOL_NAME,
    description: LIST_WORKFLOW_RUNS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    maxOutputBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listWorkflowRunsHandler,
  inputSchema: ListWorkflowRunsInputJsonSchema,
  outputSchema: ListWorkflowRunsOutputJsonSchema,
  runtimeInputSchema: ListWorkflowRunsInputSchema,
  runtimeOutputSchema: ListWorkflowRunsOutputSchema,
  formatModelContent: formatListWorkflowRunsModelContent,
  permission: {
    permission: "listWorkflowRuns",
    reason: "ListWorkflowRuns reads the run journal for the current project",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // No path subject in the input (cwd from session context): the pattern matches by tool name only.
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Deliberately NOT inheriting CreateWorkflow's alwaysAsk: that gate exists for "runs a block of code";
// reading state is not that.
  },
  resultBudget: {
    maxInlineBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    maxModelBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_WORKFLOW_RUNS_MODEL_BYTES,
      // head: most recently updated first; tail-cut drops the oldest.
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    maxMs: LIST_WORKFLOW_RUNS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ListWorkflowRuns reads the run journal synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
