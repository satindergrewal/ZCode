import {
  projectModelSelectionProviderView,
  type ModelSelectionView,
  type ProviderRegistryView,
} from "@zcode/provider";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";

/** Off-Peak projects the fixed hidden provider only; hidden candidates never enter normal user selection. */
export function buildOffPeakModelSelectionView(registry: ProviderRegistryView): ModelSelectionView {
  const providerIds = new Set<string>(Object.values(OFF_PEAK_PROVIDER_IDS));
  const providers = registry.providers.filter(
    (candidate) =>
      providerIds.has(candidate.providerId) && candidate.config.visibility === "hidden",
  );
  return Object.freeze({
    revision: registry.revision,
    providers: Object.freeze(providers.map(projectModelSelectionProviderView)),
  });
}
