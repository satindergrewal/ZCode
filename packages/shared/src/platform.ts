/* eslint-disable max-lines -- the cross-platform contract centralizes renderer capabilities; OAuth and browser lifecycle must keep the desktop/web type contract, so this MR does not split the platform boundary. */
import type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
import type { PluginSandboxPlatformPort } from "./mcp-apps/contract.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type {
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlWorkspaceTarget,
} from "./web-remote-control.js";
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

/** Main routes a browser-use operation that can resolve a real tab to its origin renderer. */
export interface BrowserViewOperationPayload {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  tabId: string;
  browserId: string;
  browserGeneration: number;
  /** The model command opens/activates/reshapes the Browser layout; the renderer must rebuild its resize-observation baseline. */
  resetsResizeBaseline?: boolean;
}

export type BrowserTabResidencyState =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

/** Only for creating residency-restore guests that have no first navigation entry yet. */
export const BROWSER_VIEW_RESTORE_BOOTSTRAP_URL = "zcode-browser-restore://pending";

/** Renderer reports tab-shell display facts; main must bind windowId from the trusted IPC sender. */
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
 * main -> renderer close notification.
 *
 * The legacy payload carries only tabId, so the renderer could only look in the active workspace's
 * side-pane state; once the user switched workspaces the notice was dropped and a ghost tab lingered
 * in persisted state. With the owner scope the renderer addresses the right workspace's side pane directly.
 * scope is optional: internal paths such as recovery-orphan carry only tabId and fall back to active-workspace semantics.
 */
export interface BrowserViewCloseTabNotification {
  tabId: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  reason?: "recovery-orphan";
}

/** Across restarts restore the logical shell first; the renderer must not mount every guest at once. */
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

/** Main delivers agent viewport changes to the target tab's origin renderer. */
export interface BrowserViewViewportChangedPayload extends BrowserViewOperationPayload {
  viewport: BrowserViewportSize | null;
}

// The legacy 1500ms budget cannot wait out stable frames on slow machines or background windows;
// main and renderer share this default, and the prepare payload carries the real override so the deadlines never drift apart.
export const BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS = 3_000;

/** Transient preview-ratio requirement of the capture/recording handshake; fall back to the user's current preview when absent. */
export type BrowserViewSurfaceScaleMode = "current" | "unscaled";

/** Main asks the owner renderer to prepare an offscreen guest compositing surface before capture. */
export interface BrowserViewScreenshotSurfacePreparePayload extends BrowserViewOperationPayload {
  requestId: string;
  webContentsId: number;
  viewport: BrowserViewportSize;
  /** Natural viewport: no metrics-based layout compensation; legacy emulation (incl. recording) when absent. */
  viewportMode?: "natural" | "emulated";
  /** `unscaled` forces a true 100% surface for the lease lifetime only; never writes back the user's fit/fixed ratio. */
  surfaceScaleMode?: BrowserViewSurfaceScaleMode;
  /** The prepare timeout main actually uses; renderer falls back to the shared default on legacy payloads. */
  timeoutMs?: number;
}

/** Owner renderer confirms the target guest's logical viewport and native preview surface ratios are stable. */
export interface BrowserViewScreenshotSurfaceReadyPayload extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}

/** Main tells the owner renderer to release the temporary offscreen capture surface. */
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

/** Bind result main returns after the renderer reports the guest; rejections must not masquerade as a silent ready timeout. */
export type BrowserGuestAttachResult =
  | { ok: true; guestGeneration: number }
  | { ok: false; reason: BrowserGuestAttachRejectReason; recoveryRequested: boolean };

/** Installed editor/terminal info */
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

/**
 * dwf artifact "open as file": materialize one version's bytes as a local copy on the host
 * （docs/dynamic-workflow/authoring.md「How the user sees them」）。
 *
 * Terminology: artifact = output published to the user via `artifact.*`, not the engine's `RunSettlement.artifact`.
 */
export interface MaterializeWorkflowArtifactFileRequest {
  runId: string;
  artifactId: string;
  /** Which artifact version these bytes are; copies are per-version directories, one copy each. */
  version: number;
  /** Desired file name (extension picks the opening app); the host sanitizes it again. */
  fileName: string;
  bytes: Uint8Array;
}

export interface MaterializeWorkflowArtifactFileResult {
  /** Absolute host-local path of the copy. */
  localPath: string;
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

export function createOpenInEditorRemoteTarget(
  target: RemoteTarget,
): OpenInEditorRemoteTarget | undefined {
  switch (target.kind) {
    case "ssh":
      // openInEditor only needs the connection identity to build a VS Code Remote-SSH URI;
      // credential fields such as password/privateKeyPassphrase must not cross renderer/preload/main IPC.
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
    case "server":
      return undefined;
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
  /** Windows App-Bound Cookie may trigger UAC only after this explicit confirmation; never persist as a global grant. */
  allowElevatedChromeDecryption?: boolean;
}

/** Chrome data import returns counts and status only; Cookie/LocalStorage values and key material never cross processes. */
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
  /** On partial success keep actionable issues; never include profile absolute paths or site data. */
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

/**
 * Desktop close-to-tray capability (spec: docs/desktop/linux-close-to-tray.md).
 * On Linux it depends on a StatusNotifierWatcher on the session bus (native on KDE/XFCE;
 * GNOME needs the AppIndicator extension); Windows is always supported; macOS/Web are not queried.
 */
export interface DesktopCloseToTrayCapability {
  /** Whether close-to-tray is available */
  supported: boolean;
  /** GNOME-family desktop without a tray; settings appends an install-AppIndicator hint */
  gnomeLikeWithoutTray: boolean;
}

export interface DesktopWindowChromeState {
  isMaximized: boolean;
  /** Local macOS major version; null off-macOS or when unparseable. */
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
  /** Owning browser-use tab of the popup; legacy events omit it and the renderer falls back to the current scope. */
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  browserId?: string;
  browserGeneration?: number;
  sourceTabId?: string;
}

export interface EmbeddedBrowserPermissionDeviceOption {
  deviceId: string;
  name?: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

export interface EmbeddedBrowserPermissionScreenOption {
  sourceId: string;
  name: string;
  /** Source kind, screen or window; main decides by desktopCapturer source-id prefix. */
  kind: "screen" | "window";
  thumbnailDataUrl?: string;
}

/** main -> renderer embedded-browser permission request; kind picks the dialog the renderer shows. */
export type EmbeddedBrowserPermissionPromptEvent =
  | {
      requestId: string;
      kind: "permission";
      origin: string;
      permission: string;
      mediaTypes?: string[];
      /** webContents id of the requesting guest; the renderer shows the dialog only in the owning tab,
       *  so background-tab requests never mis-approve in the visible tab. */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "screen-share";
      origin: string;
      screens: EmbeddedBrowserPermissionScreenOption[];
      /** Screen sharing has no tab-anchor semantics; always absent (fallback rendering). */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "device";
      origin: string;
      /** select-hid-device / select-usb-device / select-serial-port / select-bluetooth-device */
      permission: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      /** webContents id of the requesting guest (available for serial/bluetooth; hid/usb cannot cross
       *  frames and stays absent; the renderer falls back). */
      guestWebContentsId?: number;
    };

export type EmbeddedBrowserPermissionResolution =
  | { action: "allow-always" }
  | { action: "allow-session" }
  | { action: "block-always" }
  | { action: "dismiss" }
  | { action: "share-screen"; sourceId: string }
  | { action: "select-device"; deviceId: string }
  | { action: "cancel" };

export interface EmbeddedBrowserPermissionResolveRequest {
  requestId: string;
  resolution: EmbeddedBrowserPermissionResolution;
}

export type EmbeddedBrowserSitePermissionsSnapshot = Record<
  string,
  Record<string, "allow" | "deny">
>;

export interface EmbeddedBrowserSitePermissionUpdateRequest {
  origin: string;
  permission: string;
  /** "ask" deletes the record and returns to always-ask. */
  state: "allow" | "deny" | "ask";
}

export interface EmbeddedBrowserSitePermissionResetRequest {
  origin: string;
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
 * CUA Helper OS support state (macOS version-gate verdict, delivered to the renderer by main via
 * GetCuaOsSupport).
 * - supported: gate satisfied (non-version factors included; parse failures count as lenient).
 * - macos-below-minimum: macOS below the promised floor (Helper LSMinimumSystemVersion 12.0);
 *   there LaunchServices rejects the Helper with -10825 and authorization appears to hang.
 * - not-applicable: non-darwin platform; no macOS version gate applies.
 */
export type CuaOsSupport =
  | { kind: "supported" }
  | { kind: "macos-below-minimum"; minimumMacOs: string; currentMacOs: string }
  | { kind: "not-applicable" };

/**
 * Platform operations interface -- the replacement for direct window.zcode access.
 *
 * Operations that need the host environment (Electron main / web server).
 * Desktop and web provide separate implementations; the UI consumes them through this interface only.
 *
 * Design rule: only operations that must cross a process boundary and fit an RPC service poorly,
 * e.g. native dialogs and window lifecycle control.
 * Business services (files, terminal, credentials, ...) go through IServiceAccessor RPC channels.
 */
export interface IPlatformService {
  /** Whether this platform's file picker can return agent-accessible absolute paths */
  canSelectFilePath?: boolean;

  /**
   * Plugin UI sandbox platform port. Desktop-only;
   * undefined on web/phone-remote, and plugin-ui falls back to a plain MCP tool card.
   */
  pluginSandbox?: PluginSandboxPlatformPort;

  /** Open the native directory picker; returns the path or null */
  selectDirectory(): Promise<string | null>;

  /** Open the native file picker; returns the path or null */
  selectFile(): Promise<string | null>;

  /** Open the native multi-file picker; returns paths, empty array on cancel */
  selectFiles?(): Promise<string[]>;

  /** Write a file via the native save-as dialog; plain web does not implement */
  saveFile?(payload: SaveFileRequest): Promise<SaveFileResult>;

  /**
   * Print the webContents' print media layout to PDF (vector text) via the Chromium print pipeline.
   * Page size comes from renderer-injected @page CSS (preferCSSPageSize); desktop only.
   */
  printPageToPdf?(): Promise<PrintPageToPdfResult>;

  /**
   * Resolve the host-local path of a browser File object; only the desktop preload can do this safely.
   * Web/phone return null so the UI never leans on Electron's non-standard File.path.
   */
  getPathForFile?(file: unknown): string | null;

  /** Convert an agent-authorized desktop local video path into a host URL media elements can load. */
  createLocalMediaPreviewUrl?(path: string): string;

  /**
   * Create a text attachment under the host ~/.zcode temp directory.
   * Phone-remote must write through the shared-host/platform proxy so large text stays out of prompt payloads.
   */
  createTempTextAttachment?(
    payload: CreateTempTextAttachmentRequest,
  ): Promise<CreateTempTextAttachmentResult>;

  /**
   * Write one dwf artifact version to a host-local copy (only when the path is empty) and return its path.
   * Desktop-only: phone-remote and plain web cannot open files with native apps, so no entry point when absent.
   */
  materializeWorkflowArtifactFile?(
    payload: MaterializeWorkflowArtifactFileRequest,
  ): Promise<MaterializeWorkflowArtifactFileResult>;

  /** Subscribe to remote-connection progress logs in this window; returns a disposer */
  onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;

  /** Subscribe to remote workspace session close events; returns a disposer */
  onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;

  /** Subscribe to bot-triggered remote workspace reconnect success; returns a disposer */
  onBotRemoteWorkspaceReconnected(
    handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ): () => void;

  /** If the directory is open in another window, activate it and switch to that tab */
  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }>;

  /** Establish a remote connection (desktop: create a session in this window; web: HTTP API) */
  connectRemote(
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath: string;
      workspaceIdentity?: string;
      connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
    },
  ): Promise<{ success: boolean; error?: string; sessionId?: string }>;

  /** Cancel a pending remote connection in this window (optional; web may ignore) */
  cancelPendingRemoteConnection?(requestId?: string): Promise<void>;

  /** Bind the canonical workspace identity onto a created remote logical session. */
  bindRemoteWorkspaceSessionContext?(
    context: BindRemoteWorkspaceSessionContextRequest,
  ): Promise<void>;

  /** Enable web remote control for the current workspace */
  startWebRemoteControl(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStartOperationResult>;

  /** Clear old pairing material and regenerate the web remote control QR code */
  refreshWebRemoteControlPairing(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStartOperationResult>;

  /** Disable web remote control for this window */
  stopWebRemoteControl(): Promise<void>;

  /** Query this window's web remote control state */
  getWebRemoteControlStatus(): Promise<WebRemoteControlStatus>;

  /** Subscribe to web remote control state changes; optional on legacy platforms, UI keeps polling as fallback */
  onWebRemoteControlStatusChanged?(handler: (status: WebRemoteControlStatus) => void): () => void;

  /** Release a created remote session in this window */
  disposeRemoteSession(sessionId: string): Promise<void>;

  /** Check whether the local Docker daemon is available */
  isDockerAvailable(): Promise<boolean>;

  /** List available local WSL distros */
  listWSLDistros(): Promise<WSLDistro[]>;

  /** List currently connectable Docker containers */
  listDockerContainers(): Promise<DockerContainerInfo[]>;

  /** List SSH config aliases usable for quick-fill forms on this machine */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;

  /** Read native MCP user-directory config from the host; phone-remote forwards via the connected desktop host. */
  loadMcpFromUserDirectory?(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;

  /** Write native MCP user-directory config to the host; plain web without a host returns unsupported. */
  saveMcpToUserDirectory?(
    payload: SaveCliMcpToUserDirectoryRequest,
  ): Promise<{ success: boolean; error?: string }>;

  /** Migrate legacy Common MCP config; host-only, phone-remote forwards via the desktop attachment. */
  migrateLegacyCommonMcp?(
    payload?: MigrateLegacyCommonMcpRequest,
  ): Promise<MigrateLegacyCommonMcpResult>;

  /** Open an external URL (OAuth browser hand-off) */
  openExternal(url: string): void;

  /** Read the real app icon by system app id; optional off-desktop. */
  getApplicationIcon?(
    request: string | ApplicationIconRequest,
  ): Promise<ApplicationIconInfo | null>;

  /** Open the feedback entry; each platform resolves the final URL */
  openFeedback(): Promise<void>;

  /** Subscribe to main's open-feedback-dialog event (desktop) */
  onOpenFeedbackDialog?(handler: () => void): () => void;

  /** Subscribe to main's open-my-tickets event (desktop) */
  onOpenTicketsPanel?(handler: () => void): () => void;

  /** Open the community entry; each platform resolves the current-locale channel */
  openCommunity(): Promise<void>;

  /** Whether a community entry exists for the current locale */
  canOpenCommunity(locale: Locale): Promise<boolean>;

  /** Reveal the path in the system file manager */
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;

  /** Open a local file with the default app; plain web returns unsupported. */
  openExternalFile?(path: string): Promise<{ success: boolean; error?: string }>;

  /** Open the full ZCode Computer Use permission onboarding. Desktop only. */
  openCuaPermissionOnboarding?(
    options?: OpenCuaPermissionOnboardingOptions,
  ): Promise<CuaAccessibilitySettingsResult>;
  /** Cancel the onboarding participant this renderer started by operationId. Desktop only. */
  cancelCuaPermissionOnboarding?(operationId: string): void;
  /**
   * Warm-cache the verified Helper path + fingerprint so a later dragstart can startDrag synchronously.
   * Call when the drag overlay mounts: Electron native drag requires startDrag synchronously inside the
   * dragstart chain; install/verify async I/O would miss the OS gesture window. Desktop only.
   */
  prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
  /** Drag the Helper.app from the permission overlay into the macOS list. Desktop only. */
  startCuaHelperPermissionDrag?(): void;

  /** Report OAuth state to main for deep-link routing */
  registerOAuthState(payload: OAuthStateRegistration): void;

  /**
   * Register an OAuth deep-link callback listener
   * @returns disposer removing only this callback
   */
  onOAuthCallback(callback: (url: string) => void): () => void;

  /**
   * Register a payment deep-link callback listener
   * @returns disposer removing only this callback
   */
  onPaymentCallback(callback: (url: string) => void): () => void;

  /** Register a `zcode://share/import?code=...` import intent. */
  onShareImport?(callback: (payload: { shareCode: string }) => void): () => void;

  /** Tell main this renderer is ready; flushes cached cold-start deep links */
  notifyRendererReady(): void;

  /** Fire the system notification for a task state; the host decides whether to show it */
  showTaskNotification(payload: TaskNotificationPayload): void;

  /** Report a UI telemetry event through the host environment */
  reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;

  /** Report an ARMS custom event via the host; web is a no-op today */
  reportArmsCustomEvent(payload: ArmsCustomEventPayload): Promise<void>;

  /** Read the desktop renderer interaction-trace rollout config; web/phone do not implement. */
  getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
  /** Subscribe to main-pushed renderer interaction-trace config; web/phone do not implement. */
  onRendererActionTraceConfigChanged?(
    callback: (config: RendererActionTraceConfigV1) => void,
  ): () => void;
  /** Renderer -> main: send a finished ui_action batch; strict side-channel, fire-and-forget. */
  reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
  reportLocalTtftBatch?(batch: import("./localTtft.js").LocalTtftBatch): void;

  /**
   * Renderer -> main: main-window heap reading every 60s into the `renderer_main` role event. One-way, fire-and-forget;
   * web and phone-remote have no bridge and no-op.
   */
  reportRendererHeapSample?(sample: RendererHeapSample): void;

  /** Sync all tab workspace paths in this window to main (cross-window dedup) */
  syncWindowTabs(paths: string[]): void;

  /** Sync workspaces switchable via web remote control in this window; web fallback may ignore */
  syncWebRemoteControlWorkspaces?(workspaces: WebRemoteControlWorkspaceTarget[]): void;

  /** Sync task snapshots shown via web remote control in this window; web fallback may ignore */
  syncWebRemoteControlTasks?(tasks: WebRemoteControlTaskTarget[]): void;

  /** Register the phone-requests-reconnect callback for web remote control; returns a disposer */
  onWebRemoteControlReconnectWorkspace?(
    handler: (
      request: WebRemoteControlReconnectWorkspaceRequest,
    ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
  ): () => void;

  /** Sync this window's unread task count to the host for dock/taskbar badge aggregation */
  syncWindowUnreadCount(count: number): void;
  /** Active task changed in this window; main publishes the global PiP focus only while foregrounded. */
  syncActiveTaskSession(sessionId: string | null): void;

  /** Sync app settings main must know immediately; web fallback may ignore */
  syncAppSettings?(patch: Partial<AppSettings>): void;

  /**
   * Query close-to-tray capability; desktop main probes and answers. Web/phone-remote have no bridge.
   * Settings uses this to disable the toggle on Linux.
   */
  getCloseToTrayCapability?(): Promise<DesktopCloseToTrayCapability>;

  /** Shortcut recording toggle; desktop main temporarily detaches menu accelerators, web may ignore */
  setShortcutRecordingActive?(active: boolean): void;

  /** Register the focus-workspace-tab callback from main; returns a disposer */
  onFocusTab(handler: (path: string) => void): () => void;

  /** Register the new-tab callback from main; returns a disposer */
  onNewTab(handler: () => void): () => void;

  /** Register the close-current-context callback from main; returns a disposer */
  onCloseActiveContextRequest?(handler: () => void): () => void;

  /** Register the embedded-webview open-new-page callback; returns a disposer */
  onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
  /** Register the embedded-browser permission request (main -> renderer); returns a disposer */
  onEmbeddedBrowserPermissionPrompt?(
    handler: (event: EmbeddedBrowserPermissionPromptEvent) => void,
  ): () => void;
  /** Answer an embedded-browser permission prompt (renderer -> main) */
  resolveEmbeddedBrowserPermissionPrompt?(request: EmbeddedBrowserPermissionResolveRequest): void;
  /** Read embedded-browser per-site permissions (settings, Site Permissions) */
  getEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Upsert/delete one site permission; returns the updated snapshot */
  setEmbeddedBrowserSitePermission?(
    request: EmbeddedBrowserSitePermissionUpdateRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Clear all site permission records */
  clearEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Reset all permissions for one origin (drops every persisted decision); returns the updated snapshot */
  resetEmbeddedBrowserSitePermission?(
    request: EmbeddedBrowserSitePermissionResetRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Register the callback for the agent's first browser command creating the managed view (auto-opens a browser-use tab); returns a disposer */
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

  /** Refresh tab action state when browser-use targets a real tab; returns a disposer. */
  onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;

  /** Browser visibility capability: show/hide the current IAB browser-use pane explicitly. */
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

  /** Per-tab sync of agent setViewportSize and renderer free-size events. */
  onBrowserViewViewportChanged?(
    handler: (payload: BrowserViewViewportChangedPayload) => void,
  ): () => void;

  /** Register the prepare-offscreen-surface-before-capture callback from main; returns a disposer. */
  onBrowserViewScreenshotSurfacePrepare?(
    handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): () => void;

  /** Register the release-offscreen-surface-after-capture callback from main; returns a disposer. */
  onBrowserViewScreenshotSurfaceRelease?(
    handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): () => void;

  /** Report that the target guest's capture surface stayed stable across consecutive frames. */
  browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;

  onBrowserViewCloseTab?(handler: (payload: BrowserViewCloseTabNotification) => void): () => void;

  /** main asks the renderer to unload the guest and keep the logical shell. */
  onBrowserViewSuspend?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** main asks the renderer to remount the guest for a suspended shell. */
  onBrowserViewRestore?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** Register the new-task callback from main; returns a disposer */
  onNewTask(handler: () => void): () => void;

  /** Register the open-workspace callback from main; returns a disposer */
  onOpenWorkspace(handler: () => void): () => void;

  /** Register the deep-link-opens-local-workspace callback from main; returns a disposer */
  onOpenWorkspacePath?(handler: (path: string) => void): () => void;

  /** Register the fullscreen-change callback; returns a disposer */
  onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;

  /** Read maximized state and native rounded-corner capability */
  getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;

  /** Register the maximized/rounded-corner change callback */
  onDesktopWindowChromeStateChanged?(
    handler: (state: DesktopWindowChromeState) => void,
  ): () => void;

  /** Synchronously read the native window-control inset for first-paint initialization */
  getWindowControlsOverlayMetrics?(): WindowControlsOverlayMetrics | null;

  /** Register the window-control-inset change callback; returns a disposer */
  onWindowControlsOverlayChanged?(
    handler: (metrics: WindowControlsOverlayMetrics) => void,
  ): () => void;

  /** Synchronously read the zoom level; web fallback may return 0 */
  getDesktopZoomLevel?(): Promise<DesktopZoomState>;

  /** Register the zoom-level change callback; returns a disposer */
  onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;

  /** Register the notification-click-routes-to-task callback; returns a disposer */
  onTaskNotificationClick(handler: (taskId: string) => void): () => void;

  /** Export logs: zip ~/.zcode/v2 plus external agent logs and reveal in the file manager */
  exportLogs(): Promise<{ success: boolean; path?: string; error?: string }>;

  /** Capture this window for error feedback; web fallback may return null */
  captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;

  /** `<webview>` guest report; active=true means tabId-less agent commands read the visible page first. */
  browserViewAttachGuest?(payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    /** Conversation ownership of a human browser tab; when absent main must keep it unclaimed to avoid cross-conversation leaks. */
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult>;

  /** Have main detach CDP from the exact old guest before rebuild; false must not destroy the old node. */
  browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;

  /** User closed a Browser tab explicitly; distinct IPC authority from budget suspend. */
  browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** Report selected/visible/loading plus restore metadata. */
  browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;

  /** The renderer unloaded the guest of the given generation. */
  browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;

  /** User hit a suspended tab; ask main for a single-flight restore. */
  browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** Read persisted logical shells on workspace/task startup. */
  browserViewRestoreTabs?(
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]>;

  /** Renderer free-size write-back to main; null restores the host natural viewport. */
  browserViewUpdateViewport?(payload: {
    tabId: string;
    viewport: BrowserViewportSize | null;
  }): Promise<void>;

  /** One-shot import of Cookies and LocalStorage from the auto-detected local Chrome profile. */
  importChromeBrowserData?(
    options?: ChromeBrowserDataImportOptions,
  ): Promise<ChromeBrowserDataImportResult>;

  /** Clear the embedded-browser partition; cache keeps auth data, all wipes every site. */
  clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;

  /** Register the update-downloaded callback (version argument); returns a disposer */
  onUpdateReady(callback: (version: string) => void): () => void;

  /** Register the manual check-for-updates result callback (toast feedback); returns a disposer */
  onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;

  /** Register the auto-update ongoing-state callback; returns a disposer */
  onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;

  /** Pull the current auto-update state; compensates missed async events on menu open */
  getUpdateState?(): Promise<UpdateStatePayload>;

  /** User confirmed downloading the discovered version in the update dialog */
  downloadUpdate(): Promise<void>;

  /** User canceled the in-flight download in the update dialog */
  cancelUpdateDownload(): Promise<void>;

  /** Open the dedicated desktop update window; other platforms fall back to the inline dialog */
  openUpdateStatusWindow?(): Promise<void>;

  /** Read desktop auto-update preferences; other platforms may return defaults */
  getAutoUpdatePreferences?(): Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;

  /** Write the auto-download-and-install preference; other platforms may no-op */
  setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;

  /** User skipped the discovered version; main persists it per channel */
  skipUpdateVersion(version: string): Promise<void>;

  /** Count running desktop sessions; other platforms may return 0 */
  getDesktopSessionActivity?(): Promise<{
    runningAgentSessionCount: number;
  }>;

  /** Dev stdio tap proxy toggle state; optional off-desktop */
  getZCodeStdioTapDevState?(): Promise<ZCodeStdioTapDevState>;

  /** Whether running unpackaged; desktop injects !app.isPackaged, web may omit. */
  isLocalDevelopmentRuntime?: boolean;

  /** settings.json changed via a desktop menu command; the renderer refreshes its settings snapshot. */
  onSettingsChanged?(callback: () => void): () => void;

  /** App locale resolved by the desktop main; for lightweight windows without a settingService. */
  onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;

  /** Host system locale; desktop reads it in main, web falls back to navigator.language. */
  getSystemLocale?(): Promise<Locale>;

  /** Register the release-notes-after-update callback; returns a disposer */
  onPostUpdateReleaseNotes(callback: (payload: PostUpdateReleaseNotesPayload) => void): () => void;

  /** Mark current release notes read; main may clear persisted state */
  acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;

  /** User confirmed restart-to-install */
  quitAndInstallUpdate(): Promise<void>;

  /** List installed editors/terminals (with icons) */
  getInstalledEditors(): Promise<EditorInfo[]>;

  /** Open a path in the given editor */
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /** Run a desktop window-level command (titlebar menu, zoom, window controls, ...).
   *  The result passes through the main-process handler return (most commands return nothing;
   *  GetCuaOsSupport returns CuaOsSupport), hence the unknown widening. */
  executeDesktopCommand(command: DesktopCommandId): Promise<unknown>;

  /** Sync the app-menu locale; main rebuilds native menus */
  setApplicationLocale(locale: Locale): Promise<void>;

  /** Sync the titlebar light/dark theme for native window controls */
  setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;

  /** Get the stable device identifier.
   *
   * - Desktop: SHA-256 over the userData path; stable and unique.
   * - Phone (web remote): hardware fingerprint (browserPlatform | screen.width | screen.height | colorDepth),
   *   resilient to browser/network/locale/timezone changes; changes only with the device.
   */
  getDeviceId(): string;
}
