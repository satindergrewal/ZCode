import {
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildZCodeEndpointUrls,
  getForceUpdateMinimalVersionFromConfig,
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
  type Locale,
} from "@zcode/shared";
import { requestForceAutoUpdate, type ForceAutoUpdateState } from "./autoUpdater.js";
import { showForceUpdatePrompt } from "./forceUpdatePrompt.js";

const ZCODE_CLIENT_CONFIG_API_PATH = "/api/v1/client/configs";
const FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS = 10_000;
const FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

interface ForceUpdateGuardOptions {
  locale: Locale;
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  requestAutoUpdate?: (
    onStateChange?: (state: ForceAutoUpdateState) => void,
  ) => (() => void) | void;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

function resolveForceUpdateClientConfigUrl(endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN): string {
  const url = new URL(
    `${buildZCodeEndpointUrls(endpointOrigin).origin}${ZCODE_CLIENT_CONFIG_API_PATH}`,
  );
  url.searchParams.set("app_version", ZCODE_VERSION);
  url.searchParams.set("platform", `${process.platform}-${process.arch}`);
  return url.toString();
}

function getForceUpdateMinimalVersionFromClientConfig(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) {
    return undefined;
  }

  const envelope = config as {
    code?: unknown;
    data?: {
      configs?: unknown;
    };
  };
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    // Like the service layer, /client/configs is trustable only on code=0; a stale-data error envelope must not gate.
    throw new Error(`ZCode client config failed: ${envelope.code}`);
  }
  return getForceUpdateMinimalVersionFromConfig(envelope.data?.configs);
}

async function fetchRemoteForceUpdateConfig(
  endpointOrigin?: string,
  fetchRemoteConfig?: () => Promise<unknown>,
): Promise<unknown> {
  if (fetchRemoteConfig) {
    return fetchRemoteConfig();
  }

  const { net } = await import("electron");
  return new Promise<unknown>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("force update config request timeout"));
    }, FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    request = net.request(resolveForceUpdateClientConfigUrl(endpointOrigin));
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        // Never parse 4xx/5xx/HTML error pages as config; take the offline-degraded path.
        fail(new Error(`force update config request failed with status ${statusCode}`));
        return;
      }

      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES) {
          // Read before any window exists; cap the body so a runaway response cannot balloon main memory.
          fail(new Error("force update config response too large"));
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}

async function resolveDesktopForceUpdateRequirement(options: {
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
}): Promise<ForceUpdateRequirement | null> {
  const resolveFromConfig = (config: unknown) =>
    resolveForceUpdateRequirement({
      currentVersion: ZCODE_VERSION,
      forceUpdate: {
        minimalVersion:
          getForceUpdateMinimalVersionFromClientConfig(config) ??
          getForceUpdateMinimalVersionFromConfig(config) ??
          "",
      },
    });

  try {
    const remoteConfig = await fetchRemoteForceUpdateConfig(
      options.endpointOrigin,
      options.fetchRemoteConfig,
    );
    const remoteRequirement = resolveFromConfig(remoteConfig);
    if (remoteRequirement) {
      return remoteRequirement;
    }
  } catch (error) {
    // Offline-skip hook: keep the gate open when fully offline; wire an explicit bypass here later.
    options.logger.warn(
      "[force-update] failed to read remote force-update config, skipping the check",
      { error },
    );
    return null;
  }

  return null;
}

function resolveForceUpdateDownloadUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn` : `${origin}/en`;
}

function formatForceUpdateDialogText(
  requirement: ForceUpdateRequirement,
  locale: Locale,
): ForceUpdateDialogText {
  if (locale === "zh-CN") {
    return {
      title: "需要升级 ZCode",
      message: "当前版本无法继续使用",
      detail: `当前版本：v${requirement.currentVersion}\n最低可用版本：v${requirement.minimalVersion}`,
      autoUpdateButton: "自动升级",
      manualUpdateButton: "手动升级",
      quitButton: "退出",
    };
  }

  return {
    title: "Update ZCode",
    message: "The current version can no longer be used",
    detail: `Current version: v${requirement.currentVersion}\nMinimum supported version: v${requirement.minimalVersion}`,
    autoUpdateButton: "Auto update",
    manualUpdateButton: "Manual update",
    quitButton: "Quit",
  };
}

export async function maybeBlockStartupForForceUpdate(
  options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  const requirement = await resolveDesktopForceUpdateRequirement({
    ...options,
    endpointOrigin: options.endpointOrigin,
  });
  if (!requirement) {
    return { blocked: false };
  }

  options.logger.warn(
    "[force-update] remote config requires forced update, blocking main window creation",
    requirement,
  );
  options.onBlocked?.(requirement);
  const { app, shell } = await import("electron");
  const action = await showForceUpdatePrompt(
    formatForceUpdateDialogText(requirement, options.locale),
    options.locale,
    options.logger,
    {
      startAutoUpdate: (onStateChange) =>
        options.requestAutoUpdate?.(onStateChange) ??
        requestForceAutoUpdate(onStateChange, "force-update", requirement.minimalVersion),
    },
  );
  if (action === "auto") {
    return { blocked: true, requirement };
  }

  if (action === "manual") {
    const url = resolveForceUpdateDownloadUrl(options.locale, options.endpointOrigin);
    options.logger.info(`[force-update] user chose manual update: ${url}`);
    await shell.openExternal(url);
  }

  // Once gated, never show the old UI; non-auto-update paths exit after the dialog closes.
  app.quit();
  return { blocked: true, requirement };
}
