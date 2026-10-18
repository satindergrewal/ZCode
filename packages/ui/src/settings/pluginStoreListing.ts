import type {
  PluginStoreModeOrder,
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginStoreListing,
} from "@zcode/shared";
import {
  sortPluginStoreEntries,
  compareDocumentPluginPriority,
  resolvePluginStoreCategory as resolveStoreCategory,
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  formatCanonicalPluginName,
  isPublicStoreMarketplaceId,
  resolveLocalizedText,
  resolvePluginDisplayName,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
} from "@zcode/shared";
import { DEFAULT_MARKETPLACE_ID } from "@/settings/recommendedPlugins.js";
import { pluginSearchMatches } from "@/settings/pluginSearch.js";

export {
  formatCanonicalPluginName,
  resolveLocalizedText,
  resolvePluginDisplayName,
} from "@zcode/shared";

export { isPublicStoreMarketplaceId };
export { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

/**
 // Fall back to resolving a listing from a directory entry only when the name is unique.
 // Legacy capability payloads may lack pluginId; joining by bare name while same-named plugins coexist
 // misbrands one marketplace's entry with another's identity; degrading to slug is safer.
 */
export function resolveUniquePluginListingByName(
  plugins: readonly Pick<ZCodeAvailablePluginSummary, "name" | "listing">[],
  name: string,
): ZCodePluginStoreListing | undefined {
  const normalizedName = name.trim().toLocaleLowerCase();
  let match: ZCodePluginStoreListing | undefined;
  let count = 0;
  for (const plugin of plugins) {
    if (plugin.name.trim().toLocaleLowerCase() !== normalizedName) continue;
    count += 1;
    match = plugin.listing;
  }
  return count === 1 ? match : undefined;
}

/**
 // Store entry: join the overview's catalog entry (listing/install state), runtime plugin info (enabled/components) and
 // the install record (update badge/installed at) by id into one UI view model.
 */
export interface StorePluginItem {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  // Uninstalled builtin (restorable): the install button routes to restoreBuiltin.
  restorable: boolean;
  // Installed but its marketplace was removed; still runs and manages, but cannot update.
  orphaned: boolean;
  listing?: ZCodePluginStoreListing;
  summary?: ZCodeAvailablePluginSummary;
  // Runtime info (only discovered installed plugins): enabled state, components, manifest fallback fields.
  info?: ZCodePluginInfo;
  installedMeta?: ZCodeInstalledPluginSummary;
}

export type PluginUpdateStatus = NonNullable<ZCodeInstalledPluginSummary["updateStatus"]>;

export function isPluginUpdatePending(
  updateStatus: PluginUpdateStatus | undefined,
): updateStatus is Exclude<PluginUpdateStatus, "none"> {
  return updateStatus === "update-available" || updateStatus === "version-changed";
}

/**
 // Orphaned plugins may keep a pre-removal updateStatus; judging only that cached state
 // leaves an update button on a detail whose menu disabled updates. Updatability needs source-exists AND update-available.
 */
export function canUpdatePluginItem(
  item: Pick<StorePluginItem, "installedMeta" | "orphaned"> | null | undefined,
): boolean {
  return Boolean(item && !item.orphaned && isPluginUpdatePending(item.installedMeta?.updateStatus));
}

export function resolveLocalizedList(
  locale: string,
  base: string[] | undefined,
  i18n: Record<string, string[]> | undefined,
): string[] | undefined {
  if (i18n) {
    const exact = i18n[locale];
    if (exact && exact.length > 0) return exact;
    const language = locale.split("-")[0];
    if (language) {
      const match = Object.entries(i18n).find(([key]) => key.split("-")[0] === language);
      if (match?.[1] && match[1].length > 0) return match[1];
    }
  }
  return base && base.length > 0 ? base : undefined;
}

export function formatCanonicalMarketplaceName(name: string, locale: string): string {
  return formatCanonicalPluginName(name, locale);
}

export function resolveItemDisplayName(item: StorePluginItem, locale: string): string {
  return resolvePluginDisplayName(item, locale);
}

export function resolveItemDescription(item: StorePluginItem, locale: string): string | undefined {
  const base =
    item.summary?.description ?? item.info?.description ?? item.installedMeta?.description;
  return resolveLocalizedText(locale, base, item.listing?.descriptionI18n);
}

/** Management list and store share the full-ID-keyed display info, so English manifests cannot bypass localization. */
export function resolveManagedPluginDisplay(
  plugin: ZCodePluginInfo,
  item: StorePluginItem | undefined,
  locale: string,
): { name: string; description: string | undefined } {
  const matchingItem = item?.id === plugin.id ? item : undefined;
  return {
    name: resolvePluginDisplayName(matchingItem ?? plugin, locale),
    description: matchingItem ? resolveItemDescription(matchingItem, locale) : plugin.description,
  };
}

/** i18n mapping for known categories; unknown render verbatim. No category -> the other section (last). */
export const KNOWN_CATEGORY_LABEL_IDS: Record<string, string> = {
  "developer-tools": "settings.plugins.store.category.developerTools",
  productivity: "settings.plugins.store.category.productivity",
  utilities: "settings.plugins.store.category.utilities",
  legal: "settings.plugins.store.category.legal",
  template: "settings.plugins.store.category.template",
  finance: "settings.plugins.store.category.finance",
  other: "settings.plugins.store.category.other",
};

export {
  resolvePluginStoreCategory as resolveStoreCategory,
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  PLUGIN_STORE_CATEGORY_ORDER as KNOWN_CATEGORY_ORDER,
} from "@zcode/shared";

export interface StoreCategoryGroup {
  category: string;
  items: StorePluginItem[];
}

/** Personal-section marketplace groups: marketplace is the sort key, title the display name. */
export interface PersonalMarketplaceGroup {
  marketplace: string;
  title: string;
  items: StorePluginItem[];
}

const OFFICIAL_MARKETPLACE_ORDER = [
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  DEFAULT_MARKETPLACE_ID,
] as const;

/**
 // Marketplace-source ordering: official pinned first; custom by last-refresh desc, never-refreshed last.
 // Ties fall back to the localized name for stability, so order never drifts with persistence history.
 */
export function sortMarketplaceSources(
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): ZCodePluginMarketplaceSummary[] {
  const officialRank = new Map(OFFICIAL_MARKETPLACE_ORDER.map((id, index) => [id, index]));
  return marketplaces.toSorted((left, right) => {
    const leftRank = officialRank.get(left.id);
    const rightRank = officialRank.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }

    const leftAt = left.lastUpdated ?? "";
    const rightAt = right.lastUpdated ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    const byName = left.name.localeCompare(right.name, locale);
    return byName !== 0 ? byName : left.id.localeCompare(right.id, locale);
  });
}

/**
 // Personal-section group order: lastUpdated desc. Recently refreshed/added markets on top,
 // visible first when the user lands after adding; entries without lastUpdated (unrefreshed official seed) sink.
 // Full ties or both-missing fall back to display-name ascending; ISO strings sort as time.
 */
export function sortPersonalMarketplaceGroups(
  groups: PersonalMarketplaceGroup[],
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): PersonalMarketplaceGroup[] {
  const lastUpdatedById = new Map(
    marketplaces.flatMap((marketplace) =>
      marketplace.lastUpdated ? ([[marketplace.id, marketplace.lastUpdated]] as const) : [],
    ),
  );
  return groups.toSorted((left, right) => {
    const leftAt = lastUpdatedById.get(left.marketplace) ?? "";
    const rightAt = lastUpdatedById.get(right.marketplace) ?? "";
    // The empty string sorts before any timestamp, so the desc comparison naturally sinks missing times.
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return left.title.localeCompare(right.title, locale);
  });
}

/**
 // Join overview data into the store entry set.
 // Universe = availablePlugins union restorableBuiltins union actually-discovered plugin packages (covering inline/orphans).
 */
export function buildStoreItems(input: {
  marketplaces: ZCodePluginMarketplaceSummary[];
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  plugins: ZCodePluginInfo[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
}): StorePluginItem[] {
  const infoById = new Map(input.plugins.map((plugin) => [plugin.id, plugin]));
  const metaById = new Map(input.installedPlugins.map((item) => [item.id, item]));
  const marketplaceIds = new Set(input.marketplaces.map((item) => item.id));
  const items = new Map<string, StorePluginItem>();

  for (const summary of input.availablePlugins) {
    const info = infoById.get(summary.id);
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed:
        info?.packageStatus === "missing" ? false : summary.installed || info !== undefined,
      restorable: false,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
      ...(info ? { info } : {}),
      ...(metaById.get(summary.id) ? { installedMeta: metaById.get(summary.id) } : {}),
    });
  }
  for (const summary of input.restorableBuiltins) {
    const existing = items.get(summary.id);
    if (existing) {
      // An uninstalled builtin exists both in the full catalog and the restorable list: overwrite to restorable only without real
      // marketplace ownership. If installed/installedMeta/info already show a same-named CDN plugin owned by the user, keep installed
      // so the detail does not misshow Restore.
      const hasMarketplaceOwnership =
        existing.installed || existing.installedMeta !== undefined || existing.info !== undefined;
      if (hasMarketplaceOwnership) continue;
      items.set(summary.id, {
        ...existing,
        installed: false,
        restorable: true,
        ...(existing.listing || summary.listing
          ? { listing: existing.listing ?? summary.listing }
          : {}),
        ...(existing.summary ? {} : { summary }),
      });
      continue;
    }
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed: false,
      restorable: true,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
    });
  }
  // Runtime-discovered plugins absent from every catalog (inline, leftovers of removed markets) stay visible/searchable.
  for (const info of input.plugins) {
    if (items.has(info.id)) continue;
    // After a plugin split/removal the config still yields missing-package diagnostics; not an installable source.
    // Keep them for the settings diagnostics, but no store entry from them; catalog/restorable entries are kept above.
    if (info.packageStatus === "missing") continue;
    items.set(info.id, {
      id: info.id,
      name: info.name,
      marketplace: info.marketplace,
      installed: true,
      restorable: false,
      // A missing catalog entry does not mean the source was deleted; with overview failing, source state is unknown too.
      // official/inline plugins must not be derived into orphaned installs from a missing catalog.
      orphaned:
        input.marketplaceAvailabilityKnown &&
        info.source === "cache" &&
        !marketplaceIds.has(info.marketplace),
      info,
      ...(metaById.get(info.id) ? { installedMeta: metaById.get(info.id) } : {}),
    });
  }
  return [...items.values()];
}

/** Public section: Featured (CDN list, in order) + category groups (uncategorized into other, last). */
export function selectFeaturedItems(
  publicItems: StorePluginItem[],
  marketplaces: ZCodePluginMarketplaceSummary[],
): StorePluginItem[] {
  const byName = new Map<string, StorePluginItem>();
  for (const item of publicItems) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  const featured: StorePluginItem[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    if (!isPublicStoreMarketplaceId(marketplace.id)) continue;
    for (const name of marketplace.featured ?? []) {
      const item = byName.get(name);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        featured.push(item);
      }
    }
  }
  return featured;
}

export function groupItemsByCategory(
  items: StorePluginItem[],
  locale: string,
  order?: PluginStoreModeOrder,
): StoreCategoryGroup[] {
  const groups = new Map<string, StorePluginItem[]>();
  const sorted = sortPluginStoreEntries(
    items,
    (item) => ({
      id: item.id,
      category: item.listing?.category,
      displayName: resolveItemDisplayName(item, locale),
    }),
    locale,
    order,
  );
  for (const item of sorted) {
    const category = resolveStoreCategory(item.listing?.category) ?? FALLBACK_CATEGORY;
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}

export function storeItemMatches(item: StorePluginItem, keyword: string, locale: string): boolean {
  return pluginSearchMatches(
    keyword,
    [
      item.name,
      item.id,
      item.marketplace,
      resolveItemDisplayName(item, locale),
      resolveItemDescription(item, locale) ?? "",
      item.listing?.category ?? "",
      item.listing?.author ?? "",
    ],
    [item.name, item.listing?.displayName, ...Object.values(item.listing?.displayNameI18n ?? {})],
  );
}

/**
 // Installed-icon row order: official doc plugins first, then other builtin/inline by name;
 // marketplace installs after, by install time desc, name as tiebreak.
 */
export function sortInstalledStripItems(
  items: StorePluginItem[],
  locale: string,
): StorePluginItem[] {
  return items.toSorted((left, right) => {
    const documentPriority = compareDocumentPluginPriority(left.id, right.id);
    if (documentPriority !== 0) return documentPriority;

    const leftIsBuiltin = Boolean(left.info && left.info.source !== "cache");
    const rightIsBuiltin = Boolean(right.info && right.info.source !== "cache");
    if (leftIsBuiltin !== rightIsBuiltin) return leftIsBuiltin ? -1 : 1;

    const compareByName = () =>
      resolveItemDisplayName(left, locale).localeCompare(
        resolveItemDisplayName(right, locale),
        locale,
      );
    if (leftIsBuiltin) return compareByName();

    const leftAt = left.installedMeta?.installedAt ?? "";
    const rightAt = right.installedMeta?.installedAt ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return compareByName();
  });
}
