export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";

/** Shared by the settings' three resource discoverers; the bootstrap unit test mechanically compares official definitions' defaultEnabled. */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "image-search@zcode-plugins-official",
  "documents@zcode-plugins-official",
  "pdf@zcode-plugins-official",
  "presentations@zcode-plugins-official",
  "spreadsheets@zcode-plugins-official",
  // The node_repl host: not in the marketplace, never user-visible, contributes no skill/command/subagent, yet must
  // always be available--its gate is "Browser Use or Computer Use enabled", which the host
  // itself does not join. Browser Use defaults on; a default-off host would mean no host at startup.
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "plugin-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
  // Computer control defaults off, so computer-use is not in this set.
  // Must correspond one-to-one with defaultEnabled-marked plugins in official-plugin-definitions.ts;
  // the bootstrap test "settings defaults == CLI official declarations" compares them mechanically.
]);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // ZCode's only official marketplace: local seed shards and CDN shards merge inside agent storage.
    // The CDN manifest's name must equal this canonical id.
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official ZCode plugins marketplace: built-in and community plugins for ZCode.",
    pluginCount: 0,
  },
];

// The store's public segment has one ZCode official marketplace id; built-in and CDN no longer split identities.
export const PUBLIC_STORE_MARKETPLACE_IDS = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
