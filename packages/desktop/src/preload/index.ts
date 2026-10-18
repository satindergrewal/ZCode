import {
  databaseStartupControlSchema,
  databaseStartupStateSchema,
  databaseStartupPortPayloadSchema,
} from "@zcode/shared";
/* eslint-disable max-lines -- the preload concentrates desktop platform IPC; splitting it would make the contextBridge trust boundary harder to audit. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
  installArmsRumBridgeIpcForward,
  scheduleArmsEventBridgePatch,
} from "../shared/armsRumBridgeForward.js";

// ARMS frame preload: wrap Bridge.send synchronously or later ipcRenderer.send patches shadow the closure.
installArmsRumBridgeIpcForward(ipcRenderer);
scheduleArmsEventBridgePatch();

/** Parse --device-id= from the command line. */
function parseDeviceIdFromArgs(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--device-id=")) {
      return arg.slice("--device-id=".length);
    }
  }
  return "";
}

// Expose synchronous values before contextBridge so the renderer can read them before React renders.
contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());

import type {
  AppSettings,
  ApplicationIconRequest,
  BrowserViewOperationPayload,
  BrowserGuestAttachResult,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewportSize,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopCommandId,
  DesktopTitleBarTheme,
  EmbeddedBrowserOpenUrlRequest,
  Locale,
  OAuthStateRegistration,
  OpenInEditorOptions,
  RemoteTarget,
  TaskNotificationPayload,
  TelemetryRendererContext,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  BotRemoteWorkspaceReconnectedEvent,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  ZCodeStdioTapDevState,
  LoadCliMcpFromUserDirectoryRequest,
  MigrateLegacyCommonMcpRequest,
  SaveCliMcpToUserDirectoryRequest,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  SSHConfigAliasOption,
  RemoteConnectionRuntimeLog,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
  CreateTempTextAttachmentRequest,
  OpenCuaPermissionOnboardingOptions,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
} from "@zcode/shared";
import {
  InternalChannels,
  PlatformChannels,
  formatZCodeRendererProcessName,
  shouldEnableE2ETestBridge,
} from "@zcode/shared";
import { createOAuthCallbackHandler } from "./oauthCallbackBridge.js";

if (shouldEnableE2ETestBridge(process.env)) {
  contextBridge.exposeInMainWorld("__zcodeFinalArmsCustomEventsE2E", {
    read: (): Promise<FinalArmsCustomEventE2EEntry[]> =>
      ipcRenderer.invoke(PlatformChannels.ReadFinalArmsCustomEventsE2E),
    clear: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.ClearFinalArmsCustomEventsE2E),
    configure: (request: ConfigureFinalArmsCustomEventE2ERequest): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.ConfigureFinalArmsCustomEventsE2E, request),
  });
}

const updateReadyCallbacks = new Set<(version: string) => void>();
const updateStateCallbacks = new Set<(payload: UpdateStatePayload) => void>();
const postUpdateReleaseNotesCallbacks = new Set<(payload: PostUpdateReleaseNotesPayload) => void>();
const openWorkspacePathCallbacks = new Set<(path: string) => void>();
let latestReadyUpdateVersion: string | null = null;
let latestUpdateState: UpdateStatePayload | null = null;
let latestPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
const pendingOpenWorkspacePaths: string[] = [];
const shareImportCallbacks = new Set<(payload: { shareCode: string }) => void>();
const pendingShareImports: { shareCode: string }[] = [];
const MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const DESKTOP_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;
let latestWindowControlsOverlayMetrics: WindowControlsOverlayMetrics | null = null;
let latestDesktopZoomLevel = 0;

function clampDesktopZoomLevel(level: number) {
  return Math.min(DESKTOP_ZOOM_MAX_LEVEL, Math.max(DESKTOP_ZOOM_MIN_LEVEL, level));
}

function resolveDesktopZoomLevelFromFactor(zoomFactor: number) {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return 0;
  }

  return clampDesktopZoomLevel(
    Math.round(Math.log(zoomFactor) / Math.log(DESKTOP_ZOOM_FACTOR_STEP)),
  );
}

function resolveDesktopZoomFactorForLevel(level: number) {
  return Math.pow(DESKTOP_ZOOM_FACTOR_STEP, clampDesktopZoomLevel(level));
}

function readCurrentWindowControlsOverlayReadyPayload(): WindowControlsOverlayReadyPayload {
  const zoomLevel = resolveDesktopZoomLevelFromFactor(webFrame.getZoomFactor());
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const metrics: WindowControlsOverlayMetrics =
    process.platform === "darwin"
      ? {
          leftPaddingPx: Math.round(MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX / zoomFactor),
        }
      : process.platform === "win32"
        ? {
            rightPaddingPx: Math.round(WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / zoomFactor),
            titleBarHeightPx: Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * zoomFactor),
          }
        : {};
  return {
    zoomLevel,
    metrics,
  };
}

function readCurrentWindowControlsOverlayMetrics(): WindowControlsOverlayMetrics {
  return readCurrentWindowControlsOverlayReadyPayload().metrics;
}

const initialWindowControlsOverlayPayload = readCurrentWindowControlsOverlayReadyPayload();
latestDesktopZoomLevel = initialWindowControlsOverlayPayload.zoomLevel;
latestWindowControlsOverlayMetrics = initialWindowControlsOverlayPayload.metrics;
// Main needs the traffic-light position for the current zoom before RootStartupLoading renders.
// Preload runs before the React tree; notify main here instead of after the App page mounts.
ipcRenderer.send(PlatformChannels.WindowControlsOverlayReady, initialWindowControlsOverlayPayload);

ipcRenderer.on(
  PlatformChannels.WindowControlsOverlayChanged,
  (_event: unknown, metrics: WindowControlsOverlayMetrics) => {
    latestWindowControlsOverlayMetrics = metrics;
  },
);

ipcRenderer.on(
  PlatformChannels.DesktopZoomLevelChanged,
  (_event: unknown, state: DesktopZoomState) => {
    if (Number.isFinite(state.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
  },
);

ipcRenderer.on(PlatformChannels.OpenWorkspacePath, (_event: unknown, path: string) => {
  if (openWorkspacePathCallbacks.size === 0) {
    // Cold-start open-workspace is delivered from main right after renderer ready,
    // but the React platform effect may not have registered onOpenWorkspacePath yet. The preload
    // holds the IPC and replays it once subscribed, so the workspace opens with the app.
    pendingOpenWorkspacePaths.push(path);
    return;
  }

  for (const callback of openWorkspacePathCallbacks) {
    callback(path);
  }
});

ipcRenderer.on(PlatformChannels.ShareImport, (_event: unknown, payload: { shareCode: string }) => {
  if (shareImportCallbacks.size === 0) {
    pendingShareImports.push(payload);
    return;
  }
  for (const callback of shareImportCallbacks) callback(payload);
});

function updateRendererProcessTitle(): void {
  process.title = formatZCodeRendererProcessName(document.title);
}

function notifyUpdateReadyCallbacks(version: string): void {
  latestReadyUpdateVersion = version;
  for (const callback of updateReadyCallbacks) {
    callback(version);
  }
}

function notifyPostUpdateReleaseNotesCallbacks(payload: PostUpdateReleaseNotesPayload): void {
  latestPostUpdateReleaseNotes = payload;
  for (const callback of postUpdateReleaseNotesCallbacks) {
    callback(payload);
  }
}

function notifyUpdateStateCallbacks(payload: UpdateStatePayload): void {
  latestUpdateState = payload;
  // UpdateReady is a one-shot cache for legacy interactions, but after update-downloaded
  // Squirrel.Mac may still report a staging error and main broadcasts idle/error.
  // Clear stale ready state here or React resubscription replays a dead version.
  latestReadyUpdateVersion = payload.kind === "update-downloaded" ? payload.version : null;
  for (const callback of updateStateCallbacks) {
    callback(payload);
  }
}

// Process-list readability: the renderer usually shows up as a generic helper name,
// so set a zcode-* title at preload time for per-role filtering.
updateRendererProcessTitle();
window.addEventListener("DOMContentLoaded", updateRendererProcessTitle, {
  once: true,
});

/**
 * Preload bridge -- only platform operations that need the main process.
 *
 * Credential management moved to the host process ICredentialService
 * over MessagePort RPC and no longer passes through this bridge.
 */
contextBridge.exposeInMainWorld("zcode", {
  connectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath: string;
      workspaceIdentity?: string;
      connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
    },
  ) =>
    ipcRenderer.invoke(PlatformChannels.ConnectRemote, {
      target: options,
      requestId,
      ...(context ? context : {}),
    }),
  cancelPendingRemoteConnection: (requestId?: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.CancelPendingRemoteConnection, {
      requestId,
    }),
  bindRemoteWorkspaceSessionContext: (context: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BindRemoteWorkspaceSessionContext, context),
  disposeRemoteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.DisposeRemoteSession, sessionId),
  isDockerAvailable: (): Promise<boolean> => ipcRenderer.invoke(PlatformChannels.IsDockerAvailable),
  listWSLDistros: () => ipcRenderer.invoke(PlatformChannels.ListWSLDistros),
  listDockerContainers: () => ipcRenderer.invoke(PlatformChannels.ListDockerContainers),
  listSSHConfigAliases: (): Promise<SSHConfigAliasOption[]> =>
    ipcRenderer.invoke(PlatformChannels.ListSSHConfigAliases),
  loadMcpFromUserDirectory: (payload?: LoadCliMcpFromUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.LoadMcpFromUserDirectory, payload ?? {}),
  saveMcpToUserDirectory: (payload: SaveCliMcpToUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.SaveMcpToUserDirectory, payload),
  migrateLegacyCommonMcp: (payload?: MigrateLegacyCommonMcpRequest) =>
    ipcRenderer.invoke(PlatformChannels.MigrateLegacyCommonMcp, payload ?? {}),
  /** Renderer logs relayed over IPC for unified storage in main. */
  log: (level: "info" | "warn" | "error", args: unknown[]) =>
    ipcRenderer.send(PlatformChannels.Log, { level, args }),
  /** Open a system directory picker; returns the chosen path or null. */
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectory),
  /** Open a system file picker; returns the chosen file path or null. */
  selectFile: (): Promise<string | null> => ipcRenderer.invoke(PlatformChannels.SelectFile),
  /** Open a system multi-file picker; returns chosen paths, [] when cancelled. */
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke(PlatformChannels.SelectFiles),
  /** Persist via the main process native save dialog. */
  saveFile: (payload: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke(PlatformChannels.SaveFile, payload),
  /** Export the current page's print layout as PDF (Chromium print engine, vector text). */
  printPageToPdf: (): Promise<PrintPageToPdfResult> =>
    ipcRenderer.invoke(PlatformChannels.PrintToPdf),
  /** Resolve the real local path from a dragged/file-input Web File. */
  getPathForFile: (file: File): string | null => {
    // Electron 32 removed non-standard File.path; renderers can no longer read paths off dragged Files.
    // webUtils is preload-only; return null when unavailable and let web/inline attachment fallbacks handle it.
    const path = webUtils.getPathForFile(file).trim();
    return path.length > 0 ? path : null;
  },
  /** Persist long pasted text as a real local attachment instead of bloating the prompt payload. */
  createTempTextAttachment: (payload: CreateTempTextAttachmentRequest) =>
    ipcRenderer.invoke(PlatformChannels.CreateTempTextAttachment, payload),
  /** Subscribe to remote-connection progress logs for this window; returns a disposer. */
  onRemoteConnectionLog: (callback: (entry: RemoteConnectionRuntimeLog) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteConnectionRuntimeLog);
    ipcRenderer.on(PlatformChannels.RemoteConnectionLog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteConnectionLog, handler);
  },
  /** Subscribe to remote session closed events for this window; returns a disposer. */
  onRemoteSessionClosed: (callback: (event: RemoteSessionClosedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionClosedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionClosed, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionClosed, handler);
  },
  /** Subscribe to bot-triggered remote workspace reconnect success; returns a disposer. */
  onBotRemoteWorkspaceReconnected: (
    callback: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as BotRemoteWorkspaceReconnectedEvent);
    ipcRenderer.on(PlatformChannels.BotRemoteWorkspaceReconnected, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BotRemoteWorkspaceReconnected, handler);
  },
  /** Check whether the directory is already open in another window. */
  activateOrSetWorkspace: (path: string): Promise<{ activated: boolean }> =>
    ipcRenderer.invoke(PlatformChannels.ActivateOrSetWorkspace, path),
  /** Sync all tab workspace paths in this window to main. */
  syncWindowTabs: (paths: string[]) => ipcRenderer.send(PlatformChannels.SyncWindowTabs, paths),
  /** Sync the workspaces switchable via web remote control in this window. */
  /** Sync task snapshots displayable via web remote control in this window. */
  /** Sync this window's unread task count to main. */
  syncWindowUnreadCount: (count: number) =>
    ipcRenderer.send(PlatformChannels.SyncWindowUnreadCount, count),
  syncActiveTaskSession: (sessionId: string | null) =>
    ipcRenderer.send(PlatformChannels.SyncActiveTaskSession, sessionId),
  /** Sync app settings that main must react to immediately. */
  syncAppSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.send(PlatformChannels.SyncAppSettings, patch),
  /** Shortcut-recording toggle: main temporarily drops configurable menu accelerators so recorded keys skip the commands. */
  setShortcutRecordingActive: (active: boolean) =>
    ipcRenderer.send(PlatformChannels.SetShortcutRecordingActive, active),
  /** Register the callback main uses to focus a workspace tab; returns a disposer. */
  onFocusTab: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(PlatformChannels.FocusTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FocusTab, handler);
  },
  /** Register the callback main uses to open a new tab; returns a disposer. */
  onNewTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTab, handler);
  },
  /** Register the callback main uses to close the current context; returns a disposer. */
  onCloseActiveContextRequest: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.CloseActiveContextRequest, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.CloseActiveContextRequest, handler);
  },
  /** Register controlled new-page requests from the built-in webview; returns a disposer. */
  onOpenBrowserUrl: (callback: (request: EmbeddedBrowserOpenUrlRequest) => void): (() => void) => {
    const handler = (_event: unknown, request: EmbeddedBrowserOpenUrlRequest) => callback(request);
    ipcRenderer.on(PlatformChannels.OpenBrowserUrl, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenBrowserUrl, handler);
  },
  /** Fires when the agent's first browser command creates the controlled view (auto-opens the browser-use tab); returns a disposer. */
  onBrowserViewReady: (
    callback: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        tabId: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewReady, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewReady, handler);
  },
  /** Operation-state callback for when agent browser-use lands on a real tab; returns a disposer. */
  onBrowserViewOperation: (
    callback: (payload: BrowserViewOperationPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewOperationPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewOperation, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewOperation, handler);
  },
  /** Controlled-tab viewport changes; used by agent settings to sync free-size mode. */
  onBrowserViewViewportChanged: (
    callback: (payload: BrowserViewViewportChangedPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewViewportChangedPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewViewportChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewViewportChanged, handler);
  },
  onBrowserViewScreenshotSurfacePrepare: (
    callback: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfacePreparePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
  },
  onBrowserViewScreenshotSurfaceRelease: (
    callback: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfaceReleasePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
  },
  browserViewScreenshotSurfaceReady: (payload: BrowserViewScreenshotSurfaceReadyPayload): void => {
    ipcRenderer.send(PlatformChannels.BrowserViewScreenshotSurfaceReady, payload);
  },
  onBrowserViewVisibility: (
    callback: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        visible: boolean;
        workspaceKey: string;
        remoteSessionId: string | undefined;
        sessionId: string;
        tabId?: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewVisibility, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewVisibility, handler);
  },
  /** Agent close commands unloading the controlled tab; returns a disposer. */
  onBrowserViewCloseTab: (
    callback: (payload: BrowserViewCloseTabNotification) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewCloseTabNotification) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewCloseTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewCloseTab, handler);
  },
  onBrowserViewSuspend: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewSuspend, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewSuspend, handler);
  },
  onBrowserViewRestore: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewRestore, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewRestore, handler);
  },
  /** Main-triggered new-task callback; returns a disposer. */
  onNewTask: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTask, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTask, handler);
  },
  /** Main-triggered open-workspace callback; returns a disposer. */
  onOpenWorkspace: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenWorkspace, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenWorkspace, handler);
  },
  /** Deep-link direct local workspace open callback; returns a disposer. */
  onOpenWorkspacePath: (callback: (path: string) => void): (() => void) => {
    openWorkspacePathCallbacks.add(callback);
    while (pendingOpenWorkspacePaths.length > 0) {
      const path = pendingOpenWorkspacePaths.shift();
      if (path) {
        callback(path);
      }
    }
    return () => openWorkspacePathCallbacks.delete(callback);
  },
  onOpenFeedbackDialog: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenFeedbackDialog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenFeedbackDialog, handler);
  },
  onOpenTicketsPanel: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenTicketsPanel, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenTicketsPanel, handler);
  },
  /** Window fullscreen state changes; returns a disposer. */
  onWindowFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on(PlatformChannels.WindowFullscreenChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowFullscreenChanged, handler);
  },
  /** Read maximized state and native rounded-corner support. */
  getDesktopWindowChromeState: (): Promise<DesktopWindowChromeState> =>
    ipcRenderer.invoke(PlatformChannels.GetDesktopWindowChromeState),
  /** Maximized state / native rounded-corner changes. */
  onDesktopWindowChromeStateChanged: (
    callback: (state: DesktopWindowChromeState) => void,
  ): (() => void) => {
    const handler = (_event: unknown, state: DesktopWindowChromeState) => callback(state);
    ipcRenderer.on(PlatformChannels.DesktopWindowChromeStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.DesktopWindowChromeStateChanged, handler);
  },
  /** Read the current native window-control safe area. */
  getWindowControlsOverlayMetrics: (): WindowControlsOverlayMetrics =>
    latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics(),
  /** Native window-control safe-area changes; returns a disposer. */
  onWindowControlsOverlayChanged: (
    callback: (metrics: WindowControlsOverlayMetrics) => void,
  ): (() => void) => {
    const handler = (_event: unknown, metrics: WindowControlsOverlayMetrics) => callback(metrics);
    callback(latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics());
    ipcRenderer.on(PlatformChannels.WindowControlsOverlayChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowControlsOverlayChanged, handler);
  },
  /** Read the current desktop page zoom level. */
  getDesktopZoomLevel: async (): Promise<DesktopZoomState> => {
    const state = await ipcRenderer.invoke(PlatformChannels.GetDesktopZoomLevel);
    if (Number.isFinite(state?.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
    return { zoomLevel: latestDesktopZoomLevel };
  },
  /** Desktop page zoom level changes; returns a disposer. */
  onDesktopZoomLevelChanged: (callback: (state: DesktopZoomState) => void): (() => void) => {
    const handler = (_event: unknown, state: DesktopZoomState) => {
      if (!Number.isFinite(state.zoomLevel)) {
        return;
      }
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
      callback({ zoomLevel: latestDesktopZoomLevel });
    };
    callback({ zoomLevel: latestDesktopZoomLevel });
    ipcRenderer.on(PlatformChannels.DesktopZoomLevelChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopZoomLevelChanged, handler);
  },
  /** Navigate to the task on system-notification click; returns a disposer. */
  onTaskNotificationClick: (callback: (taskId: string) => void): (() => void) => {
    const handler = (_event: unknown, taskId: string) => callback(taskId);
    ipcRenderer.on(PlatformChannels.TaskNotificationClick, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.TaskNotificationClick, handler);
  },
  /** Open an external URL (e.g. the OAuth browser hop). */
  openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
  /** Whether a community entry exists for the current locale. */
  canOpenCommunity: (locale: Locale): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.CanOpenCommunity, locale),
  /** Reveal a path in the system file manager. */
  openInFileManager: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenInFileManager, path),
  /** Open a local file with the system default app. */
  openExternalFile: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenExternalFile, path),
  /** Open the full ZCode Computer Use permission guide. */
  openCuaPermissionOnboarding: (options?: OpenCuaPermissionOnboardingOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenCuaPermissionOnboarding, options),
  /** Cancel only onboarding participants started by this renderer with this operationId. */
  cancelCuaPermissionOnboarding: (operationId: string) =>
    ipcRenderer.send(PlatformChannels.CancelCuaPermissionOnboarding, {
      operationId,
    }),
  /** Prewarm/cache the verified Helper path so dragstart can startDrag synchronously (async I/O misses the gesture). */
  prepareCuaHelperPermissionDrag: () =>
    ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** Drag the permission-panel Helper.app into the macOS permission list. Must be send: an invoke round trip misses the gesture. */
  startCuaHelperPermissionDrag: () =>
    ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  /** Report OAuth state for deep-link routing. */
  registerOAuthState: (payload: OAuthStateRegistration) =>
    ipcRenderer.send(PlatformChannels.OAuthRegisterState, payload),
  /** OAuth deep-link callback; returns a disposer. */
  onOAuthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = createOAuthCallbackHandler(cb, () => {
      ipcRenderer.send(PlatformChannels.OAuthCallbackHandled);
    });
    ipcRenderer.on(PlatformChannels.OAuthCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler);
  },
  /** Payment deep-link callback; returns a disposer. */
  onPaymentCallback: (callback: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on(PlatformChannels.PaymentCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.PaymentCallback, handler);
  },
  onShareImport: (callback: (payload: { shareCode: string }) => void): (() => void) => {
    shareImportCallbacks.add(callback);
    while (pendingShareImports.length > 0) {
      const payload = pendingShareImports.shift();
      if (payload) callback(payload);
    }
    return () => shareImportCallbacks.delete(callback);
  },
  /** Tell main the renderer is ready. */
  notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
  /** Sync renderer telemetry context to main. */
  syncTelemetryContext: (context: TelemetryRendererContext) =>
    ipcRenderer.send(PlatformChannels.SyncTelemetryContext, context),
  /** Report product telemetry events via main. */
  reportTelemetryEvent: (payload: {
    context: TelemetryRendererContext;
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  }) => ipcRenderer.invoke(PlatformChannels.ReportTelemetryEvent, payload),
  /** Report ARMS custom events via main. */
  reportArmsCustomEvent: (payload: {
    name: string;
    group: string;
    value?: number;
    properties?: Record<string, string | number | boolean | undefined>;
  }) => ipcRenderer.invoke(PlatformChannels.ReportArmsCustomEvent, payload),
  /** Read the renderer action-trace rollout config. */
  getRendererActionTraceConfig: (): Promise<RendererActionTraceConfigV1> =>
    ipcRenderer.invoke(PlatformChannels.GetRendererActionTraceConfig),
  /** Main-pushed renderer action-trace config changes. */
  onRendererActionTraceConfigChanged: (
    callback: (config: RendererActionTraceConfigV1) => void,
  ): (() => void) => {
    const handler = (_event: unknown, config: RendererActionTraceConfigV1) => callback(config);
    ipcRenderer.on(PlatformChannels.RendererActionTraceConfigChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.RendererActionTraceConfigChanged, handler);
  },
  /** Flush finished spans; send keeps telemetry off the business round trip. */
  reportLocalTtftBatch: (batch: import("@zcode/shared").LocalTtftBatch): void =>
    ipcRenderer.send(PlatformChannels.ReportLocalTtftBatch, batch),
  reportRendererActionTraceBatch: (batch: RendererActionTraceBatchV1): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererActionTraceBatch, batch),
  /**
   * Main-window renderer heap readings every 60s.
   * Send-only: main does not ack, and the renderer cannot query process facts through it.
   */
  reportRendererHeapSample: (sample: RendererHeapSample): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererHeapSample, sample),
  /** Native task notifications via main. */
  showTaskNotification: (payload: TaskNotificationPayload) =>
    ipcRenderer.send(PlatformChannels.ShowTaskNotification, payload),
  /** Export logs: zip ~/.zcode/v2 plus external agent logs and reveal in Finder. */
  exportLogs: (): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> => ipcRenderer.invoke(PlatformChannels.ExportLogs),
  /** Capture this window for error feedback context. */
  captureWindowScreenshot: () => ipcRenderer.invoke(PlatformChannels.CaptureWindowScreenshot),
  // CDP-on-guest pivot: report guest webContentsId to main for attach on <webview> dom-ready.
  browserViewAttachGuest: (payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewAttachGuest, payload),
  /** Synchronously wait for main to detach the native CDP session before the old <webview> unmounts. */
  browserViewDetachGuest: (payload: { key: string; webContentsId: number }): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewDetachGuest, payload),
  browserViewCloseTab: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewCloseTabFromRenderer, payload),
  browserViewReportResidency: (payload: BrowserViewResidencyReportPayload): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewReportResidency, payload),
  browserViewSuspendReady: (payload: { tabId: string; generation: number }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewSuspendReady, payload),
  browserViewEnsureResident: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewEnsureResident, payload),
  browserViewRestoreTabs: (
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewRestoreTabs, payload),
  /** Push UI free-size onto the controlled tab's real viewport. */
  browserViewUpdateViewport: (payload: { tabId: string; viewport: BrowserViewportSize | null }) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewUpdateViewport, payload),
  /** One-shot import of built-in browser data from a discovered Chrome profile. */
  importChromeBrowserData: (options?: import("@zcode/shared").ChromeBrowserDataImportOptions) =>
    ipcRenderer.invoke(PlatformChannels.ImportChromeBrowserData, options),
  /** Clear built-in browser cache or all site data. */
  clearEmbeddedBrowserData: (mode: "cache" | "all") =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserData, mode),
  /** Read the dev stdio tap proxy switch. */
  getZCodeStdioTapDevState: (): Promise<ZCodeStdioTapDevState> =>
    ipcRenderer.invoke(PlatformChannels.GetZCodeStdioTapDevState),
  /** Main-side settings-changed notification; returns a disposer. */
  onSettingsChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.SettingsChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.SettingsChanged, handler);
  },
  /** Application locale changes; returns a disposer. */
  onApplicationLocaleChanged: (callback: (locale: Locale) => void): (() => void) => {
    const handler = (_event: unknown, locale: Locale) => callback(locale);
    ipcRenderer.on(PlatformChannels.ApplicationLocaleChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.ApplicationLocaleChanged, handler);
  },
  /** Manual check-for-updates result callback; returns a disposer. */
  onUpdateCheckResult: (callback: (payload: UpdateCheckResultPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: UpdateCheckResultPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.UpdateCheckResult, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.UpdateCheckResult, handler);
  },
  getUpdateState: (): Promise<UpdateStatePayload> =>
    ipcRenderer.invoke(PlatformChannels.GetUpdateState),
  /** Start downloading the discovered update. */
  downloadUpdate: () => ipcRenderer.invoke(PlatformChannels.DownloadUpdate),
  /** Cancel the in-flight update download. */
  cancelUpdateDownload: () => ipcRenderer.invoke(PlatformChannels.CancelUpdateDownload),
  /** Open the standalone update window. */
  openUpdateStatusWindow: () => ipcRenderer.invoke(PlatformChannels.OpenUpdateStatusWindow),
  /** Read auto-update preferences. */
  getAutoUpdatePreferences: () => ipcRenderer.invoke(PlatformChannels.GetAutoUpdatePreferences),
  /** Write the auto-download-and-install preference. */
  setAutoDownloadAndInstallUpdates: (enabled: boolean) =>
    ipcRenderer.invoke(PlatformChannels.SetAutoDownloadAndInstallUpdates, enabled),
  getDesktopSessionActivity: () => ipcRenderer.invoke(PlatformChannels.GetDesktopSessionActivity),
  /** Continuous auto-update state changes; returns a disposer. */
  onUpdateStateChanged: (callback: (payload: UpdateStatePayload) => void): (() => void) => {
    updateStateCallbacks.add(callback);
    if (latestUpdateState) {
      callback(latestUpdateState);
    }
    return () => {
      updateStateCallbacks.delete(callback);
    };
  },
  /** Update finished downloading callback; returns a disposer. */
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    // Main's update-ready is one-shot and often fires before the React effect subscribes.
    // Cache the latest state in the preload and replay it on subscribe,
    // so late-mounted UI still sees a stable update-downloaded state.
    updateReadyCallbacks.add(callback);
    if (latestReadyUpdateVersion) {
      callback(latestReadyUpdateVersion);
    }
    return () => {
      updateReadyCallbacks.delete(callback);
    };
  },
  /** Post-update release notes; returns a disposer. */
  onPostUpdateReleaseNotes: (
    callback: (payload: PostUpdateReleaseNotesPayload) => void,
  ): (() => void) => {
    postUpdateReleaseNotesCallbacks.add(callback);
    if (latestPostUpdateReleaseNotes) {
      callback(latestPostUpdateReleaseNotes);
    }
    return () => {
      postUpdateReleaseNotesCallbacks.delete(callback);
    };
  },
  /** Mark the current release notes as read. */
  acknowledgePostUpdateReleaseNotes: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.AcknowledgePostUpdateReleaseNotes, version),
  /** Skip the currently offered update version. */
  skipUpdateVersion: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.SkipUpdateVersion, version),
  /** User confirmed restart-to-install. */
  quitAndInstallUpdate: () => ipcRenderer.invoke(PlatformChannels.QuitAndInstallUpdate),
  /** Installed editors/terminals with icons. */
  getInstalledEditors: () => ipcRenderer.invoke(PlatformChannels.GetInstalledEditors),
  getApplicationIcon: (request: string | ApplicationIconRequest) =>
    ipcRenderer.invoke(PlatformChannels.GetApplicationIcon, request),
  /** Open a path in the given editor. */
  openInEditor: (editorId: string, path: string, options?: OpenInEditorOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenInEditor, {
      editorId,
      path,
      options,
    }),
  /** Run a desktop window-level command. */
  executeDesktopCommand: (command: DesktopCommandId) =>
    ipcRenderer.invoke(PlatformChannels.ExecuteDesktopCommand, command),
  /** Sync application-menu locale. */
  setApplicationLocale: (locale: Locale) =>
    ipcRenderer.invoke(PlatformChannels.SetApplicationLocale, locale),
  /** Read the host OS locale. */
  getSystemLocale: (): Promise<Locale> => ipcRenderer.invoke(PlatformChannels.GetSystemLocale),
  /** Sync titlebar light/dark theme. */
  setTitleBarTheme: (theme: DesktopTitleBarTheme) =>
    ipcRenderer.invoke(PlatformChannels.SetTitleBarTheme, theme),
  /** Desktop device identifier (deviceMid). */
  getDeviceId: () => ipcRenderer.invoke(PlatformChannels.GetDeviceId),
});

/**
 * A MessagePort cannot cross contextBridge (it gets wrapped as a Proxy and loses native
 * methods like addEventListener). Pass it through the window.postMessage transfer
 * path instead, so it lands untouched in the renderer's window context.
 */
ipcRenderer.on(InternalChannels.ServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
  if (port && parsed.success)
    window.postMessage({ type: InternalChannels.ServicePort, ...parsed.data }, "*", [port]);
  else port?.close();
});

ipcRenderer.on(
  InternalChannels.ScopedServicePort,
  (
    event,
    payload: {
      attachmentId?: string;
      sessionId?: string;
      target?: RemoteTarget;
    },
  ) => {
    const [port] = event.ports;
    if (port) {
      window.postMessage(
        {
          type: InternalChannels.ScopedServicePort,
          attachmentId: payload.attachmentId,
          sessionId: payload.sessionId,
          target: payload.target,
        },
        "*",
        [port],
      );
    }
  },
);

window.addEventListener("message", (event) => {
  if (event.source !== window || typeof event.data !== "object" || event.data === null) {
    return;
  }
  const payload = event.data as {
    type?: unknown;
    attachmentId?: unknown;
    sessionId?: unknown;
  };
  if (
    payload.type !== InternalChannels.ScopedServicePortReady ||
    typeof payload.attachmentId !== "string" ||
    !payload.attachmentId ||
    typeof payload.sessionId !== "string" ||
    !payload.sessionId
  ) {
    return;
  }
  // MessagePort registration happens in the isolated renderer world; main must not read delivered as usable.
  // Preload only forwards the renderer ready ACK; attachment state stays with the window session manager.
  ipcRenderer.send(InternalChannels.ScopedServicePortReady, {
    attachmentId: payload.attachmentId,
    sessionId: payload.sessionId,
  });
});

ipcRenderer.on(PlatformChannels.TaskNotificationSound, () => {
  window.postMessage(InternalChannels.TaskNotificationSound, "*");
});

ipcRenderer.on(PlatformChannels.UpdateReady, (_event, version: string) => {
  notifyUpdateReadyCallbacks(version);
});

ipcRenderer.on(PlatformChannels.UpdateStateChanged, (_event, payload: UpdateStatePayload) => {
  notifyUpdateStateCallbacks(payload);
});

ipcRenderer.on(
  PlatformChannels.PostUpdateReleaseNotes,
  (_event, payload: PostUpdateReleaseNotesPayload) => {
    notifyPostUpdateReleaseNotesCallbacks(payload);
  },
);

// If the Bridge is reset after dom-ready autoInject, wrap it once more.
scheduleArmsEventBridgePatch();

// The startup control plane precedes normal RPC; reloads mirror main's notice without triggering a new migration.
ipcRenderer.on(InternalChannels.DatabaseStartupState, (_event, raw: unknown) => {
  const parsed = databaseStartupStateSchema.safeParse(raw);
  if (parsed.success)
    window.postMessage({ type: InternalChannels.DatabaseStartupState, state: parsed.data }, "*");
});
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== InternalChannels.DatabaseStartupControl)
    return;
  const parsed = databaseStartupControlSchema.safeParse(event.data.control);
  if (parsed.success) ipcRenderer.send(InternalChannels.DatabaseStartupControl, parsed.data);
});
