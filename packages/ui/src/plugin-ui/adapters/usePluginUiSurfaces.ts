import { useEffect, useState } from "react";
import type { PluginUiSurfaceEntry } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { usePluginStore } from "@/store/pluginStore.js";

export interface UsePluginUiSurfacesInput {
  workspacePath: string;
  workspaceIdentity?: string;
  /** false skips the fetch (no session/unsupported), returning empty. */
  enabled?: boolean;
}

/**
 * Workspace-level pane entries: read plugins/listUiSurfaces over the bridge.
 * Refresh signal reuses the plugin settings store: the installedPlugins id+enabled fingerprint (install/uninstall/toggle) refetches;
 * no extra event channel, no cross-workspace cache.
 */
export function usePluginUiSurfaces(input: UsePluginUiSurfacesInput): PluginUiSurfaceEntry[] {
  const bridge = useOptionalServices()?.pluginUiBridgeService;
  const pluginFingerprint = usePluginStore((state) =>
    state.installedPlugins.map((plugin) => `${plugin.id}:${plugin.enabled ? 1 : 0}`).join("|"),
  );
  const enabled = input.enabled !== false && Boolean(bridge);
  const [surfaces, setSurfaces] = useState<PluginUiSurfaceEntry[]>([]);

  useEffect(() => {
    if (!enabled || !bridge) {
      setSurfaces([]);
      return;
    }
    let cancelled = false;
    void bridge
      .listSurfaces({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      })
      .then((next) => {
        if (!cancelled) setSurfaces(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[plugin-ui] listSurfaces failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        setSurfaces([]);
      });
    return () => {
      cancelled = true;
    };
    // pluginFingerprint is a refresh signal only.
  }, [bridge, enabled, input.workspaceIdentity, input.workspacePath, pluginFingerprint]);

  return surfaces;
}

/** Manifest title may be locale-mapped; prefer locale, language prefix, en, then any value. */
export function resolvePluginUiSurfaceTitle(
  title: PluginUiSurfaceEntry["title"],
  locale: string,
): string {
  if (typeof title === "string") return title;
  const language = locale.split("-")[0] ?? locale;
  return (
    title[locale] ??
    title[language] ??
    Object.entries(title).find(([key]) =>
      key.toLowerCase().startsWith(language.toLowerCase()),
    )?.[1] ??
    title.en ??
    Object.values(title)[0] ??
    ""
  );
}
