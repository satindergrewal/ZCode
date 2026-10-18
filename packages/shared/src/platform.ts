/* eslint-disable max-lines -- the cross-platform contract declares renderer capabilities in one place; OAuth and browser lifecycle must keep the desktop/web type contract, splitting platform boundaries is out of scope for this MR. */
import type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type { AppSettings, Locale } from "./protocol.js";
import type { ArmsCustomEventPayload, RendererTelemetryEventPayload } from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";
export type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";

export interface TaskNotificationPayload {
  taskId: string;
  status: "completed" | "failed" | "permission_request" | "elicitation_request" | "feedback_update";
  requestId?: string;
  title: string;
  body: string;
}

/** Main routes browser-use operations that can locate a real tab in one shot to their origin renderer. */
export interface BrowserViewOperationPayload {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  tabId: string;
  browserId: string;
  browserGeneration: number;
  /** The model command opens, activates, or reshapes the Browser layout; the renderer must rebuild the resize observation baseline. */
  resetsResizeBaseline?: boolean;
}

export type BrowserTabResidencyState =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

/** Only for creating residency-restore guests that have not committed their first navigation entry. */
export const BROWSER_VIEW_RESTORE_BOOTSTRAP_URL = "zcode-browser-restore://pending";

/** Renderer reports display facts about a tab shell; windowId must be bound by main from a trusted IPC sender. */
export interface BrowserViewResidencyReportPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  selected: boolean;
  visible: boolean;
  currentTask: boolean;
  loading: boolean;
  restoreUrl?: string | null;
  title?: string | null;
  faviconUrl?: string | null;
}

export interface BrowserViewResidencyTransitionPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId: string | undefined;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  generation: number;
  residency: Extract<
    BrowserTabResidencyState,
    "live-visible" | "live-background" | "suspended" | "restoring"
  >;
}

export interface BrowserViewCloseTabRequest {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
}

export const LOCAL_MEDIA_PREVIEW_SCHEME = "zcode-media";

export function buildLocalMediaPreviewUrl(path: string): string {
  const url = new URL(`${LOCAL_MEDIA_PREVIEW_SCHEME}://local/preview`);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 // main->renderer close notification.
 *
 // The legacy payload only has tabId, so the renderer can only look in the active workspace's side pane state;
 // if the user switched workspaces the notification is silently dropped, leaving an unclosable ghost tab in the original workspace's persisted state.
 // With the owner scope attached, the renderer can locate the right workspace's side pane memory and delete the tab.
 // The scope field is optional: internal paths like recovery-orphan only have tabId, and the renderer falls back to current-workspace-only semantics.
 */
export interface BrowserViewCloseTabNotification {
  tabId: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  reason?: "recovery-orphan";
}

/** Across restarts, restore the logical shell first; the renderer must not mount every guest at once. */
export interface BrowserViewRestoredTabShell {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  origin: "agent" | "user";
  restoreUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  openedAt: number;
  lastSelectedAt: number | null;
}

export interface BrowserViewRestoreTabsRequest {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId?: string;
}

/** Main routes Agent viewport changes to the target tab's origin renderer. */
export interface BrowserViewViewportChangedPayload extends BrowserViewOperationPayload {
  viewport: BrowserViewportSize | null;
}

// The legacy 1500ms default budget is not enough to await consecutive stable frames on slow machines or background windows; main and renderer
// share this default, and the prepare payload carries the actual override so the two ends' deadlines cannot drift apart again.
export const BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS = 3_000;

/** Transient preview-ratio requirement of the screenshot/recording handshake; when absent keep the user's current preview. */
export type BrowserViewSurfaceScaleMode = "current" | "unscaled";

/** Main asks the owner renderer to prepare a background guest compositing surface before the screenshot. */
export interface BrowserViewScreenshotSurfacePreparePayload extends BrowserViewOperationPayload {
  requestId: string;
  webContentsId: number;
  viewport: BrowserViewportSize;
  /** A natural viewport skips the metrics-based guest layout compensation; when absent keep the original emulation (recording included). */
  viewportMode?: "natural" | "emulated";
  /** `unscaled` forces a true 100% surface only for the lease lifetime, without writing back the user's Fit/fixed ratio. */
  surfaceScaleMode?: BrowserViewSurfaceScaleMode;
  /** The prepare timeout main actually uses; the renderer falls back to the shared default when legacy payloads omit it. */
  timeoutMs?: number;
}

/** The owner renderer confirms the target guest's logical viewport and native preview surface ratios are both stable. */
export interface BrowserViewScreenshotSurfaceReadyPayload extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}

/** Main tells the owner renderer to release the temporary background screenshot compositing surface. */
export type BrowserViewScreenshotSurfaceReleasePayload = Omit<
  BrowserViewScreenshotSurfacePreparePayload,
  "viewport" | "viewportMode" | "surfaceScaleMode" | "timeoutMs"
>;

export type BrowserGuestAttachRejectReason =
  | "not-found"
  | "destroyed"
  | "not-webview"
  | "closed"
  | "window-mismatch"
  | "workspace-mismatch"
  | "session-mismatch"
  | "remote-session-mismatch"
  | "residency-suspended"
  | "residency-generation-mismatch";

/** Binding result main returns after the renderer reports a guest; a rejection must not masquerade as a returnless ready timeout. */
export type BrowserGuestAttachResult =
  | { ok: true; guestGeneration: number }
  | { ok: false; reason: BrowserGuestAttachRejectReason; recoveryRequested: boolean };

/** Installed editors/terminals */
export interface EditorInfo {
  /** Editor id (e.g. "vscode", "zed", "terminal") */
  id: string;
  /** Display name */
  name: string;
  /** Icon as base64 data URL */
  iconDataUrl: string;
}

export interface ApplicationIconInfo {
  iconDataUrl: string;
}

export type ApplicationIconLocator =
  | { kind: "darwin-bundle-id"; value: string }
  | { kind: "windows-executable-path"; value: string }
  | { kind: "windows-aumid"; value: string };

export interface ApplicationIconRequest {
  locators: ApplicationIconLocator[];
}

export type OpenInEditorRemoteTarget =
  | Pick<SSHConnectOptions, "kind" | "host" | "port" | "username" | "sshConfigAlias">
  | Pick<WSLConnectOptions, "kind" | "distro" | "user">
  | Pick<DockerConnectOptions, "kind" | "container">;

export interface OpenInEditorOptions {
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  pathKind?: "file" | "directory";
}

export interface CreateTempTextAttachmentRequest {
  text: string;
  filename?: string;
}

export interface CreateTempTextAttachmentResult {
  filename: string;
  localPath: string;
  mimeType: "text/plain";
  sizeBytes: number;
}

export type SaveFileRequest =
  | {
      data: ArrayBuffer;
      sourceUrl?: never;
      suggestedName: string;
    }
  | {
      data?: never;
      sourceUrl: string;
      suggestedName: string;
    };

export interface SaveFileResult {
  canceled?: boolean;
  error?: string;
  path?: string;
  success: boolean;
}

export interface PrintPageToPdfResult {
  success: boolean;
  /** PDF bytes; present on success */
  data?: ArrayBuffer;
  /** "print_in_progress" | "print_failed" */
  error?: string;
}

export function createOpenInEditorRemoteTarget(target: RemoteTarget): OpenInEditorRemoteTarget {
  switch (target.kind) {
    case "ssh":
      // openInEditor only needs the connection id to build a VS Code Remote-SSH URI;
      // credential fields such as password/privateKeyPassphrase must not keep flowing through renderer/preload/main IPC.
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
    case "docker":
      return {
        kind: "docker",
        container: target.container,
      };
  }
}

export interface WSLDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: 1 | 2 | null;
}

export interface DockerContainerInfo {
  id: string;
  image: string;
  name: string;
  state: string;
  status: string;
}

export interface SSHConfigAliasOption {
  alias: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  source?: string;
}

export interface ZCodeStdioTapDevState {
  enabled: boolean;
  visible: boolean;
  logDir: string;
  statePath: string;
}

export type DesktopTitleBarTheme = "light" | "dark" | "system";

export interface WindowScreenshotResult {
  dataBase64: string;
  filename: string;
  contentType: string;
  size: number;
}

export type ChromeBrowserDataImportError =
  | "chrome_profile_not_found"
  | "chrome_profile_ambiguous"
  | "chrome_executable_not_found"
  | "chrome_cookie_access_denied"
  | "chrome_cookie_elevation_required"
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed"
  | "chrome_cookie_protection_unsupported"
  | "chrome_profile_locked"
  | "chrome_local_storage_import_failed"
  | "chrome_import_not_supported"
  | "chrome_browser_data_import_unavailable"
  | "chrome_data_import_failed"
  | "chrome_default_profile_not_found";

export interface ChromeBrowserDataImportOptions {
  /** Windows App-Bound Cookies may trigger UAC only after an explicit confirmation; never persist as a global grant. */
  allowElevatedChromeDecryption?: boolean;
}

/** Chrome browser-data import returns counts and status only; Cookie/LocalStorage values and decryption material must not cross processes. */
export interface ChromeBrowserDataImportResult {
  success: boolean;
  cookies: {
    imported: number;
    skipped: number;
    failed: number;
  };
  localStorage: {
    originsImported: number;
    entriesImported: number;
    originsSkipped: number;
    originsFailed: number;
    error?: ChromeBrowserDataImportError;
  };
  /** Keep actionable questions on partial success; no profile absolute paths or site data. */
  issues?: ChromeBrowserDataImportError[];
  error?: ChromeBrowserDataImportError;
}

export interface EmbeddedBrowserDataClearResult {
  success: boolean;
  error?: string;
}

export interface WindowControlsOverlayMetrics {
  leftPaddingPx?: number;
  rightPaddingPx?: number;
  titleBarHeightPx?: number;
}

export interface WindowControlsOverlayReadyPayload {
  zoomLevel: number;
  metrics: WindowControlsOverlayMetrics;
}

export interface DesktopZoomState {
  zoomLevel: number;
}

export interface DesktopWindowChromeState {
  isMaximized: boolean;
  /** Local macOS major version; null on non-macOS or when unresolvable. */
  macOSMajorVersion?: number | null;
  supportsNativeRoundedCorners: boolean;
}

export interface RemoteServiceSession {
  sessionId: string;
}

export interface RemoteConnectionRuntimeLog {
  label: string;
  requestId?: string;
  sessionId?: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  timestamp: string;
}

export interface RemoteSessionClosedEvent {
  sessionId: string;
  reason: "host-exit";
  exitCode: number | null;
  signal: string | null;
}

export interface EmbeddedBrowserOpenUrlRequest {
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  /** browser-use tab owning the popup; on legacy events without it the renderer falls back to the current scope. */
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  browserId?: string;
  browserGeneration?: number;
  sourceTabId?: string;
}

export interface BotRemoteWorkspaceReconnectedEvent {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
  target: RemoteTarget;
}

export interface ConnectRemoteRequest {
  target: RemoteTarget;
  requestId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
}

export interface CancelPendingRemoteConnectionRequest {
  requestId?: string;
}

export interface BindRemoteWorkspaceSessionContextRequest {
  remoteSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export const DesktopCommandIds = {
  NewTask: "newTask",
  OpenWorkspace: "openWorkspace",
  CloseActiveContext: "closeActiveContext",
  CloseWindow: "closeWindow",
  MinimizeWindow: "minimizeWindow",
  ToggleMaximizeWindow: "toggleMaximizeWindow",
  ToggleFullScreen: "toggleFullScreen",
  ResetWindowSize: "resetWindowSize",
  ResetZoom: "resetZoom",
  ZoomIn: "zoomIn",
  ZoomOut: "zoomOut",
  ShowAbout: "showAbout",
  OpenChangelog: "openChangelog",
  CheckForUpdates: "checkForUpdates",
  RelaunchApp: "relaunchApp",
  OpenFeedback: "openFeedback",
  OpenCommunity: "openCommunity",
  ExportLogs: "exportLogs",
  ToggleDevTools: "toggleDevTools",
  OpenResourceManager: "openResourceManager",
  ToggleZCodeStdioTapDevProxy: "toggleZCodeStdioTapDevProxy",
  SetZCodeEndpointProduction: "setZCodeEndpointProduction",
  SetZCodeEndpointTest: "setZCodeEndpointTest",
  SetZCodeEndpointCustom: "setZCodeEndpointCustom",
  ResetZCodeEndpoint: "resetZCodeEndpoint",
  ClearAllData: "clearAllData",
  ClearCodingPlanWebviewStorage: "clearCodingPlanWebviewStorage",
  GetCuaOsSupport: "getCuaOsSupport",
} as const;

export type DesktopCommandId = (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds];

/**
 // OS support state of the CUA Helper (macOS version gate result, delivered to the renderer by main via
 // GetCuaOsSupport).
 // - supported: gate satisfied (including non-version factors; parse failures are treated leniently).
 // - macos-below-minimum: macOS below the promised floor (Helper LSMinimumSystemVersion 12.0);
 // on older versions LaunchServices rejects the Helper with -10825, seen as authorization repeatedly not responding.
 // - not-applicable: non-darwin platform, no macOS version gate.
 */
export type CuaOsSupport =
  | { kind: "supported" }
  | { kind: "macos-below-minimum"; minimumMacOs: string; currentMacOs: string }
  | { kind: "not-applicable" };

/**
 // Platform operations interface -- the replacement for direct window.zcode access.
 *
 // Declares operations that need the host environment (Electron main / Web server).
 // Desktop and Web provide different implementations; the UI layer consumes them through this interface.
 *
 // Design rule: only operations that must cross a process boundary and fit poorly as RPC services,
 // such as native dialogs and window lifecycle control.
 // Business services (files, terminal, credentials, ...) go through the IServiceAccessor RPC channel.
 */
export interface IPlatformService {
  /** Whether the platform file picker can return agent-accessible absolute local paths */
  canSelectFilePath?: boolean;

  /** Open the system directory picker; returns the path or null */
  selectDirectory(): Promise<string | null>;

  /** Open the system file picker; returns the file path or null */
  selectFile(): Promise<string | null>;

  /** Open the system multi-file picker; returns the chosen paths, or an empty array on cancel */
  selectFiles?(): Promise<string[]>;

  /** Write a file via the host-native save-as dialog; plain web does not implement it */
  saveFile?(payload: SaveFileRequest): Promise<SaveFileResult>;

  /**
   // Print the current webContents print layout to PDF (vector text) with the Chromium print engine.
   // Page size comes from renderer-injected @page CSS (preferCSSPageSize); Desktop only.
   */
  printPageToPdf?(): Promise<PrintPageToPdfResult>;

  /**
   // Resolve the host-local path of a browser File object; only the Desktop preload can implement this safely.
   // Web/phone return null so the UI never depends on Electron's non-standard File.path.
   */
  getPathForFile?(file: unknown): string | null;

  /** Convert an agent-authorized desktop-local video path into a host URL readable by media elements. */
  createLocalMediaPreviewUrl?(path: string): string;

  /**
   // Create a text attachment file under the host ~/.zcode temp directory.
   // Phone remote control must write through shared-host/platform proxy to the desktop host, keeping large text out of the prompt payload.
   */
  createTempTextAttachment?(
    payload: CreateTempTextAttachmentRequest,
  ): Promise<CreateTempTextAttachmentResult>;

  /** Subscribe to remote-connection progress logs in this window; returns a disposer */
  onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;

  /** Subscribe to remote workspace session close events; returns a disposer */
  onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;

  /** Subscribe to bot-triggered remote workspace reconnect success; returns a disposer */
  onBotRemoteWorkspaceReconnected(
    handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ): () => void;

  /** Check whether the directory is open in another window; if so focus it and switch to that tab */
  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }>;

  /** Establish a remote connection (Desktop: create a remote session in this window; Web: HTTP API) */
  connectRemote(
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath: string;
      workspaceIdentity?: string;
      connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
    },
  ): Promise<{ success: boolean; error?: string; sessionId?: string }>;

  /** Cancel this window's not-yet-established remote connection (optional; Web may ignore) */
  cancelPendingRemoteConnection?(requestId?: string): Promise<void>;

  /** Bind the canonical workspace identity to the created remote logical session. */
  bindRemoteWorkspaceSessionContext?(
    context: BindRemoteWorkspaceSessionContextRequest,
  ): Promise<void>;

  /** Release a created remote session in this window */
  disposeRemoteSession(sessionId: string): Promise<void>;

  /** Check whether the local Docker daemon is available */
  isDockerAvailable(): Promise<boolean>;

  /** List available WSL distros on this machine */
  listWSLDistros(): Promise<WSLDistro[]>;

  /** List currently connectable Docker containers */
  listDockerContainers(): Promise<DockerContainerInfo[]>;

  /** List SSH config aliases usable for quick form fill on this machine */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;

  /** Read native MCP user-directory config from the host; phone remote control forwards via the connected desktop host. */
  loadMcpFromUserDirectory?(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;

  /** Write native MCP user-directory config to the host; returns unsupported when plain web has no host. */
  saveMcpToUserDirectory?(
    payload: SaveCliMcpToUserDirectoryRequest,
  ): Promise<{ success: boolean; error?: string }>;

  /** Migrate legacy Common MCP config; host environments only, phone remote control forwards via the desktop attachment. */
  migrateLegacyCommonMcp?(
    payload?: MigrateLegacyCommonMcpRequest,
  ): Promise<MigrateLegacyCommonMcpResult>;

  /** Open an external URL (for OAuth browser hops) */
  openExternal(url: string): void;

  /** Read the real app icon by system app id; non-Desktop platforms may skip. */
  getApplicationIcon?(
    request: string | ApplicationIconRequest,
  ): Promise<ApplicationIconInfo | null>;

  /** Open the feedback entry; each platform resolves the final URL */
  openFeedback(): Promise<void>;

  /** Subscribe to main opening the built-in feedback dialog (Desktop) */
  onOpenFeedbackDialog?(handler: () => void): () => void;

  /** Subscribe to main opening my-tickets panel (Desktop) */
  onOpenTicketsPanel?(handler: () => void): () => void;

  /** Open the community entry; the platform resolves the channel for the current language */
  openCommunity(): Promise<void>;

  /** Whether an available community entry exists for the current language */
  canOpenCommunity(locale: Locale): Promise<boolean>;

  /** Reveal the given path in the system file manager */
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;

  /** Open a local file with the system default app; plain web returns unsupported. */
  openExternalFile?(path: string): Promise<{ success: boolean; error?: string }>;

  /** Open the full ZCode Computer Use permission guide. Desktop only. */
  openCuaPermissionOnboarding?(
    options?: OpenCuaPermissionOnboardingOptions,
  ): Promise<CuaAccessibilitySettingsResult>;
  /** Cancel this renderer's onboarding participant by operationId. Desktop only. */
  cancelCuaPermissionOnboarding?(operationId: string): void;
  /**
   // Warm and cache the verified Helper path + fingerprint so a later dragstart can startDrag synchronously.
   // Must be called when the drag panel mounts: Electron native drag requires calling
   // startDrag synchronously inside the dragstart event chain, with no time for async install/verify I/O (or the OS drag gesture window is missed). Desktop only.
   */
  prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
  /** Drag Helper.app from the permission panel into the macOS permission list. Desktop only. */
  startCuaHelperPermissionDrag?(): void;

  /** Report the OAuth state to main for deep link routing */
  registerOAuthState(payload: OAuthStateRegistration): void;

  /**
   // Register an OAuth deep link callback listener
   // @returns disposer that removes only this callback
   */
  onOAuthCallback(callback: (url: string) => void): () => void;

  /**
   // Register a payment deep link callback listener
   // @returns disposer that removes only this callback
   */
  onPaymentCallback(callback: (url: string) => void): () => void;

  /** Register a `zcode://share/import?code=...` import intent. */
  onShareImport?(callback: (payload: { shareCode: string }) => void): () => void;

  /** Tell main the renderer is ready, triggering the cached cold-start deep link forwarding */
  notifyRendererReady(): void;

  /** Fire the system notification for a task state; the host decides whether to actually show it */
  showTaskNotification(payload: TaskNotificationPayload): void;

  /** Report a UI-side telemetry event through the host */
  reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;

  /** Report an ARMS custom event through the host; currently a no-op on web */
  reportArmsCustomEvent(payload: ArmsCustomEventPayload): Promise<void>;

  /** Read the current rollout config for desktop renderer user-action tracing; web/phone do not implement. */
  getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
  /** Subscribe to renderer user-action trace config pushed by main; web/phone do not implement. */
  onRendererActionTraceConfigChanged?(
    callback: (config: RendererActionTraceConfigV1) => void,
  ): () => void;
  /** Renderer -> main: send a finished ui_action batch; strict bypass, fire-and-forget. */
  reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
  reportLocalTtftBatch?(batch: import("./localTtft.js").LocalTtftBatch): void;

  /**
   // Renderer -> main: the main-window renderer's heap reading every 60s, into the `renderer_main` role event. One-way send, fire-and-forget;
   // web and phone remote control have no bridge; not implementing is a no-op.
   */
  reportRendererHeapSample?(sample: RendererHeapSample): void;

  /** Sync every tab's workspace path in this window to main (for cross-window dedupe) */
  syncWindowTabs(paths: string[]): void;

  /** Sync this window's unread task count to the host, for Dock/taskbar badge aggregation */
  syncWindowUnreadCount(count: number): void;
  /** Active task changed in this window; main publishes the global PiP focus only while this window is foreground. */
  syncActiveTaskSession(sessionId: string | null): void;

  /** Sync app settings main must know immediately; the web fallback may ignore */
  syncAppSettings?(patch: Partial<AppSettings>): void;

  /** Shortcut settings page recording toggle; desktop main temporarily strips configurable menu accelerators, web may ignore */
  setShortcutRecordingActive?(active: boolean): void;

  /** Register the callback for main requesting focus on a workspace tab; returns a disposer */
  onFocusTab(handler: (path: string) => void): () => void;

  /** Register the callback for main triggering a new tab; returns a disposer */
  onNewTab(handler: () => void): () => void;

  /** Register the callback for main requesting a close of the current context; returns a disposer */
  onCloseActiveContextRequest?(handler: () => void): () => void;

  /** Register the callback for the built-in browser webview asking to open a new page; returns a disposer */
  onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
  /** Register the callback for the agent's first browser command creating a controlled view (auto-opens a browser-use tab); returns a disposer */
  onBrowserViewReady?(
    handler: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** Refresh tab action state when browser-use hits a real tab; returns a disposer. */
  onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;

  /** browser visibility capability: explicitly show/hide the in-app-browser pane. */
  onBrowserViewVisibility?(
    handler: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** Per-tab sync of agent setViewportSize versus free renderer sizing. */
  onBrowserViewViewportChanged?(
    handler: (payload: BrowserViewViewportChangedPayload) => void,
  ): () => void;

  /** Register the callback for main preparing a background guest compositing surface before screenshots; returns a disposer. */
  onBrowserViewScreenshotSurfacePrepare?(
    handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): () => void;

  /** Register the callback for main releasing the background guest compositing surface after screenshots; returns a disposer. */
  onBrowserViewScreenshotSurfaceRelease?(
    handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): () => void;

  /** Report that the target guest's screenshot compositing surface is stable across consecutive animation frames. */
  browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;

  onBrowserViewCloseTab?(handler: (payload: BrowserViewCloseTabNotification) => void): () => void;

  /** Main asks the renderer to unload the guest and keep the logical shell. */
  onBrowserViewSuspend?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** Main asks the renderer to remount the guest for a suspended shell. */
  onBrowserViewRestore?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** Register the callback for main triggering a new task; returns a disposer */
  onNewTask(handler: () => void): () => void;

  /** Register the callback for main triggering open-workspace; returns a disposer */
  onOpenWorkspace(handler: () => void): () => void;

  /** Register the callback for main opening a local workspace directory via deep link; returns a disposer */
  onOpenWorkspacePath?(handler: (path: string) => void): () => void;

  /** Register the fullscreen state change callback; returns a disposer */
  onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;

  /** Read the desktop window maximized state and native rounded-corner capability */
  getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;

  /** Register the callback for desktop maximized state / native rounded-corner changes */
  onDesktopWindowChromeStateChanged?(
    handler: (state: DesktopWindowChromeState) => void,
  ): () => void;

  /// Synchronously read the native window controls inset, for first-screen startup initialization
  getWindowControlsOverlayMetrics?(): WindowControlsOverlayMetrics | null;

  /** Register the native window controls inset change callback; returns a disposer */
  onWindowControlsOverlayChanged?(
    handler: (metrics: WindowControlsOverlayMetrics) => void,
  ): () => void;

  /// Synchronously read the desktop page-zoom level; the web fallback may return the default 0
  getDesktopZoomLevel?(): Promise<DesktopZoomState>;

  /// Register the desktop page-zoom level change callback; returns a disposer
  onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;

  /// Register the callback for jumping to a task after the user clicks a system notification; returns a disposer
  onTaskNotificationClick(handler: (taskId: string) => void): () => void;

  /// Export logs: package ~/.zcode/v2 plus external agent logs into a zip and reveal it in the system file browser
  exportLogs(): Promise<{ success: boolean; path?: string; error?: string }>;

  /// Capture this window for error feedback screenshots; the web fallback may return null
  captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;

  /// `<webview>` guest report; active=true means agent commands without a tabId read the visible page first.
  browserViewAttachGuest?(payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    /// Conversation ownership of a human browser tab; when absent main must keep it unclaimable to avoid cross-conversation leaks.
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult>;

  /// Before rebuilding a `<webview>`, let main precisely detach the old guest's CDP; when false the old node must not be destroyed.
  browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;

  /// The user closed a Browser tab explicitly; uses different IPC authority from budget suspend.
  browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /// Report selected/visible/loading plus restore metadata.
  browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;

  /// The renderer unloaded the guest at the given generation.
  browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;

  /// The user selected a suspended tab; ask main for a single-flight restore.
  browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /// Read persisted logical shells at workspace/task startup.
  browserViewRestoreTabs?(
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]>;

  /// Free-form size writeback to main; null restores the host natural viewport.
  browserViewUpdateViewport?(payload: {
    tabId: string;
    viewport: BrowserViewportSize | null;
  }): Promise<void>;

  /// One-shot import of Cookies and LocalStorage from an auto-discovered local Chrome profile.
  importChromeBrowserData?(
    options?: ChromeBrowserDataImportOptions,
  ): Promise<ChromeBrowserDataImportResult>;

  /// Clear the built-in browser persisted partition; cache mode keeps auth data, all mode clears every site datum.
  clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;

  /// Register the update-downloaded callback; argument is the new version, returns a disposer
  onUpdateReady(callback: (version: string) => void): () => void;

  /// Register the manual check-for-updates result callback (for toast feedback); returns a disposer
  onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;

  /// Register the auto-update ongoing-state callback; returns a disposer
  onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;

  /// Read the current auto-update state, compensating for missed async events when the menu opens
  getUpdateState?(): Promise<UpdateStatePayload>;

  /// The user confirmed downloading the discovered version in the update dialog
  downloadUpdate(): Promise<void>;

  /// The user canceled the in-flight update from the dialog
  cancelUpdateDownload(): Promise<void>;

  /// Open the desktop standalone update window; non-desktop may skip and fall back to the in-app dialog
  openUpdateStatusWindow?(): Promise<void>;

  /// Read desktop auto-update preferences; non-desktop may return defaults
  getAutoUpdatePreferences?(): Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;

  /// Write the "auto-download and install updates" preference; non-desktop may no-op
  setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;

  /// The user skipped the currently discovered version; main persists per current channel
  skipUpdateVersion(version: string): Promise<void>;

  /// Query the number of sessions running on desktop; non-desktop may return 0
  getDesktopSessionActivity?(): Promise<{
    runningAgentSessionCount: number;
  }>;

  /// Dev-environment stdio tap proxy toggle; non-desktop platforms may skip
  getZCodeStdioTapDevState?(): Promise<ZCodeStdioTapDevState>;

  /// Whether this is a local dev run; desktop injects !app.isPackaged, web may omit.
  isLocalDevelopmentRuntime?: boolean;

  /// Notification after the desktop menu command updates the settings file; the renderer refreshes its settings snapshot.
  onSettingsChanged?(callback: () => void): () => void;

  /// App language resolved by the desktop main process; for standalone lightweight windows without a settingService.
  onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;

  /// Host system locale; desktop main reads it, web may fall back to navigator.language.
  getSystemLocale?(): Promise<Locale>;

  /// Register the post-update release notes; returns a disposer
  onPostUpdateReleaseNotes(callback: (payload: PostUpdateReleaseNotesPayload) => void): () => void;

  /// Mark the current release notes as read, letting main clean up persisted state
  acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;

  /// The user confirmed restarting to install the update
  quitAndInstallUpdate(): Promise<void>;

  /// List installed editors/terminals (with icons)
  getInstalledEditors(): Promise<EditorInfo[]>;

  /// Open a path with the given editor
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /// Run a desktop window-level command (title bar menu, zoom, window controls, ...).
  ///  The return value passes through the main handler's return (most commands return nothing;
  ///  GetCuaOsSupport returns CuaOsSupport), hence the relaxed unknown.
  executeDesktopCommand(command: DesktopCommandId): Promise<unknown>;

  /// Sync the app menu language, driving main to rebuild the native menu
  setApplicationLocale(locale: Locale): Promise<void>;

  /// Sync the desktop title-bar light/dark theme, driving native window control button colors
  setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;

  /** Get a stable device identifier
   *
   * - Desktop: SHA-256 over the userData path; always stable and unique
   * - Phone (web remote control): physical-property fingerprint (browserPlatform | screen.width | screen.height | colorDepth),
   *   robust to browser/network/language/timezone changes; only changes with the physical phone
   */
  getDeviceId(): string;
}
