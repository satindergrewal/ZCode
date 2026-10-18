// ============================================================
// FillWorkflowHole Tool Handler
// ============================================================
// docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"; engine side see
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。
//
// A running run that reaches a hole pauses that branch and emits a hole notice; this tool is where the model returns the code. It starts
// nothing itself**: splice, compile, site-stability check, engine admission, and draft rewrite are all port-side (`port.fillHole`); here
// does the four things a handler does — write the inline body to the fill file first (before the compile result is read), call the port,
// Anchor diagnostics to the file they land in; on success mint the display from the valid script (CreateWorkflow's projection path).
// Everything before confirmation (run / hole / ownership / body bytes) lives in fill-workflow-hole-resolve.ts.

import path from "node:path";
import {
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  FillWorkflowHoleInputJsonSchema,
  FillWorkflowHoleInputSchema,
  FillWorkflowHoleOutputJsonSchema,
  FillWorkflowHoleOutputSchema,
  SAVED_WORKFLOW_FILE_EXTENSION,
  type CreateWorkflowDiagnostic,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunFillHoleDiagnostic,
  type DynamicWorkflowRunPort,
  type FillWorkflowHoleInput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { resolveTraceContext } from "./create-workflow.js";
import { FILL_WORKFLOW_HOLE_TOOL_DESCRIPTION } from "./fill-workflow-hole-description.js";
import {
  FILL_WORKFLOW_HOLE_ERROR_CODE,
  rememberRejectedFill,
  resolveFillWorkflowHoleInput,
  takeFillPreview,
  validateFillWorkflowHoleSource,
} from "./fill-workflow-hole-resolve.js";
import { boundGraphOfAnalysis, displayOfAnalysis } from "./workflow-analysis-display.js";
import { recordAuthoredWorkflowDraft } from "./workflow-draft-read-state.js";
import { workflowDraftSlug, writeWorkflowDraft } from "./workflow-drafts.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { allScriptModelsBound } from "./workflow-script-models.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

export { FILL_WORKFLOW_HOLE_ERROR_CODE } from "./fill-workflow-hole-resolve.js";

const FILL_WORKFLOW_HOLE_TIMEOUT_MS = 15_000;
const FILL_WORKFLOW_HOLE_MODEL_BYTES = 24_000;

/**
 * "This session cannot fill holes." A missing port (journal unusable -> the whole run service unbuilt) and a missing method (older hosts)
 * return the same failure: to the model it is one thing. Never succeed silently — that would park a script at a hole forever.
 */
function fillUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_UNAVAILABLE,
    message:
      "workflow_fill_unavailable: this session cannot fill workflow holes — workflow execution is not available here. This is a capability gap, not a bad hole id.",
  };
}

/** Port's non-diagnostic rejections -> stable per-case codes; the message comes from the port verbatim (it names the model's next step). */
function fillRefusalFor(reason: string, message: string, runId: string): ToolHandlerFailure {
  switch (reason) {
    case "run_not_found":
      return workflowRunNotFoundFailure(runId);
    case "hole_not_waiting":
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
        message: `hole_not_waiting: ${message}`,
      };
    case "fill_ids_unstable":
      // Host failure, not the model's: the hole keeps waiting; the body need not change.
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.IDS_UNSTABLE,
        message: `fill_ids_unstable: ${message} This is a host fault, not a problem with your body: the hole is still waiting. Report it to the user rather than rewriting the body.`,
      };
    default:
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
        message: `workflow_fill_refused: ${message} (reason: ${reason})`,
      };
  }
}

/** The fill file's model-facing identity: just written by this inline submission ("saved at") or model-supplied ("The fill file is"). */
interface FillFileLocation {
  kind: "draft" | "path";
  described: string;
}

/**
 * The fill file for an inline body: `<slug>.<hole-slug>.dwf.ts` (docs/dynamic-workflow/launch.md "The fill file").
 * `<slug>` is the run draft's stem (draft filename minus extension), or the run name when no draft was recorded; `<hole-slug>` is the
 * hole name through the same naming rule. Same-name suffixes `-2`, `-3`... are writeWorkflowDraft's job: one inline re-submit mints a new file,
 * never overwriting behind the model's back. On failure return `undefined` (best effort, same as drafts).
 */
async function writeFillFile(
  parsed: FillWorkflowHoleInput,
  body: string,
  port: DynamicWorkflowRunPort,
  cwd: string | undefined,
): Promise<string | undefined> {
  const draftPath = parsed.hole?.draft_path;
  let runSlug: string;
  if (draftPath !== undefined) {
    runSlug = path.basename(draftPath, SAVED_WORKFLOW_FILE_EXTENSION);
  } else {
    const snapshot = await port.getTask(parsed.run_id).catch(() => undefined);
    runSlug = workflowDraftSlug(snapshot?.name ?? snapshot?.description ?? "workflow");
  }
  const holeSlug = workflowDraftSlug(parsed.hole?.name ?? parsed.hole_id);
  const written = await writeWorkflowDraft({ cwd, name: `${runSlug}.${holeSlug}`, source: body });
  return written?.path;
}

/**
 * Diagnostic line: `{path}:L{line}:C{column} {message}`, anchored to the file it lands in — inside the body (`inFill`) by the fill
 * file's lines; outside it (e.g. the other 9005 site in the parent script) by the run draft's lines and path, since that is the code it points at.
 * With no anchorable file, fall back to `L:C`.
 */
function formatFillDiagnosticLines(
  diagnostics: readonly DynamicWorkflowRunFillHoleDiagnostic[],
  fillFile: string | undefined,
  draftFile: string | undefined,
): string[] {
  return diagnostics.map((diagnostic) => {
    const anchor = diagnostic.inFill ? fillFile : draftFile;
    const where = `L${diagnostic.line}:C${diagnostic.column}`;
    return `${anchor === undefined ? where : `${anchor}:${where}`} ${diagnostic.message}`;
  });
}

/**
 * The output's `fill` block: the only source of the row naming itself (docs/dynamic-workflow/presentation.md "The fill row").
 * The transcript stores only the model's own input; the `hole` backfilled by resolveInput never reaches the row, so the name must travel with the output;
 * `hole` absent (port stub, normalization-bypassing caller) falls back to the site id, so the row has at least an id.
 */
function fillBlock(parsed: FillWorkflowHoleInput): NonNullable<CreateWorkflowOutput["fill"]> {
  const hole = parsed.hole;
  return {
    siteId: parsed.hole_id,
    name: hole?.name ?? parsed.hole_id,
    ...(hole?.draft_path === undefined ? {} : { draftPath: hole.draft_path }),
    ...(hole?.line === undefined ? {} : { line: hole.line }),
  };
}

function compileFailureResponse(
  parsed: FillWorkflowHoleInput,
  diagnostics: readonly DynamicWorkflowRunFillHoleDiagnostic[],
  fillFile: FillFileLocation | undefined,
  cwd: string | undefined,
): string {
  const lead =
    fillFile === undefined
      ? "The fill could not be saved to a file; fix the body below and resubmit it inline."
      : fillFile.kind === "draft"
        ? `The fill is saved at ${fillFile.described}. Edit that file in place and resubmit with \`path\`; do not paste it inline again.`
        : `The fill file is ${fillFile.described}. Edit that file in place and resubmit with \`path\`.`;
  const draftFile =
    parsed.hole?.draft_path === undefined
      ? undefined
      : describeWorkflowScriptPath(parsed.hole.draft_path, cwd ?? "");
  // Diagnostics outside the body point at the run's **recorded** script: this tool cannot change it, and editing the on-disk draft does not count
  // (first observed 2026-09-28: the main agent fixed the draft and re-submitted, got byte-identical diagnostics, and only then guessed AmendWorkflow).
  // So the way out is spelled out here, saving that round of guessing.
  const outsideFill = diagnostics.some((diagnostic) => diagnostic.inFill !== true);
  const recordedScriptNote = outsideFill
    ? `The lines outside the fill are in the run's recorded script${draftFile === undefined ? "" : ` (${draftFile} as the run launched it)`}: this tool cannot change them, and editing the draft on disk does not change what the fill is compiled into. Fix them with AmendWorkflow (pass the corrected script, or its \`path\`); the revised run will reach the hole and ask again.`
    : undefined;
  return [
    lead,
    "The effective script does not compile:",
    ...formatFillDiagnosticLines(diagnostics, fillFile?.described, draftFile),
    ...(recordedScriptNote === undefined ? [] : [recordedScriptNote]),
    "",
    `NOTE: Nothing was spliced or journaled — hole ${parsed.hole_id} of run ${parsed.run_id} is still waiting for its body.`,
  ].join("\n");
}

const fillWorkflowHoleHandler: ToolHandler = async (input, context: ToolExecutionContext) => {
  const parsed = FillWorkflowHoleInputSchema.parse(input) as FillWorkflowHoleInput;
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.fillHole !== "function") return fillUnavailableFailure();
  // resolveInput always settles the body into `script` (`path` read as bytes); still missing here means a normalization-bypassing caller.
  const body = parsed.script;
  if (body === undefined) {
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.BODY_UNAVAILABLE,
      message:
        "workflow_fill_body_unavailable: the call reached the handler without a resolved body. Pass `script` or `path`. Nothing was filled.",
    } satisfies ToolHandlerFailure;
  }
  const cwd = context.workingDirectory;

  // An inline body is written to disk **before** the compile result is read (docs/dynamic-workflow/launch.md "The fill file"): a body that
  // fails to compile has nowhere else to go; this is its only mandatory stop. A `path` submission mints nothing — that file is already the working copy.
  let fillFile: FillFileLocation | undefined;
  if (parsed.path === undefined) {
    const written = await writeFillFile(parsed, body, port, cwd);
    if (written !== undefined) {
      fillFile = { kind: "draft", described: describeWorkflowScriptPath(written, cwd ?? "") };
      // These bytes are this submission's `script`: record as a file the model wrote, so the next Edit needs no prior Read.
      await recordAuthoredWorkflowDraft(context, {
        path: written,
        source: body,
        toolName: "FillWorkflowHole",
      });
    }
  } else {
    fillFile = { kind: "path", described: describeWorkflowScriptPath(parsed.path, cwd ?? "") };
  }

  const result = await port.fillHole({
    runId: parsed.run_id,
    holeId: parsed.hole_id,
    body,
    parentSessionId: context.sessionId,
    toolCallId: context.toolCallId,
    trace: resolveTraceContext(context),
  });

  if (!result.ok) {
    if (result.reason !== "compile_failed") {
      return fillRefusalFor(result.reason, result.message, parsed.run_id);
    }
    // Record the rejected bytes: the same copy coming back via `path` means the edit was forgotten (`fill_unchanged`).
    rememberRejectedFill(context.sessionId, parsed.run_id, parsed.hole_id, body);
    const diagnostics = result.diagnostics ?? [];
    return {
      fill: fillBlock(parsed),
      diagnostics: diagnostics.map(
        (diagnostic): CreateWorkflowDiagnostic => ({
          code: diagnostic.code,
          column: diagnostic.column,
          line: diagnostic.line,
          message: diagnostic.message,
        }),
      ),
      ok: false,
      response: compileFailureResponse(parsed, diagnostics, fillFile, cwd),
    } satisfies CreateWorkflowOutput;
  }

  // Success: the display is minted from the **valid script** the port returned (body spliced, persisted), via CreateWorkflow's
  // projection path; the run card takes the latest display under the run id (docs/dynamic-workflow/presentation.md "Holes on the timeline").
  const analysis = analyzeScript(result.scriptText);
  const causalityGraph = boundGraphOfAnalysis(analysis);
  const holeName = parsed.hole?.name ?? parsed.hole_id;
  const phases =
    result.phasesAdded.length === 0
      ? "It added no phases."
      : `It added the phase${result.phasesAdded.length === 1 ? "" : "s"} ${result.phasesAdded.join(", ")}.`;
  const draft =
    result.scriptPath === undefined
      ? "The run has no draft file, so a later revision must pass the whole script to AmendWorkflow."
      : `The run's draft ${describeWorkflowScriptPath(result.scriptPath, cwd ?? "")} now holds the effective script: edit that file and pass \`path\` to AmendWorkflow for any later revision.`;
  return {
    fill: fillBlock(parsed),
    diagnostics: [],
    ok: true,
    response: `The fill joined run ${parsed.run_id} at hole "${holeName}" (${parsed.hole_id}); the branch parked there has resumed and the run keeps going in the background. ${phases} ${draft} Do not wait for the run or poll it with TaskOutput; you will be notified when it completes.`,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput;
};

/**
 * Confirm-dialog preview: the valid script's graph (spliced by resolveInput, held in the single slot). Unsplicable still opens the dialog, without the graph;
 * a valid script that fails to compile, or names models outside the run's bindings, passes to the handler — the port returns diagnostics (the latter is 9011);
 * a dialog destined to be voided is meaningless (same rule as AmendWorkflow / CreateWorkflow).
 */
function prepareFillWorkflowHoleApproval(input: unknown): ToolApprovalGate {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.script === undefined) return { gate: "ask" };
  const preview = takeFillPreview(parsed.data.run_id, parsed.data.hole_id, parsed.data.script);
  if (preview === undefined) return { gate: "ask" };
  const analysis = analyzeScript(preview.effectiveScript);
  if (!analysis.ok || !allScriptModelsBound(analysis, preview.modelBindings)) {
    return { gate: "proceed" };
  }
  const display = displayOfAnalysis(analysis, FILL_WORKFLOW_HOLE_TOOL_NAME);
  return { gate: "ask", ...(display ? { display } : {}) };
}

export const fillWorkflowHoleToolEntry: ToolEntry = {
  capability:
    "Supply the body of a hole a running dynamic-workflow run is waiting at, so the parked branch resumes",
  metadata: {
    name: FILL_WORKFLOW_HOLE_TOOL_NAME,
    description: FILL_WORKFLOW_HOLE_TOOL_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    maxOutputBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: fillWorkflowHoleHandler,
  // Exactly-one body source holds for model input only (after normalization, `script` and `path` together is a legal execution state).
  validateInput: (input) => validateFillWorkflowHoleSource(input),
  resolveInput: async (input, context) => {
    // The skill gate precedes run resolution: a fill is always writing script.
    const refused = requireDynamicWorkflowSkill(context, FILL_WORKFLOW_HOLE_TOOL_NAME);
    if (refused) return refused;
    return resolveFillWorkflowHoleInput(input, context);
  },
  prepareApproval: prepareFillWorkflowHoleApproval,
  inputSchema: FillWorkflowHoleInputJsonSchema,
  outputSchema: FillWorkflowHoleOutputJsonSchema,
  runtimeInputSchema: FillWorkflowHoleInputSchema,
  runtimeOutputSchema: FillWorkflowHoleOutputSchema,
  formatModelContent: formatFillWorkflowHoleModelContent,
  permission: {
    permission: "createWorkflow",
    reason:
      "fillWorkflowHole.runConfirmation: user must confirm the body that joins the running script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Same gate as CreateWorkflow / AmendWorkflow (alwaysAsk); the session's own runs pass the always-ask branch via the permission service's owner
    // rule (docs/dynamic-workflow/launch.md "Approval").
    alwaysAsk: true,
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    maxModelBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    maxMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "FillWorkflowHole compiles the effective script synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatFillWorkflowHoleModelContent(output: unknown): ModelMessageContent {
  const parsed = FillWorkflowHoleOutputSchema.safeParse(output);
  if (!parsed.success) return "FillWorkflowHole returned an invalid result.";
  return parsed.data.response;
}
