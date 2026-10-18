import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  type ModelSelection,
  type ProviderRegistryServiceSnapshot,
} from "@zcode/provider";
import { legacyReasoningLevelRenames as renames } from "./legacy-reasoning-level-renames.js";

const oldRulesCache = new WeakMap<ModelConfigRules, ModelConfigRules>();

/** Restores known legacy Built-in value domains for historical selections only; no Personal migration, no looser execution validation. */
export function resolveLegacyReasoningLevel(
  snapshot: ProviderRegistryServiceSnapshot,
  selection: ModelSelection,
): string | undefined {
  const oldLevel = selection.options?.reasoningLevel;
  if (oldLevel !== "off" && oldLevel !== "nothink") return undefined;
  const personal = snapshot.config.personalModels.getExactRule(
    selection.providerId,
    selection.modelId,
  );
  if (
    personal &&
    (personal.type === "manual-provider-model" ||
      personal.config.optionSpecs?.reasoningLevel?.values !== undefined ||
      personal.config.optionSpecs?.reasoningLevel?.map !== undefined)
  )
    return undefined;
  const provider = snapshot.resolution.effectiveProviders.get(selection.providerId);
  if (!provider) return undefined;
  const builtin = snapshot.config.zcodeBuiltinModelRules;
  let oldRules = oldRulesCache.get(builtin);
  if (!oldRules) {
    oldRules = new ModelConfigRules(
      builtin.rules().map((rule) => {
        // Only the adjudicated original no-site/no-API restriction qualifies; a new same-name
        // site rule must not inherit the legacy alias.
        const rename =
          rule.type === "model"
            ? renames.find((entry) => entry.modelMatch === rule.modelMatch)
            : undefined;
        const values = rule.config.optionSpecs?.reasoningLevel?.values;
        return rename && values?.includes("disabled")
          ? {
              ...rule,
              config: rule.config.overlay(
                new ModelConfig({
                  optionSpecs: new ModelOptionSpecsConfig({
                    reasoningLevel: {
                      values: values.map((value) =>
                        value === "disabled" ? rename.oldLevel : value,
                      ),
                    },
                  }),
                }),
              ),
            }
          : rule;
      }),
    );
    oldRulesCache.set(builtin, oldRules);
  }
  // Case, affixes, API/site scoping, and later overrides stay in the original rule engine --
  // no second matcher.
  const values = oldRules.resolve({
    providerId: selection.providerId,
    modelId: selection.modelId,
    templateId: snapshot.resolution.effectiveProviders.getRule(selection.providerId)?.templateId,
    apiType: provider.api?.type,
    baseUrl: provider.api?.baseUrl,
  }).optionSpecs?.reasoningLevel?.values;
  return values?.includes(oldLevel) ? "disabled" : undefined;
}
