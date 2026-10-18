export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";

/**
 * The Claude Code official marketplace (GitHub git source). Not a hard dependency: with GitHub unreachable refresh
 * always fails, and that failure must not surface as an error -- the UI silences its refresh failures (any cause) by this id.
 */
export const CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "claude-plugins-official";

/** Shared by the three Settings resource discoveries; the bootstrap test mechanically checks defaultEnabled against the official definition. */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "image-search@zcode-plugins-official",
  "documents@zcode-plugins-official",
  "pdf@zcode-plugins-official",
  "presentations@zcode-plugins-official",
  "spreadsheets@zcode-plugins-official",
  // node_repl host: not in the marketplace, not user-visible, contributes no skill/command/subagent -- yet must
  // always exist: its registration gate is Browser Use or Computer Use enabled, and the host itself
  // takes no part in that check. Browser Use defaults on; a default-off host would leave it hostless.
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "plugin-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
  // visualize (interactive views) shipped defaultEnabled in the CLI definition alongside the UI plugin but was missed here,
  // so Settings read it default-off, diverging from the CLI's actual state.
  "visualize@zcode-plugins-official",
  // Computer control defaults off, so computer-use is not in this list.
  // This set must map 1:1 onto plugins marked defaultEnabled in official-plugin-definitions.ts;
  // the bootstrap test checks the two mechanically.
]);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // ZCode's single official marketplace: local seed shards and CDN shards merge inside Agent storage.
    // The CDN manifest's name must equal this canonical id.
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official ZCode plugins marketplace: built-in and community plugins for ZCode.",
    pluginCount: 0,
  },
  {
    id: CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "anthropics/claude-plugins-official",
    name: CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description:
      "Directory of popular Claude Code extensions including development tools, productivity plugins, and MCP integrations",
    // Only the official catalog source is built in; remote manifest snapshots are not committed -- counts unknown before the first refresh.
    pluginCount: 0,
  },
];

// The store's public section has exactly one ZCode official market id; built-in and CDN no longer split identities.
export const PUBLIC_STORE_MARKETPLACE_IDS = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
