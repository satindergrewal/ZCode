// ============================================================
// SaveWorkflow Tool Handler
// ============================================================
// Store a dwf script plus metadata as a reusable project definition.
//
// Deliberately isomorphic to CreateWorkflow: for the model these are two verbs over one thing.
//   1. Compile with the **same** checker first. No compile → return diagnostics, no dialog, no write. Having the user
//      approve non-compiling code only interrupts the agent fix-retry loop with a decision that does nothing
//      (same note as create-workflow.ts).
//   2. Clean → confirmation dialog. Writing into the user repo is an irreversible outward act; always ask.
//   3. Allow → write.
//
// The key difference from CreateWorkflow is **what the dialog asks**: there, spend the money to run this code? Here,
// keep this code in the repo, runnable by others later? The facts the answer needs — destination,
// metadata, create-or-overwrite — are computed into the normalized input by `resolveInput`, so this tool
// deliberately carries **no display**: the input channel is an unschemaed passthrough on every client, while new
// display fields are unreadable to old clients and can fail whole-payload validation (see the field-set note in
// tool-result-metadata.ts). New desktops render a rich dialog from input by toolName; `overwrite` tells which;
// old desktops and legacy v3 get the generic prompt plus full input JSON — degraded, content-complete.

import {
  SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
  SAVE_WORKFLOW_SOURCE_ERROR,
  SAVE_WORKFLOW_TOOL_NAME,
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SaveWorkflowInputJsonSchema,
  SaveWorkflowInputSchema,
  SaveWorkflowOutputJsonSchema,
  SaveWorkflowOutputSchema,
  isValidSavedWorkflowName,
  type ModelMessageContent,
  type SaveWorkflowInput,
  type SaveWorkflowOutput,
  type SavedWorkflowMeta,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolHandler,
  ToolInputResolutionResult,
  ToolInputValidationResult,
} from "../types.js";
import { SAVE_WORKFLOW_TOOL_DESCRIPTION } from "./save-workflow-description.js";
import {
  SAVED_WORKFLOW_SENTINEL,
  findSavedWorkflowShadowing,
  savedWorkflowExists,
  savedWorkflowPath,
  savedWorkflowRoot,
  saveSavedWorkflow,
} from "./saved-workflows/index.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

const SAVE_WORKFLOW_TIMEOUT_MS = 15_000;
const SAVE_WORKFLOW_MODEL_BYTES = 24_000;
const SAVE_WORKFLOW_FAILURE_CODE = 400;

const DIAGNOSTICS_NOT_SAVED_NOTE =
  "NOTE: Nothing was saved — fix the errors above and call the tool again.";

/** Metadata view: the three input fields folded into the object frontmatter will write. */
function toMeta(parsed: SaveWorkflowInput): SavedWorkflowMeta {
  return {
    description: parsed.description,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    ...(parsed.args === undefined ? {} : { args: parsed.args }),
  };
}

/**
 * Semantic validation of the model input, settled before hooks.
 *
 * Scripts carrying their own frontmatter are rejected as a business failure — no detect-and-merge cleverness: after a merge
 * the model cannot tell which description wins, and encode idempotence (one
 * frontmatter block per file) loses its guard.
 */
function validateSaveWorkflowInput(input: unknown): ToolInputValidationResult {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };

  if (!isValidSavedWorkflowName(parsed.data.name)) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: `'${parsed.data.name}' is not a usable workflow name: names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters.`,
    };
  }

  const hasScript = parsed.data.script !== undefined;
  const hasScriptPath = parsed.data.script_path !== undefined;
  if (hasScript === hasScriptPath) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: SAVE_WORKFLOW_SOURCE_ERROR,
    };
  }

  // The has-frontmatter check applies to **inline** bodies only: `script_path` often points at a draft copied from
  // a saved definition — block included by construction, and `resolveInput` strips it. Erroring there would ban this path main use.
  if (parsed.data.script?.trimStart().startsWith(SAVED_WORKFLOW_SENTINEL) === true) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
    };
  }

  return { result: true };
}

/**
 * Normalization: compute destination, overwrite decision and shadowing facts into the input.
 *
 * These facts are the dialog decision core (approving an overwrite consents to discarding the disk copy; the shadowing note tells the user
 * whether a same-named entry in the other store shadows this one here); they ride the **input**, not display — the input channel
 * is an unschemaed passthrough on every client, so old desktops and legacy v3 get the full content too, while new
 * display fields are unreadable to them and can fail whole-payload validation.
 *
 * Scope is no longer backfilled: the model must provide it; here it only picks the root for `path` / `overwrite` / `shadowing`.
 */
async function resolveSaveWorkflowInput(
  input: unknown,
  cwd: string,
): Promise<ToolInputResolutionResult> {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };

  // `script_path` is read into the body first: the dialog shows the exact bytes to be written, and it precedes the handler.
  // The block is dropped (body only) — this call fields own the metadata; that is what the user approves.
  let script = parsed.data.script;
  if (parsed.data.script_path !== undefined) {
    const read = await readWorkflowScriptFile({ cwd, inputPath: parsed.data.script_path });
    if (!read.ok) {
      return { result: false, errorCode: SAVE_WORKFLOW_FAILURE_CODE, message: read.message };
    }
    script = read.file.script;
  }

  const { scope, name } = parsed.data;
  const shadowing = findSavedWorkflowShadowing({ cwd, name, scope });
  return {
    result: true,
    input: {
      ...parsed.data,
      ...(script === undefined ? {} : { script }),
      path: savedWorkflowPath(savedWorkflowRoot(cwd, scope), name),
      overwrite: savedWorkflowExists({ cwd, name, scope }),
      // Omit the key when no same-name exists: a undefined hangs a noise field on every save.
      ...(shadowing === undefined ? {} : { shadowing }),
    } satisfies SaveWorkflowInput,
  };
}

const saveWorkflowHandler: ToolHandler = async (input, context) => {
  const parsed = SaveWorkflowInputSchema.parse(input) as SaveWorkflowInput;
  const cwd = context.workingDirectory ?? ".";
  const scope = parsed.scope;
  // Destination comes from normalization; absence means a bypassed executor lifecycle — recompute here rather than crash.
  const path = parsed.path ?? savedWorkflowPath(savedWorkflowRoot(cwd, scope), parsed.name);
  const script = parsed.script;
  if (script === undefined) {
    // Unreachable: validateInput rejects both-missing and resolveInput reads `script_path` into `script`.
    // If it happens, someone bypassed the executor lifecycle; saying so beats silently storing an empty file.
    throw new Error("SaveWorkflow handler received input without a resolved script");
  }

  const { diagnostics, ok } = analyzeScript(script);
  if (!ok) {
    return {
      name: parsed.name,
      scope,
      path,
      diagnostics,
      ok,
      response: [
        "The workflow script has errors:",
        ...diagnostics.map(
          (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
        ),
        "",
        DIAGNOSTICS_NOT_SAVED_NOTE,
      ].join("\n"),
    } satisfies SaveWorkflowOutput;
  }

  // Write failures (read-only mount, permissions) bubble up as tool-call failures: never swallow them into a success naming the path,
  // or the model tells the user it saved.
  //
  // `overwritten` is re-decided at **write time**, not read from the input `overwrite`: that one is for
  // the dialog and hooks, and hooks rewrite input — letting them change the post-write self-report turns a display field
  // into a behavior switch.
  const written = saveSavedWorkflow({
    cwd,
    name: parsed.name,
    meta: toMeta(parsed),
    script,
    scope,
  });

  const isGlobal = written.scope === "global";
  return {
    name: parsed.name,
    scope: written.scope,
    path: written.path,
    diagnostics,
    ok,
    overwritten: written.overwritten,
    response: [
      written.overwritten
        ? isGlobal
          ? `Replaced the saved global workflow '${parsed.name}' at ${written.path}.`
          : `Replaced the saved workflow '${parsed.name}' at ${written.path}.`
        : isGlobal
          ? `Saved global workflow '${parsed.name}' to ${written.path}.`
          : `Saved the workflow '${parsed.name}' to ${written.path}.`,
      `Run it with CreateWorkflow using \`saved: { name: "${parsed.name}" }\`.`,
    ].join(" "),
  } satisfies SaveWorkflowOutput;
};

/**
 * Decide whether writing this script into the repo is worth an interruption.
 *
 * **No display**: everything the dialog shows — script, metadata, destination, overwrite-or-not — already sits in the
 * normalized input. New desktops render the rich dialog via `toolName === "SaveWorkflow"`; old desktops and legacy v3
 * get the generic prompt with full input: degraded, content-complete, and true across **all** version pairs. Adding
 * a new display kind would reach new clients only (see tool-result-metadata.ts).
 *
 * Non-compiling scripts pass to the handler: it returns diagnostics, writes nothing; nothing to decide, no dialog.
 */
function prepareSaveWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  // Post-normalization `script` must exist; absence means a bypassed lifecycle — let the handler error.
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };
  return analyzeScript(parsed.data.script).ok ? { gate: "ask" } : { gate: "proceed" };
}

function formatSaveWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = SaveWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "SaveWorkflow returned an invalid result.";
  return parsed.data.response;
}

export const saveWorkflowToolEntry: ToolEntry = {
  capability:
    "Typecheck a dynamic-workflow script and, once confirmed, save it into the project as a reusable definition",
  metadata: {
    name: SAVE_WORKFLOW_TOOL_NAME,
    description: SAVE_WORKFLOW_TOOL_DESCRIPTION,
    readOnly: false,
    // Overwriting discards the disk copy, but the dialog states that first; same tier as Write.
    destructive: false,
    concurrentSafe: false,
    timeoutMs: SAVE_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: SAVE_WORKFLOW_MODEL_BYTES,
    // Writes a project file — the same scope as Write/Edit.
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: saveWorkflowHandler,
  validateInput: (input) => validateSaveWorkflowInput(input),
  // Destination and overwrite decision go into the input: dialog and hooks read one fact, visible to every client version.
  resolveInput: (input, context) =>
    // Skill gate before destination resolution (handlers/workflow-skill-gate.ts): a save is a script too.
    requireDynamicWorkflowSkill(context, SAVE_WORKFLOW_TOOL_NAME) ??
    resolveSaveWorkflowInput(input, context.workingDirectory ?? "."),
  prepareApproval: prepareSaveWorkflowApproval,
  inputSchema: SaveWorkflowInputJsonSchema,
  outputSchema: SaveWorkflowOutputJsonSchema,
  runtimeInputSchema: SaveWorkflowInputSchema,
  runtimeOutputSchema: SaveWorkflowOutputSchema,
  formatModelContent: formatSaveWorkflowModelContent,
  permission: {
    permission: "saveWorkflow",
    // For diagnostics, not user-facing: the dialog renders its own localized title.
    reason: "saveWorkflow.confirmation: user must confirm writing the workflow into the project",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Same tier as CreateWorkflow: repo content gets committed, seen, re-run —
    // every permission mode (incl. yolo / plan) asks first.
    alwaysAsk: true,
    // Each call writes a different file with different content; persistent project rules cannot remember one-instance decisions,
    // only permanently disable the dialog.
    askOptions: { allowAlways: false },
  },
  resultBudget: {
    maxInlineBytes: SAVE_WORKFLOW_MODEL_BYTES,
    maxModelBytes: SAVE_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: SAVE_WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: SAVE_WORKFLOW_TIMEOUT_MS,
    maxMs: SAVE_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "SaveWorkflow typechecks and writes synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
