import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type SkillRoot } from "@zcode/contracts";

const VISUALIZE_PLUGIN_ID = `visualize@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export function filterVisualizeSkillRoots(
  roots: readonly SkillRoot[],
  includeVisualize = false,
): SkillRoot[] {
  // Bundled-plugin default-enable once made terminal sessions discover visualize too, but terminals have no inline-view host.
  // Filter to official-plugin identities only, sparing user/project skills of the same name; protocol entrypoints opt back in explicitly.
  return roots.filter((root) => includeVisualize || root.pluginId !== VISUALIZE_PLUGIN_ID);
}
