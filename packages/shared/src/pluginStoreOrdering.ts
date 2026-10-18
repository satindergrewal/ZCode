import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "./plugin-marketplaces.js";
import type { PluginStoreModeOrder } from "./pluginStoreOrder.js";

export const FALLBACK_PLUGIN_STORE_CATEGORY = "other";
export const PLUGIN_STORE_CATEGORY_ORDER: readonly string[] = [
  "productivity",
  "developer-tools",
  "utilities",
  "finance",
  "legal",
  "template",
];

// Full ids keep same-named personal-marketplace plugins from being pinned by mistake; every display reuses this order.
const DOCUMENT_PLUGIN_RANKS = new Map(
  ["pdf", "presentations", "spreadsheets", "documents"].map((name, index) => [
    `${name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
    index,
  ]),
);

export function compareDocumentPluginPriority(leftId: string, rightId: string): number {
  return compareRanks(DOCUMENT_PLUGIN_RANKS, leftId, rightId);
}

/** Category merge is display-only; the marketplace and reference Picker must share one sort key. */
export function resolvePluginStoreCategory(category: string | undefined): string | undefined {
  const normalized = category?.trim();
  return normalized === "guides" ? "utilities" : normalized || undefined;
}

interface PluginStoreSortEntry {
  id: string;
  category?: string;
  displayName: string;
}

/** Display-only ordering: configured first, remaining categories in product default order, doc plugins first within a category, localized-name tiebreak. */
export function sortPluginStoreEntries<T>(
  items: readonly T[],
  project: (item: T) => PluginStoreSortEntry,
  locale: string,
  order?: PluginStoreModeOrder,
): T[] {
  const categoryRanks = ranks(order?.categoryOrder);
  const pluginRanks = new Map(
    Object.entries(order?.pluginOrder ?? {}).map(([category, ids]) => [category, ranks(ids)]),
  );
  return items
    .map((item, index) => {
      const entry = project(item);
      return {
        item,
        index,
        ...entry,
        category: resolvePluginStoreCategory(entry.category) ?? FALLBACK_PLUGIN_STORE_CATEGORY,
      };
    })
    .sort(
      (left, right) =>
        compareRanks(categoryRanks, left.category, right.category) ||
        compareCategories(left.category, right.category) ||
        compareRanks(pluginRanks.get(left.category), left.id, right.id) ||
        compareDocumentPluginPriority(left.id, right.id) ||
        left.displayName.localeCompare(right.displayName, locale) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

function ranks(order: readonly string[] = []): Map<string, number> {
  const result = new Map<string, number>();
  for (const key of order) if (!result.has(key)) result.set(key, result.size);
  return result;
}
function compareRanks(order: Map<string, number> | undefined, left: string, right: string): number {
  if (!order) return 0;
  return (order.get(left) ?? order.size) - (order.get(right) ?? order.size);
}
function compareCategories(left: string, right: string): number {
  if (left === right) return 0;
  if (left === FALLBACK_PLUGIN_STORE_CATEGORY) return 1;
  if (right === FALLBACK_PLUGIN_STORE_CATEGORY) return -1;
  const a = PLUGIN_STORE_CATEGORY_ORDER.indexOf(left);
  const b = PLUGIN_STORE_CATEGORY_ORDER.indexOf(right);
  if (a !== -1 && b !== -1) return a - b;
  if (a !== -1) return -1;
  if (b !== -1) return 1;
  return left < right ? -1 : 1;
}
