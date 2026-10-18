/**
 * Plugin ids look like name@marketplace; users see only the name. Pure, shared by source labels and confirms.
 */
export function formatPluginDisplayName(pluginId: string): string {
  const at = pluginId.indexOf("@");
  const name = at > 0 ? pluginId.slice(0, at) : pluginId;
  return name.trim() || pluginId;
}
