import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = ["browser-use-plugin"] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Dev-mode remote plugin copies use a separate allowlist; omitting agents would lose subagents on the remote only.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser bootstrap dynamically imports scripts/browser-client.mjs from the plugin root. Dev-mode
  // SSH deploys without scripts leave an MCP server running whose browser binding never initializes.
  "scripts",
  "skills",
  "templates",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS = [
  ...REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.map(
    (packageName) => `${packageName}/.zcode-plugin/plugin.json`,
  ),
  // Validating only the Browser Use manifest misreads a hollow plugin shell as reusable. Production
  // remote, dev remote, and release-source validation share this required-asset contract.
  //
  // Only assets browser-use itself produces belong here. Since the node_repl host moved to
  // @zcode/node-repl-host, browser-use no longer emits dist/mcp/server.js; listing nonexistent files
  // makes remote asset validation report missing ghost paths. Remote workspaces carry no Browser
  // Use/Computer Use today, so the host runtime stays out of this remote contract: to support remote
  // bua/cua, add node-repl-host to PACKAGE_NAMES above and declare its dist/mcp/server.js here
  // instead of pinning host artifacts onto browser-use.
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // Without the recording body in the remote cache, documents.json still falsely advertises that lookup.
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // Manifest-only validation cannot detect a docs plugin missing skill bodies or the visual-review agent.
] as const;

export function buildRemoteAgentOfficialPluginDir(remoteProviderDir: string): string {
  return posix.join(remoteProviderDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
}

export function buildRemoteAgentOfficialPluginSourceRelativePath(params: {
  runtimeResourceDir: string;
  platformArch: string;
}): string {
  return posix.join(
    params.runtimeResourceDir,
    params.platformArch,
    REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  );
}

export function buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir: string): string[] {
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  return REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.map((relativePath) =>
    posix.join(remoteOfficialPluginDir, relativePath),
  );
}
