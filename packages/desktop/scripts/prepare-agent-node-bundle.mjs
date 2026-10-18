#!/usr/bin/env node

// Desktop-packaged agent runtime asset: place the agent JS bundle (zcode.cjs) under bundled-agents/<platform>/glm,
// executed by the app's own Electron Node runtime (ELECTRON_RUN_AS_NODE), replacing the previously bundled standalone Node binary.
//
// Why:
// - the agent has no native NAPI addons (ripgrep is WASM, the rest pure JS) and runs directly on Electron's Node;
// - Electron 41 embeds Node 24.x, matching zcode-cli's target runtime;
// - per-platform size drops from ~180MB to ~16MB, and one JS build serves all platforms;
// - the app-server command path never loads @zcode/tui, so the TUI is naturally not packaged here.
//
// Remote targets (SSH/WSL/Docker) have no Electron and keep using prepare:remote-assets native binaries; the two paths are independent.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { access, cp, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const adaptersRoot = resolve(repoRoot, "apps/zcode-cli/packages/adapters");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 triggers an install before runs in the apps/zcode-cli sub-workspace;
  // that workspace cannot resolve the root workspace's @zcode/shared, stalling Docker/web app packaging at plugin runtime build.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";

// Platform dir naming: darwin/win32/linux + x64/arm64;
// ZCODE_TARGET_OS / ZCODE_TARGET_ARCH overrides supported (injected by CI for cross-packaging).
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// zcode.cjs / .node-bundle-meta.json destinations are resolved by stage-agent-bundle.mjs itself (same source of truth).
// After the node_repl host moved to the standalone @zcode/node-repl-host package, browser-use no
// longer emits dist/mcp/server.js, and the CUA assets (docs/computer-use.md, scripts/computer-use-client.mjs)
// moved to @zcode/zcode-cua-plugin.
// This manifest missed that change, so packaging kept requesting those three files from browser-use and died with missing runtime.
// The dev path uses scripts/build-desktop-agent-cli.mjs's requiredDevPluginRuntimeBuilds (updated correctly);
// the two parallel lists are maintained separately, which is why dev never caught it. Authoritative ownership: bootstrap/official-plugin-definitions.ts.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json now exposes the recording lookup; the desktop package must not reuse a runtime lacking bodies.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const officialPluginPackages = [
  {
    // browser-use carries only its own client script and skill/docs; the node_repl MCP runtime belongs to
    // @zcode/node-repl-host (see the constant comment above).
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },

  {
    // node_repl host: the MCP runtime shared by Browser Use and Computer Use, split into its own package this round.
    // It has no listing (not shown in the plugin market), but first-launch seeding in production needs its dist runtime,
    // or bua/cua cannot reach node_repl when either is enabled.
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
];
// CLI-bundled skill packs (not plugins): bootstrap's resolveBundledSkillRoots looks beside zcode.cjs for
// packages/bundled-skills in the same candidate dirs as official plugins and reads in place. Without staging it,
// the desktop /workflow prompt expands to load the dynamic-workflows skill whose files do not exist, so it must ship with the agent.
const bundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["skills"],
};
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron production resource copying has its own allowlist; missing agents permanently drops subagents from first-launch filesystem seed.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // Reuse the repo-root script (turbo build:desktop-agent --filter=@zcode/cli); near-instant on cache hit.
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime(plugin);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote builds remote assets and the desktop agent bundle back to back.
  // Via pnpm/filter the plugin build's tsc shim easily gets SIGKILLed in low-memory local environments;
  // only under the bootstrap flag, run the equivalent tsc + build-mcp with the current Node, leaving the plugin's own build script untouched.
  // browser-use server and browser-client are one release pair; rebuild even when an old server.js exists,
  // or the staged desktop package pairs a stale server with the current (or missing) client.
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageBundle() {
  // Implementation lives in stage-agent-bundle.mjs; the dev path (scripts/build-desktop-agent-cli.mjs)
  // must share it, or dev keeps running the stale agent left by the previous package run.
  stageAgentBundle({ repoRoot, platformKey });
}

function stageOfficialPlugins() {
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

async function stageBundledSkillPack() {
  const sourceRoot = resolve(repoRoot, bundledSkillPack.relativePath);
  const targetRoot = resolve(glmDir, bundledSkillPack.stagedPath);
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of bundledSkillPack.topLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    await cp(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of bundledSkillPack.requiredPaths) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    await access(stagedAssetPath);
  }
  console.log(`[prepare:agent-bundle] staged bundled skill pack ${bundledSkillPack.stagedPath}`);
}

// When the Electron production package carries only resources/glm/zcode.cjs, nothing near the app-server
// process __dirname looks like official plugin dirs, so startup seed finds no source and users never get built-in plugins.
// Place official plugins at glm/packages/*-plugin per bootstrap's rootCandidates so running zcode.cjs under Electron Node
// reuses the same filesystem seed logic.
// browser-use runtime declaration generation depends on @zcode/core/dist. A clean CI checkout lacks that artifact,
// so CLI deps must build before official plugins; stale dev-machine dist once masked this ordering bug.
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
stageOfficialPlugins();
await stageBundledSkillPack();
