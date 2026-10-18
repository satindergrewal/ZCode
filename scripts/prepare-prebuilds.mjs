#!/usr/bin/env node
/* eslint-disable max-lines */

import { access, cp, mkdir } from "node:fs/promises";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveRemoteNativeSearchPrebuiltPlan } from "./remote-native-search-tools-config.mjs";
import { prepareNativeSearchTools } from "./prepare-native-search-tools.mjs";
import { stageNodeNotices, stageThirdPartyNotices } from "./third-party-notices.mjs";
import {
  computeDeterministicSourceSha256 as computeComponentSourceSha256,
  packSourceAsDeterministicTarGzip as packComponentSourceAsArchive,
} from "./deterministic-tar-archive.mjs";
import { runCommand } from "./spawn-command.mjs";
import { resolveIntranetDepsBaseUrl } from "./intranetDefaults.mjs";

export { computeComponentSourceSha256, packComponentSourceAsArchive };

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const desktopDir = join(rootDir, "packages/desktop");
const mockCdnDir = join(desktopDir, "mock-cdn");
const version = require(join(rootDir, "package.json")).version;
const ZCODE_AGENT_RUNTIME = {
  glm: {
    version: readZCodeAgentRuntimeVersion(),
  },
};
const releaseDir = join(mockCdnDir, "releases", version);
const nodeVersion = "v22.16.0";
const componentSchemaVersion = 1;
const remotePlatforms = ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"];
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

/**
 * Node dist download source. Defaults to a China mirror; override with
 * `ZCODE_NODE_DIST_MIRROR` (same convention as the identically named CI variable in
 * `.gitlab/ci/00-workflow.yml` and in `scripts/cua-helper-sea-base.mjs`).
 *
 * This used to hardcode `https://nodejs.org/dist`, which the macOS runner could not
 * reach — all 3 attempts failed with `UND_ERR_CONNECT_TIMEOUT` (10s). Worse, this file's
 * error message kept telling people to "check the Node.js mirror URL" when no such
 * knob existed.
 *
 * Why it went unnoticed: `mock-cdn` persists across jobs via GIT_CLEAN_FLAGS exclusions, while
 * `build:remote:assets` runs `rm -rf` on every release dir except its own $VERSION.
 * Version dirs therefore evict each other's persisted artifacts, and whichever gets evicted
 * must re-download from the source. Normally it logs `[skip] already exists`, so this network
 * path was rarely exercised.
 */
export const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";

export function nodeDistBase(env = process.env) {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";
// After the node_repl host was split into the standalone @zcode/node-repl-host package,
// browser-use no longer produces dist/mcp/server.js, and CUA assets moved to
// @zcode/zcode-cua-plugin. This is the **third** parallel manifest (the other two: production
// packaging in packages/desktop/scripts/prepare-agent-node-bundle.mjs and the dev build in
// scripts/build-desktop-agent-cli.mjs); only the dev copy was updated back then, so
// build:macos:arm64 and then build:remote:assets each failed with "missing runtime".
// Authoritative ownership lives in bootstrap/official-plugin-definitions.ts.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // The remote prebuild must share the desktop seed's recording-doc completeness contract.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const remoteOfficialPluginPackages = [
  // 44b25ed46c "remove bundled plugins except browser use and cua" removed the other bundled
  // plugin sources but missed this manifest, so bootstrap:with-remote threw missing on the very
  // first staged manifest. Keep this in sync with the desktop seed manifest in
  // packages/desktop/scripts/prepare-agent-node-bundle.mjs and the remote contract in
  // packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts.
  {
    // The remote shared-host must deploy the node_repl runtime, otherwise only the skill exists
    // with no mcp__node_repl__js — that runtime is now provided by @zcode/node-repl-host
    // (see next entry); browser-use only ships its own client script and skill/docs.
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },
  {
    // node_repl host: the MCP runtime shared by Browser Use and Computer Use. Without it the
    // remote shared-host has no mcp__node_repl__js and both bua/cua fail to connect.
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
];
// Skill packs bundled with the CLI (not plugins): the remote agent's bootstrap looks for
// packages/bundled-skills next to zcode.cjs via the same candidate dirs used for official
// plugins and reads them in place; same manifest as packages/desktop/scripts/prepare-agent-node-bundle.mjs.
const remoteBundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["skills"],
};
const remoteOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // The production remote prebuild has its own top-level allowlist; omitting agents would
  // permanently strip subagents before upload.
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
const remoteOfficialPluginRequiredPaths = [
  "packages/browser-use-plugin/.zcode-plugin/plugin.json",
  "packages/node-repl-host/.zcode-plugin/plugin.json",
];

function readZCodeAgentRuntimeVersion() {
  const runtimeSourcePath = join(rootDir, "packages/shared/src/zcode-agent-runtime.ts");
  const runtimeSource = readFileSync(runtimeSourcePath, "utf8");
  const match = runtimeSource.match(/version:\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new Error("Unable to parse ZCode Agent runtime version");
  }
  return match[1];
}

async function download(url, destinationPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  }
  if (!response.body) {
    throw new Error(`Download failed: empty response body (${url})`);
  }

  // The original response.pipe(file) + finish listener could neither resolve nor reject when
  // the network dropped, eventually triggering Node 24's unsettled top-level await. Switched to
  // pipeline so failure paths are observable and exit non-zero.
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destinationPath, { flags: "w" }),
  );
}

async function downloadWithRetry(url, destinationPath, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await download(url, destinationPath);
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.warn(`  [warn] download attempt ${attempt}/${maxAttempts} failed: ${url}`);
      console.warn(`  [warn] retry reason: ${String(error)}`);
    }
  }
}

async function extractArchiveMember(url, destinationDir, archiveMember) {
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-node-dist-"));
  const archivePath = join(tempDir, "node.tar.xz");

  try {
    await downloadWithRetry(url, archivePath);
    // Bugfix: on Windows the absolute path carries a drive-letter colon (C:\...) and GNU tar
    // (Git Bash) treats "C:" as a remote host, reporting "Cannot connect to C". Use cwd plus a
    // relative archive name to keep the colon out of -f. Backslash paths are also mangled by
    // MSYS tar argument conversion (\3 parsed as an escape); -C targets are normalized to
    // forward slashes, a no-op for bsdtar and Linux/macOS CI.
    runCommand(
      "tar",
      [
        "-xJf",
        "node.tar.xz",
        "--strip-components=2",
        "-C",
        destinationDir.replaceAll("\\", "/"),
        archiveMember,
      ],
      {
        cwd: tempDir,
      },
    );
  } finally {
    // Bugfix: on Windows a freshly written archive can be held briefly by antivirus/indexers or
    // an xz child that has not exited; rmSync right away hits EPERM, and an exception thrown in
    // finally masks the real download/extract error. Retry the deletion, warn only on failure,
    // and let the original error propagate.
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`  [warn] failed to remove temp dir (ignorable): ${tempDir}`);
      console.warn(`  [warn] ${String(error)}`);
    }
  }
}

function resolveDedicatedPackageRoot(packageName, fromDir) {
  const packageEntryPath = require.resolve(packageName, { paths: [fromDir] });
  let currentDir = dirname(packageEntryPath);

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = require(packageJsonPath);
      if (packageJson?.name === packageName) {
        return currentDir;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error(
    `Unable to resolve package root for ${packageName} from entry ${packageEntryPath}`,
  );
}

function resolveNodePtyPackageName(platformKey) {
  return `@lydell/node-pty-${platformKey}`;
}

function resolveNodePtyPackageVersion(platformKey) {
  const packageName = resolveNodePtyPackageName(platformKey);
  const packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
  const packageJson = require(join(packageRoot, "package.json"));
  if (typeof packageJson?.version !== "string" || !packageJson.version.trim()) {
    throw new Error(`Unable to resolve version for ${packageName}`);
  }
  return packageJson.version.trim();
}

async function prepareNodeBinaries() {
  for (const platformKey of remotePlatforms) {
    const nodeDir = join(releaseDir, "node", platformKey);
    const nodeBinaryPath = join(nodeDir, "node");
    await stageNodeNotices(nodeDir, nodeVersion, rootDir);

    if (existsSync(nodeBinaryPath)) {
      console.log(`  [skip] mock-cdn node/${platformKey} already exists`);
      continue;
    }

    mkdirSync(nodeDir, { recursive: true });
    const archiveName = `node-${nodeVersion}-${platformKey}.tar.xz`;
    const url = `${nodeDistBase()}/${nodeVersion}/${archiveName}`;

    console.log(`  [download] ${url}`);

    try {
      await extractArchiveMember(url, nodeDir, `node-${nodeVersion}-${platformKey}/bin/node`);
      chmodSync(nodeBinaryPath, 0o755);
      console.log(`  [ok] mock-cdn node/${platformKey}`);
    } catch (error) {
      console.error(`  [error] download or extraction failed: ${url}`);
      console.error(
        `  [error] check the CI runner's internet access and tar/xz availability, or override the download source with ZCODE_NODE_DIST_MIRROR (current ${nodeDistBase()})`,
      );
      throw error;
    }
  }
}

function buildServerBundle() {
  console.log("==> Building server bundle");

  try {
    if (isBootstrapWithRemote) {
      runBootstrapServerRemoteBuild();
      return;
    }

    // On Windows CI (Node 24), spawnSync("pnpm.cmd") throws EINVAL before the child starts.
    // Route through the cross-platform spawn wrapper so .cmd runs via shell/cmd.exe and remote
    // asset preparation does not abort early.
    runCommand(pnpmCommand, ["run", "build:remote"], {
      cwd: join(rootDir, "packages/server"),
    });
  } catch (error) {
    console.error(
      "  [error] packages/server build:remote failed; check the TypeScript / esbuild output in the CI logs first",
    );
    throw error;
  }
}

function runBootstrapServerRemoteBuild() {
  // bootstrap:with-remote chains install, remote assets, and the workspace build locally.
  // Do not reuse the existing zcode-server.cjs: in dev the package version often stays the same,
  // and a stale bundle would deploy a server missing new RPCs to the SSH remote. Keep only the
  // low-memory optimization of running tsx via the current Node; CI's build:remote is unchanged.
  runCommand(
    process.execPath,
    [join(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: join(rootDir, "packages/server"),
      env: process.env,
    },
  );
}

function copyServerBundle() {
  const serverDir = join(releaseDir, "server");
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(
    join(rootDir, "packages/server/dist/remote/zcode-server.cjs"),
    join(serverDir, "zcode-server.cjs"),
  );
  console.log("  [ok] mock-cdn server/zcode-server.cjs");
}

function copyNodePtyPrebuilds() {
  console.log("==> Copying node-pty prebuilds from @lydell/node-pty");

  for (const platformKey of remotePlatforms) {
    const ptyDir = join(releaseDir, "node-pty", platformKey);
    const targetBinaryPath = join(ptyDir, "pty.node");
    const targetSpawnHelperPath = join(ptyDir, "spawn-helper");
    const requiresSpawnHelper = platformKey.startsWith("darwin-");

    if (
      existsSync(targetBinaryPath) &&
      (!requiresSpawnHelper || existsSync(targetSpawnHelperPath))
    ) {
      console.log(`  [skip] mock-cdn node-pty/${platformKey} already exists`);
      continue;
    }

    mkdirSync(ptyDir, { recursive: true });

    const packageName = resolveNodePtyPackageName(platformKey);
    let packageRoot;
    try {
      packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
    } catch {
      console.log(`  [warn] ${packageName} not found, run: pnpm install`);
      continue;
    }

    const sourcePrebuildDir = join(packageRoot, "prebuilds", platformKey);
    const sourceBinaryPath = join(sourcePrebuildDir, "pty.node");
    if (!existsSync(sourceBinaryPath)) {
      console.log(`  [warn] binary not found at ${sourceBinaryPath}`);
      continue;
    }

    // On Darwin, node-pty needs spawn-helper in addition to pty.node. mock-cdn used to copy
    // only pty.node and remote deployment failed at terminal.create with posix_spawn ENOENT.
    // Copy spawn-helper into the remote assets too so remote terminals are never missing it.
    copyFileSync(sourceBinaryPath, targetBinaryPath);
    if (requiresSpawnHelper) {
      const sourceSpawnHelperPath = join(sourcePrebuildDir, "spawn-helper");
      if (!existsSync(sourceSpawnHelperPath)) {
        console.log(`  [warn] spawn-helper not found at ${sourceSpawnHelperPath}`);
        continue;
      }
      copyFileSync(sourceSpawnHelperPath, targetSpawnHelperPath);
      chmodSync(targetSpawnHelperPath, 0o755);
    }
    console.log(`  [ok] mock-cdn node-pty/${platformKey} (copied from ${packageName})`);
  }
}

function buildRemoteOfficialPluginRuntimes() {
  for (const plugin of remoteOfficialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`==> Building remote official plugin runtime: ${plugin.packageName}`);
    if (isBootstrapWithRemote) {
      buildRemoteOfficialPluginRuntimeForBootstrap(plugin);
      assertRemoteOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      pnpmCommand,
      ["--dir", join(rootDir, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: rootDir,
        env: process.env,
      },
    );
    assertRemoteOfficialPluginRuntime(plugin);
  }
}

function buildRemoteOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(join(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(`  [skip] reuse existing remote official plugin runtime: ${plugin.packageName}`);
    return;
  }

  // bootstrap:with-remote prepares remote assets and the workspace build serially.
  // Official plugin runtimes are only needed while staging assets; run the equivalent build with
  // the current Node instead of nesting pnpm/tsc shims. browser-use's MCP server and
  // browser-client must come from the same build; trusting a stale server.js for reuse would
  // mix stale or missing clients into the remote assets, so always rebuild it in bootstrap mode.
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertRemoteOfficialPluginRuntime(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare-prebuilds] missing remote official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageRemoteOfficialPlugins(glmDir) {
  for (const plugin of remoteOfficialPluginPackages) {
    const sourceRoot = join(rootDir, plugin.relativePath);
    const manifestPath = join(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `[prepare-prebuilds] missing remote official plugin manifest: ${manifestPath}`,
      );
    }

    const targetRoot = join(glmDir, ...plugin.stagedPath.split("/"));
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of remoteOfficialPluginTopLevelPaths) {
      const sourcePath = join(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, join(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of remoteOfficialPluginRequiredPaths) {
      if (!relativePath.startsWith(`${plugin.stagedPath}/`)) continue;
      const stagedAssetPath = join(glmDir, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare-prebuilds] missing staged remote official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`  [ok] mock-cdn glm official plugin ${plugin.stagedPath}`);
  }
}

async function stageRemoteBundledSkillPack(glmDir) {
  const sourceRoot = join(rootDir, remoteBundledSkillPack.relativePath);
  const targetRoot = join(glmDir, ...remoteBundledSkillPack.stagedPath.split("/"));
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of remoteBundledSkillPack.topLevelPaths) {
    const sourcePath = join(sourceRoot, entryName);
    await cp(sourcePath, join(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of remoteBundledSkillPack.requiredPaths) {
    const stagedAssetPath = join(targetRoot, ...relativePath.split("/"));
    await access(stagedAssetPath);
  }
  console.log(`  [ok] mock-cdn glm bundled skill pack ${remoteBundledSkillPack.stagedPath}`);
}

// Remote agents now run the compiled zcode.cjs instead of per-platform native binaries:
// remote deployment already has a dedicated node (running zcode-server.cjs) and the agent
// reuses it to run zcode.cjs, so there is no need for a per-platform SEA binary with an
// embedded node. zcode.cjs is identical across platforms; per platform it is just placed in
// its glm/<platform> component dir, keeping the existing manifest component structure.
async function stageRemoteAgentBundles() {
  console.log("==> Building zcode-cli bundle for remote agents");
  // Reuse the desktop build script (turbo build:desktop-agent --filter=@zcode/cli); near-instant on cache hits.
  runCommand(process.execPath, [join(rootDir, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: rootDir,
    env: process.env,
  });
  // browser-use runtime's tsc depends on @zcode/core/dist. Remote assets must build the
  // agent CLI deps first too, avoiding TS2307 on clean CI checkouts hidden by dev caches.
  buildRemoteOfficialPluginRuntimes();
  const cliBundlePath = join(rootDir, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[prepare-prebuilds] expected cli bundle missing: ${cliBundlePath}`);
  }

  for (const platformKey of remotePlatforms) {
    const glmDir = join(releaseDir, "glm", platformKey);
    // Clean rebuild: the glm component now contains only zcode.cjs; drop legacy native binaries
    // and stale meta so they do not bloat the component tar shipped to remotes.
    rmSync(glmDir, { recursive: true, force: true });
    mkdirSync(glmDir, { recursive: true });
    copyFileSync(cliBundlePath, join(glmDir, "zcode.cjs"));
    stageRemoteOfficialPlugins(glmDir);
    await stageRemoteBundledSkillPack(glmDir);
    console.log(`  [ok] mock-cdn glm/${platformKey}/zcode.cjs`);
  }
}

function canResolveIntranetDepsBaseUrl() {
  try {
    resolveIntranetDepsBaseUrl();
    return true;
  } catch {
    return false;
  }
}

export async function prepareRemoteNativeSearchTools({
  platforms = remotePlatforms,
  outputDir = join(releaseDir, "tools"),
} = {}) {
  console.log("==> Preparing local native search binaries for remote platforms");
  for (const platformKey of platforms) {
    const [targetOs, targetArch] = platformKey.split("-");
    if (!targetOs || !targetArch) {
      throw new Error(`Invalid remote platform key: ${platformKey}`);
    }

    await prepareNativeSearchTools({
      prebuiltPlan: resolveRemoteNativeSearchPrebuiltPlan({
        platform: targetOs,
        arch: targetArch,
        outputDir: join(outputDir, platformKey),
      }),
    });
  }
}

function joinPosix(...segments) {
  return segments.join("/").replace(/\/+/g, "/");
}

function normalizeSemanticPrefix(rawPrefix, fallback = "v1") {
  const prefix = String(rawPrefix ?? "").trim();
  if (!prefix) {
    return fallback;
  }

  const normalized = prefix.replace(/\+/g, "-");
  if (!normalized) {
    return fallback;
  }
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

function computeFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function buildComponentVersion(semanticPrefix) {
  return normalizeSemanticPrefix(semanticPrefix);
}

export function buildContentAddressedComponentVersion(semanticPrefix, sha256) {
  const normalizedSha = String(sha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedSha)) {
    throw new Error(`Invalid component sha256: ${sha256}`);
  }
  return `${buildComponentVersion(semanticPrefix)}+${normalizedSha.slice(0, 12)}`;
}

export function buildComponentArtifactRelativePath(platformKey, componentId, componentVersion) {
  return joinPosix("components", platformKey, componentId, `${componentVersion}.tar.gz`);
}

function resolveComponentSemanticVersion(componentVersion) {
  const version = String(componentVersion ?? "").trim();
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return version;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/.test(suffix) ? version.slice(0, plusIndex) : version;
}

// glm carries the zcode-cli app-server protocol schema. Even when the runtime version is
// unchanged, zcode.cjs can still change with app code; reusing an old glm across releases makes
// remote agents reject new protocol fields.
const nonReusableReleaseAssetIds = new Set(["server-bundle", "glm"]);

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function compareVersionSegments(left, right) {
  const leftParts = String(left).split(/[.-]/);
  const rightParts = String(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      continue;
    }

    const compared = leftPart.localeCompare(rightPart, undefined, {
      numeric: true,
    });
    if (compared !== 0) {
      return compared;
    }
  }

  return 0;
}

function findReusableReleaseDirs({ mockCdnDir, currentVersion }) {
  const releasesDir = join(mockCdnDir, "releases");
  if (!existsSync(releasesDir)) {
    return [];
  }

  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentVersion)
    .map((entry) => entry.name)
    .filter((candidate) => compareVersionSegments(candidate, currentVersion) < 0)
    .sort((left, right) => compareVersionSegments(right, left))
    .map((candidate) => join(releasesDir, candidate));
}

function normalizeManifestComponents(manifest) {
  if (!manifest || !Array.isArray(manifest.components)) {
    return new Map();
  }

  return new Map(
    manifest.components
      .filter((component) => typeof component?.id === "string")
      .map((component) => [component.id, component]),
  );
}

export function restoreReusableReleaseAssets({
  mockCdnDir,
  currentVersion,
  releaseDir,
  componentDefinitionsByPlatform,
}) {
  const previousReleaseDirs = findReusableReleaseDirs({
    mockCdnDir,
    currentVersion,
  });
  if (previousReleaseDirs.length === 0) {
    return;
  }

  for (const [platformKey, componentDefinitions] of componentDefinitionsByPlatform.entries()) {
    for (const componentDefinition of componentDefinitions) {
      if (nonReusableReleaseAssetIds.has(componentDefinition.id)) {
        continue;
      }

      for (const previousReleaseDir of previousReleaseDirs) {
        const previousManifest = readJsonFile(
          join(previousReleaseDir, `manifest-${platformKey}.json`),
        );
        const previousComponents = normalizeManifestComponents(previousManifest);
        const previousComponent = previousComponents.get(componentDefinition.id);
        if (
          resolveComponentSemanticVersion(previousComponent?.version) !==
          resolveComponentSemanticVersion(componentDefinition.version)
        ) {
          continue;
        }

        const sourcePath = join(previousReleaseDir, ...componentDefinition.mount.split("/"));
        const targetPath = join(releaseDir, ...componentDefinition.mount.split("/"));
        if (!existsSync(sourcePath)) {
          continue;
        }

        const requiredPaths = componentDefinition.requiredPaths ?? [];
        const hasTargetRequiredPaths =
          existsSync(targetPath) &&
          requiredPaths.every((relativePath) =>
            existsSync(join(targetPath, ...relativePath.split("/"))),
          );
        if (hasTargetRequiredPaths) {
          continue;
        }

        const hasRequiredPaths = requiredPaths.every((relativePath) =>
          existsSync(join(sourcePath, ...relativePath.split("/"))),
        );
        if (!hasRequiredPaths) {
          continue;
        }

        // A new app version creates a new releases/<version> dir, so cache hits must not depend
        // on that path. Copy a historical release only when the component version matches and
        // key files are intact, avoiding re-downloads of stable runtimes.
        mkdirSync(dirname(targetPath), { recursive: true });
        if (existsSync(targetPath)) {
          // An interrupted bootstrap can leave a target dir holding only .part files.
          // When the target exists but key files are incomplete, do not skip reuse: clear it
          // and repair from the historical release's complete assets.
          rmSync(targetPath, { force: true, recursive: true });
        }
        cpSync(sourcePath, targetPath, { recursive: true });
        console.log(
          `  [reuse] ${componentDefinition.id} ${platformKey} from ${basename(previousReleaseDir)}`,
        );
        break;
      }
    }
  }
}

function buildReusableComponentDefinitionsByPlatform() {
  return new Map(
    remotePlatforms.map((platformKey) => [
      platformKey,
      buildRemoteComponentDefinitions(platformKey).map((component) => ({
        id: component.id,
        version: buildComponentVersion(component.semanticPrefix),
        mount: component.mount,
        requiredPaths: buildReusableComponentRequiredPaths(component.id, platformKey),
      })),
    ]),
  );
}

function buildReusableComponentRequiredPaths(componentId, platformKey) {
  switch (componentId) {
    case "node-runtime":
      return ["node"];
    case "node-pty":
      return platformKey.startsWith("darwin-") ? ["pty.node", "spawn-helper"] : ["pty.node"];
    case "glm":
      // GLM is now the compiled zcode.cjs (identical across platforms); remotes execute it with
      // the already-deployed node. Reuse also requires the official plugin seed assets to be
      // intact, otherwise old releases keep producing remote packages with 0 builtin plugins.
      return ["zcode.cjs", ...remoteOfficialPluginRequiredPaths];
    case "bfs":
      return ["bfs"];
    case "ripgrep":
      return [platformKey.startsWith("win32-") ? "rg.exe" : "rg"];
    case "ugrep":
      return ["ugrep"];
    default:
      return [];
  }
}

export function buildRemoteComponentDefinitions(platformKey) {
  const baseComponents = [
    {
      id: "server-bundle",
      semanticPrefix: version,
      mount: "server",
      sourcePath: join(releaseDir, "server"),
    },
    {
      id: "node-runtime",
      semanticPrefix: nodeVersion,
      mount: joinPosix("node", platformKey),
      sourcePath: join(releaseDir, "node", platformKey),
    },
    {
      id: "node-pty",
      // The node-pty component used to be pinned to v1, so clients kept hitting stale cache
      // after package upgrades. Use the actual copied-from package version so the component
      // cache invalidates when @lydell/node-pty-<platform> is upgraded.
      semanticPrefix: resolveNodePtyPackageVersion(platformKey),
      mount: joinPosix("node-pty", platformKey),
      sourcePath: join(releaseDir, "node-pty", platformKey),
    },
    {
      id: "glm",
      // The GLM native binary used to be pinned to v1, so binary upgrades never invalidated
      // the component cache. Reuse ZCODE_AGENT_RUNTIME.glm.version to keep the manifest version
      // aligned with the runtime descriptor.
      semanticPrefix: ZCODE_AGENT_RUNTIME.glm.version,
      mount: joinPosix("glm", platformKey),
      sourcePath: join(releaseDir, "glm", platformKey),
    },
  ];

  const [platform, arch] = platformKey.split("-");
  const nativeSearchPlan = resolveRemoteNativeSearchPrebuiltPlan({
    platform,
    arch,
    outputDir: join(releaseDir, "tools", platformKey),
  });

  return [
    ...baseComponents,
    ...nativeSearchPlan.artifacts
      .toSorted((left, right) => left.toolId.localeCompare(right.toolId))
      .map((artifact) => ({
        id: artifact.toolId,
        semanticPrefix: artifact.release,
        mount: joinPosix("tools", platformKey, artifact.toolId),
        sourcePath: dirname(artifact.binaryPath),
      })),
  ];
}

function tryReuseRemoteComponentArtifact({
  mockCdnDir,
  component,
  previousComponent,
  sourceSha256,
}) {
  if (!previousComponent) {
    return null;
  }

  if (previousComponent.id !== component.id || previousComponent.mount !== component.mount) {
    return null;
  }

  if (
    resolveComponentSemanticVersion(previousComponent.version) !==
    buildComponentVersion(component.semanticPrefix)
  ) {
    return null;
  }

  if (previousComponent.sourceSha256 !== sourceSha256) {
    return null;
  }

  if (
    typeof previousComponent.artifactPath !== "string" ||
    typeof previousComponent.sha256 !== "string" ||
    !isSha256(previousComponent.sha256)
  ) {
    return null;
  }

  const artifactPath = join(mockCdnDir, ...previousComponent.artifactPath.split("/"));
  if (!existsSync(artifactPath)) {
    return null;
  }

  if (computeFileSha256(artifactPath) !== previousComponent.sha256) {
    return null;
  }

  return previousComponent;
}

export function prepareRemoteComponentArtifact({
  mockCdnDir,
  platformKey,
  component,
  previousComponents = new Map(),
}) {
  if (!existsSync(component.sourcePath)) {
    throw new Error(
      `Missing component source for ${component.id} (${platformKey}): ${component.sourcePath}`,
    );
  }

  const sourceSha256 = computeComponentSourceSha256(component.sourcePath);
  const previousComponent = previousComponents.get(component.id);
  const reusedComponent = tryReuseRemoteComponentArtifact({
    mockCdnDir,
    component,
    previousComponent,
    sourceSha256,
  });
  if (reusedComponent) {
    // Never re-tar.gz unchanged remote mock-cdn component sources on every run. Match the
    // existing manifest and artifact via the source dir content fingerprint, avoiding
    // re-compressing large components during bootstrap:with-remote.
    console.log(`  [skip] component ${component.id} ${platformKey} unchanged`);
    return reusedComponent;
  }

  const semanticComponentVersion = buildComponentVersion(component.semanticPrefix);
  const stagingArtifactRelativePath = joinPosix(
    "components",
    platformKey,
    component.id,
    `${semanticComponentVersion}.tmp-${process.pid}-${Date.now()}.tar.gz`,
  );
  const stagingArtifactPath = join(mockCdnDir, ...stagingArtifactRelativePath.split("/"));
  mkdirSync(dirname(stagingArtifactPath), { recursive: true });

  // Reusing the old tar on same-version local reruns would point manifest sha256 at stale
  // content. Pack to a temp artifact first and only then write the content hash into the final
  // file name, so CDN caches stop hitting the stale same-name object.
  packComponentSourceAsArchive(component.sourcePath, stagingArtifactPath);
  const artifactSha256 = computeFileSha256(stagingArtifactPath);
  const componentVersion = buildContentAddressedComponentVersion(
    component.semanticPrefix,
    artifactSha256,
  );
  const artifactRelativePath = buildComponentArtifactRelativePath(
    platformKey,
    component.id,
    componentVersion,
  );
  const artifactPath = join(mockCdnDir, ...artifactRelativePath.split("/"));
  if (artifactPath !== stagingArtifactPath) {
    rmSync(artifactPath, { force: true });
    mkdirSync(dirname(artifactPath), { recursive: true });
    renameSync(stagingArtifactPath, artifactPath);
  }
  console.log(`  [component] ${component.id} ${platformKey} -> ${artifactRelativePath}`);

  return {
    id: component.id,
    version: componentVersion,
    sha256: artifactSha256,
    sourceSha256,
    artifactPath: artifactRelativePath,
    mount: component.mount,
  };
}

function prepareRemoteComponentArtifacts() {
  console.log("==> Packaging component artifacts and manifests");

  const componentRootDir = join(mockCdnDir, "components");
  mkdirSync(componentRootDir, { recursive: true });

  for (const platformKey of remotePlatforms) {
    const componentManifestEntries = [];
    const componentDefinitions = buildRemoteComponentDefinitions(platformKey);
    const previousComponents = normalizeManifestComponents(
      readJsonFile(join(releaseDir, `manifest-${platformKey}.json`)),
    );

    for (const component of componentDefinitions) {
      if (!existsSync(component.sourcePath)) {
        if (!canResolveIntranetDepsBaseUrl()) {
          console.warn(
            `  [skip] component ${component.id} (${platformKey}): source missing and intranet deps source is not configured`,
          );
          continue;
        }
      }
      componentManifestEntries.push(
        prepareRemoteComponentArtifact({
          mockCdnDir,
          platformKey,
          component,
          previousComponents,
        }),
      );
    }

    const manifestPath = join(releaseDir, `manifest-${platformKey}.json`);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: componentSchemaVersion,
          appVersion: version,
          platformArch: platformKey,
          components: componentManifestEntries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`  [ok] mock-cdn releases/${version}/manifest-${platformKey}.json`);
  }
}

async function main() {
  console.log(`==> Preparing mock CDN release in ${releaseDir}`);

  mkdirSync(releaseDir, { recursive: true });
  restoreReusableReleaseAssets({
    mockCdnDir,
    currentVersion: version,
    releaseDir,
    componentDefinitionsByPlatform: buildReusableComponentDefinitionsByPlatform(),
  });

  await prepareNodeBinaries();
  buildServerBundle();
  copyServerBundle();
  copyNodePtyPrebuilds();
  await stageRemoteAgentBundles();
  await prepareRemoteNativeSearchTools();
  // Fix: server, pty, and agent are each independently downloadable; their notices must be
  // staged before component hashes are computed.
  await stageThirdPartyNotices(join(releaseDir, "server"), rootDir);
  for (const platformKey of remotePlatforms) {
    await stageThirdPartyNotices(join(releaseDir, "node-pty", platformKey), rootDir);
    await stageThirdPartyNotices(join(releaseDir, "glm", platformKey), rootDir);
  }
  prepareRemoteComponentArtifacts();

  console.log(`==> Done! Mock CDN release ready at ${releaseDir}`);
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  await main();
}
