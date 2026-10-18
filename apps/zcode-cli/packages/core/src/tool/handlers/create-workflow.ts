// ============================================================
// CreateWorkflow Tool Handler
// ============================================================
// Typechecks a dynamic-workflow script against the facade, and — once the user has
// confirmed at the gate — starts the run in the background through
// `DynamicWorkflowRunPort`.
//
// Two paths, decided by whether the port is injected:
//   1. Port present (production wiring): clean compile + Allow → port.submit → output
//      {status:"backgrounded", backgroundTaskId: runId}; the result returns to the main agent via the background-notification pipeline.
//   2. Port absent (unwired hosts, unit tests): keep the pre-wiring placeholder behavior — return diagnostics and the causality graph, execute nothing.
//
// The broken-script path is port-independent and unchanged: `prepareApproval` waives the dialog, the handler returns diagnostics directly,
// and no run starts (approving non-compiling code would only interrupt the agent own
// fix-retry loop).

import {
  CreateWorkflowInputJsonSchema,
  CreateWorkflowInputSchema,
  CreateWorkflowOutputJsonSchema,
  CreateWorkflowOutputSchema,
  type CreateWorkflowInput,
  type CreateWorkflowOutput,
  type ModelMessageContent,
  type TraceContext,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
} from "@zcode/contracts";
import type { ToolApprovalGate, ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { CREATE_WORKFLOW_TOOL_DESCRIPTION } from "./create-workflow-description.js";
import {
  resolveCreateWorkflowInput,
  validateCreateWorkflowSource,
} from "./create-workflow-source.js";
import { describeWorkflowSubagentModel, parseWorkflowSubagentModel } from "./model-reference.js";
import { boundGraphOfAnalysis, displayOfAnalysis } from "./workflow-analysis-display.js";
import { recordAuthoredWorkflowDraft } from "./workflow-draft-read-state.js";
import { resolveWorkflowDraftName, writeWorkflowDraft } from "./workflow-drafts.js";
import {
  formatWorkflowDiagnosticLines,
  workflowLaunchedScriptSentence,
  workflowSavedDraftNote,
  workflowScriptFileNote,
  type WorkflowScriptLocation,
} from "./workflow-script-notes.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { createWorkflowNeedsSkill, requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";
const CREATE_WORKFLOW_TIMEOUT_MS = 15_000;
const CREATE_WORKFLOW_MODEL_BYTES = 24_000;

// The not-executed NOTE is split per path, each saying only what holds there. The old merged-constant form
// (PLACEHOLDER_HINT) made both claims lies once the engine was wired: it said execution was still in development and the tool only
// type-checked, while clean script plus port present long since started real background runs. The text only reader is the model; a lie costs
// a skipped or duplicated submission.
export const DIAGNOSTICS_NOT_EXECUTED_NOTE =
  "NOTE: The workflow was NOT executed — fix the errors above and resubmit.";
export const EXECUTION_UNAVAILABLE_NOTE =
  "NOTE: The workflow was NOT executed — workflow execution is not available in this session, so the script was only typechecked.";

const createWorkflowHandler: ToolHandler = async (input, context) => {
  // Input is normalizeOutput by resolveInput by here: `script` always present, both sources identical from here on.
  // `saved` is provenance only (run-label fallback and arg persistence read it); execution never reads a byte of it — so
  // a hook rewriting `saved` after normalization is **deliberately inert**: it cannot change what will run.
  const parsed = CreateWorkflowInputSchema.parse(input) as CreateWorkflowInput;
  const script = parsed.script;
  if (script === undefined) {
    // Unreachable: validateInput rejects both-missing and resolveInput fills saved from script.
    // If it happens, someone bypassed the executor lifecycle; saying so beats silently running an empty script.
    throw new Error("CreateWorkflow handler received input without a resolved script");
  }
  const saved = parsed.saved;
  const cwd = context.workingDirectory;

  const analysis = analyzeScript(script);
  const { diagnostics, ok } = analysis;
  // Confirmation dialog and persisted output read the same static analysis: no model call renames anything in between.
  const causalityGraph = boundGraphOfAnalysis(analysis);

  // The inline script working copy is written to disk **regardless of compile result**:
  // a non-compiling script never reaches the dialog and the handler is its only mandatory stop; not writing it means the one file needing an edit
  // has no file at all. The analysis runs first only for naming: without `name` the filename takes the first phase name, and phase names
  // live in the graph. The saved-source copy was already written in resolveInput; the path source writes none.
  const inlineDraft =
    saved === undefined && parsed.path === undefined
      ? await writeWorkflowDraft({
          cwd,
          name: resolveWorkflowDraftName(parsed.name, causalityGraph),
          source: script,
        })
      : undefined;
  // This draft bytes are this call `script`: record it as a file the model wrote so the next Edit needs no prior Read.
  if (inlineDraft !== undefined) {
    await recordAuthoredWorkflowDraft(context, {
      path: inlineDraft.path,
      source: script,
      toolName: "CreateWorkflow",
    });
  }
  const location = describeScriptLocation(parsed, inlineDraft?.path, cwd);

  if (!ok) {
    return {
      diagnostics,
      ok,
      response: [
        // A saved definition failing to compile is **its** problem, not this call input; without naming the file the model
        // assumes it just mistyped something and retries verbatim.
        saved === undefined
          ? "The workflow script has errors:"
          : `The saved workflow '${saved.name}'${saved.path === undefined ? "" : ` (${saved.path})`} has errors:`,
        // With a file, report by **file line** (numbers must paste straight into an `Edit`); the output `diagnostics` array
        // keeps body lines unchanged — the transcript renders the body.
        ...formatWorkflowDiagnosticLines(diagnostics, location),
        "",
        diagnosticsNote(parsed, location, cwd),
      ].join("\n"),
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    // Unwired host: keep placeholder semantics. Deliberately not degraded into pretend-started — the model would wait for a notification that never comes.
    return {
      diagnostics,
      ok,
      response: `The workflow script compiled cleanly.\n\n${EXECUTION_UNAVAILABLE_NOTE}`,
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }

  // What the run records is always an **absolute path**: part of the run identity, while the session cwd changes. The model-facing spelling
  // is `location.described` job (another spelling of the same absolute path, not a second source).
  const scriptPath = resolveSubmittedScriptPath(parsed, inlineDraft?.path);

  // Submit failures (corrupt artifact, unavailable journal) bubble up as tool-call failures: never swallow them into a success output carrying a
  // backgroundTaskId — that sends the background tracker polling a run that does not exist.
  const submitted = await port.submit(
    {
      scriptText: script,
      cwd: context.workingDirectory,
      // The optional display name must reach dwf_run.name (submit → EngineConfig → createRun), not stop at
      // the tool-row/task-title fallback chain — or cross-session enumeration shows bare runIds.
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      // Args ride the exact metadata path as name / scriptText / cwd: submit → EngineConfig →
      // createRun writes dwf_run.args_json → sandbox injection. Inline runs have no args; the field is absent,
      // and the sandbox reads absence as `{}` (invariant 7: `args` always defined).
      // Each source has its own slot: saved in `saved.args`, path in top-level `args` (spelled exactly
      // that way in the model face); they never coexist (`validateInput` ties `args` to `path`).
      ...(() => {
        const args = parsed.args ?? saved?.args;
        return args === undefined ? {} : { args };
      })(),
      parentSessionId: context.sessionId,
      toolCallId: context.toolCallId,
      // The declared phase table rides the submission into run-launched; the sidebar mini-track draws sites from it. The running-now table shares
      // its source and rows: indexes point into one table; counting apart drifts.
      ...(() => {
        const phaseNames = createWorkflowPhaseNames(causalityGraph);
        if (phaseNames === undefined) return {};
        const phaseAlongside = createWorkflowPhaseAlongside(causalityGraph);
        return { phaseNames, ...(phaseAlongside === undefined ? {} : { phaseAlongside }) };
      })(),
      // The concurrency cap was clamped into `[1, ceiling]` in resolveInput (the dialog shows the value that will apply);
      // absence means ceiling, so no shell keys.
      ...(parsed.max_concurrency === undefined ? {} : { maxConcurrency: parsed.max_concurrency }),
      // The subagent model was likewise resolved to canonical form in resolveInput (unresolvable calls never reach here),
      // so this only splits that string back into a structured choice. Absence inherits the session model, no shell keys — the port reads
      // field-present as this run explicitly chose a model.
      ...(() => {
        const subagentModel = parseWorkflowSubagentModel(parsed.subagent_model);
        return subagentModel === undefined ? {} : { subagentModel };
      })(),
      // The script home rides the submission into `run-launched`; the terminal notification and `GetWorkflowRun` read it back from there. If the draft cannot be written the field is absent:
      // the port reads field-present as this run having an editable file, and a undefined would turn that into a lie.
      ...(scriptPath === undefined ? {} : { scriptPath }),
      trace: resolveTraceContext(context),
    },
    { signal: context.abortSignal },
  );

  const { runId } = submitted;

  return {
    diagnostics,
    ok,
    // Wording mirrors backgrounded Bash (bash-model-content.ts): give the id, say it is still running,
    // and that results arrive as a notification. The placeholder hint must vanish on this path.
    // A model that takes the backgrounded output and immediately blocks on TaskOutput
    // turns the async run into a synchronous wait — the text must discourage polling by default (when the user explicitly asks to wait,
    // TaskOutput still works; this changes default guidance only, not tool semantics).
    response: `The workflow script compiled cleanly and the run started in the background with ID: ${runId}. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.${describeWorkflowConcurrencyLimit(parsed.max_concurrency, port.concurrencyCeiling?.())}${describeWorkflowSubagentModel(parsed.subagent_model)}${location === undefined ? "" : workflowLaunchedScriptSentence(location)}`,
    status: "backgrounded",
    backgroundTaskId: runId,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput;
};

/**
 * Which file is this run script (absolute path, into the journal on submit): for the path source it is that file,
 * for saved the fresh copy, for inline the fresh draft. All three can be absent (draft unwritable).
 */
function resolveSubmittedScriptPath(
  parsed: CreateWorkflowInput,
  inlineDraft: string | undefined,
): string | undefined {
  if (parsed.path !== undefined) return parsed.path;
  if (parsed.saved !== undefined) return parsed.saved.draft;
  return inlineDraft;
}

/** The script file model-facing identity; absent when there is no file (draft unwritable), wording falling back to the legacy set. */
function describeScriptLocation(
  parsed: CreateWorkflowInput,
  inlineDraft: string | undefined,
  cwd: string,
): WorkflowScriptLocation | undefined {
  const absolute = resolveSubmittedScriptPath(parsed, inlineDraft);
  if (absolute === undefined) return undefined;
  return {
    // For the path source the file was model-provided, not just written — hence the different verb.
    kind: parsed.path === undefined ? "draft" : "path",
    described: describeWorkflowScriptPath(absolute, cwd),
    lineOffset: parsed.script_line_offset ?? 0,
  };
}

/**
 * The NOTE on non-compiling scripts, three ways: saved names the definition it copied, other files name the file,
 * and no-file keeps the pre-change wording (there, re-submitting inline is genuinely the only option).
 */
function diagnosticsNote(
  parsed: CreateWorkflowInput,
  location: WorkflowScriptLocation | undefined,
  cwd: string,
): string {
  const saved = parsed.saved;
  if (location === undefined) {
    return saved === undefined
      ? DIAGNOSTICS_NOT_EXECUTED_NOTE
      : "NOTE: The workflow was NOT executed — the saved file needs fixing (edit it, or save a corrected version).";
  }
  if (saved !== undefined) {
    return workflowSavedDraftNote({
      savedName: saved.name,
      // Give the definition in model-facing spelling too: changing it later goes through `SaveWorkflow`, but one absolute path among
      // workspace-relative ones reads like it lives on another machine.
      savedPath:
        saved.path === undefined ? location.described : describeWorkflowScriptPath(saved.path, cwd),
      draft: location.described,
    });
  }
  return workflowScriptFileNote(location);
}

/**
 * One result-text sentence for the effective concurrency cap (shared with `AmendWorkflow`). **Present only when a cap is set**: a run
 * at the ceiling has nothing to state; an extra at-most-N makes the model believe it set something.
 *
 * Exactly at ceiling, name the machine limit — the requested number was lowered, and unsaid the model takes at-most-32
 * as applied and repeats a false number when the user asks.
 */
export function describeWorkflowConcurrencyLimit(
  limit: number | undefined,
  ceiling: number | undefined,
): string {
  if (limit === undefined) return "";
  const subject = limit === 1 ? "1 subagent runs" : `${limit} subagents run`;
  return ` At most ${subject} at once${limit === ceiling ? " (this machine's maximum)" : ""}.`;
}

/**
 * The port contract requires non-optional `trace` while `context.traceContext` is optional, hence the field-wise composition.
 */
export function resolveTraceContext(context: ToolExecutionContext): TraceContext {
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
 * Decide whether running this script is worth interrupting the user, and build the preview the dialog renders.
 *
 * **One code path for both sources**: input is normalized by `resolveInput` before this runs, `script` always present,
 * so this neither knows nor needs to know whether the script was inline or read from disk. A saved run dialog is thus
 * byte-identical to inline — what the display-identical-across-paths test pins.
 *
 * Two failure shapes pass to the handler without a dialog: schema-invalid input and non-compiling scripts. User-approving
 * non-compiling code only interrupts the agent fix-retry loop with a no-effect decision. (Parse failures
 * are settled earlier in `resolveInput` and never get here.)
 */
function prepareCreateWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };

  const analysis = analyzeScript(parsed.data.script);
  if (!analysis.ok) return { gate: "proceed" };

  // The dialog carries its own title and leads with the graph; its display shares one constructor with the hub-launch turn metadata.
  const display = displayOfAnalysis(analysis);
  return { gate: "ask", ...(display ? { display } : {}) };
}

export const createWorkflowToolEntry: ToolEntry = {
  capability:
    "Typecheck a dynamic-workflow TypeScript script against the facade and, once confirmed, start the run in the background",
  metadata: {
    name: CREATE_WORKFLOW_TOOL_NAME,
    description: CREATE_WORKFLOW_TOOL_DESCRIPTION,
    // Wired, this call starts an executor child and several actor sessions; the read-only claim flips with execution semantics
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CREATE_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: CREATE_WORKFLOW_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: createWorkflowHandler,
  // Either-or holds for model input only (post-normalization coexistence is a legal execution state), so it lives here,
  // not in the schema — see CreateWorkflowInputSchema.
  validateInput: (input) => validateCreateWorkflowSource(input),
  // The single disk read of the whole flow; hooks, permission rules, dialog and handler all see the same bytes.
  // The ceiling is read here too: clamping must precede the dialog, or the user approves a number that will not apply.
  // The model catalog likewise: `subagent_model` must be canonical before the dialog, or the user approves a
  // name not yet recognized, and unresolvable calls fail only after approval.
  resolveInput: (input, context) => {
    // The skill gate precedes all resolution: no dynamic-workflows read, no script submission (saved source excepted; see the gate module).
    if (createWorkflowNeedsSkill(input)) {
      const refused = requireDynamicWorkflowSkill(context, CREATE_WORKFLOW_TOOL_NAME);
      if (refused) return refused;
    }
    return resolveCreateWorkflowInput(
      input,
      context.workingDirectory ?? ".",
      context.dynamicWorkflowRunPort?.concurrencyCeiling?.(),
      context.modelCatalogPort,
    );
  },
  prepareApproval: prepareCreateWorkflowApproval,
  inputSchema: CreateWorkflowInputJsonSchema,
  outputSchema: CreateWorkflowOutputJsonSchema,
  runtimeInputSchema: CreateWorkflowInputSchema,
  runtimeOutputSchema: CreateWorkflowOutputSchema,
  formatModelContent: formatCreateWorkflowModelContent,
  permission: {
    permission: "createWorkflow",
    // For diagnostics, not user-facing: the dialog renders its own localized title and the UI filters internal-sounding reasons.
    reason: "createWorkflow.runConfirmation: user must confirm running the analyzed script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // A workflow is one execution plus model calls; every permission mode (incl. yolo / plan) prompts first.
    alwaysAsk: true,
    // Each-call-a-different-script no longer holds for saved workflows: by name,
    // the same name is the same workflow every time. Yet sameness cannot justify skipping the dialog —
    // it still prompts, for two harder reasons: a run
    // costs money and has real side effects, and the saved file can change any time after approval (hand edits, git pull, other commits),
    // so approved-this-name-before never implies the same code runs now. **Persistent** confirmations are never waived.
    //
    // What is relaxed is **session scope**: after the user approves this session first script,
    // the session can opt into always-allow so later CreateWorkflow calls skip the dialog. The grant lives in
    // the PermissionService instance memory; restart / cold resume / `/new` start from zero.
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: CREATE_WORKFLOW_MODEL_BYTES,
    maxModelBytes: CREATE_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: CREATE_WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: CREATE_WORKFLOW_TIMEOUT_MS,
    maxMs: CREATE_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "CreateWorkflow typechecks synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatCreateWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "CreateWorkflow returned an invalid result.";
  return parsed.data.response;
}
