// ============================================================
// submit_result Tool Handler
// ============================================================
// Workflow actors (child AgentRuntime) submit this ask's structured terminal result. Handler hands it to
// the injected WorkflowSubmitPort and blocks on the engine verdict:
 //   - accept -> success output; the executor attaches turnControl to end the turn.
 //   - reject -> ToolHandlerFailure with the violation list; it becomes an error tool_result without
 //     turnControl, the loop continues, and the model retries in-session -- the repair channel.
 // The per-ask schema is not in the tool declaration; it rides the ask epilogue (frozen-tool cache
// invariant). This handler only forwards; schema validation happens engine-side at the port.

import {
  CoreErrorType,
  SUBMIT_RESULT_TOOL_NAME,
  SubmitResultInputJsonSchema,
  SubmitResultInputSchema,
  SubmitResultOutputJsonSchema,
  SubmitResultOutputSchema,
  createCoreError,
  typedSubmitResultInputSchema,
  type JsonSchema,
  type SubmitResultInput,
  type SubmitResultOutput,
  type SubmitViolation,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";

const MAX_SUBMIT_RESULT_MODEL_BYTES = 16_000;

// Violations normalize under this errorCode into the error tool_result's code field.
const SUBMIT_RESULT_REJECTED_ERROR_CODE = 1;

const submitResultHandler: ToolHandler = async (input, context) => {
  const parsed = SubmitResultInputSchema.parse(input) as SubmitResultInput;

  // Gate: workflowSubmitPort is injected only in workflow-actor sessions. Not keyed on runtimeScope -- the
 // workflow actor is taskType "workflow_child" whose runtimeScope is currently "main"; port presence is
// the taskType-independent test.
  if (!context.workflowSubmitPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Workflow submit port is not configured for submit_result",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SUBMIT_RESULT_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const verdict = await context.workflowSubmitPort.respond({
    toolCallId: context.toolCallId,
    result: parsed.result,
    trace: resolveToolTraceContext(context),
  });

  if (verdict.accept) {
    return { status: "accepted" } satisfies SubmitResultOutput;
  }

  // reject: returned as ToolHandlerFailure; call-runner turns it into an error tool_result, the violation
// list survives as modelContent, no turnControl -- loop continues, model repairs in-session.
  return submitResultRejection(verdict.violations);
};

/**
 * submit_result's tool entry. Without schema = the generic declaration (`result` any JSON; per-ask schema
 via the ask epilogue); with schema = the dwf mono subagent's typed declaration (`result` is that actor's
// sole ask-result schema, frozen per actor across asks, cache-prefix safe) plus `strict` eligibility for
// native Anthropic enforcement. Only the provider-visible declaration/description differ: handler,
// permissions, concurrency group, terminal semantics, budget are byte-identical -- engine-side validation is
// the same for both; typing just makes the shape provider-visible (and enforced where supported).
export function createSubmitResultToolEntry(resultSchema?: JsonSchema): ToolEntry {
  const typed = resultSchema !== undefined;
  return {
    capability: "Submit the structured terminal result for a workflow subagent's ask",
    metadata: {
      name: SUBMIT_RESULT_TOOL_NAME,
      description: typed
        ? "Submit the structured result for the current ask. The `result` argument must match this tool's schema."
        : "Submit the structured result for the current ask. The required JSON shape is described in the ask instructions.",
      readOnly: false,
      destructive: false,
      // Payload nature: concurrentSafe:false puts it in its own serial group. When a valid submit
 // (success requests turn end) runs, later-scheduled siblings get the existing synthetic ToolCancelled
// (success requests turn end) runs, later-scheduled siblings get the existing synthetic ToolCancelled
      concurrentSafe: false,
      // Terminal tool: a valid submit (engine accept) is success and must end the actor turn. Declared via
 // metadata so the executor's generic withTerminalToolTurnStop attaches turnControl on the success
// result -- no name-keyed hardcoding, no handler-side stop channel.
      stopTurnOnSuccess: true,
      maxOutputBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      sideEffectScope: "session",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: submitResultHandler,
    formatModelContent: formatSubmitResultModelContent,
    inputSchema: typed ? typedSubmitResultInputSchema(resultSchema) : SubmitResultInputJsonSchema,
    ...(typed ? { strict: true } : {}),
    outputSchema: SubmitResultOutputJsonSchema,
    // Runtime zod validation is the same for both (result any JSON): per-ask shape is validated engine-side
// at the port, returning repairable violations.
    runtimeOutputSchema: SubmitResultOutputSchema,
    permission: {
      permission: "workflow.submitResult",
      reason: "submit_result delivers the subagent's terminal result to the workflow engine",
      riskLevel: "low",
      sideEffectScope: "session",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      maxModelBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      strategy: "truncate",
      preview: {
        maxBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
        direction: "head",
      },
    },
    // Engine verdicts may take arbitrarily long; kind:"none" sets no wall clock -- cancellation aborts the tool call.
    timeout: {
      kind: "none",
    },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "submit_result was cancelled before the engine returned a verdict",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

/** The generic-declaration entry (the one in the built-in tools table). */
export const submitResultToolEntry: ToolEntry = createSubmitResultToolEntry();

function submitResultRejection(violations: readonly SubmitViolation[]): ToolHandlerFailure {
  return {
    result: false,
    errorCode: SUBMIT_RESULT_REJECTED_ERROR_CODE,
    message: formatSubmitViolations(violations),
  };
}

// Violations format matches the dynamic-workflow synthetic side: one per line,
// `<path>: expected <expected>, got <got>`, so the model can fix them one by one.
function formatSubmitViolations(violations: readonly SubmitViolation[]): string {
  const header = "The submitted result does not match the required schema:";
  if (violations.length === 0) {
    return `${header}\n(no details provided)`;
  }
  const lines = violations.map(
    (violation) => `${violation.path}: expected ${violation.expected}, got ${violation.got}`,
  );
  return [header, ...lines].join("\n");
}

function formatSubmitResultModelContent(output: unknown): string {
  const parsed = SubmitResultOutputSchema.safeParse(output);
  if (!parsed.success) return "submit_result returned an invalid result.";
  return "The result was accepted.";
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
