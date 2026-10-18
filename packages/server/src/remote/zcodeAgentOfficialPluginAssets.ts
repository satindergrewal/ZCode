import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = [
  "android-emulator-plugin",
  "browser-use-plugin",
  "zcode-cua-plugin",
  "documents-plugin",
  "pdf-plugin",
  "presentations-plugin",
  "spreadsheets-plugin",
  "image-search-plugin",
  "ios-simulator-plugin",
  "restore-legacy-sessions-plugin",
  "skill-creator-plugin",
  "plugin-creator-plugin",
  "zcode-guide-plugin",
  "visualize-plugin",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Dev-mode remote plugin copying uses its own allowlist; a missing agents entry only loses subagents on the remote side.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser bootstrap dynamically imports scripts/browser-client.mjs from the plugin root.
  // If the dev-mode SSH deploy skips scripts, the MCP server starts but browser binding never initializes - a half-deployed state.
  "scripts",
  "skills",
  "templates",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS = [
  ...REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.map(
    (packageName) => `${packageName}/.zcode-plugin/plugin.json`,
  ),
  // Validating only the Browser Use manifest mistakes a hollow "plugin shell" directory
  // for a reusable one. Production remote, dev-mode remote and release source checks share this required-asset contract.
  //
  // Only assets produced by browser-use itself belong here. After the node_repl host moved to @zcode/node-repl-host,
  // browser-use no longer produces dist/mcp/server.js;
  // entries in this manifest pointing at missing files would make remote asset verification report ghost paths.
  // Remote workspaces do not host Browser Use / Computer Use yet, so the host runtime stays out of this remote contract:
  // to support remote bua/cua, add node-repl-host to PACKAGE_NAMES above and declare its
  // dist/mcp/server.js here, instead of pinning host artifacts onto browser-use.
  "visualize-plugin/skills/visualize/SKILL.md",
  "visualize-plugin/skills/visualize/references/api.md",
  "visualize-plugin/skills/visualize/references/styles.md",
  "visualize-plugin/skills/visualize/tweak.md",
  "visualize-plugin/skills/visualize/LICENSE.md",
  "visualize-plugin/skills/visualize/scripts/render.py",
  "visualize-plugin/skills/visualize/assets/visualize.css",
  "visualize-plugin/skills/visualize/assets/visualize.html",
  "visualize-plugin/skills/visualize/assets/calendar.js",
  "visualize-plugin/skills/visualize/assets/runtime-manifest.json",
  "visualize-plugin/skills/visualize/scripts/vendor.py",
  "visualize-plugin/skills/visualize/assets/vendor/manifest.json",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/lucide-1.17.0.js",
  "visualize-plugin/skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/d3-7.9.0.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/standalone-host-bridge.js",
  "visualize-plugin/skills/visualize/assets/standalone-shell.js",
  "visualize-plugin/skills/visualize/widgets/calendar.md",
  "visualize-plugin/skills/visualize/examples/calendar.html",
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // If the remote cache lacks recording bodies, documents.json would still wrongly advertise that lookup as available.
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // Fix reason: manifest-only validation cannot detect a doc plugin missing skill bodies or the visual-review agent.
  "image-search-plugin/.mcp.json",
  "documents-plugin/agents/visual-judge.md",
  "documents-plugin/skills/docx/SKILL.md",
  "pdf-plugin/agents/visual-judge.md",
  "pdf-plugin/skills/pdf/SKILL.md",
  "presentations-plugin/agents/visual-judge.md",
  "presentations-plugin/skills/pptx/SKILL.md",
  "spreadsheets-plugin/agents/visual-judge.md",
  "spreadsheets-plugin/skills/xlsx/SKILL.md",
  "zcode-cua-plugin/docs/computer-use.md",
  "zcode-cua-plugin/scripts/computer-use-client.mjs",
  "zcode-cua-plugin/skills/computer-use/SKILL.md",
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
