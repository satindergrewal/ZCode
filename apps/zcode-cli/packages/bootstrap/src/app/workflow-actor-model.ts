// ============================================================
// Model surface for workflow actors (run selection / journal pin -> AgentRuntime model config)
// ============================================================
//
// The persona model tier (`model?: "main" | "lite"`) is retired. The host has no lite model source
// after the provider refactor, and "lite" long behaved identically to "main" - both inherit the
// parent session's current model.
//
// So this module answers a single question: **which model does this actor's session run on**.
// Three sources in priority order: this run's `subagentModel` (the `subagent_model` of
// `CreateWorkflow` / `AmendWorkflow`) > resume pin (the model actually used last run, from the
// journal) > the parent session's current model. Sister module to workflow-actor-tools.ts on the
// same seam: one exposes the tool surface, this one the model surface; both are expanded by the
// driver-side runtime factory when building the AgentRuntime.

import type { ModelSelection } from "@zcode/shared/model-selection";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

/** Host-side facts the model surface needs. */
interface WorkflowActorModelHost {
  /**
   * The parent session's **current** model selection (`runtime.getSessionModelSelection()`).
   * Only matters when there is no run-level selection: compared against the pin (to decide
   * whether the pinned model already is the current main model, and thus whether the pin branch
   * should override at all). Absent while the parent session has no selection yet.
   */
  parentSelection?: ModelSelection | undefined;
  /**
   * This run's own subagent model (the `subagent_model` of `CreateWorkflow` / `AmendWorkflow`,
   * read back from the journal's `run-launched` event). The **entire selection**, including the
   * reasoning level - when the user asks for `GLM-5.3-Flash$high` on a subagent, that level is
   * part of the selection and must not be dropped here.
   *
   * Precedence: **highest**. It is the user's explicit statement for this run; when present, pin
   * and parent model are merely the defaults it exists to replace (see the function comment
   * below). The main agent is unaffected - this only describes subagents.
   */
  runSelection?: ModelSelection | undefined;
}

/** Model-surface slice of AgentRuntimeConfig. */
interface WorkflowActorModelPolicy {
  /**
   * Overrides expanded into AgentRuntimeConfig. **Empty object means "no override"**: the child
   * runtime's baseline already is the parent session's model selection
   * (script-workflow-child-runtime.ts), so with neither run selection nor pin we write nothing,
   * which inherits the parent model.
   */
  configOverrides: {
    modelSelection?: ModelSelection;
  };
}

/**
 * Thrown when the pinned model cannot be constructed. Carries the pin itself: whoever debugs
 * needs to know which model the journal pinned, not guess from a generic "invalid model
 * reference" message.
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
 * Maps the run selection and the journal pin onto the AgentRuntime model config. Pure function.
 *
 * `pinnedModel` is the `resolvedModel` (`providerId/modelId`) recorded for this actor in the
 * journal; only resume (including the seed amend-resume inherits from its predecessor) passes it.
 *
 * Precedence: **this run's `subagentModel` > resume pin > parent session's current model**.
 *
 * | run selection | pin | result |
 * |---|---|---|
 * | present | any (incl. malformed, not parsed) | override with the run selection (whole, incl. reasoning level) |
 * | absent | none | no override (parent session's current model) |
 * | absent | equals the parent's current model | no override (the pin already is the current main model) |
 * | absent | differs from the parent's current model | override with the selection parsed from the pin |
 * | absent | malformed (missing provider part) | {@link WorkflowActorPinnedModelError} |
 *
 * **Omission inherits; an explicit value replaces.** resume / amend's `resolveInput` already
 * follows this rule for `subagentModel` and `max_concurrency`; the pin applies the same rule to
 * the **implicit default**: for a run without `subagentModel`, the subagent's default is not
 * "the parent session's current model" but "the model this subagent actually ran last time".
 * Once the run carries a `subagentModel` there is no default left to inherit and the pin has no
 * say - hence pin below run selection. The pin guards against silent drift, while `AmendWorkflow`
 * with `subagent_model` is exactly the explicit, user-visible decision (the confirmation dialog
 * and the tool output both say "Subagents run on ..."). Previously the pin outranked the run
 * selection, so every resumed subagent with live work ran on the predecessor's model while
 * `run-launched` and the confirmation dialog said otherwise. The model switch is not lost to
 * history: the new run's own `dwf_actor` row records the new selection and the predecessor's row
 * keeps the old model, so the lineage preserves "at which run it changed".
 *
 * Why the pin exists - it is the persisted half of the **persona freeze invariant**: the persona
 * is frozen at `agent()` time, while resume rebuilds the actor from the journal. Without a pin,
 * a parent session that changed its main model between runs would **quietly alter a frozen
 * identity mid-transcript**: asks before resume produced by model X, those after by model Y,
 * with nothing recording the switch.
 *
 * **v1 pin-miss policy (the no-run-selection path): fail loudly, never switch models silently.**
 * When the pin points at a model the host can no longer construct (provider gone, model
 * retired), this function does **not** fall back to the parent model - that is exactly the
 * silent identity change the pin guards against. A malformed pin fails here with
 * {@link WorkflowActorPinnedModelError}; a syntactically valid model the host no longer offers
 * cannot be checked at session-build time (that would require the host's registry, machinery
 * this pure function deliberately avoids) and surfaces as a node-level error on the **first
 * ask**'s model call - accepted by design: failing loudly later beats silently running on
 * another model. The only way to change models on resume is `AmendWorkflow` with
 * `subagent_model`, i.e. the run-selection branch.
 *
 * This function does **not** produce the fact "which model will actually run": that lands in
 * the journal, and the authority is the constructed child runtime itself
 * (`runtime.getSessionModelSelection()`). Letting the runtime say it avoids the
 * two-bookkeeping divergence where the policy believes A was chosen while the runtime runs B.
 * Persisted via dynamic-workflow-run-launch.ts's `journalActorResolvedModel`.
 */
export function workflowActorModelPolicy(
  host: WorkflowActorModelHost,
  pinnedModel?: string,
): WorkflowActorModelPolicy {
  // Run selection present: override wholesale; the pin is not even parsed - it is just the
  // default this run replaces.
  if (host.runSelection !== undefined) {
    return { configOverrides: { modelSelection: host.runSelection } };
  }
  if (pinnedModel === undefined) return { configOverrides: {} };
  const pinned = parsePinnedModel(pinnedModel);
  // The pin already is the parent's current model: let the child runtime baseline express it.
  // "No override" is the **stronger** statement - the baseline inherits the reasoning options
  // too, whereas an identity-based override would swap them for an equivalent without options.
  if (host.parentSelection !== undefined && sameModelIdentity(pinned, host.parentSelection)) {
    return { configOverrides: {} };
  }
  // The parent changed its main model between runs. Keep the pin - silent model switches are
  // exactly what it guards; to switch, go through AmendWorkflow's subagent_model (branch above).
  // Reasoning options are not recomputed on this path: the pin guards the **model identity**
  // (providerId/modelId); the journal records only those two parts.
  return { configOverrides: { modelSelection: pinned } };
}

/** Pin comparison looks at the identity parts only: the journal records `providerId/modelId`; options are not part of the identity. */
function sameModelIdentity(a: ModelSelection, b: ModelSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * Parses the journal pin. **No default provider**: the pin was written locally as
 * `providerId/modelId`; a missing provider part means the record was not written in that format
 * (or was edited since), and backfilling the parent's provider would guess a new identity -
 * exactly what the pin guards against. Fail loudly instead.
 */
function parsePinnedModel(pinnedModel: string): ModelSelection {
  const parsed = parseProviderQualifiedModelSelection(pinnedModel);
  if (parsed === undefined) throw new WorkflowActorPinnedModelError(pinnedModel);
  return parsed;
}
