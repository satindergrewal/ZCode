import { getPluginSandboxHost } from "./pluginSandbox/index.js";
/* eslint-disable max-lines -- desktop command dispatch shares window/platform context; central keeps it consistent */
import { readZCodeStdioTapDevState, setZCodeStdioTapDevEnabled } from "@zcode/services/node";
import {
  buildZCodeEndpointUrls,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  DesktopCommandIds,
  REWARDS_PARTITION,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  getCommunityUrlFromConfigs,
  getFeedbackUrlFromConfig,
  normalizeZCodeEndpointOrigin,
  PlatformChannels,
  resolveHelpAppConfig,
  resolveZCodeEndpointOrigin,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  type AppSettings,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import type { MessageBoxOptions } from "electron";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { showAboutDialog } from "./about.js";
import { checkForUpdateMenuClick } from "./autoUpdater.js";
import { resolveCuaOsSupport } from "./cuaOsSupport.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import {
  DEFAULT_DESKTOP_WINDOW_HEIGHT,
  DEFAULT_DESKTOP_WINDOW_WIDTH,
} from "./desktopWindowSize.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { exportLogs } from "./exportLogs.js";
import { openResourceManager } from "./resourceManagerWindow.js";

export const HELP_TOGGLE_DEV_TOOLS_MENU_ID = "help.toggle-dev-tools";
export const HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID = "help.toggle-zcode-stdio-tap";
const ZCODE_ENDPOINT_PROMPT_WIDTH = 460;
const ZCODE_ENDPOINT_PROMPT_HEIGHT = 210;
const CODING_PLAN_WEBVIEW_PARTITION = "persist:zcode-coding-plan";

function resolveTargetWindow(senderWindow?: BrowserWindow | null) {
  if (senderWindow && !senderWindow.isDestroyed()) {
    return senderWindow;
  }

  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}
export function updateDesktopZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  action: "reset" | "in" | "out",
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const currentLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  const nextLevel =
    action === "reset" ? 0 : clampDesktopZoomLevel(currentLevel + (action === "in" ? 1 : -1));

  // Keep the system zoom shortcuts usable, but clamp so the UI cannot grow/shrink unbounded.
  // Electron zoomLevel is really 1.2^level; use zoomFactor so every step is a uniform 1.1.
  targetWindow.webContents.setZoomFactor(resolveDesktopZoomFactorForLevel(nextLevel));
  syncWindowControlsOverlayForZoomLevel(targetWindow, nextLevel);
  targetWindow.webContents.send(PlatformChannels.DesktopZoomLevelChanged, { zoomLevel: nextLevel });
  return nextLevel;
}

function showMessageBoxWithOptionalParent(
  parentWindow: BrowserWindow | null | undefined,
  options: MessageBoxOptions,
) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}
async function clearAllDataAndRelaunch(options: {
  credentialsDir: string;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}) {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Clear All"],
    defaultId: 0,
    cancelId: 0,
    title: "Clear All Data",
    message: "Clear all data?",
    detail:
      "Deletes ~/.zcode/v2 (settings, credentials, logs) and browser cache (localStorage). This cannot be undone; the app restarts afterwards.",
  });
  if (response !== 1) {
    return;
  }

  await getPluginSandboxHost()?.clearBrowserData();
  const { rm } = await import("node:fs/promises");
  try {
    await rm(options.credentialsDir, { recursive: true, force: true });
    options.logger.info("[clear-all-data] deleted ~/.zcode/v2");
  } catch (error) {
    options.logger.error("[clear-all-data] failed to delete ~/.zcode/v2:", error);
  }

  for (const win of BrowserWindow.getAllWindows()) {
    try {
      await win.webContents.executeJavaScript("localStorage.clear()");
    } catch {
      // Window may already be destroyed; ignore.
    }
  }

  try {
    const session = BrowserWindow.getAllWindows()[0]?.webContents.session;
    if (session) {
      await session.clearStorageData();
      options.logger.info("[clear-all-data] cleared session storage data");
    }
  } catch (error) {
    options.logger.error("[clear-all-data] failed to clear session data:", error);
  }

  app.relaunch();
  app.exit(0);
}

export async function clearCodingPlanWebviewStorage(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}) {
  try {
    // The Coding Plan webview uses a dedicated persistent partition; a default-window session.clearStorageData()
    // never touches it. Clear explicitly on logout/data-reset so the next storefront visit sees no stale account token.
    await session.fromPartition(CODING_PLAN_WEBVIEW_PARTITION).clearStorageData();
    await session.fromPartition(REWARDS_PARTITION).clearStorageData();
    options.logger.info("[coding-plan-webview] cleared persistent partition storage");
  } catch (error) {
    options.logger.warn(
      "[coding-plan-webview] failed to clear persistent partition storage:",
      error,
    );
  }
}

async function fetchRemoteAppConfig(fetchRemoteConfig?: () => Promise<unknown>): Promise<unknown> {
  if (!fetchRemoteConfig) throw new Error("Help config reader is unavailable");
  return fetchRemoteConfig();
}

export function resolveLocalAppConfigPath(options?: {
  appPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
}): string {
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  if (isPackaged) {
    // In packaged builds app.getAppPath() points into resources/app.asar; walking up two levels misreads
    // Contents/config. electron-builder puts the built-in config in resources/config -- resolve from resourcesPath.
    return join(options?.resourcesPath ?? process.resourcesPath, "config/default.json");
  }
  return join(options?.appPath ?? app.getAppPath(), "../../config/default.json");
}

async function readLocalAppConfig(readLocalConfig?: () => unknown): Promise<unknown> {
  const localConfigPath = resolveLocalAppConfigPath();
  return readLocalConfig?.() ?? JSON.parse(await readFile(localConfigPath, "utf-8"));
}

async function resolveRemoteAppConfigValue(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  resolveFromConfig: (config: unknown) => string | undefined;
  logPrefix: "feedback" | "community";
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  try {
    const remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
    const remoteResolvedValue = options.resolveFromConfig(remoteConfig);
    if (remoteResolvedValue) {
      return remoteResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to fetch remote config:`, error);
  }

  try {
    const localConfig = await readLocalAppConfig(options.readLocalConfig);
    const localResolvedValue = options.resolveFromConfig(localConfig);
    if (localResolvedValue) {
      return localResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to read local config:`, error);
  }

  return undefined;
}

export async function resolveFeedbackUrl(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  return resolveRemoteAppConfigValue({
    ...options,
    logPrefix: "feedback",
    resolveFromConfig: getFeedbackUrlFromConfig,
  });
}

export async function resolveCommunityUrl(options: {
  locale: Locale;
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  let remoteConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
  } catch (error) {
    options.logger.warn("[community] failed to fetch remote config:", error);
  }

  let localConfig: unknown;
  try {
    localConfig = await readLocalAppConfig(options.readLocalConfig);
  } catch (error) {
    options.logger.warn("[community] failed to read local config:", error);
  }

  return getCommunityUrlFromConfigs(remoteConfig, localConfig, options.locale);
}

async function openFeedback(
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  targetWindow?: BrowserWindow | null,
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  let remoteConfig: unknown;
  let localConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(fetchRemoteConfig);
  } catch (error) {
    logger.warn("[feedback] failed to fetch remote config:", error);
  }
  try {
    localConfig = await readLocalAppConfig();
  } catch (error) {
    logger.warn("[feedback] failed to read local config:", error);
  }
  const config = resolveHelpAppConfig(remoteConfig, localConfig);
  if (!config.feedback_use_external_form) {
    resolveTargetWindow(targetWindow)?.webContents.send(PlatformChannels.OpenFeedbackDialog);
    return;
  }
  if (config.feedback_url) await shell.openExternal(config.feedback_url);
}

async function openCommunity(
  locale: Locale,
  logger: {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  },
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  const communityUrl = await resolveCommunityUrl({ locale, logger, fetchRemoteConfig });
  if (!communityUrl) {
    logger.warn("[community] community_urls is missing from both remote and local config");
    return;
  }
  await shell.openExternal(communityUrl);
}

async function promptCustomZCodeEndpoint(
  targetWindow: BrowserWindow | null | undefined,
  currentValue: string,
): Promise<string | undefined> {
  return showZCodeEndpointPromptWindow({
    currentValue,
    parentWindow: targetWindow && !targetWindow.isDestroyed() ? targetWindow : undefined,
  });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildZCodeEndpointPromptHtml(currentValue: string): string {
  const value = escapeHtmlAttribute(currentValue);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ZCode Endpoint</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; height: 34px; padding: 6px 8px; font: inherit; }
      .hint { margin-top: 8px; color: #6b7280; font-size: 12px; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
      button { min-width: 78px; height: 30px; font: inherit; }
    </style>
  </head>
  <body>
    <form id="form">
      <label for="endpoint">ZCode endpoint origin</label>
      <input id="endpoint" value="${value}" placeholder="https://zcode.z.ai" spellcheck="false" />
      <div class="hint">Use an http or https origin, for example https://zcode.z.ai.</div>
      <div class="actions">
        <button id="cancel" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
    <script>
      const input = document.getElementById("endpoint");
      const submit = (value) => { document.title = "zcode-endpoint-submit:" + encodeURIComponent(value); };
      document.getElementById("form").addEventListener("submit", (event) => {
        event.preventDefault();
        submit(input.value);
      });
      document.getElementById("cancel").addEventListener("click", () => {
        document.title = "zcode-endpoint-cancel";
      });
      input.focus();
      input.select();
    </script>
  </body>
</html>`;
}

function showZCodeEndpointPromptWindow(options: {
  currentValue: string;
  parentWindow?: BrowserWindow;
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const promptWindow = new BrowserWindow({
      width: ZCODE_ENDPOINT_PROMPT_WIDTH,
      height: ZCODE_ENDPOINT_PROMPT_HEIGHT,
      parent: options.parentWindow,
      modal: Boolean(options.parentWindow),
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "ZCode Endpoint",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      if (!promptWindow.isDestroyed()) {
        promptWindow.close();
      }
    };

    promptWindow.on("closed", () => finish(undefined));
    promptWindow.on("page-title-updated", (event, title) => {
      if (title === "zcode-endpoint-cancel") {
        event.preventDefault();
        finish(undefined);
        return;
      }
      if (!title.startsWith("zcode-endpoint-submit:")) {
        return;
      }
      event.preventDefault();
      finish(decodeURIComponent(title.slice("zcode-endpoint-submit:".length)));
    });

    // Electron menu commands fire in the main process; renderer window.prompt may be disabled or unfocused (click does nothing).
    // Use a main-process controlled modal input instead so Custom... always has a visible entry point.
    void promptWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildZCodeEndpointPromptHtml(options.currentValue),
      )}`,
    );
  });
}

async function setZCodeEndpointOverride(options: {
  value: string | undefined;
  settingService: { update(patch: { zcodeEndpointOrigin?: string | undefined }): Promise<void> };
  onZCodeEndpointChanged: () => Promise<void> | void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  if (ZCODE_ENV === "production") {
    return;
  }
  const normalized = options.value ? normalizeZCodeEndpointOrigin(options.value) : undefined;
  await options.settingService.update({ zcodeEndpointOrigin: normalized });
  await options.onZCodeEndpointChanged();
}

async function persistDesktopZoomLevel(options: {
  zoomLevel: number;
  logger: { warn: (...args: unknown[]) => void };
  settingService: { update(patch: Pick<AppSettings, "desktopZoomLevel">): Promise<void> };
}) {
  try {
    // Desktop zoom commands used to touch only the live BrowserWindow, with no restore source after restart.
    // On success persist the clamped level to setting.json -- shortcut, View menu, and sidebar share one truth.
    await options.settingService.update({ desktopZoomLevel: options.zoomLevel });
  } catch (error) {
    options.logger.warn("[desktop-zoom] persist zoom level failed:", error);
  }
}

function toggleZCodeStdioTapDevProxy(options: {
  logger: { info: (...args: unknown[]) => void };
  updateZCodeStdioTapDevMenuState: () => void;
}) {
  const current = readZCodeStdioTapDevState();
  const next = setZCodeStdioTapDevEnabled(!current.enabled);
  options.updateZCodeStdioTapDevMenuState();
  options.logger.info("[stdio-tap] dev proxy toggled", {
    enabled: next.enabled,
    visible: next.visible,
    logDir: next.logDir,
  });
}

function resolveChangelogUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  // Help-menu external links used to be fixed English URLs, landing on the English changelog even in zh UI.
  // Centralize locale branching in main instead of hand-written menu-template branches.
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn/changelog` : `${origin}/en/changelog`;
}

export async function openChangelog(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
) {
  await shell.openExternal(resolveChangelogUrl(locale, endpointOrigin));
}

async function resolveCurrentZCodeEndpointOrigin(settingService: {
  get(): Promise<{ zcodeEndpointOrigin?: string }>;
  envBaseOrigin?: string | null;
}): Promise<string> {
  const settings = await settingService.get();
  return resolveZCodeEndpointOrigin({
    env: ZCODE_ENV,
    envBaseOrigin: settingService.envBaseOrigin,
    overrideOrigin: settings.zcodeEndpointOrigin,
  });
}

export async function executeDesktopCommand(options: {
  command: DesktopCommandId;
  fetchHelpConfig?: () => Promise<unknown>;
  senderWindow?: BrowserWindow | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  updateZCodeStdioTapDevMenuState: () => void;
  onDesktopZoomChanged?: (zoomLevel: number) => Promise<void> | void;
  onZCodeEndpointChanged: () => Promise<void> | void;
  onRelaunchApp: () => Promise<void>;
  settingService: {
    get(): Promise<Pick<AppSettings, "zcodeEndpointOrigin" | "desktopZoomLevel">>;
    update(
      patch: Partial<Pick<AppSettings, "zcodeEndpointOrigin" | "desktopZoomLevel">>,
    ): Promise<void>;
  };
  zcodeEndpointEnvBaseOrigin?: string | null;
  credentialsDir: string;
  currentApplicationLocale: Locale;
}) {
  const targetWindow = resolveTargetWindow(options.senderWindow);
  options.logger.info(
    `[desktop-command] execute ${options.command} windowId=${targetWindow?.id ?? "<none>"}`,
  );

  switch (options.command) {
    case DesktopCommandIds.NewTask:
      targetWindow?.webContents.send(PlatformChannels.NewTask);
      return;
    case DesktopCommandIds.OpenWorkspace:
      targetWindow?.webContents.send(PlatformChannels.OpenWorkspace);
      return;
    case DesktopCommandIds.CloseActiveContext:
      targetWindow?.webContents.send(PlatformChannels.CloseActiveContextRequest);
      return;
    case DesktopCommandIds.CloseWindow:
      targetWindow?.close();
      return;
    case DesktopCommandIds.MinimizeWindow:
      targetWindow?.minimize();
      return;
    case DesktopCommandIds.ToggleMaximizeWindow:
      if (targetWindow?.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow?.maximize();
      }
      return;
    case DesktopCommandIds.ToggleFullScreen:
      if (targetWindow) {
        targetWindow.setFullScreen(!targetWindow.isFullScreen());
      }
      return;
    case DesktopCommandIds.ResetWindowSize:
      if (targetWindow) {
        if (targetWindow.isFullScreen()) targetWindow.setFullScreen(false);
        if (targetWindow.isMaximized()) targetWindow.unmaximize();
        targetWindow.setSize(DEFAULT_DESKTOP_WINDOW_WIDTH, DEFAULT_DESKTOP_WINDOW_HEIGHT, true);
      }
      return;
    case DesktopCommandIds.ResetZoom:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "reset");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomIn:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "in");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomOut:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "out");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ShowAbout:
      await showAboutDialog(targetWindow ?? undefined, options.currentApplicationLocale);
      return;
    case DesktopCommandIds.OpenChangelog:
      await openChangelog(
        options.currentApplicationLocale,
        await resolveCurrentZCodeEndpointOrigin({
          ...options.settingService,
          envBaseOrigin: options.zcodeEndpointEnvBaseOrigin,
        }),
      );
      return;
    case DesktopCommandIds.CheckForUpdates:
      // Gate by product identity, not backend env: Preview on the production backend still has no updater.
      if (ZCODE_PRODUCT_FLAVOR === "production") {
        checkForUpdateMenuClick(targetWindow);
      } else {
        options.logger.info("[auto-update] manual update check disabled for Preview");
      }
      return;
    case DesktopCommandIds.RelaunchApp:
      await options.onRelaunchApp();
      return;
    case DesktopCommandIds.OpenFeedback:
      await openFeedback(options.logger, targetWindow, options.fetchHelpConfig);
      return;
    case DesktopCommandIds.OpenCommunity:
      await openCommunity(
        options.currentApplicationLocale,
        options.logger,
        options.fetchHelpConfig,
      );
      return;
    case DesktopCommandIds.ExportLogs:
      await exportLogs();
      return;
    case DesktopCommandIds.ToggleDevTools:
      targetWindow?.webContents.toggleDevTools();
      return;
    case DesktopCommandIds.OpenResourceManager:
      openResourceManager();
      return;
    case DesktopCommandIds.ToggleZCodeStdioTapDevProxy:
      toggleZCodeStdioTapDevProxy({
        logger: options.logger,
        updateZCodeStdioTapDevMenuState: options.updateZCodeStdioTapDevMenuState,
      });
      return;
    case DesktopCommandIds.SetZCodeEndpointProduction:
      await setZCodeEndpointOverride({
        value: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.SetZCodeEndpointTest:
      await setZCodeEndpointOverride({
        value: TEST_ZCODE_ENDPOINT_ORIGIN,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.SetZCodeEndpointCustom: {
      const current =
        (await options.settingService.get()).zcodeEndpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
      const value = await promptCustomZCodeEndpoint(targetWindow, current);
      if (!value) {
        return;
      }
      try {
        await setZCodeEndpointOverride({
          value,
          settingService: options.settingService,
          onZCodeEndpointChanged: options.onZCodeEndpointChanged,
          logger: options.logger,
        });
      } catch (error) {
        await showMessageBoxWithOptionalParent(targetWindow, {
          type: "error",
          title: "ZCode Endpoint",
          message: "Invalid endpoint",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    case DesktopCommandIds.ResetZCodeEndpoint:
      await setZCodeEndpointOverride({
        value: undefined,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.ClearAllData:
      await clearCodingPlanWebviewStorage({ logger: options.logger });
      await clearAllDataAndRelaunch({
        credentialsDir: options.credentialsDir,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.ClearCodingPlanWebviewStorage:
      await clearCodingPlanWebviewStorage({ logger: options.logger });
      return;
    case DesktopCommandIds.GetCuaOsSupport:
      return resolveCuaOsSupport();
  }
}
