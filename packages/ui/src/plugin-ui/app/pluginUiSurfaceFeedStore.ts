import {
  EMPTY_PLUGIN_UI_SURFACE_FEED,
  mergePluginUiSurfaceFeed,
  type PluginUiSurfaceFeed,
} from "../domain/pluginUiToolFeed.js";

/**
 * Owner of pane feed snapshots (renderer memory, not persisted). Keyed buildPluginUiSurfaceKey(target, surfaceScope),
 * same isolation as surface/widgetState stores. Pane models merge reduced snapshots here, so reopen and window
 * truncation still yield the last good result. Merge by rowId only, never regress.
 */
const feeds = new Map<string, PluginUiSurfaceFeed>();
const listeners = new Set<() => void>();

export function getPluginUiSurfaceFeed(key: string): PluginUiSurfaceFeed {
  return feeds.get(key) ?? EMPTY_PLUGIN_UI_SURFACE_FEED;
}

/** Returns the stored snapshot; unchanged input returns the same reference without notifying. */
export function offerPluginUiSurfaceFeed(
  key: string,
  candidate: PluginUiSurfaceFeed,
): PluginUiSurfaceFeed {
  const current = getPluginUiSurfaceFeed(key);
  const next = mergePluginUiSurfaceFeed(current, candidate);
  if (next === current) return current;
  feeds.set(key, next);
  for (const listener of listeners) listener();
  return next;
}

export function subscribePluginUiSurfaceFeeds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: clear all records. */
export function resetPluginUiSurfaceFeedsForTest(): void {
  feeds.clear();
  listeners.clear();
}

export function clearPluginUiSurfaceFeed(key: string): void {
  feeds.delete(key);
}
