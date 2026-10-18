import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const seaOfficialPluginAssetPrefix = "zcode-official-plugins/";
export const seaOfficialPluginManifestAssetKey = `${seaOfficialPluginAssetPrefix}manifest.json`;
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // recording lookup is the model entry for the recording API; SEA must not accept plugin assets with missing bodies.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

export const officialSeaPlugins = [
  {
    marketplace: "zcode-plugins-official",
    name: "visualize",
    packageName: "@zcode/visualize-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    rootPath: join("packages", "visualize-plugin"),
    version: "0.1.0",
  },
  {
    // node_repl host: the runtime artifact shared by Browser Use and Computer Use; not a user-facing plugin itself
    // (no skill, no marketplace listing). It must always ship embedded, or neither capability has a host to run.
    marketplace: "zcode-plugins-official",
    name: "node-repl-host",
    packageName: "@zcode/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "node-repl-host"),
    version: "0.6.1",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "android-emulator",
    packageName: "@zcode/android-emulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "android-emulator-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "documents",
    packageName: "@zcode/documents-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/docx/SKILL.md"],
    rootPath: join("packages", "documents-plugin"),
    // Root cause: the SEA manifest must stay in sync with the package, plugin manifest, and official definition, or the release embeds a stale version.
    version: "0.1.8",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "image-search",
    packageName: "@zcode/image-search-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [".mcp.json"],
    rootPath: join("packages", "image-search-plugin"),
    // Root cause: the SEA manifest must stay in sync with the package, plugin manifest, and official definition, or the release embeds a stale version.
    version: "0.1.1",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "pdf",
    packageName: "@zcode/pdf-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/pdf/SKILL.md"],
    rootPath: join("packages", "pdf-plugin"),
    // Root cause: the SEA manifest must stay in sync with the package, plugin manifest, and official definition, or the release embeds a stale version.
    version: "0.1.8",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "presentations",
    packageName: "@zcode/presentations-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/pptx/SKILL.md"],
    rootPath: join("packages", "presentations-plugin"),
    // Root cause: the SEA manifest must stay in sync with the package, plugin manifest, and official definition, or the release embeds a stale version.
    version: "0.1.8",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "spreadsheets",
    packageName: "@zcode/spreadsheets-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["agents/visual-judge.md", "skills/xlsx/SKILL.md"],
    rootPath: join("packages", "spreadsheets-plugin"),
    // Root cause: the SEA manifest must stay in sync with the package, plugin manifest, and official definition, or the release embeds a stale version.
    version: "0.1.8",
  },
  {
    // browser-use uses the real node_repl MCP runtime; SEA must validate and embed server.js.
    marketplace: "zcode-plugins-official",
    name: "browser-use",
    packageName: "@zcode/browser-use-plugin",
    requiresRuntime: true,
    // Browser Use's runtime, client, API docs, and skills are one release unit;
    // the SEA build must reject any missing piece before embedding, not leave a broken artifact to surface at user startup.
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    rootPath: join("packages", "browser-use-plugin"),
    // If the SEA manifest still points at the old version, the runtime fails the exact match against the official definition,
    // the release fails to seed browser-use, and the host node_repl MCP cannot be assembled.
    version: "0.5.1",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "ios-simulator",
    packageName: "@zcode/ios-simulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "ios-simulator-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "restore-legacy-sessions",
    packageName: "@zcode/restore-legacy-sessions-plugin",
    requiresRuntime: false,
    rootPath: join("packages", "restore-legacy-sessions-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "skill-creator",
    packageName: "@zcode/skill-creator-plugin",
    requiresRuntime: false,
    rootPath: join("packages", "skill-creator-plugin"),
    version: "0.1.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "plugin-creator",
    packageName: "@zcode/plugin-creator-plugin",
    requiresRuntime: false,
    rootPath: join("packages", "plugin-creator-plugin"),
    version: "0.1.1",
  },
  {
    // Content-only (skills only): requiresRuntime:false, and the SEA build skips dist/mcp/server.js validation.
    // The version must bump in lockstep across package.json / plugin.json / official-plugin-definitions.ts --
    // the runtime exact-matches SEA assets by (name, version); a lag here leaves the whole plugin unseeded under SEA
    // (the browser-use 0.3.1 lesson; build-sea.test.mjs:564 pins the four-way alignment).
    // 0.3.0: `/workflow` and the dynamic-workflows skills moved out of this plugin (see sea-bundled-skill-assets.mjs).
    marketplace: "zcode-plugins-official",
    name: "zcode-guide",
    packageName: "@zcode/zcode-guide-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["skills/zcode-configuration-guide/SKILL.md"],
    rootPath: join("packages", "zcode-guide-plugin"),
    version: "0.3.0",
  },
  // superpowers was retired from built-in plugins in favor of on-demand install via the UI recommendation shelf; no longer packed into the SEA asset manifest.
];

export const collectSeaOfficialPluginAssets = async ({
  requireRuntime = false,
  root,
  stagingDirectory,
} = {}) => {
  const files = [];
  const assets = {};
  const plugins = [];

  await rm(stagingDirectory, {
    force: true,
    recursive: true,
  });

  for (const plugin of officialSeaPlugins) {
    const pluginRoot = resolve(root, plugin.rootPath);
    assertPluginRoot(pluginRoot, plugin);
    assertPluginRequiredSeedAssets(pluginRoot, plugin);
    // Content-only plugins with skills but no MCP server skip validation via requiresRuntime:false;
    // runtime plugins are still validated here so a release never ships without its executable entry.
    if (requireRuntime && plugin.requiresRuntime !== false) assertPluginRuntime(pluginRoot, plugin);

    const pluginFiles = [];
    for await (const sourcePath of walkFiles(pluginRoot)) {
      const relativePath = relative(pluginRoot, sourcePath);
      if (!shouldIncludePluginFile(relativePath)) continue;

      const bytes = await readFile(sourcePath);
      const sourceStats = await stat(sourcePath);
      const assetPath = toPosixPath(
        join(plugin.marketplace, plugin.name, plugin.version, relativePath),
      );
      assets[`${seaOfficialPluginAssetPrefix}${assetPath}`] = sourcePath;
      const file = {
        mode: modeForSeedFile(relativePath, sourceStats.mode),
        path: toPosixPath(relativePath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      pluginFiles.push(file);
      files.push({
        ...file,
        plugin: plugin.name,
      });
    }

    pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
    plugins.push({
      files: pluginFiles,
      marketplace: plugin.marketplace,
      name: plugin.name,
      version: plugin.version,
    });
  }

  plugins.sort((left, right) => left.name.localeCompare(right.name));
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        plugins.map((plugin) => [
          plugin.marketplace,
          plugin.name,
          plugin.version,
          plugin.files.map(({ path, sha256, mode }) => [path, sha256, modeForSeedFile(path, mode)]),
        ]),
      ),
    )
    .digest("hex");
  const manifest = {
    hash: manifestHash,
    plugins,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "official-plugins-manifest.json");
  await mkdir(stagingDirectory, {
    recursive: true,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaOfficialPluginManifestAssetKey] = manifestPath;

  return {
    assets,
    manifest,
  };
};

function assertPluginRoot(pluginRoot, plugin) {
  if (!existsSync(join(pluginRoot, ".zcode-plugin", "plugin.json"))) {
    throw new Error(`Missing ${plugin.name} plugin manifest at ${pluginRoot}`);
  }
}

function assertPluginRequiredSeedAssets(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredSeedPaths ?? []) {
    const assetPath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(assetPath)) {
      throw new Error(`Missing ${plugin.name} required seed asset at ${assetPath}`);
    }
  }
}

function assertPluginRuntime(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredRuntimePaths ?? ["dist/mcp/server.js"]) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      const assetKind = relativePath === "dist/mcp/server.js" ? "MCP runtime" : "runtime asset";
      throw new Error(
        `Missing ${plugin.name} ${assetKind} at ${runtimePath}. ` +
          `Run \`pnpm --filter ${plugin.packageName} build\` before \`pnpm sea\`.`,
      );
    }
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (shouldSkipDirectory(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

const shouldSkipDirectory = (name) =>
  name === "node_modules" ||
  name === ".turbo" ||
  name === "coverage" ||
  name === ".venv" ||
  name === "__pycache__";

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // SEA asset collection once allowed only skills/commands, leaving document-skills' judge subagent out of the executable.
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

const shouldIncludePluginFile = (relativePath) => {
  const segments = relativePath.split(sep);
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split(sep);
  return topLevel !== undefined && includedTopLevelPaths.has(topLevel);
};

const toPosixPath = (value) => value.split(sep).join("/");

const modeForSeedFile = (filePath, sourceMode) => {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
};
