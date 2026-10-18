interface RendererNavigationEntry {
  readonly type?: string;
}

function readRendererNavigationEntries(): RendererNavigationEntry[] {
  try {
    if (typeof globalThis.performance?.getEntriesByType !== "function") {
      return [];
    }
    return globalThis.performance.getEntriesByType("navigation") as RendererNavigationEntry[];
  } catch {
    return [];
  }
}

/**
 * Distinguish a cold app start from a reload of the same renderer.
 * The workspace/app entry must show only drafts, while a renderer reload in the output still restores the current pane and stream.
 */
export function isRendererReloadNavigation(
  entries: readonly RendererNavigationEntry[] = readRendererNavigationEntries(),
): boolean {
  return entries[0]?.type === "reload";
}
