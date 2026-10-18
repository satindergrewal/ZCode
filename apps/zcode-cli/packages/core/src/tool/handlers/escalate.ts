// ============================================================
// escalate Tool Handler
// ============================================================
// Workflow actors (child AgentRuntime) use it to escalate a **truly blocking** question to the main agent that
// created the workflow, parking inside this ask until the answer. Handler hands the question to the injected
// WorkflowEscalatePort and blocks on the outcome:
//   - answered -> returns the main agent's answer text; the actor turn continues in place, ask settles normally.
//   - refused  -> returns the port-authored copy (budget exhausted / no ask in flight).
// Both branches are **plain tool results**, not ToolHandlerFailure -- unlike submit_result's reject:
// an error tool_result there is a repair channel (model should retry); here nothing is repairable, and
// rendering "escalation budget exhausted" as an error just makes the model ram the same wall -- exactly
// the speculative-bypass behavior this feature exists to prevent.
//
// Port absent still throws ConfigurationError (as in submit_result): registered only in port-injected actor
// sessions; reaching here is a wiring bug, not an outcome.
import {
  CoreErrorType,
  ESCALATE_TOOL_NAME,
  EscalateInputJsonSchema,
  EscalateInputSchema,
  EscalateOutputJsonSchema,
  EscalateOutputSchema,
  createCoreError,
  type EscalateInput,
  type EscalateOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/** The answer may be a full paragraph; same model-face cap as submit_result. */
const MAX_ESCALATE_MODEL_BYTES = 16_000;

/**
 * The tool description is the actor-side discipline of use, which matters more than the mechanism:
 * the mechanism only enables asking; discipline makes it ask when right. Four constraints in the copy:
 last resort (not curiosity), one question at a time, blocking may take long, per-ask cap 3.
 */
const ESCALATE_DESCRIPTION = [
  "Escalates a question that is BLOCKING you to the main agent that created this workflow, and waits here for the answer.",
  "",
  "This is a LAST RESORT, for when you are genuinely stuck on something outside your reach:",
  "- a gate that is broken or impossible to pass (a check capped at 95 when the threshold is 96);",
  "- instructions that contradict each other, so no output can satisfy both;",
  "- a fact you cannot obtain (a tradeoff, an external convention, what 'good' means here) that only whoever started this run knows.",
  "",
  "Do NOT use it for curiosity, progress reports, asking permission, confirming a conclusion you could verify yourself, or thinking out loud. None of those are blocked — keep working.",
  "",
  "Ask ONE focused question that can be answered in a sentence, and put your evidence in `context`: what you already tried, and exactly where you are stuck. The quality of the answer depends on it.",
  "",
  "The cost: this call BLOCKS until the main agent answers, which may take a long time. You get at most 3 escalations per ask; the 4th tells you the budget is spent and to proceed on your own best judgement. Do not spend them on questions not worth waiting for.",
].join("\n");

const escalateHandler: ToolHandler = async (input, context) => {
  const parsed = EscalateInputSchema.parse(input) as EscalateInput;

  // Same gate as submit_result: port presence, regardless of runtimeScope/taskType.
  if (!context.workflowEscalatePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Workflow escalate port is not configured for escalate",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: ESCALATE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const outcome = await context.workflowEscalatePort.escalate({
    toolCallId: context.toolCallId,
    question: parsed.question,
    ...(parsed.context === undefined ? {} : { context: parsed.context }),
    trace: resolveToolTraceContext(context),
  });

  if (outcome.kind === "answered") {
    return {
      status: "answered",
      message: outcome.answer,
      qid: outcome.qid,
    } satisfies EscalateOutput;
  }

  // Rejection copy is authored by the port (state + next step) and passed through verbatim -- keeping the
 // discriminator and the copy apart; they would drift, and the reader here is the model.
  return {
    status: "refused",
    message: outcome.message,
    reason: outcome.reason,
  } satisfies EscalateOutput;
};

export const escalateToolEntry: ToolEntry = {
  capability: "Escalate a blocking question from a workflow subagent to the main agent and wait",
  metadata: {
    name: ESCALATE_TOOL_NAME,
    description: ESCALATE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    // Deliberately unlike submit_result: escalate is NOT a terminal tool. It ends no turn and excludes no
 // sibling -- the pause covers this call, not the whole actor.
    concurrentSafe: true,
    maxOutputBytes: MAX_ESCALATE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: escalateHandler,
  formatModelContent: formatEscalateModelContent,
  inputSchema: EscalateInputJsonSchema,
  outputSchema: EscalateOutputJsonSchema,
  runtimeInputSchema: EscalateInputSchema,
  runtimeOutputSchema: EscalateOutputSchema,
  permission: {
    permission: "workflow.escalate",
    reason: "escalate asks the main agent a blocking question from inside a workflow run",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_ESCALATE_MODEL_BYTES,
    maxModelBytes: MAX_ESCALATE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_ESCALATE_MODEL_BYTES,
      direction: "head",
    },
  },
  // The wait is unbounded by design (no timeout -- "decide yourself after timeout" reintroduces speculative
 // bypass). The escape hatch is the existing cancel: the driver's cancelAsk rejects the parked escalation too.
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "escalate was cancelled before the main agent answered",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** The model sees one text: the answer, or the refusal copy. Discriminants never reach the model face. */
function formatEscalateModelContent(output: unknown): string {
  const parsed = EscalateOutputSchema.safeParse(output);
  if (!parsed.success) return "escalate returned an invalid result.";
  return parsed.data.message;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
