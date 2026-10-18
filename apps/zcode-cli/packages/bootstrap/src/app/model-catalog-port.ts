// ============================================================
// The host implementation of ModelCatalogPort: Provider Registry -> the model catalog visible to the tool layer.
// ============================================================
// Contract: contracts/src/interfaces/model-catalog.port.ts. It exists for one reason:
// `CreateWorkflow` / `AmendWorkflow`'s `subagent_model` must resolve the user's model name into a
// per-run subagent choice, and core cannot see the provider registry. This module hands over the host-side
// fact of "which models exist"; the resolution itself stays a pure function in core.
//
// `listRegistryBackedModels` in provider-registry-selection.ts is the same registry's **other face**:
// there the GUI picker's `ZCodeModelOption` (label / maxOutputTokens / display attrs); here the narrow
// entries the tool layer needs. Deliberately no shared projection function -- the two faces' field sets and presence rules are independent, and merging
// would let a picker-driven change silently alter resolution criteria. What IS shared: the default-tier rule (below).

import type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

interface ModelCatalogPortDeps {
  /** The process's Provider Registry. Keep the **whole object**; never `getView()` once into a snapshot. */
  registry: ProviderRegistryModelSource;
  /**
   * The session's **current** model selection (`runtime.getSessionModelSelection()`). A function, like the registry,
   * not a value: `current` is the fact at each listing; the user can switch the main model between tool calls.
   */
  currentSelection: () => ModelSelection | undefined;
}

/**
 * Builds {@link ModelCatalogPort}.
 *
 * **`listModels()` reads `registry.getView()` fresh on every call**, no caching -- not a performance choice but the
 * direct lesson of stale provider registries: subagents clutching the provider adapters from parent-session construction
 * keep requesting against a config that no longer exists once the user changes providers. A construction-frozen catalog would let
 * `subagent_model` resolution pick a since-deleted model, and the failure waits for the subagent's first word --
 * far from the user's confirmation. The view is an in-memory object;
 * re-reading it is not I/O.
 */
export function createModelCatalogPort(deps: ModelCatalogPortDeps): ModelCatalogPort {
  return {
    listModels(): ModelCatalogEntry[] {
      // This line is the entire implementation of the discipline above; any "optimization" hoisting it out of the closure reenacts the bug.
      const view = deps.registry.getView();
      const current = deps.currentSelection();
      return view.providers.flatMap((provider) =>
        provider.models.map((model): ModelCatalogEntry => {
          const reasoning = model.config.optionSpecs.reasoningLevel;
          // Copy the tier table, never hand out the original: the registry's values are part of a readonly view,
          // while the port contract promises a plain readable array -- the caller gets a copy that does not move with the registry.
          const reasoningLevels = [...reasoning.values];
          // default tier = last tier, the same rule as provider-registry-selection.ts's `toModelOption`
          // (the GUI picker's `reasoning.defaultLevel`). Two different defaults would produce
          // "picker defaults high, `subagent_model` without a tier defaults low" -- a divergence only users notice.
          // Tier-less models omit the whole field (empty array, no default).
          const defaultReasoningLevel = reasoning.values.at(-1);
          const contextWindow = model.config.properties.contextWindow;
          // `providerName` is `string | null | undefined` in the registry (config-service.ts normalizes empty to `null`),
          // while the port contract says `string | undefined`. The three "no name" shapes collapse here into
          // **one** answer: absent key. Never pass a `null` or empty string -- it would print verbatim into ListModels'
          // row, and readers want "fall back to providerId when never named".
          const providerLabel = provider.providerName?.trim();
          return {
            providerId: provider.providerId,
            modelId: model.modelId,
            // The provider's human name; absent when never set (readers fall back to providerId). Do not backfill
            // to providerId here -- that would erase "was ever named" from the port.
            ...(providerLabel ? { providerLabel } : {}),
            reasoningLevels,
            ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
            ...(contextWindow === undefined ? {} : { contextWindow }),
            // Both identity halves equal => current selection; options are not identity (same criterion as
            // workflow-actor-model.ts's pin check). At most one row is true.
            current:
              current !== undefined &&
              current.providerId === provider.providerId &&
              current.modelId === model.modelId,
            // `disabledReason` is deliberately **always absent**: this host has no source for that fact today. The GUI model list
            // uses the same registry (listRegistryBackedModels -> toModelOption) and never writes it either;
            // `registry.validateSelection()` is no source either -- every entry we enumerate comes from the registry
            // view itself and passes by construction. The only disabledReason producer in the repo lives in
            // packages/services' desktop legacy-config migration, unreachable from this registry. When a real
            // "configured but unavailable" criterion appears (missing key, policy-disabled), add it here; the port contract need not change.
          };
        }),
      );
    },
  };
}
