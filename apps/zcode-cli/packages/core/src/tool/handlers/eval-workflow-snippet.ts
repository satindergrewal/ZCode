// ============================================================
// EvalWorkflowSnippet Tool Handler
// ============================================================
// The experimental channel for dynamic-workflow authoring: synchronously compile and run a
// scratch-facade snippet, handed to the bootstrap execution plane via `DynamicWorkflowSnippetPort`.
// Fully transient: no background task, no persistence. The confirmation gate lands only on snippets carrying world.run commands
// （prepareApproval）。
//
// Two paths, decided by whether the port is injected:
//   1. Port present (production wiring): compile + run, returning {ok, diagnostics, logs, response}.
//   2. Port absent (unwired hosts, unit tests): an honest failure — never pretend it ran.

import {
  EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS,
  EVAL_WORKFLOW_SNIPPET_SOURCE_ERROR,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  EvalWorkflowSnippetInputJsonSchema,
  EvalWorkflowSnippetInputSchema,
  EvalWorkflowSnippetOutputJsonSchema,
  EvalWorkflowSnippetOutputSchema,
  serializeWorkflowArtifact,
  type EvalWorkflowSnippetInput,
  type EvalWorkflowSnippetOutput,
  type ModelMessageContent,
  type TraceContext,
} from "@zcode/contracts";
import {
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  SNIPPET_FACADE_DTS,
} from "@zcode/dynamic-workflow";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolInputResolutionResult,
  ToolInputValidationResult,
} from "../types.js";
import { EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION } from "./eval-workflow-snippet-description.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";
import { formatWorkflowDiagnosticLines } from "./workflow-script-notes.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

// The tool-level timeout is the **outer backstop**, not the snippet wall clock: input timeoutMs (≤600s) makes the harness
// kill the child on expiry and return a normal failure; slack here covers compile and teardown. Dual-clock semantics are deliberately absent —
// the inner timer always fires first on the happy path.
const EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS = 660_000;
const EVAL_WORKFLOW_SNIPPET_MODEL_BYTES = 24_000;

const NOT_EXECUTED_NOTE = "NOTE: The snippet was NOT executed — fix the errors above and call the tool again.";
const UNAVAILABLE_NOTE =
  "NOTE: The snippet was NOT executed — snippet evaluation is not available in this session.";

const EVAL_WORKFLOW_SNIPPET_FAILURE_CODE = 400;

/**
 * Either-or sources holds for **model-emitted** input only: post-normalization, coexisting `code` and `path` is a legal execution state
 * (same reason as `CreateWorkflow`; see create-workflow-source.ts).
 */
function validateEvalWorkflowSnippetInput(input: unknown): ToolInputValidationResult {
  const parsed = EvalWorkflowSnippetInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  const hasCode = parsed.data.code !== undefined;
  const hasPath = parsed.data.path !== undefined;
  if (hasCode === hasPath) {
    return {
      result: false,
      errorCode: EVAL_WORKFLOW_SNIPPET_FAILURE_CODE,
      message: EVAL_WORKFLOW_SNIPPET_SOURCE_ERROR,
    };
  }
  return { result: true };
}

/**
 * The path source normalizes into `code`. The whole file is the snippet (no metadata-block parsing) and the path is recorded absolute — the gate
 * (`prepareApproval` reads `code` for `world.run` sites) and the handler therefore see the same bytes.
 */
async function resolveEvalWorkflowSnippetInput(
  input: unknown,
  cwd: string,
): Promise<ToolInputResolutionResult> {
  const parsed = EvalWorkflowSnippetInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.path === undefined) return { result: true, input };
  const read = await readWorkflowScriptFile({
    cwd,
    inputPath: parsed.data.path,
    parseFrontmatter: false,
  });
  if (!read.ok) {
    return { result: false, errorCode: EVAL_WORKFLOW_SNIPPET_FAILURE_CODE, message: read.message };
  }
  return {
    result: true,
    input: {
      ...parsed.data,
      code: read.file.source,
      path: read.file.path,
    } satisfies EvalWorkflowSnippetInput,
  };
}

const evalWorkflowSnippetHandler: ToolHandler = async (input, context) => {
  const parsed = EvalWorkflowSnippetInputSchema.parse(input) as EvalWorkflowSnippetInput;
  const code = parsed.code;
  if (code === undefined) {
    // Unreachable: validateInput rejects both-missing and resolveInput reads `path` into `code`.
    throw new Error("EvalWorkflowSnippet handler received input without resolved code");
  }
  // With a file, report diagnostics by **file line** (snippets have no metadata block, so the offset is always 0).
  const location =
    parsed.path === undefined
      ? undefined
      : {
          kind: "path" as const,
          described: describeWorkflowScriptPath(parsed.path, context.workingDirectory),
          lineOffset: 0,
        };
  const startedAt = Date.now();

  const port = context.dynamicWorkflowSnippetPort;
  if (port === undefined) {
    // Unwired host: honest degradation (same semantics as CreateWorkflow EXECUTION_UNAVAILABLE).
    return {
      ok: false,
      diagnostics: [],
      logs: [],
      response: UNAVAILABLE_NOTE,
      durationMs: 0,
    } satisfies EvalWorkflowSnippetOutput;
  }

  const result = await port.evalSnippet(
    {
      code,
      cwd: context.workingDirectory,
      timeoutMs: parsed.timeoutMs ?? EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS,
      trace: resolveTraceContext(context),
    },
    { signal: context.abortSignal },
  );
  const durationMs = Math.max(0, Date.now() - startedAt);

  if (result.kind === "diagnostics") {
    return {
      ok: false,
      diagnostics: result.diagnostics,
      logs: [],
      response: [
        "The snippet has errors:",
        ...formatWorkflowDiagnosticLines(result.diagnostics, location),
        "",
        NOT_EXECUTED_NOTE,
      ].join("\n"),
      durationMs,
    } satisfies EvalWorkflowSnippetOutput;
  }

  const logsSection = renderLogs(result.logs, result.logsTruncated);

  if (result.kind === "failed") {
    return {
      ok: false,
      diagnostics: [],
      logs: result.logs,
      response: [
        `The snippet failed (${result.error.code}): ${result.error.message}`,
        ...logsSection,
      ].join("\n"),
      durationMs,
    } satisfies EvalWorkflowSnippetOutput;
  }

  // completed. An `undefined` result means no return value — say so, do not invent an empty object.
  const serialized = serializeWorkflowArtifact(result.artifact);
  return {
    ok: true,
    diagnostics: [],
    logs: result.logs,
    response: [
      `The snippet completed in ${durationMs}ms.`,
      serialized === undefined ? "It returned no value." : `Return value:\n${serialized}`,
      ...logsSection,
    ].join("\n"),
    durationMs,
  } satisfies EvalWorkflowSnippetOutput;
};

/** Logs render into the response (formatModelContent hands over response only; beyond the logs field the model never sees them). */
function renderLogs(logs: string[], truncated: boolean): string[] {
  if (logs.length === 0) return [];
  return [
    "",
    "Logs:",
    ...logs.map((message) => `- ${message}`),
    ...(truncated ? ["- … (logs truncated)"] : []),
  ];
}

/** The port contract requires non-optional trace; compose field-wise, same as the CreateWorkflow handler. */
function resolveTraceContext(context: ToolExecutionContext): TraceContext {
  return (
    context.traceContext ??
    ({
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext)
  );
}

/**
 * The snippet confirmation gate: only a snippet
 * carrying world.run sites is worth an interruption; read-only snippets (files/git + pure computation) pass silently,
 * as do non-compiling ones (the handler returns diagnostics via the port; a dialog for non-compiling code is pointless,
 * the same stance as the CreateWorkflow gate).
 *
 * v1 is a **plain permission ask** (no rich preview): on deployed desktops the display permission schema is .strict(),
 * so new payload kinds make old desktops drop the whole permission.requested event — the gate itself disappears (that class of
 * regression was reproduced in practice). The command set is directly readable from
 * the input code (cmd is a compile-time literal — exactly the readability the literal rule buys).
 *
 * This compile and the port-side compile are two passes (gate in core, execution in bootstrap; ts.Program is not shared across packages);
 * snippets are small, and the second compile buys a gate independent of port presence.
 */
function prepareEvalWorkflowSnippetApproval(input: unknown): ToolApprovalGate {
  const parsed = EvalWorkflowSnippetInputSchema.safeParse(input);
  // Post-normalization `code` must be present (`path` was read into it); absence means a bypassed lifecycle — pass it to the handler.
  if (!parsed.success || parsed.data.code === undefined) return { gate: "proceed" };
  const workflow = createWorkflowProgram(parsed.data.code, { facadeDts: SNIPPET_FACADE_DTS });
  if (collectDiagnostics(workflow.program).length > 0) return { gate: "proceed" };
  const { commands, diagnostics } = collectWorldRunCommands(workflow, collectSites(workflow));
  if (diagnostics.length > 0) return { gate: "proceed" };
  return commands.length > 0 ? { gate: "ask" } : { gate: "proceed" };
}

export const evalWorkflowSnippetToolEntry: ToolEntry = {
  capability:
    "Compile and synchronously run a small dynamic-workflow TypeScript snippet (world reads + pure logic) against the real workflow execution path, fully ephemerally",
  metadata: {
    name: EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
    description: EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION,
    // Once world.run lands, snippets can express effects: readOnly flips, and the gate lives in prepareApproval
    // (ask only when world.run sites are present).
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS,
    maxOutputBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: true,
  },
  prepareApproval: prepareEvalWorkflowSnippetApproval,
  handler: evalWorkflowSnippetHandler,
  // Either-or holds for model input only; `path` is read into `code` by normalization, so gate and handler see the same shape.
  validateInput: (input) => validateEvalWorkflowSnippetInput(input),
  resolveInput: (input, context) =>
    // The skill gate precedes path normalization (handlers/workflow-skill-gate.ts): the snippet language rules live in that skill too.
    requireDynamicWorkflowSkill(context, EVAL_WORKFLOW_SNIPPET_TOOL_NAME) ??
    resolveEvalWorkflowSnippetInput(input, context.workingDirectory ?? "."),
  inputSchema: EvalWorkflowSnippetInputJsonSchema,
  outputSchema: EvalWorkflowSnippetOutputJsonSchema,
  runtimeInputSchema: EvalWorkflowSnippetInputSchema,
  runtimeOutputSchema: EvalWorkflowSnippetOutputSchema,
  formatModelContent: formatEvalWorkflowSnippetModelContent,
  permission: {
    permission: "evalWorkflowSnippet",
    reason:
      "evalWorkflowSnippet.runConfirmation: snippets carrying world.run commands must be confirmed",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: true,
    // Input is code text with no path subject: patterns match by tool name only.
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Standard-permission posture:
    // alwaysAsk belongs to CreateWorkflow alone — a whole-workflow run is load-bearing and expensive, worth overriding every
    // pass-through branch. Snippets are cheap and transient; like Bash they go through the standard pattern/rule flow (always-allow,
    // yolo as usual); prepareApproval still rules read-only and non-compiling
    // snippets back to proceed in the default ask flow; the dialog lands only on snippets that really carry commands.
  },
  resultBudget: {
    maxInlineBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
    maxModelBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS,
    maxMs: EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    // The abort signal reaches the harness and kills the sandbox child (bestEffort: it may already have exited in a teardown race).
    cleanup: "bestEffort",
    userVisibleMessage: "Snippet evaluation cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatEvalWorkflowSnippetModelContent(output: unknown): ModelMessageContent {
  const parsed = EvalWorkflowSnippetOutputSchema.safeParse(output);
  if (!parsed.success) return "EvalWorkflowSnippet returned an invalid result.";
  return parsed.data.response;
}
