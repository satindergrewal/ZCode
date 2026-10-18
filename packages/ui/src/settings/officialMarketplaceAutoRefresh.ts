// Throttle gate for the store page's Catalog Auto-Refresh.
//
// Requirement: refresh the official marketplace on every store entry so new CDN plugins are visible without a manual refresh;
// but throttled (skip within the window of the last success) and debounced (no re-trigger while a request flies or right after failure).
//
// Gate = now - max(lastUpdated, lastAttemptAt) >= window.
// - lastUpdated comes from the agent's persisted known_marketplaces.json; any successful refresh (manual, session-recommended
// plugin flows) rewrites it, so it is shared across windows and restarts, and a manual refresh restarts the auto window.
// - lastAttemptAt is this module's in-memory attempt time. The UI's PluginMarketplaceSummary has no failure timestamp;
// keying on lastUpdated alone would have offline users fire a long-timeout request on every entry; recording at dispatch
// blocks both just-failed and still-in-flight repeats. Reset on process restart is acceptable (one more try).
// - The store page remounts on every entry (key carries pluginStoreOpenVersion); a component ref cannot hold throttle state,
// hence module level.

const OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS = 10 * 60_000;

const lastAttemptAtByMarketplace = new Map<string, number>();

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function shouldAutoRefreshMarketplace(params: {
  lastUpdated?: string;
  lastAttemptAt?: number;
  now: number;
}): boolean {
  const lastUpdatedAt = parseTimestamp(params.lastUpdated);
  const lastKnownAt = Math.max(lastUpdatedAt ?? -Infinity, params.lastAttemptAt ?? -Infinity);
  return params.now - lastKnownAt >= OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS;
}

/**
 // Decide whether to auto-refresh; on pass, record the attempt immediately (placeholder) and return true.
 // Decision and placeholder in one step, so effect re-runs or quick enter/exit cannot double-fire.
 */
export function claimMarketplaceAutoRefresh(
  marketplaceId: string,
  lastUpdated: string | undefined,
  now: number = Date.now(),
): boolean {
  const shouldRefresh = shouldAutoRefreshMarketplace({
    lastUpdated,
    lastAttemptAt: lastAttemptAtByMarketplace.get(marketplaceId),
    now,
  });
  if (shouldRefresh) {
    lastAttemptAtByMarketplace.set(marketplaceId, now);
  }
  return shouldRefresh;
}
