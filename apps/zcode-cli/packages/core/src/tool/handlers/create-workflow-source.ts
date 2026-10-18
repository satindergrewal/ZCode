// ============================================================
// CreateWorkflow -- validation and normalization of the args
// ============================================================
//
// This module is where **two sources merge into one script**, and the flow's only disk read. The merge
// point must stay single: back in the handler it would get tangled in handler branches, and the next
// person would naturally add a "saved-run special case" fork -- whose first victim is the confirm dialog,
// which would start showing bytes different from what will run.
import {
  CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR,
  CREATE_WORKFLOW_SOURCE_ERROR,
  CreateWorkflowInputSchema,
  type CreateWorkflowInput,
  type ModelCatalogPort,
  type SavedWorkflowArgsDeclaration,
  type SavedWorkflowScope,
} from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionResult } from "../types.js";
import { resolveModelReference } from "./model-reference.js";
import {
  listSavedWorkflows,
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "./saved-workflows/index.js";
import { writeWorkflowDraft } from "./workflow-drafts.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/** Business-failure code, same shape as the existing handler-failure convention. */
const CREATE_WORKFLOW_FAILURE_CODE = 400;

function failure(message: string): ToolHandlerFailure {
  return { result: false, errorCode: CREATE_WORKFLOW_FAILURE_CODE, message };
}

/**
 * Three-way source choice (plus "args only follows path") holds for **model-emitted** args only.
 *
 * Not expressible in zod: after normalization, `script` together with `saved`/`path` is a legal execution
 * state, but the schema would explode on the handler parse and the post-hook re-validation -- and only on
 * non-inline paths. */
export function validateCreateWorkflowSource(
  input: unknown,
): { result: true } | ToolHandlerFailure {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  // The schema's own failures are settled earlier by the executor; here only the XOR.
  if (!parsed.success) return { result: true };
  const sources = [parsed.data.script, parsed.data.saved, parsed.data.path].filter(
    (source) => source !== undefined,
  );
  if (sources.length !== 1) return failure(CREATE_WORKFLOW_SOURCE_ERROR);
  // `args` and `path` stand or fall together: saved args go in `saved.args`, inline scripts have nothing to
 // validate. Silent drops would make the caller believe the args applied while the script sees none.
  if (parsed.data.args !== undefined && parsed.data.path === undefined) {
    return failure(CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR);
  }
  return { result: true };
}

/**
 * Concurrency clamp: `[1, ceiling]`.
 * Over-ceiling values are **lowered, not rejected** -- "at most 32" means the user wants a cap, not an error.
 *
 * Unknown ceiling (port absent, or the host port has no `concurrencyCeiling`) passes through: the port
 impl clamps again anyway; skipping one clamp only shows a larger number in the confirm dialog, while
 rejecting would collapse the whole path.
 * Shared by `CreateWorkflow` and `AmendWorkflow`: the same number clamping differently on the two tools is
 the kind of inconsistency found only when a user changes concurrency once.
 */
export function clampWorkflowMaxConcurrency(value: number, ceiling: number | undefined): number {
  // Values passed schema (positive int); the lower bound is still written: this helper is the shared entry
 // for two tools and must not let 0 or negatives through even if the schema changes.
  const atLeastOne = Math.max(1, value);
  return ceiling === undefined ? atLeastOne : Math.min(atLeastOne, Math.max(1, ceiling));
}

/**
 * Subagent-model normalization result: the resolved canonical form, or a business failure.
 *
 * Discriminant is `result`, not a custom `ok`: call sites want to `return` failures as-is, and
 * `ToolHandlerFailure`'s discriminant is exactly `result: false`.
 */
type SubagentModelResolution = { result: true; canonical?: string } | ToolHandlerFailure;

/**
 * Resolve `subagent_model` to canonical form (the `CreateWorkflow` half; `AmendWorkflow`'s three-state
 version lives in amend-workflow.ts; both share `resolveModelReference`).
 *
 * Port absent while the field present => **explicit rejection**, never silent pass-through: a string the
 host cannot resolve travels far and explodes at the subagent's first word -- far from the confirm click,
 * and looking like a model problem by then. */
function resolveCreateSubagentModel(
  requested: string | undefined,
  catalog: ModelCatalogPort | undefined,
): SubagentModelResolution {
  if (requested === undefined) return { result: true };
  if (catalog === undefined) return failure(SUBAGENT_MODEL_UNAVAILABLE);
  const resolution = resolveModelReference(requested, catalog.listModels());
  // Unresolvable => the whole call fails: nothing started, no confirm dialog (same path as "saved def missing").
  if (!resolution.ok) return failure(resolution.message);
  return { result: true, canonical: resolution.canonical };
}

/** Rejection copy for a missing model catalog (shared with `AmendWorkflow`, hence a constant not an inline). */
export const SUBAGENT_MODEL_UNAVAILABLE =
  "This host cannot choose a subagent model; omit subagent_model.";

/**
 * Normalize inputs into execution facts. Inline is the **identity function** (zero disk ops); saved parses the file,
 * validates args, backfills defaults, writes a working copy, and yields `{name, script, saved: {name, args, path, scope,
 * draft}}`; the path source reads the file (strips a metadata block when present, validates `args`), yielding
 * `{name, script, path, args?, script_line_offset?}`。
 *
 * Post-normalization `script` is always present, so downstream (hooks, permission rules, prepareApproval, handler) share one path across all three
 * sources. Past this point saved / path are **provenance only**: run-label fallback, arg persistence and
 * script-file bookkeeping read them; execution never reads a byte.
 *
 * `ceiling` is this machine concurrency ceiling (`port.concurrencyCeiling?.()`; absent, no clamping); `catalog` is the local
 * model catalog (`context.modelCatalogPort`; absent, no model choice). `max_concurrency` and
 * `subagent_model` `subagent_model` are top-level fields, handled identically for all three sources.
 */
export async function resolveCreateWorkflowInput(
  input: unknown,
  cwd: string,
  ceiling?: number,
  catalog?: ModelCatalogPort,
): Promise<ToolInputResolutionResult> {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const model: CreateWorkflowInput = parsed.data;
  const requested = model.max_concurrency;

  // Model resolution precedes the disk read: one path for all sources, and an unresolvable call must not scan the disk first.
  const subagentModel = resolveCreateSubagentModel(model.subagent_model, catalog);
  if (!subagentModel.result) return subagentModel;
  const subagentModelField =
    subagentModel.canonical === undefined ? {} : { subagent_model: subagentModel.canonical };
  const clampedField =
    requested === undefined
      ? {}
      : { max_concurrency: clampWorkflowMaxConcurrency(requested, ceiling) };

  if (model.path !== undefined) {
    return resolvePathSource(model, model.path, cwd, {
      ...clampedField,
      ...subagentModelField,
    });
  }

  // Inline: identity. The inline path must not touch the disk — the testable form of zero regression.
  if (model.saved === undefined) {
    // Both exceptions rewrite without disk I/O; unwritten, the dialog would show a value that will not apply: an over-clamped concurrency
    // cap, and a model name not yet canonical. With neither touched it stays byte-identical.
    const clamped =
      requested === undefined ? undefined : clampWorkflowMaxConcurrency(requested, ceiling);
    // The name comparison uses the **raw** input, not `model.subagent_model`: the schema has `.trim()`, so a
    // padded string parses equal to canonical, and identity-pass would show that padding in the dialog.
    const rawSubagentModel = (input as { subagent_model?: unknown } | null)?.subagent_model;
    if (clamped === requested && subagentModel.canonical === rawSubagentModel) {
      return { result: true, input };
    }
    return {
      result: true,
      input: {
        ...model,
        ...(clamped === undefined ? {} : { max_concurrency: clamped }),
        ...subagentModelField,
      } satisfies CreateWorkflowInput,
    };
  }

  const found = resolveSavedWorkflow({ cwd, name: model.saved.name, scope: model.saved.scope });
  if (!found.ok) return describeResolveFailure(model.saved.name, found, cwd, model.saved.scope);

  const validated = validateWorkflowArgs(found.meta.args, model.saved.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for saved workflow '${model.saved.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(`'${found.name}'`, found.meta.args),
      ].join("\n"),
    );
  }

  // The working copy is written right after this one read, from **the very bytes just read** (metadata block included), so no
  // second read can diverge. The definition itself is never modified by a run: the model edits this copy.
  const draft = await writeWorkflowDraft({
    cwd,
    name: model.name ?? found.name,
    source: found.source,
  });

  return {
    result: true,
    input: {
      // Without an explicit display name, take the saved name: cross-session enumeration still shows which workflow it is,
      // not bare runIds. `readWorkflowName` existing rule (reads input.name) therefore hits as-is.
      name: model.name ?? found.name,
      // verbatim script body. Legacy desktop `readWorkflowScript(raw.script)` therefore hits **by construction** —
      // not a compat shim.
      script: found.script,
      saved: {
        name: found.name,
        args: validated.args,
        path: found.path,
        scope: found.scope,
        // If the draft cannot be written the field is absent (best effort); the model face falls back to the legacy wording.
        ...(draft === undefined ? {} : { draft: draft.path }),
      },
      // The copy carries the metadata block byte-for-byte, so diagnostic file lines skip the block lines.
      ...(found.bodyLineOffset === 0 ? {} : { script_line_offset: found.bodyLineOffset }),
      ...(requested === undefined
        ? {}
        : { max_concurrency: clampWorkflowMaxConcurrency(requested, ceiling) }),
      // The saved branch assembles a fresh input from scratch, so every top-level field must be named here once, or it is
      // silently dropped — and dropped-only-on-the-saved-path is the hardest failure to spot.
      ...subagentModelField,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * Normalization for the path source.
 *
 * No draft: the file already is the working copy; a duplicate leaves the model guessing which to edit.
 *
 * Files with a metadata block parse as saved definitions, `args` checked against the declarations (defaults backfilled); a blockless file is
 * all script, and passing `args` then is an error — nothing validates them, and silent dropping fakes success.
 */
async function resolvePathSource(
  model: CreateWorkflowInput,
  inputPath: string,
  cwd: string,
  extraFields: { max_concurrency?: number; subagent_model?: string },
): Promise<ToolInputResolutionResult> {
  const read = await readWorkflowScriptFile({ cwd, inputPath });
  if (!read.ok) return failure(read.message);
  const file = read.file;

  if (file.meta === undefined && model.args !== undefined) {
    return failure(
      `The workflow script file ${file.described} declares no arguments (it has no \`/* zcode-workflow\` metadata block), so it takes none. Drop \`args\`, or add a block declaring them.`,
    );
  }

  const validated = validateWorkflowArgs(file.meta?.args, model.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for the workflow script file ${file.described} are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(file.described, file.meta?.args),
      ].join("\n"),
    );
  }

  return {
    result: true,
    input: {
      // Same discipline as the saved branch: a fresh input from scratch, every top-level field named once.
      ...(model.name === undefined ? {} : { name: model.name }),
      script: file.script,
      path: file.path,
      // Empty declarations mean args are always `{}`; no shell keys — same shape as an inline run without args.
      ...(Object.keys(validated.args).length === 0 ? {} : { args: validated.args }),
      ...(file.bodyLineOffset === 0 ? {} : { script_line_offset: file.bodyLineOffset }),
      ...extraFields,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * The not-found explanation. On a miss, **list the names that exist** (scope-tagged): after a wrong guess that is the most useful
 * next-step information; otherwise it just guesses again.
 *
 * Two not-found wordings: with `scope`, none-in-that-scope; without, none-anywhere — both list names from
 * both stores so the model sees whether its name lives in the other one.
 */
function describeResolveFailure(
  name: string,
  found: Exclude<ReturnType<typeof resolveSavedWorkflow>, { ok: true }>,
  cwd: string,
  scope: SavedWorkflowScope | undefined,
): ToolHandlerFailure {
  if (found.reason === "invalid_name") {
    return failure(`'${name}' is not a usable workflow name: ${found.detail}`);
  }
  if (found.reason === "parse_error") {
    return failure(
      [
        `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
        "",
        "Its metadata block is malformed — most likely hand-edited. Fix the file, or save the workflow again.",
      ].join("\n"),
    );
  }
  if (found.reason === "read_error") {
    return failure(
      `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
    );
  }

  const headline =
    scope === undefined
      ? `No saved workflow named '${name}' in this project or globally.`
      : `No ${scope} workflow named '${name}'.`;
  return failure(`${headline}\n\n${describeAvailableWorkflows(cwd)}`);
}

/**
 * Names actually present in either store, scope-tagged. Scan each root directly (no shadowing) so a global entry shadowed by the project store
 * still lists — that is how the model learns it takes `scope: "global"` to reach it.
 */
function describeAvailableWorkflows(cwd: string): string {
  const project = listSavedWorkflows({ cwd, scope: "project" }).entries;
  const global = listSavedWorkflows({ cwd, scope: "global" }).entries;
  const tagged = [
    ...project.map((entry) => `${entry.name} (project)`),
    ...global.map((entry) => `${entry.name} (global)`),
  ];
  if (tagged.length === 0) {
    return "There are no saved workflows yet, in this project or globally. Use SaveWorkflow to create one, or pass an inline `script` instead.";
  }
  return `Available saved workflows: ${tagged.join(", ")}. Use ListSavedWorkflows for their descriptions.`;
}

/** Compact restatement of the arg declarations, appended to validation failures so one pass fixes it instead of another guess. */
function describeArgsDeclaration(
  label: string,
  args: SavedWorkflowArgsDeclaration | undefined,
): string {
  const declared = Object.entries(args ?? {});
  if (declared.length === 0) return `${label} declares no arguments.`;
  return [
    `${label} declares:`,
    ...declared.map(([key, spec]) => {
      const notes = [
        spec.type,
        spec.required === true ? "required" : "optional",
        spec.default === undefined ? undefined : `default ${JSON.stringify(spec.default)}`,
      ].filter((note) => note !== undefined);
      return `- ${key} (${notes.join(", ")})${spec.description === undefined ? "" : `: ${spec.description}`}`;
    }),
  ].join("\n");
}
