// ============================================================
// ResumeWorkflowRun Tool Handler
// ============================================================
// Resume a stopped dwf run (model-side entry; resumable set = `stopped`, any reason). See the port contract
// `DynamicWorkflowRunPort.resume`（contracts/src/interfaces/dynamic-workflow-run.port.ts）。
//
// The handler is deliberately **thin**: gating (resumable-set test), registry replacement, and
// compileOnce/scriptHash re-validation all live port-side. Three things here: take the port, pass run_id
// through, project into the contract shape. The backgrounded shape routes the executor down
// CreateWorkflow's existing auto-tracking (call-runner -> trackBackgroundTask): snapshot/wait/cancel/notify
// with zero new code.
// No confirm dialog: resume is scriptHash-pinned to the exact script approved at submit -- same risk class
// as the UI Resume button, so the model call runs directly. Interception remains: PreToolUse deny
// (call-runner, pre-execution) and project deny rules. No prepareApproval either: runId cannot be
// validated synchronously; a bad id fails run_not_found after approval anyway -- a dialog would trim nothing.

import {
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunInputJsonSchema,
  ResumeWorkflowRunInputSchema,
  ResumeWorkflowRunOutputJsonSchema,
  ResumeWorkflowRunOutputSchema,
  type ModelMessageContent,
  type ResumeWorkflowRunInput,
  type ResumeWorkflowRunOutput,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

const RESUME_WORKFLOW_RUN_TIMEOUT_MS = 15_000;
/** Like CreateWorkflow: output is one guidance paragraph; 24k is plenty. */
const RESUME_WORKFLOW_RUN_MODEL_BYTES = 24_000;

/**
 * Local failure codes. Numbers never reach the model (executor projects errorCode to `code: "N"`);
 the message prefix is the only discriminant -- number-space ownership documented here:
 *
 *   - `not_found` **reuses the introspection table's** (workflow-run-introspection.ts) RUN_NOT_FOUND code
 and message (same key, same code), so it is not in this table;
 *   - this table's other four codes and the introspection space are **independent; never compare across** --
 numbered from 11 to avoid colloring with introspection (1/2), but the real guard is "numbers are log
 bits; the discriminant is the message prefix".
 * Comment-owned rather than a shared table: an introspection-side ledger would burden a read-only
 * toolset with execution-side failure semantics. */
const RESUME_WORKFLOW_RUN_ERROR_CODE = {
  RESUME_UNAVAILABLE: 11,
  NOT_RESUMABLE: 12,
  ALREADY_RUNNING: 13,
  SCRIPT_MISSING: 14,
  SCRIPT_MISMATCH: 15,
  SUPERSEDED: 16,
  COMPILE_FAILED: 17,
} as const;

const RESUME_WORKFLOW_RUN_DESCRIPTION = [
  "Resumes a dynamic-workflow run whose status is `stopped` — the user cancelled it, you stopped it with TaskStop, a provider-side error stopped it (expired sign-in, model not in the plan, quota cap), or the process that owned it exited (`interrupted`). The run continues under the same run ID: finished steps are replayed from the journal without spending tokens, unfinished steps are dispatched again. The one stopped run that is NOT resumable is a `superseded` one: an AmendWorkflow replaced it, and its successor is the live run.",
  "",
  "- Takes run_id — from CreateWorkflow's or AmendWorkflow's result, from a completion notification, or from GetWorkflowRun / ListWorkflowRuns.",
  "- The resumed run is backgrounded: you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.",
  "- An `errored` run (the script itself failed) is NOT resumable — replaying it would fail the same way. Fix the script and submit it with AmendWorkflow instead. A completed run is not resumable either; a `superseded` run is refused with the successor's ID.",
  "- Stop reason `user` means the user stopped it on purpose: resume it only when the user asks you to; never resume a run the user just cancelled on your own initiative. Reason `model` is your own TaskStop. Reason `provider` means a provider-side error stopped it: resolve the cause with the user first (the stop notification names it), then resume. Reason `interrupted` (the process died) is different: continuing it is usually what the user wants.",
].join("\n");

/**
 * "No resume capability in this session". Port absent (no journal -> no run service) and method absent
 (stub without resume) fail identically -- one fact to the model (the listRuns/getRunDetail typeof-probe
 * probe precedent). Never silent-degrade: the model would wait for a notification that never comes.
 */
function workflowResumeUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.RESUME_UNAVAILABLE,
    message:
      "workflow_resume_unavailable: this session cannot resume workflow runs — workflow execution is not available here. This is a capability gap, not a status problem.",
  };
}

/** Port reason -> structured failure with actionable copy (discriminant: message prefix). */
function resumeFailureFor(reason: string, runId: string, detail?: string): ToolHandlerFailure {
  switch (reason) {
    // A saved script may no longer fit the current facade; on compile failure amend the script first -- no blind replay.
    case "compile_failed":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.COMPILE_FAILED,
        message: `workflow_run_compile_failed: the stored script of run ${runId} no longer compiles against the current workflow facade, so it cannot be replayed as-is. Rewrite it for the current facade and submit it with AmendWorkflow, which keeps the finished work of this run.${detail === undefined ? "" : `\n${detail}`}`,
      };
    case "not_resumable":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.NOT_RESUMABLE,
        message:
          "workflow_run_not_resumable: this run is not in the resumable set — only a `stopped` run can be resumed (any stop reason except `superseded`). An `errored` run needs a corrected script submitted with AmendWorkflow; a completed run has nothing to resume. Check the status with GetWorkflowRun.",
      };
    case "superseded":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SUPERSEDED,
        message: `workflow_run_superseded: run ${runId} was stopped by an AmendWorkflow and superseded; its unfinished work belongs to the successor run (see GetWorkflowRun's <superseded_by>). Read or amend the successor instead of resuming this run.`,
      };
    // already_running gates the **in-flight registry of this run-service instance** (per-app/per-session)
// only: cross-session concurrent resumes of one journal run pass -- existing semantics; copy covers this instance only.
    case "already_running":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.ALREADY_RUNNING,
        message:
          "workflow_run_already_running: this run is already in flight in this session's workflow runtime. Wait for its completion notification instead of resuming it again.",
      };
    case "script_missing":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SCRIPT_MISSING,
        message:
          "workflow_run_script_missing: this run's journal record has no stored script text (it predates script persistence), so there is nothing to re-run. Start a fresh run with CreateWorkflow instead.",
      };
    case "script_mismatch":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SCRIPT_MISMATCH,
        message: `workflow_run_script_mismatch: the stored script hash for run ${runId} no longer matches the stored script text — the journal record was modified by an outside force. Start a fresh run with CreateWorkflow instead.`,
      };
    default:
      // Out-of-contract reason: structured failure, no throw (that is the wiring-bug channel); keep the
 // reserved prefix and put the raw word in the copy for log triage.
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.NOT_RESUMABLE,
        message: `workflow_run_not_resumable: the workflow runtime refused to resume run ${runId} (reason: ${reason}).`,
      };
  }
}

const resumeWorkflowRunHandler: ToolHandler = async (input, context: ToolExecutionContext) => {
  const parsed = ResumeWorkflowRunInputSchema.parse(input) as ResumeWorkflowRunInput;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.resume !== "function") {
    return workflowResumeUnavailableFailure();
  }

  const result = await port.resume(parsed.run_id);
  if (!result.ok) {
    // not_found reuses the introspection tool's run_not_found key (same key, code, and message).
    return result.reason === "not_found"
      ? workflowRunNotFoundFailure(parsed.run_id)
      : resumeFailureFor(result.reason, parsed.run_id, result.message);
  }

  return {
    ok: true,
    runId: result.runId,
    // Copy mirrors CreateWorkflow's backgrounded guidance (create-workflow.ts): give the id, state that it
 // is running, that the result arrives as a notification, and discourage default polling (observed:
 // without that line the model immediately TaskOutput-waits a async run sync).
    response: `The workflow run ${result.runId} has been resumed and is running in the background. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.`,
    status: "backgrounded",
    // backgroundTaskId == runId (same identity as CreateWorkflow's backgrounded output):
 // cancel, TaskOutput query, and terminal notification all share this one key.
    backgroundTaskId: result.runId,
  } satisfies ResumeWorkflowRunOutput;
};

function formatResumeWorkflowRunModelContent(output: unknown): ModelMessageContent {
  const parsed = ResumeWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return "ResumeWorkflowRun returned an invalid result.";
  return parsed.data.response;
}

export const resumeWorkflowRunToolEntry: ToolEntry = {
  capability: "Resume a stopped dynamic-workflow run under the same run ID",
  metadata: {
    name: RESUME_WORKFLOW_RUN_TOOL_NAME,
    description: RESUME_WORKFLOW_RUN_DESCRIPTION,
    // Resume restarts the execution child and actor session (done nodes replay, pending re-dispatch) --
 // same class as CreateWorkflow; read-only does not hold.
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    maxOutputBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    // No confirm: pinned to the same approved script; no dialog.
    needsApproval: false,
  },
  handler: resumeWorkflowRunHandler,
  inputSchema: ResumeWorkflowRunInputJsonSchema,
  outputSchema: ResumeWorkflowRunOutputJsonSchema,
  runtimeInputSchema: ResumeWorkflowRunInputSchema,
  runtimeOutputSchema: ResumeWorkflowRunOutputSchema,
  formatModelContent: formatResumeWorkflowRunModelContent,
  permission: {
    permission: "resumeWorkflowRun",
    reason: "resumeWorkflowRun.runConfirmation: resuming continues executing a stopped workflow run",
    riskLevel: "low",
    sideEffectScope: "none",
    // scriptHash-pinned to the exact script approved at submit; completed nodes pure-replay -- same risk
    // class as the UI button, so the call runs directly. Interception stays: PreToolUse deny (call-runner,
    // pre-execution) and project deny rules (denyPriority:"beforeAsk") as usual.
    //
    needsApproval: false,
    // run_id joins the pattern-match surface (as task_id in TaskOutput) so project rules can scope to a run.
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    maxModelBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    maxMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ResumeWorkflowRun resumes the run synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
