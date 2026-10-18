import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";

/**
 * Resolve a marketplace id into a user-friendly display name:
 * prefer the name from the marketplaces overview, falling back to the raw id.
 * Pure, so the directory header and the installed-source label share one naming.
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
): string {
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}
