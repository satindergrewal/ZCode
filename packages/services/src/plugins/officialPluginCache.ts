import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";

/**
 * Keep in sync with defaultEnabled in apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts.
 * services consumers (skills/commands/subagents) share this one list; a missed entry forked zcode-guide once already.
 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "document-skills@zcode-plugins-official",
  // The host contributes no skills/commands/subagents; listed only to mirror definitions' defaultEnabled one-for-one
  // (see the same-named set in @zcode/shared). No mirror test guards this, so misses fork silently.
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
]);

export interface OfficialPluginCacheRoot {
  /** Cache directory name, i.e. the official plugin name. */
  name: string;
  /** Version dirs, version-aware descending; first is newest. */
  versionRoots: string[];
}

/**
 * Scans `<plugins storage>/cache/zcode-plugins-official/<name>/<version>/`.
 * Builtin plugins are seeded here by the CLI with no installed_plugins.json row, so install-record-only reads miss them.
 * Skip CLI backup/lock/temp dirs, sort version-aware descending, matching the CLI's fallback pick.
 */
export async function scanOfficialPluginCacheRoots(
  pluginStorageRoot: string,
): Promise<OfficialPluginCacheRoot[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries;
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: OfficialPluginCacheRoot[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries;
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const versionRoots = versionEntries
      .filter((entry) => entry.isDirectory() && !isTransientCacheEntryName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map((version) => join(pluginDir, version));
    if (versionRoots.length > 0) {
      roots.push({ name: pluginEntry.name, versionRoots });
    }
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name));
}

function isTransientCacheEntryName(name: string): boolean {
  return name.includes(".backup") || name.includes(".seed-lock") || name.includes(".tmp-");
}
