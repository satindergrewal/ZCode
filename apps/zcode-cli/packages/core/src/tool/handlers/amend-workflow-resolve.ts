// ============================================================
// AmendWorkflow: everything before confirmation (resolveInput and its structured failures).
// ============================================================
//
// Split from amend-workflow.ts: that is handler+declaration; this is the flow's **only port read --
 normalizing model args into execution facts. Every omittable field follows one rule (omit = inherit);
 three settle here: script (three provenances, amend-workflow-source.ts), concurrency ceiling, subagent
 model. Downstream, hook/permission/confirm/handler see only: one script, a number-or-nothing, a canonical-or-nothing.

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
 * Permission (own-run no-confirm, permission/service.ts) and the confirm dialog ("running, will be
 stopped") both read it, both pre-handler and synchronous -- so it is computed here. **Unconditionally
 overwrites** any model-given predecessor: forging one is invalid. Unknown predecessor settles here --
 no confirm dialog destined to fail.
 * Order is fixed: predecessor lookup (missing = run_not_found, script-independent) -> land the script
 (read file or predecessor archive; name the file on failure) -> compare bytes (script_unchanged).
 Reversed, a call naming a nonexistent run fails on the file read first, sending the model to fix a non-issue.
 *
 * Port absent (unwired host): with a script given (inline/file) pass through -- handler takes the
 typecheck-only path, isomorphic to CreateWorkflow; permission asks as usual without predecessor. With
 neither source there is nothing to inherit: fail now -- "typecheck-only" needs something to compile.
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
    // No port = no predecessor and no ceiling: null (clear) and inherit collapse to absent; the number passes.
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
      input: {
        ...rest,
        ...script.fields,
        ...(typeof requested === "number" ? { max_concurrency: requested } : {}),
        ...subagentModel.field,
      },
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
    ...resolveAmendMaxConcurrency(
      parsed.data.max_concurrency,
      snapshot.maxConcurrency,
      port.concurrencyCeiling?.(),
    ),
    ...subagentModel.field,
    predecessor: {
      ...predecessor,
      ...(script.inherited ? { script_inherited: true as const } : {}),
    },
  };
  return { result: true, input: resolved };
}

/**
 * Subagent-model three-state normalization, the same shape contract as the concurrency ceiling --
 three states live only here; afterwards it is canonical-or-nothing:
 *
 *   - string -> resolve; failure fails the call (nothing stopped/created, no dialog).
 *   - null -> clear, key drops (new run returns to the session model).
 *   - omitted -> the predecessor snapshot's, **re-resolved**. The predecessor may be days old; that
 model may since be deleted/disabled -- without re-resolution the failure surfaces at the subagent's
 first word, looking like a runtime fault.
 * Catalog absent: the two sources split -- a model-given string is rejected as in CreateWorkflow
 (never silently accept what the host cannot resolve), while the **inherited** one passes verbatim:
 resolved once already at predecessor time; failing the amend over a field this call never mentioned
 bills a host-wiring gap to the user.
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
 it the raw resolution diagnostic reads as its own bad arg, and it would retry verbatim.
  return subagentModelFailure(
    choice.inherited
      ? `This amend inherited the predecessor run's subagent model (\`${choice.text}\`), which is no longer usable. ${choice.message}\n\nPass \`subagent_model: null\` to run the revision on the session model instead.`
      : choice.message,
  );
}

/**
 * The three-state **resolver itself**, shared by the tool and the GUI settings editor (runtime
 amendWorkflowRunSettings) -- shared code, not a copy. Only the failure **wording** differs: the tool
 speaks model (with the subagent_model:null hint), the GUI speaks human (diagnostics into the ACK message).
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
