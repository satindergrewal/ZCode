/* eslint-disable max-lines -- desktop runtime/env resolution centralizes main/host/remote-asset startup boundaries; splitting widens the remote-connection regression surface. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { ConnectOptions } from "@zcode/server/remote";
import { listSSHConfigAliasesFromLocalConfig } from "@zcode/services/node";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  ZCODE_APP_VERSION_ENV,
  ZCODE_BUILD_COMMIT_ID_ENV,
  ZCODE_AGENT_RUNTIME,
  ZCODE_COMMIT,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_RUNTIME_ENV_KEY,
  ZCODE_VERSION,
  buildZCodeToolEnvPassthroughEnv,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  normalizeDynamicWorkflowMode,
  readZCodeAgentTelemetryEnv,
  sanitizeZCodeRuntimeEnv,
  type ZCodeRuntimeEnv,
} from "@zcode/shared";
import { resolvePlatformKeyForPackagedApp } from "../../scripts/target-platform.mjs";
import {
  getAppConfigDir,
  getDataBaseDir,
  ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "@zcode/services/node";
import {
  resolveRemoteCdnBaseUrls as resolveOrderedRemoteCdnBaseUrls,
  type ResolveRemoteCdnOptions,
} from "./remoteCdn.js";
import { getElectronAppPath, isElectronAppPackaged } from "./desktopElectronApp.js";

declare const __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: Readonly<Record<string, string>> | undefined;

const isLocalDevelopmentRuntime = !isElectronAppPackaged();
export const desktopRuntimeEnv: ZCodeRuntimeEnv = isLocalDevelopmentRuntime
  ? "development"
  : "production";
// Identity keys off the compile-time flavor, not ZCODE_ENV: production-backend builds with
// ZCODE_PREVIEW_IDENTITY=1 are still Preview and need own name/data dir/helper subdir to run side by side.
export const isPreviewPackagedRuntime =
  !isLocalDevelopmentRuntime && ZCODE_PRODUCT_FLAVOR === "preview";

function readRuntimeEnvOverride(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function isTruthyRuntimeEnvOverride(name: string): boolean {
  const value = readRuntimeEnvOverride(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// e2e runs the production build, which by default shares app name/userData with the installed ZCode;
// the single-instance lock then just focuses the existing window and Chromedriver never gets the test process.
// Let tests isolate the runtime identity explicitly; normal desktop/remote paths keep the defaults.
export const runtimeApplicationName =
  readRuntimeEnvOverride("ZCODE_DESKTOP_APPLICATION_NAME") ??
  (isLocalDevelopmentRuntime ? "ZCode Dev" : isPreviewPackagedRuntime ? "ZCode Preview" : "ZCode");
// Electron app.getPath("home") does not always follow HOME overrides in the test process.
// The e2e default workspace depends on home: allow an explicit override and keep tests off the real ~/ZCodeProject.
export const runtimeHomePath = readRuntimeEnvOverride("ZCODE_DESKTOP_HOME_DIR");
// Chromedriver injects a temp userData; in e2e default-path mode appData must not be read at import time.
export const shouldUseElectronDefaultUserDataPath = isTruthyRuntimeEnvOverride(
  "ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
);
export const runtimeUserDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR") ??
  (shouldUseElectronDefaultUserDataPath
    ? undefined
    : join(getElectronAppPath("appData"), runtimeApplicationName));
export const runtimeSessionDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_SESSION_DATA_DIR") ??
  (runtimeUserDataPath ? join(runtimeUserDataPath, "session") : undefined);
// Chromedriver injects a temp --user-data-dir and waits there for DevToolsActivePort.
// If e2e also overrides userData/sessionData via app.setPath, the port file lands in another dir and
// the session never starts. With this switch on, test mode keeps Chromedriver's directory.
export const hostModulePath = join(import.meta.dirname, "../host/index.js");
export const schedulerModulePath = join(import.meta.dirname, "../scheduler/index.js");
export function getCredentialsDir() {
  return getAppConfigDir();
}

export type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;
type LocalRuntimeEnv = Record<string, string | undefined>;

export async function isDockerDaemonAvailable(): Promise<boolean> {
  const { isDockerAvailable } = await import("@zcode/server/remote");
  return isDockerAvailable();
}

export async function listAvailableWSLDistros() {
  const { listWSLDistros } = await import("@zcode/server/remote");
  return listWSLDistros();
}

export async function listAvailableDockerContainers() {
  const { listDockerContainers } = await import("@zcode/server/remote");
  return listDockerContainers();
}

export async function listSSHConfigAliases() {
  return await listSSHConfigAliasesFromLocalConfig();
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function resolveWorkspaceRootForEnvFiles(): string | null {
  const workspaceRootCandidate = resolve(import.meta.dirname, "../../../..");
  return existsSync(join(workspaceRootCandidate, "pnpm-workspace.yaml"))
    ? workspaceRootCandidate
    : null;
}

export function loadHostProcessEnvFromLocalFiles(): Record<string, string> {
  if (isElectronAppPackaged()) {
    return resolvePackagedAgentTelemetryEnv();
  }

  const desktopRoot = resolve(import.meta.dirname, "../..");
  const workspaceRoot = resolveWorkspaceRootForEnvFiles();
  const fileCandidates = [
    ...(workspaceRoot
      ? [resolve(workspaceRoot, ".env"), resolve(workspaceRoot, ".env.local")]
      : []),
    // Dev host processes bypass Vite and load the same .env files themselves, keeping OAuth config consistent.
    ...(workspaceRoot && isLocalDevelopmentRuntime
      ? [
          resolve(workspaceRoot, ".env.development"),
          resolve(workspaceRoot, ".env.development.local"),
        ]
      : []),
    resolve(desktopRoot, ".env"),
    resolve(desktopRoot, ".env.local"),
    ...(isLocalDevelopmentRuntime
      ? [resolve(desktopRoot, ".env.development"), resolve(desktopRoot, ".env.development.local")]
      : []),
  ];

  const merged: Record<string, string> = {};
  const seen = new Set<string>();

  for (const candidate of fileCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (!existsSync(candidate)) {
      continue;
    }

    // Walking upward from cwd used to misread same-named files outside the workspace.
    // Loading is now limited to the workspace root and the desktop package dir.
    const parsed = parseDotenv(readFileSync(candidate, "utf-8"));
    Object.assign(merged, parsed);
  }

  return applySelectedZCodeEnvLinks(merged);
}

export function resolvePackagedAgentTelemetryEnv(
  compiledEnv:
    | Readonly<Record<string, string>>
    | undefined = typeof __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__ === "undefined"
    ? undefined
    : __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__,
): Record<string, string> {
  if (!compiledEnv) {
    return {};
  }

  // Fix: dev builds inherit OTLP config from the launching process; installed apps started from
  // Finder/Start menu lack it and the agent silently fell back to Noop. Build defaults may only
  // carry connection fields into Main; UID, device MID and runtime surface still come from the
  // Host's trusted runtime context.
  return readZCodeAgentTelemetryEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: compiledEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: compiledEnv.OTEL_EXPORTER_OTLP_HEADERS,
    OTEL_SERVICE_NAME: compiledEnv.OTEL_SERVICE_NAME,
    ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: compiledEnv.ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION,
  });
}

function resolveDevelopmentMockCdnDir(): string {
  return join(import.meta.dirname, "../../mock-cdn");
}

function resolveAvailableDevelopmentMockCdnDir(): string | undefined {
  const mockCdnDir = resolveDevelopmentMockCdnDir();
  const releaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
  // Dev mock-cdn is an optional offline cache. Passing mockCdnDir when the version dir is absent would
  // make WSL/SSH reconnect hit a guaranteed-missing local path, masking the CDN/cache fallback.
  return existsSync(releaseDir) ? mockCdnDir : undefined;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldUseRemoteCdnInDevelopment(localEnv: LocalRuntimeEnv = {}): boolean {
  return isTruthyEnvFlag(resolveEnvValue("ZCODE_DEV_REMOTE_ASSET_USE_CDN", localEnv));
}

function resolveRemoteCdnBaseUrls(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): string[] {
  const raw = resolveEnvValue("ZCODE_REMOTE_ASSET_CDN_BASE_URL", localEnv);
  return resolveOrderedRemoteCdnBaseUrls({
    ...options,
    env: ZCODE_ENV,
    overrideBaseUrl: raw,
    version: ZCODE_VERSION,
  });
}

function resolveEnvValue(envName: string, localEnv: LocalRuntimeEnv = {}): string | undefined {
  return process.env[envName]?.trim() || localEnv[envName]?.trim() || undefined;
}

export function resolveZCodeEndpointEnvBaseOrigin(
  localEnv: LocalRuntimeEnv = {},
): string | undefined {
  const scopedEnvName =
    ZCODE_ENV === "production" ? "ZCODE_PRODUCTION_BASE_URL" : "ZCODE_TEST_BASE_URL";
  // Bugfix: main's temporary update-service verification never rewrites .env; a CLI-provided endpoint must win over the local file.
  return (
    process.env["ZCODE_BASE_URL"]?.trim() ||
    process.env["ZCODE_ENDPOINT_ORIGIN"]?.trim() ||
    process.env[scopedEnvName]?.trim() ||
    localEnv.ZCODE_BASE_URL?.trim() ||
    localEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    localEnv[scopedEnvName]?.trim() ||
    undefined
  );
}

function readDefinedProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

function applySelectedZCodeEnvLinks(env: Record<string, string>): Record<string, string> {
  const endpointEnv = {
    ...env,
    ZCODE_ENV,
  };

  return {
    ...env,
    ZCODE_BASE_URL: env.ZCODE_BASE_URL ?? resolveRuntimeZCodeEndpointOrigin(endpointEnv),
    ZAI_OAUTH_ORIGIN: env.ZAI_OAUTH_ORIGIN ?? resolveZaiOAuthOrigin(endpointEnv),
    ZAI_BUSINESS_BASE_URL: env.ZAI_BUSINESS_BASE_URL ?? resolveZaiBusinessBaseUrl(endpointEnv),
    ZAI_OAUTH_CLIENT_ID: env.ZAI_OAUTH_CLIENT_ID ?? resolveZaiOAuthClientId(endpointEnv),
  };
}

function resolveHostProcessNodeEnv(): ZCodeRuntimeEnv {
  return desktopRuntimeEnv;
}

function resolveRemoteAssetCacheDir(localEnv: LocalRuntimeEnv = {}): string {
  const overrideCacheDir = resolveEnvValue("ZCODE_REMOTE_ASSET_CACHE_DIR", localEnv);
  if (overrideCacheDir) {
    // Dev needs the production remote cache for download checks without switching Electron userData wholesale;
    // only the remote-assets cache dir may be overridden, leaving login/window state untouched.
    return resolve(overrideCacheDir);
  }

  return join(getElectronAppPath("userData"), "remote-assets-cache");
}

export function resolveRemoteAssetDirs(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): RemoteAssetDirs {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options, localEnv);
  const remoteCdnBaseUrl = remoteCdnBaseUrls[0];

  // Remote assets used to share installer paths with desktop local provider assets, stuffing the whole Linux
  // runtime into the .app and clashing with the remote-assets-via-CDN/mock-cdn responsibility split.
  // Now explicit: dev reads the in-repo mock-cdn; production always uses CDN + local cache dir,
  // exposing no in-installer remote-assets path so they never get stuffed back into the bundle.
  // Flag: dev defaults to mock-cdn; the explicit switch alone moves to the public CDN,
  // keeping offline dev intact while allowing early real-CDN download verification.
  if (isElectronAppPackaged() || shouldUseRemoteCdnInDevelopment(localEnv)) {
    return {
      remoteCdnBaseUrl,
      remoteCdnBaseUrls,
      remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
    };
  }

  const developmentMockCdnDir = resolveAvailableDevelopmentMockCdnDir();
  return {
    ...(developmentMockCdnDir ? { mockCdnDir: developmentMockCdnDir } : {}),
    remoteCdnBaseUrl,
    remoteCdnBaseUrls,
    remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
  };
}

function resolveBundledZCodeAgentBinaryPath(): string | undefined {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const platformKey = resolvePlatformKeyForPackagedApp();
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, runtime.bundledResourceDir, ...entrySegments)
      : null,
    // Dev startup cwd may be packages/desktop or the repo root;
    // deriving bundled-agents from import.meta.dirname alone drifts across entry points.
    // Mirror services' multi-candidate roots so dev/build/restart resolve assets identically.
    join(
      process.cwd(),
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      import.meta.dirname,
      "../../bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledRuntimeToolBinaryPath(
  toolDir: string,
  binaryName: string,
): string | undefined {
  const candidateBinaryName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, "tools", toolDir, candidateBinaryName)
      : null,
    join(
      import.meta.dirname,
      "../../bundled-tools",
      resolvePlatformKeyForPackagedApp(),
      toolDir,
      candidateBinaryName,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledLarkCliBinaryPath(): string | undefined {
  return resolveBundledRuntimeToolBinaryPath("lark-cli", "lark-cli");
}

export function resolveBundledGlmBinaryPath(): string | undefined {
  return resolveBundledZCodeAgentBinaryPath();
}

function resolveHostProcessBinaryEnv(
  envVar: string,
  hostProcessLocalEnv: Record<string, string>,
  bundledPath: string | undefined,
): string | undefined {
  // The ZCode agent protocol is version-pinned; packaged builds must prefer the bundled runtime.
  // A stale GLM_BINARY_PATH from the user machine or local .env may be incompatible.
  // Explicit paths only fallback when the bundled runtime is missing; a local CLI never overrides it.
  if (bundledPath) {
    return bundledPath;
  }
  const explicitPath = process.env[envVar]?.trim() || hostProcessLocalEnv[envVar]?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  return undefined;
}

export function resolveWindowsAppInstallDirForDataBaseDirGuard(
  options: {
    platform?: NodeJS.Platform | string;
    isPackaged?: boolean;
    resourcesPath?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (platform !== "win32" || !packaged) {
    return undefined;
  }

  const trimmedResourcesPath = resourcesPath?.trim();
  if (!trimmedResourcesPath) {
    return undefined;
  }

  return win32.dirname(trimmedResourcesPath);
}

/**
 * Dynamic Workflow rollout local overrides, three tiers by build flavor:
 *
 *   - unpackaged dev: pass through legal shell values for manual tier switches; invalid values are
 *     dropped here rather than forwarded, so the Host never re-checks provenance;
 *   - packaged preview: always write `alwaysOn`, ignore shell -- preview users always have it;
 *   - packaged production: write nothing and delete inherited values, else env vars could self-enable the rollout.
 * Main is the sole decider: only write or delete on this key, never pass through, so the Host's
 * resolveDynamicWorkflowClientConfig can trust what it reads unconditionally.
 */
export function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
  isPreview: boolean;
}): Record<string, string> {
  if (!options.isPackaged) {
    const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
    return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
  }
  if (options.isPreview) {
    return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" };
  }
  return {};
}

export function buildHostProcessEnv(hostProcessLocalEnv: Record<string, string>) {
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const larkCliBinaryPath = resolveBundledLarkCliBinaryPath();
  const resolvedGlmBinaryPath = resolveHostProcessBinaryEnv(
    "GLM_BINARY_PATH",
    hostProcessLocalEnv,
    glmBinaryPath,
  );
  const resolvedLarkCliBinaryPath = resolveHostProcessBinaryEnv(
    "ZCODE_LARK_CLI_BINARY",
    hostProcessLocalEnv,
    larkCliBinaryPath,
  );
  const dataBaseDir = getDataBaseDir();
  const rawInheritedEnv = {
    ...hostProcessLocalEnv,
    ...readDefinedProcessEnv(),
  };
  const packagedDesktop = isElectronAppPackaged();
  const bundledCuaHelperAppPath =
    process.platform !== "darwin"
      ? undefined
      : packagedDesktop
        ? join(process.resourcesPath, "cua-helper", HELPER_APP_NAME)
        : // Truthy grammar must match the producer's isUnsignedHelperLocalDevRequested
          // (1|true|on, case-insensitive). Accepting only the literal "1" silently
          // ignored `true`/`on` set by scripts following the documented dev flow.
          ["1", "true", "on"].includes(
              rawInheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL?.trim().toLowerCase() ?? "",
            )
          ? rawInheritedEnv.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim() ||
            join(
              rawInheritedEnv.ZCODE_HOME?.trim() || join(homedir(), ".zcode"),
              "computer-use",
              "dev",
              DEV_HELPER_APP_NAME,
            )
          : undefined;
  const windowsAppInstallDir = resolveWindowsAppInstallDirForDataBaseDirGuard();
  const agentTelemetryEnv = readZCodeAgentTelemetryEnv(rawInheritedEnv);
  // Desktop identity is injected trusted by the host from the credential store/local state; external env may
  // configure the OTLP connection only -- never fake uid/device/surface or bypass local identity isolation.
  for (const key of [
    "ZCODE_TELEMETRY_USER_ID",
    "ZCODE_TELEMETRY_USER_ID_HASH",
    "ZCODE_TELEMETRY_USER_SUBJECT_ID",
    "ZCODE_TELEMETRY_IDENTITY_STATE",
    "ZCODE_TELEMETRY_DEVICE_MID",
    "ZCODE_TELEMETRY_RUNTIME_SURFACE",
  ]) {
    delete agentTelemetryEnv[key];
  }
  const inheritedEnv = applySelectedZCodeEnvLinks({
    ...sanitizeZCodeRuntimeEnv(rawInheritedEnv),
    ...buildZCodeToolEnvPassthroughEnv(rawInheritedEnv),
  });
  // A release app must never inherit the local unsigned-Helper escape hatch.
  // Otherwise a developer shell/launchctl variable can make the signed app
  // reject its verified bundled Helper and route onboarding to a stale dev app.
  if (packagedDesktop) {
    delete inheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL;
  }
  const dynamicWorkflowModeHostEnv = resolveDynamicWorkflowModeHostEnv({
    inheritedValue: rawInheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV],
    isPackaged: packagedDesktop,
    isPreview: isPreviewPackagedRuntime,
  });
  // Two of three tiers write nothing; an empty object cannot override inheritedEnv, so delete the inherited
  // value first, then spread the decision back. Without this, production/dev values leak through to the Host.
  delete inheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];

  return {
    ...inheritedEnv,
    // OTLP credentials go to the host only; host init captures and clears them from process.env at once,
    // then re-injects briefly at agent spawn -- never into Bash/MCP/tool env.
    ...agentTelemetryEnv,
    // The ZCode runtime no longer uses NODE_ENV (shells/package managers/test runners reuse it).
    // Emit ZCODE_RUNTIME_ENV explicitly and clear NODE_ENV from inherited env; host/agent/Bash stay clean.
    [ZCODE_RUNTIME_ENV_KEY]: resolveHostProcessNodeEnv(),
    // Inject the compile-time product identity so main and host agree; endpoints resolve separately.
    // inheritedEnv fills ZCode/ZAI links from generic .env vars, else online defaults apply.
    ZCODE_ENV,
    // Preview and production share tasks/settings/credentials, but version-mismatched Helpers must not
    // overwrite each other or trip downgrade protection; only computer-use components are isolated, never ZCODE_HOME/ZCODE_DATA_BASE_DIR.
    ...(isPreviewPackagedRuntime ? { ZCODE_CUA_HELPER_INSTALL_VARIANT: "preview" } : {}),
    // Dynamic Workflow local override, written by main's decision; empty object in production (inheritance deleted above).
    ...dynamicWorkflowModeHostEnv,
    // Default model-request headers are built by the agent process; shell-only inheritance missed the app version at startup.
    // Main now sends it explicitly; the agent inherits host env and writes a stable header.
    [ZCODE_APP_VERSION_ENV]: ZCODE_VERSION,
    // Telemetry build identity must come from Desktop compile-time metadata; the agent must not
    // read the worktree or guess from the install path, or different patch builds of one version
    // become indistinguishable in ARMS.
    [ZCODE_BUILD_COMMIT_ID_ENV]: ZCODE_COMMIT,
    ...(dataBaseDir !== homedir() ? { ZCODE_DATA_BASE_DIR: dataBaseDir } : {}),
    ...(windowsAppInstallDir ? { [ZCODE_WINDOWS_APP_INSTALL_DIR_ENV]: windowsAppInstallDir } : {}),
    ...(bundledCuaHelperAppPath
      ? { [ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]: bundledCuaHelperAppPath }
      : {}),
    ...(resolvedGlmBinaryPath ? { GLM_BINARY_PATH: resolvedGlmBinaryPath } : {}),
    ...(resolvedLarkCliBinaryPath ? { ZCODE_LARK_CLI_BINARY: resolvedLarkCliBinaryPath } : {}),
  };
}
