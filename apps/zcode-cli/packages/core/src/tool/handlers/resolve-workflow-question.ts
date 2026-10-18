// ============================================================
// ResolveWorkflowQuestion Tool Handler
// ============================================================
// The main agent answers a blocking question escalated by an actor inside a **running** workflow. See port DynamicWorkflowRunPort.resolveQuestion.
//
// The handler is deliberately **thin**: qid lookup, driver settlement, dual-track events all live
// port-side. Three things here: take the port (typeof probe, per resume/listRuns), pass qid+answer through,
// project the result into the contract shape.
// Server rejection copy passes through **verbatim**: authored by the registry layer (state + next step);
// discriminator and copy maintained apart would drift, and the reader here is the model -- what it reads
// IS its next step. The three rejection branches only pick a stable errorCode, never rewording.

import {
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  ResolveWorkflowQuestionInputJsonSchema,
  ResolveWorkflowQuestionInputSchema,
  ResolveWorkflowQuestionOutputJsonSchema,
  ResolveWorkflowQuestionOutputSchema,
  type ModelMessageContent,
  type ResolveWorkflowQuestionInput,
  type ResolveWorkflowQuestionOutput,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";

const RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS = 15_000;
/** Output is one confirmation paragraph; 24k is plenty (as in ResumeWorkflowRun). */
const RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES = 24_000;

/**
 * Local failure codes. Numbers are log bits (executor projects errorCode to `code: "N"`); the model reads
 the message, authored server-side per branch. Numbered from 21 to stay visually apart from the
 * the ResumeWorkflowRun table (11-15); three independent number spaces, never compare across tables.
 */
const RESOLVE_WORKFLOW_QUESTION_ERROR_CODE = {
  ANSWERING_UNAVAILABLE: 21,
  UNKNOWN_QUESTION: 22,
  ALREADY_RESOLVED: 23,
  RUN_NOT_IN_FLIGHT: 24,
} as const;

const RESOLVE_WORKFLOW_QUESTION_DESCRIPTION = [
  "Answers a blocking question that a subagent escalated from inside a RUNNING dynamic-workflow run.",
  "",
  "- Takes question_id — the ID from the escalation notification (it looks like `dwfq-...`). If that notification was lost, GetWorkflowRun lists the questions a run still owes an answer to.",
  "- The run keeps running the whole time: only the subagent that asked is parked on its call, while every other subagent and the script's control flow keep going. Your answer becomes that call's result verbatim and the subagent continues from there.",
  "- Answer directly and actionably. If you are not sure, look at the run first with GetWorkflowRun, or ask the user with AskUserQuestion, then come back and answer — nothing answers on your behalf, and the subagent waits indefinitely.",
  "- If the question reveals the SCRIPT is structurally broken (a broken gate, wrong control flow), a sentence cannot fix that: cancel the run and continue with a revised script via CreateWorkflow's `resume_from`.",
].join("\n");

/**
 * "No answer capability in this session". Port absent (no journal -> no run service at all) and method
 absent (stub without resolveQuestion) fail identically: one fact to the model (the resume typeof-probe
 * precedent). Never succeed silently — an actor would wait forever while the model believes it answered.
 */
function resolveQuestionUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.ANSWERING_UNAVAILABLE,
    message:
      "workflow_question_answering_unavailable: this session cannot answer workflow escalations — workflow execution is not available here. This is a capability gap, not a bad question ID.",
  };
}

/** Port reason -> stable error code; message verbatim from the server. */
function resolveQuestionFailureFor(reason: string, message: string): ToolHandlerFailure {
  switch (reason) {
    case "unknown_question":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.UNKNOWN_QUESTION,
        message,
      };
    case "already_resolved":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.ALREADY_RESOLVED,
        message,
      };
    case "run_not_in_flight":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.RUN_NOT_IN_FLIGHT,
        message,
      };
    default:
      // Out-of-contract reason: still a structured failure (throw is the wiring-bug channel); copy keeps the raw word for triage.
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.UNKNOWN_QUESTION,
        message: `${message} (reason: ${reason})`,
      };
  }
}

const resolveWorkflowQuestionHandler: ToolHandler = async (
  input,
  context: ToolExecutionContext,
) => {
  const parsed = ResolveWorkflowQuestionInputSchema.parse(
    input,
  ) as ResolveWorkflowQuestionInput;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.resolveQuestion !== "function") {
    return resolveQuestionUnavailableFailure();
  }

  const result = await port.resolveQuestion(parsed.question_id, parsed.answer);
  if (!result.ok) {
    return resolveQuestionFailureFor(result.reason, result.message);
  }

  return {
    ok: true,
    qid: result.qid,
    // Say two things: the answer was delivered, and the run did not stop -- no need to babysit it.
    response: `Answer delivered for question ${result.qid}. The subagent that asked has resumed its turn with your answer; the run keeps going as before.`,
  } satisfies ResolveWorkflowQuestionOutput;
};

function formatResolveWorkflowQuestionModelContent(output: unknown): ModelMessageContent {
  const parsed = ResolveWorkflowQuestionOutputSchema.safeParse(output);
  if (!parsed.success) return "ResolveWorkflowQuestion returned an invalid result.";
  return parsed.data.response;
}

export const resolveWorkflowQuestionToolEntry: ToolEntry = {
  capability: "Answer a blocking question escalated by a subagent inside a running workflow run",
  metadata: {
    name: RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
    description: RESOLVE_WORKFLOW_QUESTION_DESCRIPTION,
    // Answering sends text into a running actor -- not read-only.
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    maxOutputBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    // No confirm: answering only feeds text into an already-approved run (approved at CreateWorkflow's
 // confirm), same risk class as ResumeWorkflowRun. A dialog would park a waiting actor longer.
    needsApproval: false,
  },
  handler: resolveWorkflowQuestionHandler,
  inputSchema: ResolveWorkflowQuestionInputJsonSchema,
  outputSchema: ResolveWorkflowQuestionOutputJsonSchema,
  runtimeInputSchema: ResolveWorkflowQuestionInputSchema,
  runtimeOutputSchema: ResolveWorkflowQuestionOutputSchema,
  formatModelContent: formatResolveWorkflowQuestionModelContent,
  permission: {
    permission: "resolveWorkflowQuestion",
    reason: "resolveWorkflowQuestion answers a blocked subagent inside a running workflow run",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // question_id joins the pattern-match surface (as run_id in ResumeWorkflowRun).
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    maxModelBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    maxMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "ResolveWorkflowQuestion delivers the answer synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
