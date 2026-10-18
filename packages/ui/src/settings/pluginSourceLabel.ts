import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";
import { DEFAULT_MARKETPLACE_ID } from "@/settings/recommendedPlugins.js";

// The official plugin source value agent-side; anything else (inline local dirs and friends) counts as built-in.
// Note: market-installed plugins have source cache; true provenance lives on plugin.marketplace.
const MARKETPLACE_INSTALLED_SOURCE = "cache";

/**
 * Resolve a marketplace id into a user-friendly display name:
 * prefer the name from the marketplaces overview, falling back to the raw id.
 * Pure, so the directory header and the installed-source label share one naming.
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  claudeCodePluginsLabel: string,
): string {
  if (marketplaceId === DEFAULT_MARKETPLACE_ID) {
    return claudeCodePluginsLabel;
  }
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}

/**
 * Installed-plugin source labels, two kinds only:
 * - market install (source cache): installed from the named market;
 * - everything else (official / inline and friends): built-in.
 */
export function resolvePluginSourceLabel(input: {
  source: string;
  marketplace: string;
  marketplaces: readonly ZCodePluginMarketplaceSummary[];
  builtinLabel: string;
  claudeCodePluginsLabel: string;
  formatFromMarketplace: (marketplaceName: string) => string;
}): string {
  if (input.source !== MARKETPLACE_INSTALLED_SOURCE) {
    return input.builtinLabel;
  }
  const marketplaceName = resolveMarketplaceDisplayName(
    input.marketplace,
    input.marketplaces,
    input.claudeCodePluginsLabel,
  );
  return input.formatFromMarketplace(marketplaceName);
}
