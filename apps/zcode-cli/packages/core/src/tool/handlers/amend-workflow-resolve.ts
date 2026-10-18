// ============================================================
// AmendWorkflow: everything before confirmation (resolveInput and its structured failures).
// ============================================================
//
// Split from amend-workflow.ts: that is handler+declaration; this is the flow's **only port read --
// normalizes the input into "the execution facts that will happen". Every omittable field obeys one rule (absent inherits the predecessor); all three settle here:
// the script (three sources, see amend-workflow-source.ts), the concurrency bound, the subagent model. Past this, hook, permission,
// dialog and handler see only "one script, a number or none, one canonical form or none".

import {
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type ModelCatalogPort,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { SUBAGENT_MODEL_UNAVAILABLE } from "./create-workflow-source.js";
import { resolveConcurrencyRetuneRoute } from "./amend-workflow-retune.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  describePredecessor,
  refuseUnchangedScript,
  resolveAmendMaxConcurrency,
  resolveAmendScript,
} from "./amend-workflow-source.js";
import { resolveModelReference } from "./model-reference.js";
import { withScriptModelBindings } from "./workflow-script-models.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

export {
  AMEND_WORKFLOW_ERROR_CODE,
  resolveAmendMaxConcurrency,
  scriptUnavailableFailure,
  validateAmendWorkflowSource,
} from "./amend-workflow-source.js";

/** Unknown predecessor: reuse the introspection tool's run_not_found, adding which run_id. */
export function predecessorNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was stopped or created: \`run_id\` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow.`,
  };
}

/**
 * The flow's only port read: resolve run_id into the predecessor fact block, backfilled into args.
 *
 * Permission decision (this session's runs are always-allow, permission/service.ts) and the confirm dialog ("still running, will be stopped") both
 * read it, both before the handler and both synchronous — so it can only be computed here. **Unconditionally override** any
 * `predecessor` the model supplied: a forged one is invalid. A missing predecessor closes here — never open a dialog destined to fail.
 *
 * Order is fixed: predecessor lookup (missing = `run_not_found`, unrelated to the script) -> settle the script (file or predecessor
 * archive; name the reason when unreadable) -> byte compare (`script_unchanged`). Reordered, a call naming a nonexistent run
 * errors on the unreadable file first and the model goes fixing a non-problem.
 *
 * With the port absent (unwired host), a supplied script (inline or file) passes through: the handler takes the "typecheck only,
 * no execution" path, same shape as CreateWorkflow; permission reads no `predecessor` and asks as usual. With neither source
 * there is nothing to inherit — fail immediately; "typecheck only" cannot degrade, there is nothing to compile.
 */
export async function resolveAmendWorkflowInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const cwd = context.workingDirectory ?? ".";
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    const {
      predecessor: _forged,
      max_concurrency: requested,
      subagent_model: _model,
      script_line_offset: _offset,
      ...rest
    } = parsed.data;
    void _forged;
    void _model;
    void _offset;
    // No port means no predecessor and no default concurrency: `null` (clear) and "inherit" collapse to absent, the number passes through.
    // Post-normalization args only ever have the number-or-nothing shape.
    const subagentModel = resolveAmendSubagentModel(
      parsed.data.subagent_model,
      undefined,
      context.modelCatalogPort,
    );
    if (!subagentModel.result) return subagentModel;
    const script = await resolveAmendScript({
      model: parsed.data,
      cwd,
      port,
      predecessorScriptPath: undefined,
    });
    if (!script.result) return script;
    return {
      result: true,
      // No port, no predecessor to inherit: models named by the script always re-resolve against the catalog.
      input: withScriptModelBindings(
        {
          ...rest,
          ...script.fields,
          ...(typeof requested === "number" ? { max_concurrency: requested } : {}),
          ...subagentModel.field,
        },
        context.modelCatalogPort,
      ),
    };
  }
  const snapshot = await port.getTask(parsed.data.run_id);
  if (snapshot === undefined) return predecessorNotFoundFailure(parsed.data.run_id);
  const predecessor = describePredecessor(snapshot, context.sessionId);
  // The route forks here and only here: predecessor just read (alive?), arg shape in hand (anything but
  // concurrency to change?). Hit = in-place concurrency -- no script read, no inheritance, no compile;
  // normalized args then carry **no script**, which is how handler/prepareApproval recognize this path.
  const retune = resolveConcurrencyRetuneRoute({
    model: parsed.data,
    port,
    predecessor,
    inherited: snapshot.maxConcurrency,
  });
  if (retune !== undefined) return retune;
  const subagentModel = resolveAmendSubagentModel(
    parsed.data.subagent_model,
    snapshot.subagentModel,
    context.modelCatalogPort,
  );
  if (!subagentModel.result) return subagentModel;
  const script = await resolveAmendScript({
    model: parsed.data,
    cwd,
    port,
    predecessorScriptPath: snapshot.scriptPath,
  });
  if (!script.result) return script;
  const unchanged = await refuseUnchangedScript({
    port,
    model: parsed.data,
    resolvedScript: script.fields.script,
    described: script.described,
  });
  if (unchanged !== undefined) return unchanged;
  const {
    predecessor: _forged,
    max_concurrency: _tristate,
    subagent_model: _model,
    // Line offset, same stance as predecessor: a resolved fact; model-given values discarded (recomputed from file below).
    script_line_offset: _offset,
    ...rest
  } = parsed.data;
  void _forged;
  void _model;
  void _offset;
  const resolved: AmendWorkflowInput = {
    ...rest,
    ...script.fields,
    ...resolveAmendMaxConcurrency(parsed.data.max_concurrency, snapshot.maxConcurrency),
    ...subagentModel.field,
    predecessor: {
      ...predecessor,
      ...(script.inherited ? { script_inherited: true as const } : {}),
    },
  };
  // Script-named models: same names inherit the binding recorded on the predecessor's run-launched (preserving model swaps made in its dialog);
  // new names resolve against the catalog (docs/dynamic-workflow/launch.md "The `AmendWorkflow` tool").
  return {
    result: true,
    input: withScriptModelBindings(resolved, context.modelCatalogPort, snapshot.modelBindings),
  };
}

/**
 * The subagent model's three-state normalization shares one shape contract with the concurrency bound —
 * the three states live only up to here; past the dialog and handler there is only "one canonical form or none":
 *
 *   - string -> resolve; an unresolvable value fails the whole call (nothing stopped, nothing created, no dialog).
 *   - `null` -> clear, the key disappears entirely (the new run returns to the session model).
 *   - absent -> keep the predecessor snapshot's value, and **re-resolve it**. The predecessor may date back days; that model may
 *     since be deleted or disabled; without re-resolution the failure waits for the subagent's first word, looking like a runtime fault.
 *
 * With no catalog the two sources diverge: a model-supplied string is rejected as `CreateWorkflow` would (never silently pass
 * something the host cannot resolve), while the **inherited** one passes through as-is — it was resolved once on the predecessor, and failing
 * the whole revision over a field this call never mentions books a host-wiring gap to the user.
 */
function resolveAmendSubagentModel(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
): { result: true; field: { subagent_model?: string } } | ToolHandlerFailure {
  const choice = resolveAmendSubagentModelChoice(requested, inherited, catalog);
  if (choice.ok) {
    return {
      result: true,
      field: choice.canonical === undefined ? {} : { subagent_model: choice.canonical },
    };
  }
  // When the inherited one fails, say it was **inherited**: the model named no model this call; handing
  // diagnostics; it would assume it passed wrong params and retry verbatim.
  return subagentModelFailure(
    choice.inherited
      ? `This amend inherited the predecessor run's subagent model (\`${choice.text}\`), which is no longer usable. ${choice.message}\n\nPass \`subagent_model: null\` to run the revision on the session model instead.`
      : choice.message,
  );
}

/**
 * The three-state **resolver itself**, shared by the tool and the GUI settings editor (runtime
 * (shared resolution code, not a copy). They differ only in how the failure is **spoken** —
 * the tool tells the model (with a `subagent_model: null` hint), the GUI tells the person (diagnostics in the ACK message).
 *
 * Result: no canonical = session model; failures carry `inherited` (the inherited one failed) plus diagnostics.
 */
export function resolveAmendSubagentModelChoice(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
):
  | { ok: true; canonical?: string }
  | { ok: false; inherited: boolean; text: string; message: string } {
  if (requested === null) return { ok: true };
  const text = requested ?? inherited;
  if (text === undefined) return { ok: true };
  if (catalog === undefined) {
    return requested === undefined
      ? { ok: true, canonical: text }
      : { ok: false, inherited: false, text, message: SUBAGENT_MODEL_UNAVAILABLE };
  }
  const resolution = resolveModelReference(text, catalog.listModels());
  if (!resolution.ok) {
    return { ok: false, inherited: requested === undefined, text, message: resolution.message };
  }
  return { ok: true, canonical: resolution.canonical };
}

/** Resolution failure -> structured business failure; discriminant is the message prefix (as the other codes here). */
function subagentModelFailure(message: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SUBAGENT_MODEL,
    message: `workflow_subagent_model_unresolved: ${message} Nothing was stopped or created.`,
  };
}
