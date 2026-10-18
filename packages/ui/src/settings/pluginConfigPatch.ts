import type { ZCodePluginInfo, ZCodePluginUserConfigOption } from "@zcode/shared";

export type PluginOptionDraftValue = string | number | boolean | null;

export interface PluginConfigPatch {
  options: Record<string, string | number | boolean>;
  clearOptionKeys: string[];
}

/**
 * Build the plugin-config write patch.
 *
 * configuredOptions is the current scope's effective values; never write it back as a whole draft on save,
 * or a Workspace page changing one field would also fossilize User/default's other fields into a
 * Workspace override. Only fields that explicitly produced a draft belong to this write.
 */
export function buildPluginConfigPatch(
  plugin: Pick<ZCodePluginInfo, "userConfig">,
  drafts: Record<string, PluginOptionDraftValue | undefined>,
): PluginConfigPatch {
  const options: Record<string, string | number | boolean> = {};
  const clearOptionKeys: string[] = [];

  for (const [key, option] of Object.entries(plugin.userConfig ?? {}) as [
    string,
    ZCodePluginUserConfigOption,
  ][]) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    if (draft === null) {
      clearOptionKeys.push(key);
      continue;
    }

    // An empty sensitive string still means leave-existing-alone; only null explicitly clears.
    if (option.sensitive && draft === "") continue;

    if (option.type === "number") {
      const numeric = typeof draft === "number" ? draft : Number(draft);
      if (Number.isFinite(numeric)) options[key] = numeric;
      continue;
    }
    options[key] = draft;
  }

  return { options, clearOptionKeys };
}
