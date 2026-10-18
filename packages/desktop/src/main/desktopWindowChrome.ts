/* eslint-disable max-lines -- desktop window chrome, webview security policy, and popup routing share one BrowserWindow lifecycle. */
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, shell } from "electron";
import { join } from "node:path";
import type {
  ContextMenuParams,
  Input,
  MenuItemConstructorOptions,
  WebContents,
  WindowOpenHandlerResponse,
} from "electron";
import type { DesktopTitleBarTheme, Locale } from "@zcode/shared";
import {
  DEFAULT_LOCALE,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isTrustedCodingPlanWebviewOrigin,
  isTrustedRewardsUrl,
  PlatformChannels,
} from "@zcode/shared";
import { loadWindow, type WindowBootstrapOptions } from "./desktopHostProcess.js";
import {
  buildWindowsTitleBarOverlayForZoomLevel,
  hasCustomWindowsControls,
  registerCustomWindowsControls,
  MACOS_TRAFFIC_LIGHT_BASE_POSITION,
  syncWindowControlsOverlayForZoomLevel,
} from "./desktopWindowButtonPosition.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import {
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  resolveDesktopWindowSize,
  type DesktopWindowSize,
} from "./desktopWindowSize.js";
import { getPluginSandboxHost, isPluginSandboxSrc } from "./pluginSandbox/index.js";
import { installEmbeddedBrowserBluetoothDeviceGuard } from "./embeddedBrowserBluetoothGuard.js";
import { getEmbeddedBrowserDevicePicker } from "./embeddedBrowserPermissionUiBridge.js";
// CDP-on-guest pivot: the built-in browser renders via <webview> again, so the host BrowserWindow re-enables webviewTag
// and hardens guests plus URL allowlisting and popup routing back to internal tabs in will/did-attach-webview.
const ALLOWED_EMBEDDED_BROWSER_PROTOCOLS = new Set([
  "about:",
  "data:",
  "http:",
  "https:",
  "zcode-browser-restore:",
]);
const ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_BROWSER_DISPOSITIONS = new Set(["background-tab"]);
const CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS = new Set(["api.z.ai", "api.z.ai"]);
const embeddedBrowserJavaScriptDialogPreloadPath = join(
  import.meta.dirname,
  "../preload/embeddedBrowserJavaScriptDialog.cjs",
);
// Coding Plan storefront preload: exposes window.zcodeBridge so the storefront can report purchase completion.
const codingPlanWebviewPreloadPath = join(import.meta.dirname, "../preload/codingPlanWebview.cjs");

/**
 * Whether the webview loaded the Coding Plan purchase page (/coding-plan?...&embedded=app).
 * Used in will-attach-webview to switch such webviews to codingPlanWebviewPreloadPath while every other webview
 * (the built-in browser included) keeps embeddedBrowserJavaScriptDialogPreloadPath.
 */
function isCodingPlanEmbeddedWebviewSrc(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (url.pathname !== "/coding-plan") return false;
    const embedded = url.searchParams.get("embedded");
    return embedded === "app";
  } catch {
    return false;
  }
}

/**
 * Loose check whether the webview URL is still a coding-plan purchase page.
 *
 * The webview may have locale-redirected by the time setWindowOpenHandler runs
 * (/coding-plan to /cn/coding-plan), so match the pathname via includes.
 * embedded=app stays a hard condition so external links in the built-in browser never match.
 */
function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isLinuxDesktopWindow() {
  return process.platform === "linux";
}

function buildDesktopWindowVisualOptions() {
  if (process.platform === "darwin") {
    return {
      backgroundColor: "#00000000",
      titleBarStyle: "hidden" as const,
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_BASE_POSITION,
      vibrancy: "under-window" as const,
      visualEffectState: "active" as const,
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundColor: "#00000000",
      // Windows window controls are renderer-drawn; disable the native title bar to avoid two button sets.
      frame: false,
      backgroundMaterial: "acrylic" as const,
    };
  }

  return {
    // An opaque BrowserWindow fills the renderer's rounded corners back to square black,
    // so the Linux shell cannot form concentric arcs with the inner 12px panel. Transparency only reveals the corners;
    // the renderer root stays opaque so the desktop background never bleeds into the sidebar.
    backgroundColor: "#00000000",
    transparent: true,
    // A native Linux title bar duplicates the renderer-drawn menu; hiding the frame centralizes custom window controls.
    frame: false,
    // Some Linux window managers draw an extra outer shadow/border on frameless windows,
    // seen as a black outline. Disable system shadow on Linux only, preserving native materials on macOS/Windows.
    hasShadow: false,
  };
}

export function applyAppIcon(iconPath: string) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  // TypeScript does not narrow app.dock from a process.platform === "darwin" check.
  // app.dock is typed as possibly undefined, so direct calls keep raising ts(18048).
  // Combine the platform and null checks: runtime-correct and proves to the type system that the Dock exists.
  const dockIcon = nativeImage.createFromPath(iconPath);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function syncWindowFullscreenState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send(
    PlatformChannels.WindowFullscreenChanged,
    targetWindow.isFullScreen(),
  );
}

function syncDesktopWindowChromeState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) return;

  targetWindow.webContents.send(
    PlatformChannels.DesktopWindowChromeStateChanged,
    resolveDesktopWindowChromeState(targetWindow.isMaximized()),
  );
}

export function getWindowOverlayTheme(): Exclude<DesktopTitleBarTheme, "system"> {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function applyWindowsTitleBarTheme(
  targetWindow: BrowserWindow,
  theme: DesktopTitleBarTheme,
) {
  if (
    process.platform !== "win32" ||
    targetWindow.isDestroyed() ||
    hasCustomWindowsControls(targetWindow)
  ) {
    return;
  }

  const resolvedTheme = theme === "system" ? getWindowOverlayTheme() : theme;
  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  targetWindow.setTitleBarOverlay(
    buildWindowsTitleBarOverlayForZoomLevel(zoomLevel, resolvedTheme),
  );
}

function attachWindowsWindowRepaint(targetWindow: BrowserWindow) {
  if (process.platform !== "win32") {
    return;
  }

  let pendingRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  const repaint = () => {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
      return;
    }

    targetWindow.webContents.invalidate();
  };

  const scheduleRepaint = () => {
    repaint();
    if (pendingRepaintTimer !== null) {
      clearTimeout(pendingRepaintTimer);
    }
    pendingRepaintTimer = setTimeout(() => {
      pendingRepaintTimer = null;
      repaint();
    }, 32);
  };

  targetWindow.on("resized", () => {
    // After a manual Windows resize, Electron/Chromium sometimes updates only the window bounds
    // without a full renderer repaint, leaving host-colored areas. resized is a low-frequency end event;
    // repaint the whole window once so content fills the final viewport.
    scheduleRepaint();
  });
  targetWindow.on("show", () => {
    // A Windows Acrylic window re-shown from the tray can reuse a stale compositor surface,
    // leaving host background only. Reuse the bounded two-frame repaint from resize; never reload renderer or session.
    scheduleRepaint();
  });
}

function isAllowedEmbeddedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isAllowedEmbeddedBrowserNewWindowUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    // The backend's PayPal approveUrl may first point at a Z.AI payment relay that 302s to PayPal.
    // That relay URL must also stay in this webview or the system browser takes over.
    return (
      CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function hasExternalBrowserModifier(input: Input): boolean {
  const modifiers = new Set(input.modifiers ?? []);
  return (
    input.meta === true ||
    input.control === true ||
    modifiers.has("meta") ||
    modifiers.has("command") ||
    modifiers.has("cmd") ||
    modifiers.has("control") ||
    modifiers.has("ctrl")
  );
}

function isExternalBrowserModifierKey(input: Input): boolean {
  const key = input.key.toLowerCase();
  const code = input.code.toLowerCase();
  return (
    key === "meta" ||
    key === "control" ||
    code === "metaleft" ||
    code === "metaright" ||
    code === "controlleft" ||
    code === "controlright"
  );
}

function shouldOpenEmbeddedBrowserRequestExternally(input: {
  disposition: string;
  externalBrowserModifierActive: boolean;
}): boolean {
  return (
    input.externalBrowserModifierActive || EXTERNAL_BROWSER_DISPOSITIONS.has(input.disposition)
  );
}

function attachEmbeddedBrowserWindowOpenHandler(options: {
  hostWebContents: WebContents;
  guestWebContents: WebContents;
  isCodingPlanGuest: boolean;
  isRewardsGuest: boolean;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
  logger: { warn: (...args: unknown[]) => void };
}) {
  let externalBrowserModifierActive = false;

  options.guestWebContents.on("before-input-event", (_event, input) => {
    // Some platforms report modifiers on keyUp; remembering the last modifiers directly
    // makes open-in-system-browser stick, so later plain clicks open externally too.
    if (input.type === "keyUp" && isExternalBrowserModifierKey(input)) {
      externalBrowserModifierActive = false;
      return;
    }

    externalBrowserModifierActive = hasExternalBrowserModifier(input);
  });

  options.guestWebContents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const { url, disposition } = details;
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview popup url: ${url}`);
      return { action: "deny" };
    }

    // Coding Plan webview external links (terms/admin, target=_blank) open the system default browser directly
    // instead of internal tabs (matching the native purchase panel). By callback time the webview URL
    // has finished loading and may be /cn/coding-plan after locale redirect; use the loose match.
    // Payment links use location.href (no setWindowOpenHandler) and are unaffected.
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldRouteCodingPlanPopup =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (shouldRouteCodingPlanPopup) {
      if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
        // PayPal authorize/callback is part of the Coding Plan purchase and must not escape to the system browser,
        // or the return trip loses purchase context; popups navigate the current guest instead.
        void options.guestWebContents.loadURL(url).catch((error: unknown) => {
          options.logger.warn(
            "[browser-pane] failed to load coding-plan embedded popup in webview",
            {
              error: error instanceof Error ? error.message : String(error),
              url,
            },
          );
        });
        return { action: "deny" };
      }
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open coding-plan popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    if (
      shouldOpenEmbeddedBrowserRequestExternally({
        disposition,
        externalBrowserModifierActive,
      })
    ) {
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open webview popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    const owner = options.resolveBrowserViewOwner?.(options.guestWebContents.id);
    options.hostWebContents.send(PlatformChannels.OpenBrowserUrl, {
      disposition,
      url,
      ...(owner
        ? {
            workspaceKey: owner.workspaceKey,
            ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
            sessionId: owner.sessionId,
            browserId: owner.browserId,
            browserGeneration: owner.browserGeneration,
            sourceTabId: owner.tabId,
          }
        : {}),
    });
    return { action: "deny" };
  });

  options.guestWebContents.on("will-navigate", (event, url) => {
    if (options.isRewardsGuest) {
      if (
        isTrustedRewardsUrl(url, {
          dev: !app.isPackaged,
          e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
        })
      )
        return;
      // Leaving the trusted invite flow must open externally; third-party pages must not reuse the credentialed container.
      event.preventDefault();
      if (isAllowedEmbeddedBrowserNewWindowUrl(url))
        void shell
          .openExternal(url)
          .catch(() => options.logger.warn("[rewards] external navigation failed"));
      return;
    }
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldGuardCodingPlanNavigation =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (!shouldGuardCodingPlanNavigation || isCodingPlanWebviewUrl(url)) {
      return;
    }
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported coding-plan navigation url: ${url}`);
      event.preventDefault();
      return;
    }
    if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
      // A storefront location.href PayPal authorize triggers a main-frame navigation.
      // PayPal/relay/trusted-storefront returns must stay in this webview for the callback to continue the subscription.
      return;
    }

    // The Coding Plan preload persists across later main-frame navigations.
    // Off the trusted purchase pages, block guest navigation and hand off to the system browser so third parties never inherit zcodeBridge.
    event.preventDefault();
    void shell.openExternal(url).catch((error: unknown) => {
      options.logger.warn("[browser-pane] failed to open coding-plan navigation externally", {
        error: error instanceof Error ? error.message : String(error),
        url,
      });
    });
  });
}

function buildTextContextMenuTemplate(
  params: ContextMenuParams,
  locale: Locale,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
      getDesktopMenuMessage(locale, id);

    return [
      {
        label: getLabel(desktopMenuMessageIds.editUndo),
        role: "undo",
        enabled: params.editFlags.canUndo,
      },
      {
        label: getLabel(desktopMenuMessageIds.editRedo),
        role: "redo",
        enabled: params.editFlags.canRedo,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editCut),
        role: "cut",
        enabled: params.editFlags.canCut,
      },
      {
        label: getLabel(desktopMenuMessageIds.editCopy),
        role: "copy",
        enabled: params.editFlags.canCopy,
      },
      {
        label: getLabel(desktopMenuMessageIds.editPaste),
        role: "paste",
        enabled: params.editFlags.canPaste,
      },
      {
        label: getLabel(desktopMenuMessageIds.editDelete),
        role: "delete",
        enabled: params.editFlags.canDelete,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editSelectAll),
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      },
    ];
  }

  if (params.selectionText.trim().length > 0) {
    return [{ role: "copy", enabled: params.editFlags.canCopy }];
  }

  return [];
}

export function createBrowserWindow(options: {
  iconPath: string;
  preloadPath: string;
  title?: string;
  bootstrap?: WindowBootstrapOptions;
  logger: { warn: (...args: unknown[]) => void };
  /* Desktop device identifier (SHA-256 of the userData path) for synchronous renderer reads */
  deviceMid?: string;
  /* Persisted desktop page-zoom level; applied at window creation so the first paint keeps the chosen size. */
  initialDesktopZoomLevel?: number;
  /* Last normal-window bounds and maximized state, read by the main-process settings service. */
  initialWindowSize?: DesktopWindowSize;
  /* Read on each native menu popup so language switches apply without rebuilding the window. */
  currentApplicationLocale?: () => Locale;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
}): BrowserWindow {
  const initialDesktopZoomLevel = clampDesktopZoomLevel(options.initialDesktopZoomLevel ?? 0);
  const initialDesktopZoomFactor = resolveDesktopZoomFactorForLevel(initialDesktopZoomLevel);
  const initialWindowSize = resolveDesktopWindowSize(
    options.initialWindowSize,
    screen.getPrimaryDisplay().workAreaSize,
  );
  const win = new BrowserWindow({
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    minWidth: MIN_DESKTOP_WINDOW_WIDTH,
    // 1280x720 desktops often have less than 768px usable height; a taller minimum blocks shrinking.
    minHeight: MIN_DESKTOP_WINDOW_HEIGHT,
    title: options.title,
    icon: options.iconPath,
    // Some Linux environments still show Electron's menu bar when frameless; auto-hide avoids double menu bars.
    autoHideMenuBar: isLinuxDesktopWindow(),
    ...buildDesktopWindowVisualOptions(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // CDP-on-guest pivot: the built-in browser renders via <webview>, so the host enables webviewTag.
      webviewTag: true,
      // A permanent backgroundThrottling=false wakes the whole renderer, every webview guest, and the GPU.
      // Keep default throttling; wake only the owner renderer and target guest during capture.
      zoomFactor: initialDesktopZoomFactor,
      // Pass deviceMid through to preload for a synchronous pre-React read
      additionalArguments: [`--device-id=${options.deviceMid ?? ""}`],
    },
  });

  // Zoom commands used to affect only the live window and never survived restart.
  // At creation, main applies the setting.json desktop zoom level and overrides any per-host zoom Chromium kept.
  win.webContents.setZoomFactor(initialDesktopZoomFactor);
  if (process.platform === "win32") registerCustomWindowsControls(win);
  syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);

  if (initialWindowSize.maximized) {
    win.maximize();
  }

  win.on("enter-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("leave-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("maximize", () => syncDesktopWindowChromeState(win));
  win.on("unmaximize", () => syncDesktopWindowChromeState(win));
  attachWindowsWindowRepaint(win);
  // will-attach and did-attach pair in order; queue entries record the guest kind so did-attach dispatches the right policy.
  const pendingWebviewGuestKinds: Array<
    | { kind: "browser" | "codingPlan"; isRewards: boolean }
    | { kind: "pluginSandbox"; sandboxId: string }
  > = [];

  win.webContents.once("did-finish-load", () => {
    // With packaged loadFile(file://...) navigation, Chromium can replay origin-level zoom after load,
    // overriding the persisted zoom applied at creation back to defaults.
    // Replay the setting.json level after did-finish-load so packaged and dev localhost behave the same.
    win.webContents.setZoomFactor(initialDesktopZoomFactor);
    syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);
    syncWindowFullscreenState(win);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // On navigation failure CDP target metadata can keep the old file:// URL while the renderer document
      // is already chrome-error://; log the main-frame failure to find the real cause.
      options.logger.warn("[desktop-window] renderer did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        webContentsId: win.webContents.id,
      });
    },
  );

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    // CDP swaps the UI after the native dialog exists; macOS can still show an already-queued
    // Chromium NSAlert. The pinned preload intercepts before native calls in every frame, and the isolated world exposes
    // only a synchronous alert/confirm bridge; the page world keeps no Node or arbitrary IPC.
    //
    // Exception: the Coding Plan storefront needs window.zcodeBridge for purchase-completion signals,
    // so it uses the dedicated preload (codingPlanWebview.ts); all other webviews keep the native dialog bridge.
    const targetUrl = params.src ?? "about:blank";
    // Plugin UI sandbox guest: dedicated branch, no embedded-browser preload/allowpopups/protocol allowlist.
    if (isPluginSandboxSrc(targetUrl)) {
      const host = getPluginSandboxHost();
      const decision = host?.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!decision?.ok) {
        options.logger.warn(
          `[plugin-sandbox] blocked webview attach: ${decision ? decision.reason : "host-not-installed"}`,
        );
        event.preventDefault();
        return;
      }
      pendingWebviewGuestKinds.push({ kind: "pluginSandbox", sandboxId: decision.sandboxId });
      return;
    }
    const isCodingPlanWebview = isCodingPlanEmbeddedWebviewSrc(targetUrl);
    webPreferences.preload = isCodingPlanWebview
      ? codingPlanWebviewPreloadPath
      : embeddedBrowserJavaScriptDialogPreloadPath;
    const isRewardsWebview = isTrustedRewardsUrl(targetUrl, {
      dev: !app.isPackaged,
      e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
    });
    if (isRewardsWebview) {
      webPreferences.preload = join(import.meta.dirname, "../preload/rewardsWebview.cjs");
      if (!app.isPackaged)
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          "--zcode-rewards-dev",
        ];
    }
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = true;

    delete params.preload;
    delete params.nodeintegration;
    // nodeIntegrationInSubFrames is a guest-creation preference; pin it true in both the derived WebPreferences and the original
    // attach args so a navigating subframe loads the same preload before page scripts.
    // Empty inherited frames without src skip preload; the preload's same-origin frame observer covers them.
    params.nodeintegrationinsubframes = "true";
    delete params.disablewebsecurity;
    delete params.allowpopups;

    // Fully disabling popups makes target=_blank/window.open in webviews look dead;
    // letting Electron default roam creates BrowserWindows outside ZCode. The host re-opens
    // allowpopups, then did-attach-webview adds a setWindowOpenHandler denying default window creation and
    // routes legit URLs to internal tabs or the system browser.
    params.allowpopups = "true";

    if (!isAllowedEmbeddedBrowserUrl(targetUrl)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview url: ${targetUrl}`);
      event.preventDefault();
      return;
    }

    pendingWebviewGuestKinds.push({
      kind: isCodingPlanWebview ? "codingPlan" : "browser",
      isRewards: isRewardsWebview,
    });
  });

  win.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    const guestKind = pendingWebviewGuestKinds.shift() ?? {
      kind: "browser" as const,
      isRewards: false,
    };
    if (guestKind.kind === "pluginSandbox") {
      getPluginSandboxHost()?.attachGuest({
        guest: guestWebContents,
        hostWebContents: win.webContents,
        sandboxId: guestKind.sandboxId,
      });
      return;
    }
    attachEmbeddedBrowserWindowOpenHandler({
      guestWebContents,
      hostWebContents: win.webContents,
      resolveBrowserViewOwner: options.resolveBrowserViewOwner,
      // PayPal/relay 30x redirects do not reliably fire will-navigate per hop.
      // Stick the Coding Plan guest identity to the initial src; never derive protection from the current URL.
      isCodingPlanGuest: guestKind.kind === "codingPlan",
      isRewardsGuest: guestKind.isRewards,
      logger: options.logger,
    });
    // Bluetooth device-selection events hang off the guest WebContents (Session covers only
    // hid/usb/serial); install the guard on embedded-browser guests only, blocking Electron's
    // silent first-device grant when nothing listens.
    if (guestKind.kind === "browser") {
      installEmbeddedBrowserBluetoothDeviceGuard(guestWebContents, options.logger.warn, {
        devicePicker: getEmbeddedBrowserDevicePicker(),
        hostWebContentsId: win.webContents.id,
      });
    }
  });

  win.webContents.on("context-menu", (_event, params) => {
    // Role-only items follow system/Electron language, which can diverge from the app language.
    // Read the locale per context-menu and set labels explicitly; the next open after a switch is correct.
    const template = buildTextContextMenuTemplate(
      params,
      options.currentApplicationLocale?.() ?? DEFAULT_LOCALE,
    );

    if (!app.isPackaged) {
      if (template.length > 0) {
        template.push({ type: "separator" });
      }
      template.push({
        label: "Inspect Element",
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (template.length === 0) {
      return;
    }

    // Production once skipped native menus entirely to avoid double menus with DOM menus (terminal);
    // but plain selections/inputs have none, making copy/paste look broken. Add native menus only for text-editing contexts.
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  void Promise.resolve(loadWindow(win, "index", options.bootstrap)).catch((error: unknown) => {
    // The loadFile/loadURL promise used to be dropped; late navigation failures
    // surfaced only as chrome-error pages with no original exception in main logs.
    options.logger.warn("[desktop-window] renderer navigation rejected", error);
  });
  return win;
}
