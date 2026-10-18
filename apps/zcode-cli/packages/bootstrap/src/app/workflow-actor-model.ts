// ============================================================
// Model surface for workflow actors (run selection / journal pin -> AgentRuntime model config)
// ============================================================
//
// The persona model tiers (model?: "main" | "lite") are retired: after the provider rework the host has no lite source,
// and "lite"/"main" have long been the same road -- inherit the parent session's current model.
//
// So this module answers one question: WHICH model should this actor's session run on. Four sources, by priority:
// the model the persona names (the script's agent(..., { model }), resolved through run-launched's binding table;
// docs/dynamic-workflow/authoring.md, "Choosing a model per subagent") > this run's subagentModel
// (CreateWorkflow / AmendWorkflow's subagent_model, docs/dynamic-workflow/launch.md) >
// the resume pin (the last model actually run, from the journal) > the parent session's current model.
//
// 2026-09-26 addendum: the persona model is back -- not the retired tier, but a concrete model name, resolved against the catalog into the
// binding table at launch; this module only looks it up ({@link resolveActorPersonaModel}).
// Sibling module to workflow-actor-tools.ts on the same seam: one owns the tool surface, one the model surface,
// both expanded by the driver-side runtime factory when building the AgentRuntime.

import type { ModelSelection } from "@zcode/shared/model-selection";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

/** Host-side facts the model surface needs. */
interface WorkflowActorModelHost {
  /**
   //   * The parent session's CURRENT model selection (runtime.getSessionModelSelection()). Useful only when there is no run-level
   //   * choice: to compare against the pin (is the pinned model the current main model?), deciding whether the pin branch should
   //   * override at all. Absent while the parent has no selection.
   */
  parentSelection?: ModelSelection | undefined;
  /**
   //   * This run's own subagent model (CreateWorkflow / AmendWorkflow's subagent_model, read back from the journal's
   //   * run-launched event). The WHOLE choice, reasoning tier included: when the user says the subagent runs
   //   * GLM-5.3-Flash$high, that tier is part of the choice and must not be dropped here.
   *
   //   * Position: HIGHEST. It is the user's explicit statement for this run; present, the pin and parent model are just the
   //   * defaults it exists to replace (see the function docs below). The main agent is unaffected -- this describes subagents only.
   */
  runSelection?: ModelSelection | undefined;
  /**
   //   * The model this actor's persona names, resolved through this run's binding table into a whole choice (reasoning tier included;
   //   * {@link resolveActorPersonaModel}). Position: HIGHEST -- written for this one subagent and approved by the user in the
   //   * confirm dialog's bindings, more specific than "the run's subagent default model".
   */
  actorSelection?: ModelSelection | undefined;
}

/** Model-surface slice of AgentRuntimeConfig. */
interface WorkflowActorModelPolicy {
  /**
   //   * Overrides folded into AgentRuntimeConfig. EMPTY OBJECT = no override: the child runtime's baseline already is
   //   * the parent session's model choice (script-workflow-child-runtime.ts), so with neither run choice nor pin, write
   //   * nothing at all: inherit the parent model.
   */
  configOverrides: {
    modelSelection?: ModelSelection;
  };
}

/**
 // * Thrown when the pinned model cannot be constructed. Carries the pin itself: the debugger needs which model the journal pinned,
 // * not a guess from a generic "invalid model reference" message.
 */
export class WorkflowActorPinnedModelError extends Error {
  readonly pinnedModel: string;

  constructor(pinnedModel: string, cause?: unknown) {
    super(`Cannot construct the model pinned for this subagent: ${pinnedModel}`);
    this.name = "WorkflowActorPinnedModelError";
    this.pinnedModel = pinnedModel;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 // * The persona named a model absent from this run's binding table. Reachable only via a type assertion bypassing the compiler's 9010 rule
 // * (compile-time closure of the name set; the whole table resolved at launch); carries the name and the names the table has, so the
 // * debugger knows which script line and what's missing. Fail loudly rather than quietly falling back to the run's subagent model -- that runs a model the user never approved.
 */
export class WorkflowActorModelUnboundError extends Error {
  readonly modelName: string;

  constructor(modelName: string, bound: readonly string[]) {
    super(
      `This subagent's persona names the model "${modelName}", which the run did not resolve at launch` +
        (bound.length === 0
          ? " (the script named no models)."
          : ` (it resolved: ${bound.map((name) => `"${name}"`).join(", ")}).`),
    );
    this.name = "WorkflowActorModelUnboundError";
    this.modelName = modelName;
  }
}

/**
 // * Persona model name -> whole choice (docs/dynamic-workflow/launch.md, "Models the script names"). Pure function.
 *
 // * Names match the table VERBATIM: lowering reduces model("x") to "x"; the persona carries the exact string the script wrote,
 // * and the table's keys are that. Returns undefined when the persona names none (defer to run choice / pin / parent model).
 */
export function resolveActorPersonaModel(
  personaModel: string | undefined,
  bindings: Readonly<Record<string, string>> | undefined,
): ModelSelection | undefined {
  if (personaModel === undefined) return undefined;
  const canonical = bindings?.[personaModel];
  if (canonical === undefined) {
    throw new WorkflowActorModelUnboundError(personaModel, Object.keys(bindings ?? {}));
  }
  return parseModelPickerValue(canonical);
}

/**
 // * Maps the persona model, the run choice and the journal pin onto AgentRuntime model config. Pure function.
 *
 * `pinnedModel` is the `resolvedModel` (`providerId/modelId`) recorded for this actor in the
 * journal; only resume (including the seed amend-resume inherits from its predecessor) passes it.
 *
 // * Priority: persona-named model > this run's subagentModel > resume pin > parent session's current model.
 *
 * | run selection | pin | result |
 * |---|---|---|
 * | present | any (incl. malformed, not parsed) | override with the run selection (whole, incl. reasoning level) |
 * | absent | none | no override (parent session's current model) |
 * | absent | equals the parent's current model | no override (the pin already is the current main model) |
 * | absent | differs from the parent's current model | override with the selection parsed from the pin |
 * | absent | malformed (missing provider part) | {@link WorkflowActorPinnedModelError} |
 *
 // * OMIT = INHERIT, EXPLICIT = REPLACE. resume/amend's resolveInput already runs this rule for subagentModel and
 // * max_concurrency; the pin is the same rule applied to the IMPLICIT default: in a run without subagentModel, a
 // * subagent's default is not "the parent's current model" but "the model this subagent actually ran last". Once the run has
 // * subagentModel there is no default to inherit and the pin is mute; hence the pin ranks BELOW the run choice -- it guards
 // * silent drift, while AmendWorkflow with subagent_model is exactly the explicit, user-visible decision (confirm dialog and
 // * tool output both say "Subagents run on ..."). The legacy pin-above order made every resumed subagent with live work
 // * run on the predecessor's model while run-launched and the dialog said otherwise.
 // * The switch history survives: the new run's own dwf_actor row records the new choice and the predecessor's row keeps the old model, so the lineage
 // * preserves "at which run it changed".
 *
 // * Why a pin at all -- it is the PERSISTED HALF of the persona-freeze invariant: the persona freezes at agent(),
 // * and resume rebuilds the actor from the journal. Without a pin, a parent whose main model changed between runs would
 // * silently alter a frozen identity MID-TRANSCRIPT: asks before the resume by model X, after by model Y,
 // * with nothing recording the change.
 *
 // * The v1 pin-miss policy (the no-run-choice path): rather fail than silently switch models. When the pin points at a model the
 // * host can no longer construct (provider gone, model retired) this does NOT fall back to the parent model -- that is exactly
 // * the silent identity change the pin guards. A malformed pin fails here as {@link WorkflowActorPinnedModelError};
 // * a syntactically valid but host-absent model cannot be checked at session creation (that would touch the host Registry, machinery this
 // * pure function deliberately avoids) and surfaces as a node error on the FIRST ask's model call -- accepted
 // * deliberately: failing loudly late beats silently running another model. To switch models on resume there is one road:
 // * AmendWorkflow with subagent_model -- the run-choice branch.
 *
 // * This function does NOT produce the "which model finally ran" fact: that must be journaled, and the authority is the built child
 // * runtime itself (runtime.getSessionModelSelection()). Letting the runtime say it avoids "policy thinks A,
 // * runtime runs B" divergences that only double-computation creates. Persisting: dynamic-workflow-run-launch.ts's
 // * journalActorResolvedModel.
 */
export function workflowActorModelPolicy(
  host: WorkflowActorModelHost,
  pinnedModel?: string,
): WorkflowActorModelPolicy {
  // The persona names a model: it is this subagent's explicit choice; run choice and pin are just the defaults it replaces.
  if (host.actorSelection !== undefined) {
    return { configOverrides: { modelSelection: host.actorSelection } };
  }
  // Run choice present: override whole; do not even parse the pin -- it is the default this run exists to replace.
  if (host.runSelection !== undefined) {
    return { configOverrides: { modelSelection: host.runSelection } };
  }
  if (pinnedModel === undefined) return { configOverrides: {} };
  const pinned = parsePinnedModel(pinnedModel);
  // The pin IS the parent's current model: let the child runtime's baseline express it. "No override" is the STRONGER
  // form: the baseline inherits the reasoning options too, while an identity-based override would swap them for an equivalent missing options.
  if (host.parentSelection !== undefined && sameModelIdentity(pinned, host.parentSelection)) {
    return { configOverrides: {} };
  }
  // The parent changed its main model between runs. Keep the pin -- silent model switches are what it guards; to switch,
  // go through AmendWorkflow's subagent_model (the branch above).
  // Reasoning options are not recomputed on this path: the pin guards model IDENTITY (providerId/modelId); the journal records those two segments only.
  return { configOverrides: { modelSelection: pinned } };
}

/** Pin comparison looks at the identity parts only: the journal records `providerId/modelId`; options are not part of the identity. */
function sameModelIdentity(a: ModelSelection, b: ModelSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 // Parse the journal's pin. NO default provider: the pin is a locally written providerId/modelId;
 // a missing provider segment means the record was not written in this format (or was edited); patching the parent's provider in
 // would guess a new identity -- what the pin guards. Fail loudly.
 */
function parsePinnedModel(pinnedModel: string): ModelSelection {
  const parsed = parseProviderQualifiedModelSelection(pinnedModel);
  if (parsed === undefined) throw new WorkflowActorPinnedModelError(pinnedModel);
  return parsed;
}
