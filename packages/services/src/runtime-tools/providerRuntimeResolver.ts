import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { ZCODE_AGENT_RUNTIME, sanitizeZCodeRuntimeEnvInPlace } from "@zcode/shared";
import { getDataBaseDir, getProviderWorkspaceConfigDir } from "../paths.js";
import { buildRuntimeProcessEnvPatch } from "./runtimeCommandEnv.js";

const ZCODE_AGENT_WORKDIR_ENV = "ZCODE_AGENT_WORKDIR";

/** Returns the in-app config dir for a provider+workspace pair */
export function resolveProviderConfigDir(
  _legacyProvider: string,
  _workspacePath: string,
  _workspaceIdentity?: string,
): string {
  return getProviderWorkspaceConfigDir();
}

/** Builds a clean Node.js env, stripping Electron/GPU variables */
export function buildCleanEnv(
  provider: string,
  _configDir: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    // Filter Electron-specific and GPU-related variables
    if (key.startsWith("ELECTRON_")) continue;
    if (key.startsWith("ORIGINAL_XDG_")) continue;
    if (key === "NODE_OPTIONS") continue;
    // Bugfix: git-bash/WSL on Windows inject SHELL=/usr/bin/bash into process.env;
    // the agent runtime uses SHELL on Windows to spawn children (stdio MCP servers),
    // and a bogus POSIX path fails every stdio MCP start.
    // Deleting SHELL outright breaks MCP connections too, so
    // replace invalid POSIX paths with a native Windows shell (ComSpec, else cmd.exe).
    if (key === "SHELL" && process.platform === "win32") {
      const winShell = process.env.ComSpec || "cmd.exe";
      env.SHELL = winShell;
      continue;
    }
    if (key === "GOOGLE_API_KEY") continue;
    env[key] = value;
  }
  // Fix: provider/agent children must not inherit shell NODE_ENV, proxies, or cert vars by default.
  // Those inputs come from explicit ZCODE_* config or app settings, keeping user env out of model requests and tool children.
  sanitizeZCodeRuntimeEnvInPlace(env);
  // Bugfix: Windows env names are case-insensitive; plain JS objects are not.
  // process.env enumerates PATH as "Path" (title case),
  // and buildRuntimeProcessEnvPatch looks up "PATH", gets undefined,
  // builds a tools-only PATH, and at child init "PATH" overrides "Path",
  // dropping the whole system PATH so git/node/cmd vanish for the agent and its children.
  // Normalize Path to PATH so downstream code uses one uppercase key.
  if (process.platform === "win32") {
    const nonCanonicalPathKey = Object.keys(env).find(
      (k) => k.toUpperCase() === "PATH" && k !== "PATH",
    );
    if (nonCanonicalPathKey && env[nonCanonicalPathKey]) {
      env.PATH = env[nonCanonicalPathKey]!;
      delete env[nonCanonicalPathKey];
    }
  }
  if (provider === "glm") {
    const glmHome = getDataBaseDir();
    // Bugfix: the GLM agent writes config/session artifacts to ~/.zcode/cli under dataBaseDir.
    // Point the child HOME at dataBaseDir so writes and reads always agree.
    env.HOME = glmHome;
    if (process.platform === "win32") {
      env.USERPROFILE = glmHome;
    }
  }
  Object.assign(env, buildRuntimeProcessEnvPatch(env));
  if (extra) Object.assign(env, extra);
  return env;
}

const packagedResourcesPath =
  typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    : null;

function resolveExistingPath(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePlatformScopedBundledAgentRoots(moduleDir?: string): Array<string | null> {
  const platformKey = `${process.platform}-${process.arch}`;
  return [
    resolvePath(process.cwd(), "bundled-agents", platformKey),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-agents", platformKey),
    // dev:web starts via pnpm --filter @zcode/server dev, so cwd is packages/server. ZCode Agent
    // resources may live in the desktop package or the repo-root bundled-agents/<platform> dir.
    // Add every platform-scoped repo candidate so desktop/web/server share one resolution chain.
    resolvePath(process.cwd(), "..", "desktop", "bundled-agents", platformKey),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-agents", platformKey) : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-agents", platformKey) : null,
  ];
}

function resolveLegacyBundledResourceRoots(moduleDir?: string): Array<string | null> {
  return [
    resolvePath(process.cwd(), "bundled-resources"),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-resources"),
    resolvePath(process.cwd(), "..", "desktop", "bundled-resources"),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-resources") : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-resources") : null,
  ];
}

export function findZCodeAgentRuntimeBinary(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];
  const envPath = process.env[runtime.binaryEnvVar];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // import.meta.dirname is undefined inside the packaged CJS bundle (zcode-server.cjs); passing it
  // to resolvePath raises "paths[0]" argument must be of type string. Guard for null and only
  // build the matching candidates when import.meta.dirname exists.
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/**
 * Locate the agent JS bundle (resources/glm/zcode.cjs). The packaged desktop app executes this
 * bundle with the built-in Electron Node runtime instead of shipping a separate Node binary.
 * Candidate directories mirror findZCodeAgentRuntimeBinary exactly, except the entry is the
 * platform-agnostic nodeBundleEntryFile. GLM_BINARY_PATH is not consulted: that env points at the
 * native binary, a different semantic.
 */
export function findZCodeAgentRuntimeNodeBundle(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveNodeBundleSegments();
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];

  // Same as findZCodeAgentRuntimeBinary: import.meta.dirname is undefined in the packaged CJS
  // bundle, so guard for null before building the in-repo candidates.
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/** Finds the binary path for a provider */
export function findBinary(provider: string): string | null {
  if (provider !== "glm") {
    return null;
  }
  // GLM dev mode: discover via ZCODE_AGENT_WORKDIR or sibling dirs; the source entry path acts as the binary
  const devEntry = findGlmDevEntry();
  if (devEntry) {
    return devEntry.agentPath;
  }
  return findZCodeAgentRuntimeBinary();
}

/**
 * GLM dev-mode source entry discovery.
 * Prefers ZCODE_AGENT_WORKDIR.
 * Otherwise searches cwd siblings for zcode-cli / glm.
 */
interface GlmDevEntry {
  workdir: string;
  entryArg: string;
  agentPath: string;
}

function resolveGlmDevEntry(workdir: string): GlmDevEntry | null {
  const candidates = [
    ["packages", "cli", "src", "main.ts"],
    ["src", "cli.ts"],
  ];
  for (const segments of candidates) {
    const agentPath = resolvePath(workdir, ...segments);
    if (existsSync(agentPath)) {
      return {
        workdir,
        entryArg: segments.join("/"),
        agentPath,
      };
    }
  }
  return null;
}

function findGlmDevEntry(): GlmDevEntry | null {
  const workdir = process.env[ZCODE_AGENT_WORKDIR_ENV];
  if (workdir) {
    const entry = resolveGlmDevEntry(workdir);
    if (entry) {
      return entry;
    }
  }
  // Bugfix: desktop dev runs with cwd packages/desktop; the old parent-only lookup hit
  // packages/zcode-cli instead of ../zcode-cli beside the repo. Locate the repo root first,
  // then search repo siblings for the local GLM checkout, keeping cwd siblings as the non-monorepo fallback.
  const repoRoot = findWorkspaceRoot(process.cwd());
  const anchorDirs = [repoRoot, process.cwd()].filter((anchor): anchor is string =>
    Boolean(anchor),
  );
  const candidates = ["zcode-cli", "glm", "cc-refactor"];
  const seen = new Set<string>();
  for (const anchorDir of anchorDirs) {
    for (const name of candidates) {
      const candidate = resolvePath(anchorDir, "..", name);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      const entry = resolveGlmDevEntry(candidate);
      if (entry) {
        return entry;
      }
    }
  }
  return null;
}

function findWorkspaceRoot(startDir: string): string | null {
  let current = resolvePath(startDir);
  while (true) {
    if (existsSync(resolvePath(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
