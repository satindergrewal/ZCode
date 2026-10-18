/* eslint-disable max-lines -- release staging is assembled linearly step by step; after oxfmt wrapping it slightly exceeds 400 lines and splitting would add cross-step state sync. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRuntimeManifest, type ServerTarget } from "../runtime/manifest.js";
import { isTarCommand, resolveHostTarCommand } from "./tarCommand.js";

const NODE_BUILTIN_MODULES = new Set(builtinModules);

/**
 * Extract top-level bare module specifiers from bundle output (`from "x"` / `import("x")` / `require("x")`).
 * Results are only normalized syntactically (first two segments for scoped packages); whether each is a real
 * npm package is decided by the caller intersecting with the workspace node_modules; node builtins are filtered here.
 */
function collectBareModuleSpecifiers(source: string): Set<string> {
  const names = new Set<string>();
  const specifierPattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = specifierPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) continue;
    const segments = specifier.split("/");
    const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!packageName || NODE_BUILTIN_MODULES.has(packageName)) continue;
    names.add(packageName);
  }
  return names;
}

async function readPackageJson(packageDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Simplified Node resolution: locate `node_modules/<name>` by walking up from the depender's real dir.
 * Skips main/exports entry resolution, so it also covers exports-tightened or types-only packages;
 * matches both pnpm (deps beside `.pnpm/<pkg>/node_modules`) and the npm flat layout.
 */
async function findDependencyDir(fromDir: string, name: string): Promise<string | null> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if ((await readPackageJson(candidate)) !== null) {
      return await realpath(candidate);
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Recursively collect the production dependency closure (dependencies + optionalDependencies) from the entry packages.
 * Returns package name -> real dir. Error when the same name resolves to different real dirs: a flat release
 * layout cannot hold two versions, and silently picking one would leak version drift into the release.
 * Missing optional deps are skipped.
 */
async function resolveProductionPackageClosure(
  entryPackageNames: readonly string[],
  nodeModulesDir: string,
  workspacePackageDirs: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const closure = new Map<string, string>();
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = entryPackageNames.map(
    (name) => ({ name, fromDir: dirname(resolve(nodeModulesDir)), optional: true }),
  );

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const packageDir =
      (await findDependencyDir(item.fromDir, item.name)) ??
      workspacePackageDirs.get(item.name) ??
      null;
    if (!packageDir) {
      if (item.optional) continue;
      throw new Error(
        `Missing production dependency in workspace: ${item.name} (from ${item.fromDir})`,
      );
    }
    const existing = closure.get(item.name);
    if (existing) {
      if (existing !== packageDir) {
        // pnpm peer deps may legitimately keep several versions (typically ajv6 + ajv8).
        // Keep the first-resolved version at the top level and preserve the package's own nested
        // node_modules during the copy phase so Node's local resolution picks the right peer;
        // a legitimate Agent bundle must not be rejected at staging.
        continue;
      }
      continue;
    }
    closure.set(item.name, packageDir);

    const packageJson = await readPackageJson(packageDir);
    const dependencies = (packageJson?.dependencies ?? {}) as Record<string, string>;
    const optionalDependencies = (packageJson?.optionalDependencies ?? {}) as Record<
      string,
      string
    >;
    for (const dependencyName of Object.keys(dependencies)) {
      queue.push({
        name: dependencyName,
        fromDir: packageDir,
        optional: dependencyName in optionalDependencies,
      });
    }
    for (const dependencyName of Object.keys(optionalDependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir, optional: true });
    }
  }
  return closure;
}

/**
 * node-pty runtime allowlist. `build/` must be excluded: it holds host-platform build artifacts, and
 * node-pty's loadNativeModule probes build/Release -> build/Debug -> prebuilds/<platform>-<arch> in order;
 * leaving build/ in a cross-built package makes the target load a wrong-arch pty.node and crash.
 * Also drop prebuilds of non-target platforms to keep the release small.
 */
function isNodePtyRuntimePath(relativePath: string, target: ServerTarget): boolean {
  const normalized = relativePath.split(sep).join("/");
  if (normalized === "" || normalized === "package.json") return true;
  if (/^(?:LICENSE|NOTICE|COPYING)(?:[._-].*)?$/iu.test(normalized)) return true;
  if (normalized === "lib" || normalized.startsWith("lib/")) return true;
  if (normalized === "typings" || normalized.startsWith("typings/")) return true;
  if (
    normalized === "prebuilds" ||
    normalized === `prebuilds/${target}` ||
    normalized.startsWith(`prebuilds/${target}/`)
  ) {
    return true;
  }
  return false;
}

function isTargetSpecificPackage(packageName: string, target: ServerTarget): boolean {
  if (!packageName.startsWith("@mbears/opentui-core-")) return true;
  return packageName === `@mbears/opentui-core-${target}`;
}

interface StageOptions {
  target: ServerTarget;
  appVersion: string;
  /** tsup output dir (server-cli.js / server-core.js) */
  distDir: string;
  /** Prebuilt CLI/Agent bundle (zcode.cjs, self-contained CJS) */
  agentBundlePath: string;
  /** Prepared Node binary for the target platform */
  nodeBinaryPath: string;
  /** Compliance notices verified by the build entry owner; component assembly must not fabricate them. */
  notices: { thirdParty: string; node: string; nodeSource: string };
  /** node_modules the dependency closure is resolved and copied from */
  workspaceNodeModulesDir: string;
  /** Workspace packages not linked into node_modules by pnpm (e.g. @zcode/tui). */
  workspacePackageDirs?: ReadonlyMap<string, string>;
  /** Parent output dir of the release directory */
  outputDir: string;
  /** Prepared native search tools root (tools/<id>/<binary>). */
  nativeToolsDir?: string;
  /** Official plugins source or seeded packages dir. */
  officialPluginsDir?: string;
  /** Also produce the tar.gz archive (default true) */
  archive?: boolean;
}

interface StagedRelease {
  releaseDir: string;
  archivePath: string | null;
  componentArchivePaths: string[];
  packagedDependencies: string[];
}

const POSIX_LAUNCHER = `#!/bin/sh
// Generated by zcode-server staging: locate the release root and boot the Server CLI with the bundled Node.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$DIR/runtime/node" "$DIR/runtime/server-cli.js" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  'set "DIR=%~dp0.."',
  '"%DIR%\\runtime\\node.exe" "%DIR%\\runtime\\server-cli.js" %*',
  "",
].join("\r\n");

async function copyPackageDir(
  sourceDir: string,
  targetDir: string,
  filter?: (relativePath: string) => boolean,
  includeNestedNodeModules = false,
): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relativePath = relative(sourceDir, source);
      if (relativePath === "") return true;
      // Nested package node_modules are not copied: closure resolution already flattened transitive deps into the release node_modules.
      if (
        !includeNestedNodeModules &&
        (relativePath === "node_modules" || relativePath.split(sep).includes("node_modules"))
      )
        return false;
      return filter ? filter(relativePath) : true;
    },
  });
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // macOS stock tar writes Finder extended attributes as AppleDouble `._*` entries.
    // Extracting the release on Linux/Windows would materialize that host metadata as real files,
    // polluting the file tree and breaking component hashes between the download side and the target;
    // disable copyfile metadata before archiving. The Windows side passes an absolute System32
    // tar.exe path, which hits the same branch.
    const env = isTarCommand(command) ? { ...process.env, COPYFILE_DISABLE: "1" } : process.env;
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function hashPaths(
  root: string,
  paths: readonly string[],
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(root, relativePath);
    const stat = await (await import("node:fs/promises")).stat(absolutePath);
    const files = stat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const contents = await readFile(join(root, file));
      hash.update(`${file}\0`);
      hash.update(contents);
      sizeBytes += contents.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function copyDirectoryIfPresent(
  sourceDir: string | undefined,
  targetDir: string,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const names = (
    await (await import("node:fs/promises")).readdir(sourceDir, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-plugin"))
    .map((entry) => entry.name)
    .filter((name) => name !== "superpowers-plugin")
    .sort();
  for (const name of names) {
    await copyPackageDir(join(sourceDir, name), join(targetDir, name));
  }
  return names.map((name) => name.replace(/-plugin$/u, ""));
}

async function copyNativeTools(
  sourceDir: string | undefined,
  targetDir: string,
  target: ServerTarget,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const ids = target.startsWith("win32-") ? ["ripgrep", "ugrep"] : ["bfs", "ripgrep", "ugrep"];
  const copied: string[] = [];
  for (const id of ids) {
    const source = join(
      sourceDir,
      id,
      id === "ripgrep"
        ? target.startsWith("win32-")
          ? "rg.exe"
          : "rg"
        : id + (target.startsWith("win32-") ? ".exe" : ""),
    );
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(targetDir, id, source.split(sep).pop() ?? id);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { dereference: true });
    // Fix: copying only the binaries would drop the prepared notices of the standalone native-search-tools component.
    for (const notice of ["THIRD-PARTY-NOTICES.txt", "SOURCES.json"]) {
      const bytes = await readFile(join(dirname(source), notice));
      if (!bytes.length) throw new Error(`Empty native notice: ${notice}`);
      await writeFile(join(dirname(targetPath), notice), bytes);
    }
    if (!target.startsWith("win32-")) await chmod(targetPath, 0o755);
    copied.push(id);
  }
  return copied;
}

async function createComponentArchive(
  releaseDir: string,
  outputDir: string,
  target: ServerTarget,
  id: string,
  paths: readonly string[],
): Promise<{ archivePath: string; sha256: string; sizeBytes: number }> {
  const info = await hashPaths(releaseDir, paths);
  const componentRoot = join(outputDir, ".components", `${id}-${info.sha256.slice(0, 12)}`);
  await rm(componentRoot, { force: true, recursive: true });
  await mkdir(componentRoot, { recursive: true });
  for (const relativePath of paths) {
    const source = join(releaseDir, relativePath);
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(componentRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { recursive: true, dereference: true });
  }
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  const archivePath = join(outputDir, "components", target, `${id}-${info.sha256}.${extension}`);
  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  // Windows hosts have no zip command and Git Bash's GNU tar is unavailable (see
  // tarCommand.ts); every tar call is the explicit System32 bsdtar. POSIX hosts keep using zip for zip archives.
  const tarCommand = resolveHostTarCommand();
  if (extension === "zip") {
    if (process.platform === "win32")
      await runCommand(tarCommand, ["-acf", archivePath, "."], componentRoot);
    else await runCommand("zip", ["-qr", archivePath, "."], componentRoot);
  } else if (process.platform === "win32") {
    await runCommand(tarCommand, ["-czf", archivePath, "."], componentRoot);
  } else await runCommand("tar", ["-czf", archivePath, "."], componentRoot);
  await rm(componentRoot, { force: true, recursive: true });
  return { archivePath, ...info };
}

/** Assemble the `zcode-server-<os>-<arch>/` release dir; local assembly only, no upload or publish. */
export async function stageRelease(options: StageOptions): Promise<StagedRelease> {
  for (const [name, value] of Object.entries(options.notices)) {
    if (!value.trim()) throw new Error(`Missing distribution notice: ${name}`);
  }
  const releaseName = `zcode-server-${options.target}`;
  const outputRoot = resolve(options.outputDir);
  const releaseDir = join(outputRoot, releaseName);
  const runtimeDir = join(releaseDir, "runtime");
  await rm(releaseDir, { force: true, recursive: true });
  // Staging rebuilds the release dir: drop component archives of the same target left by the
  // previous build so stale hashes are not uploaded to the CDN, which would expose components
  // in the catalog that do not match this manifest.
  await rm(join(outputRoot, "components", options.target), { force: true, recursive: true });
  await rm(join(outputRoot, ".components"), { force: true, recursive: true });
  await mkdir(join(releaseDir, "bin"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "THIRD-PARTY-NOTICES.md"), options.notices.thirdParty);
  await writeFile(join(runtimeDir, "LICENSE.node.txt"), options.notices.node);
  await writeFile(join(runtimeDir, "NODE-SOURCES.json"), options.notices.nodeSource);
  for (const component of ["agent", "official-plugins"]) {
    await mkdir(join(runtimeDir, "licenses", component), { recursive: true });
    await writeFile(
      join(runtimeDir, "licenses", component, "THIRD-PARTY-NOTICES.md"),
      options.notices.thirdParty,
    );
  }

  // Entry bundles are copied under matching names; file names must stay in sync with relative path resolution in cli.ts.
  const bundleSources: string[] = [];
  for (const entryName of ["server-cli.js", "server-core.js"]) {
    const sourcePath = join(options.distDir, entryName);
    const contents = await readFile(sourcePath, "utf8");
    bundleSources.push(contents);
    await writeFile(join(runtimeDir, entryName), contents, "utf8");
  }
  await writeFile(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: releaseName, private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await cp(options.agentBundlePath, join(runtimeDir, "zcode.cjs"), { dereference: true });
  // The Agent bundle is the third actually running entry; scanning only the Server bundle would miss externalized TUI/Playwright.
  bundleSources.push(await readFile(options.agentBundlePath, "utf8"));

  const nodeTargetPath = join(
    runtimeDir,
    options.target.startsWith("win32-") ? "node.exe" : "node",
  );
  await cp(options.nodeBinaryPath, nodeTargetPath, { dereference: true });
  if (!options.target.startsWith("win32-")) await chmod(nodeTargetPath, 0o755);

  // runtime/node_modules treats the artifact scan as the source of truth: install exactly what the bundles import (incl. transitive deps)
  // instead of the tsup external list, avoiding drift between the declaration and actual imports.
  const referencedPackages = new Set<string>();
  for (const source of bundleSources) {
    for (const name of collectBareModuleSpecifiers(source)) referencedPackages.add(name);
  }
  const rawClosure = await resolveProductionPackageClosure(
    [...referencedPackages],
    options.workspaceNodeModulesDir,
    options.workspacePackageDirs,
  );
  const closure = new Map(
    [...rawClosure].filter(([packageName]) => isTargetSpecificPackage(packageName, options.target)),
  );
  const nodeModulesTargetDir = join(runtimeDir, "node_modules");
  for (const [packageName, packageDir] of closure) {
    const targetDir = join(nodeModulesTargetDir, ...packageName.split("/"));
    await mkdir(dirname(targetDir), { recursive: true });
    if (packageName === "node-pty") {
      await copyPackageDir(packageDir, targetDir, (relativePath) =>
        isNodePtyRuntimePath(relativePath, options.target),
      );
    } else {
      // The Agent's external deps keep peer versions side by side (e.g. ajv6 + ajv8). Keep nested
      // node_modules only for known peer-conflict packages, avoiding copying pnpm's whole dev dependency tree into the release.
      await copyPackageDir(
        packageDir,
        targetDir,
        undefined,
        packageName === "ajv-formats" || packageName === "ajv-keywords",
      );
      if (packageName === "koffi") await pruneKoffiRuntime(packageDir, targetDir, options.target);
    }
  }

  if (closure.has("node-pty")) {
    await ensureNodePtyPrebuild(options, nodeModulesTargetDir);
  }

  const tools = await copyNativeTools(
    options.nativeToolsDir,
    join(runtimeDir, "tools"),
    options.target,
  );
  const plugins = await copyDirectoryIfPresent(
    options.officialPluginsDir,
    join(runtimeDir, "packages"),
  );

  const launcherPath = join(
    releaseDir,
    "bin",
    options.target.startsWith("win32-") ? "zcode.cmd" : "zcode",
  );
  await writeFile(launcherPath, POSIX_LAUNCHER, "utf8");
  if (options.target.startsWith("win32-")) {
    await writeFile(launcherPath, WINDOWS_LAUNCHER, "utf8");
  } else {
    await chmod(launcherPath, 0o755);
  }

  const componentSpecs = [
    {
      id: "node-runtime",
      paths: [
        options.target.startsWith("win32-") ? "runtime/node.exe" : "runtime/node",
        "runtime/LICENSE.node.txt",
        "runtime/NODE-SOURCES.json",
      ],
    },
    {
      id: "server-runtime",
      paths: [
        "runtime/server-cli.js",
        "runtime/server-core.js",
        "runtime/package.json",
        "runtime/node_modules",
        "runtime/THIRD-PARTY-NOTICES.md",
      ],
    },
    { id: "agent-runtime", paths: ["runtime/zcode.cjs", "runtime/licenses/agent"] },
    ...(plugins.length > 0
      ? [
          {
            id: "official-plugins",
            paths: ["runtime/packages", "runtime/licenses/official-plugins"],
          },
        ]
      : []),
    ...(tools.length > 0 ? [{ id: "native-search-tools", paths: ["runtime/tools"] }] : []),
  ];
  const componentMeta: Array<{
    id: string;
    sha256: string;
    paths: string[];
    sizeBytes: number;
    archivePath?: string;
  }> = [];
  const componentArchivePaths: string[] = [];
  for (const component of componentSpecs) {
    const info = await hashPaths(releaseDir, component.paths);
    componentMeta.push({ ...component, ...info });
  }
  const manifest = createRuntimeManifest(options.target, options.appVersion, {
    tools,
    plugins,
    components: componentMeta,
  });
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  for (const component of componentMeta) {
    const archive = await createComponentArchive(
      releaseDir,
      outputRoot,
      options.target,
      component.id,
      component.paths,
    );
    component.archivePath = relative(outputRoot, archive.archivePath).split(sep).join("/");
    componentArchivePaths.push(archive.archivePath);
  }
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify({ ...manifest, components: componentMeta }, null, 2)}\n`,
    "utf8",
  );

  let archivePath: string | null = null;
  if (options.archive !== false) {
    const extension = options.target.startsWith("win32-") ? "zip" : "tar.gz";
    archivePath = join(outputRoot, `${releaseName}.${extension}`);
    await rm(archivePath, { force: true });
    // Windows hosts use the explicit System32 bsdtar, independent of the caller's PATH (same reason as tarCommand.ts).
    const tarCommand = resolveHostTarCommand();
    if (extension === "zip") {
      if (process.platform === "win32")
        await runCommand(tarCommand, ["-acf", archivePath, releaseName], outputRoot);
      else await runCommand("zip", ["-qr", archivePath, releaseName], outputRoot);
    } else if (process.platform === "win32") {
      await runCommand(tarCommand, ["-czf", archivePath, releaseName], outputRoot);
    } else await runCommand("tar", ["-czf", archivePath, releaseName], outputRoot);
  }

  return {
    releaseDir,
    archivePath,
    componentArchivePaths,
    packagedDependencies: [...closure.keys()].sort(),
  };
}

async function pruneKoffiRuntime(
  sourceDir: string,
  targetDir: string,
  target: ServerTarget,
): Promise<void> {
  const [platform, architecture] = target.split("-");
  const targetKeys =
    platform === "linux"
      ? [`linux_${architecture}`, `musl_${architecture}`]
      : [`${platform}_${architecture}`];
  const sourceBuild = join(sourceDir, "build", "koffi");
  const targetBuild = join(targetDir, "build", "koffi");
  await rm(targetBuild, { recursive: true, force: true });
  await mkdir(targetBuild, { recursive: true });
  for (const targetKey of targetKeys) {
    const sourcePath = join(sourceBuild, targetKey);
    try {
      await access(sourcePath);
    } catch {
      continue;
    }
    await cp(sourcePath, join(targetBuild, targetKey), { recursive: true, dereference: true });
  }
}

/**
 * Ensure the release's node-pty has the target platform's pty.node. The official node-pty npm package only
 * ships darwin/win32 prebuilds; for linux, fill the gap from the workspace's `@lydell/node-pty-<target>`
 * (same source as the legacy remote asset chain). Fail hard when missing so the release's terminal support is not silently broken.
 */
async function ensureNodePtyPrebuild(
  options: StageOptions,
  nodeModulesTargetDir: string,
): Promise<void> {
  const prebuildDir = join(nodeModulesTargetDir, "node-pty", "prebuilds", options.target);
  const ptyNodePath = join(prebuildDir, "pty.node");
  let hasPtyNode = true;
  try {
    await access(ptyNodePath);
  } catch {
    hasPtyNode = false;
  }
  if (!hasPtyNode) {
    // The official package has no prebuild for this platform (linux); fill in from the @lydell platform package.
    const lydellDir = await findDependencyDir(
      dirname(resolve(options.workspaceNodeModulesDir)),
      `@lydell/node-pty-${options.target}`,
    );
    const lydellPtyNode = lydellDir
      ? join(lydellDir, "prebuilds", options.target, "pty.node")
      : null;
    if (!lydellPtyNode) {
      throw new Error(
        `Missing node-pty prebuild for ${options.target}: install @lydell/node-pty-${options.target}`,
      );
    }
    await mkdir(prebuildDir, { recursive: true });
    await cp(lydellPtyNode, ptyNodePath, { dereference: true });
  }
  // darwin's spawn-helper must be executable; npm publish/extraction does not guarantee permission bits,
  // and node-pty fails at the posix_spawn stage without it (same pit in the legacy remote asset chain, see prepare-prebuilds.mjs).
  const spawnHelperPath = join(prebuildDir, "spawn-helper");
  try {
    await access(spawnHelperPath);
    await chmod(spawnHelperPath, 0o755);
  } catch {
    // Non-darwin platforms have no spawn-helper; ignore.
  }
}
