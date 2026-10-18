/**
 * At most one live sandbox per scope.
 * Keyed buildPluginUiSurfaceKey(target, scope); isolates workspace/session/plugin uniformly.
 * While the pane is open the inline card shows a placeholder; results carrying display.ui.surface use this to route (R4).
 * Records who renders only; no sandbox state. Renderer memory, never persisted.
 */
export type PluginUiSurface = "inline" | "side-pane";

const surfaces = new Map<string, Map<symbol, PluginUiSurface>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function claimPluginUiSurface(key: string, surface: PluginUiSurface): () => void {
  const token = Symbol();
  const claims = surfaces.get(key) ?? new Map<symbol, PluginUiSurface>();
  const before = getPluginUiSurface(key);
  claims.set(token, surface);
  surfaces.set(key, claims);
  if (before !== getPluginUiSurface(key)) notify();
  return () => {
    const before = getPluginUiSurface(key);
    claims.delete(token);
    if (!claims.size && surfaces.get(key) === claims) surfaces.delete(key);
    if (before !== getPluginUiSurface(key)) notify();
  };
}

export function getPluginUiSurface(key: string): PluginUiSurface | null {
  const claims = surfaces.get(key);
  return claims?.size
    ? [...claims.values()].includes("side-pane")
      ? "side-pane"
      : "inline"
    : null;
}

export function subscribePluginUiSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: clear all records. */
export function resetPluginUiSurfacesForTest(): void {
  surfaces.clear();
  listeners.clear();
}
