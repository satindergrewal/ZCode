/* eslint-disable max-lines -- transport channels and request/response maps must stay centralized; scattering channel strings across processes caused drift. */
import type {
  ResourceUsageSnapshot,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./index.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type { AppSettings, Locale } from "./protocol.js";
import type { StorageCleanRequest, StorageCleanResult, StorageUsageSnapshot } from "./storage.js";
import type {
  ArmsCustomEventPayload,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  RendererTelemetryEventPayload,
  TelemetryRendererContext,
} from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  CancelPendingRemoteConnectionRequest,
  BindRemoteWorkspaceSessionContextRequest,
  BotRemoteWorkspaceReconnectedEvent,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewViewportChangedPayload,
  ConnectRemoteRequest,
  DesktopCommandId,
  DesktopTitleBarTheme,
  DockerContainerInfo,
  EmbeddedBrowserOpenUrlRequest,
  EditorInfo,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  OpenInEditorOptions,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  SSHConfigAliasOption,
  TaskNotificationPayload,
  WSLDistro,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  DesktopZoomState,
  DesktopWindowChromeState,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
} from "./platform.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";

// ============================================================================
// RPC service channels - transported via ChannelServer/ChannelClient
// ============================================================================

/** RPC service channel name; matches ServiceDescriptor.channelName. */
export const ServiceChannels = {
  File: "file",
  MediaPreview: "media-preview",
  System: "system",
  Terminal: "terminal",
  /** Git service */
  Git: "git",
  /** Git checkpoint service */
  GitCheckpoint: "git-checkpoint",
  Setting: "setting",
  /** Credential management (migrated from main IPC to host RPC) */
  Credential: "credential",
  /** Computer Use Helper macOS permission service */
  CuaPermission: "cua-permission",
  /** producer-owned PiP session presentation client */
  CuaPipSession: "cua-pip-session",
  /** Cross-window broadcast */
  Broadcast: "broadcast",
  /** ZCode task wrapper service */
  ZCodeTask: "zcode-task",
  /** Window Host aggregating workspace/task projections and list write routing */
  WindowController: "window-controller",
  /** ZCode Protocol agent service */
  ZCodeAgent: "zcode-agent",
  /** ZCode session application service */
  ZCodeSession: "zcode-session",
  /** Session share publish/preview and continuation API orchestration */
  ConversationShare: "conversation-share",
  /** File system watcher service */
  FileWatcher: "file-watcher",
  /** OAuth authentication service */
  OAuth: "oauth",
  /** Settings facade for the new Provider Config */
  ProviderSettings: "provider-settings",
  /** Model selection facade for the new Provider Registry */
  ModelSelection: "model-selection",
  /** Provider provisioning target inside a remote environment */
  ProviderProvisioningTarget: "provider-provisioning-target",
  /** Local usage stats service */
  UsageStats: "usage-stats",
  /** Coding Plan subscription purchase service */
  CodingPlanSubscription: "coding-plan-subscription",
  ClientConfig: "client-config",
  /** ZCode client scenario configuration service */
  ClientScenes: "client-scenes",
  /** Skills management service */
  Skills: "skills",
  /** SSH remote skills sync service */
  SkillSync: "skill-sync",
  /** SSH remote MCP sync service */
  McpSync: "mcp-sync",
  /** SSH remote plugin sync service */
  PluginSync: "plugin-sync",
  /** Plugin management service */
  Plugins: "plugins",
  /** Settings-page plugin management (funnels UI platform capabilities; no direct zcodeAgentService access) */
  PluginManagement: "plugin-management",
  /** Subagents management service */
  Subagents: "subagents",
  /** Commands management service */
  Commands: "commands",
  /** Hooks management service */
  Hooks: "hooks",
  /** Memory management service */
  Memory: "memory",
  /** First-run setup sync service */
  SettingsSync: "settings-sync",
  /** Bot remote-chat control service */
  Bots: "bots",
  /** User feedback ticket service */
  Feedback: "feedback",
  /** Pre-transfer for composer attachments between host-local and remote runtimes */
  PromptAttachmentTransfer: "prompt-attachment-transfer",
  /** Idle-time task management (separate surface from the automation service) */
  OffPeakTask: "off-peak-task",
  /** Onboarding completion record (local persistence, uploaded later) */
  OnboardingRecord: "onboarding-record",
} as const;

export type ServiceChannelName = (typeof ServiceChannels)[keyof typeof ServiceChannels];

// ============================================================================
// Platform channels - handled only by the Desktop main process (Electron IPC)
// ============================================================================

/** Electron IPC channel names; used only between preload and main. */
export const PlatformChannels = {
  /** Open the system directory picker */
  SelectDirectory: "zcode:select-directory",
  /** Open the system file picker */
  SelectFile: "zcode:select-file",
  /** Open the system multi-file picker */
  SelectFiles: "zcode:select-files",
  /** Renderer -> Main: write a temp text attachment under the host ~/.zcode */
  CreateTempTextAttachment: "zcode:create-temp-text-attachment",
  /** Renderer -> Main: save a file via the native save-as dialog */
  SaveFile: "zcode:save-file",
  /** Renderer -> Main: export the page's print layout to PDF via the Chromium print engine */
  PrintToPdf: "zcode:print-to-pdf",
  /** Main -> Renderer: forward remote-connection progress logs */
  RemoteConnectionLog: "zcode:remote-connection-log",
  /** Main -> Renderer: remote workspace session closed */
  RemoteSessionClosed: "zcode:remote-session-closed",
  /** Main -> Renderer: bot-triggered remote workspace reconnect succeeded */
  BotRemoteWorkspaceReconnected: "zcode:bot-remote-workspace-reconnected",
  /** Check whether the directory is open in another window; activate it if so */
  ActivateOrSetWorkspace: "zcode:activate-or-set-workspace",
  /** Establish an SSH remote connection */
  ConnectRemote: "zcode:connect-remote",
  /** Cancel the in-flight remote connection of this window */
  CancelPendingRemoteConnection: "zcode:cancel-pending-remote-connection",
  /** Renderer -> Main: bind the canonical workspace context of a remote logical session */
  BindRemoteWorkspaceSessionContext: "zcode:bind-remote-workspace-session-context",
  /** Release the remote session held by this window */
  DisposeRemoteSession: "zcode:dispose-remote-session",
  /** Renderer -> Main: check whether the local Docker daemon is available */
  IsDockerAvailable: "zcode:is-docker-available",
  /** Renderer -> Main: list available local WSL distros */
  ListWSLDistros: "zcode:list-wsl-distros",
  /** Renderer -> Main: list connectable Docker containers */
  ListDockerContainers: "zcode:list-docker-containers",
  /** Renderer -> Main: list SSH config aliases usable for quick-fill */
  ListSSHConfigAliases: "zcode:list-ssh-config-aliases",
  /** Renderer -> Main: load the CLI MCP config from the user directory */
  LoadMcpFromUserDirectory: "zcode:load-mcp-from-user-directory",
  /** Renderer -> Main: save the CLI MCP config to the user directory */
  SaveMcpToUserDirectory: "zcode:save-mcp-to-user-directory",
  /** Forward renderer logs to main for unified storage */
  Log: "zcode:log",
  /** Renderer -> Main: sync workspace paths of all tabs in this window */
  SyncWindowTabs: "zcode:sync-window-tabs",
  /** Renderer -> Main: sync this window's unread task count */
  SyncWindowUnreadCount: "zcode:sync-window-unread-count",
  /** Renderer -> Main: active task of this window; only updates main's ephemeral focus map. */
  SyncActiveTaskSession: "zcode:sync-active-task-session",
  /** Renderer -> Main: sync app settings main must see immediately */
  SyncAppSettings: "zcode:sync-app-settings",
  /** Renderer -> Main: shortcut recording toggle; true = main temporarily removes configurable menu accelerators */
  SetShortcutRecordingActive: "zcode:set-shortcut-recording-active",
  /** Main -> Renderer: focus the tab of the given workspace path */
  FocusTab: "zcode:focus-tab",
  /** Main -> Renderer: menu-triggered new tab */
  NewTab: "zcode:new-tab",
  /** Main -> Renderer: menu/shortcut asks to close the current context */
  CloseActiveContextRequest: "zcode:close-active-context-request",
  /** Main -> Renderer: embedded webview asks to open a new browser tab */
  OpenBrowserUrl: "zcode:open-browser-url",
  /** Main -> Renderer: the agent's first browser command created a controlled view; renderer auto-opens the browser-use tab */
  BrowserViewReady: "zcode:browser-view-ready",
  /** Main -> Renderer: agent is driving a browser-use tab; renderer shows a transient status icon */
  BrowserViewOperation: "zcode:browser-view-operation",
  /** Main -> Renderer: browser visibility capability shows/hides the IAB side panel */
  BrowserViewVisibility: "zcode:browser-view-visibility",
  /** Main -> Renderer: agent sets/resets the target tab viewport */
  BrowserViewViewportChanged: "zcode:browser-view-viewport-changed",
  /** Main -> Renderer: ask the owner renderer to prepare a background guest compositing surface before a screenshot. */
  BrowserViewScreenshotSurfacePrepare: "zcode:browser-view-screenshot-surface-prepare",
  /** Renderer -> Main: viewport stable across two consecutive animation frames of the target guest. */
  BrowserViewScreenshotSurfaceReady: "zcode:browser-view-screenshot-surface-ready",
  /** Main -> Renderer: capture finished or prepare failed; release the temporary background layer. */
  BrowserViewScreenshotSurfaceRelease: "zcode:browser-view-screenshot-surface-release",
  /** Main -> Renderer: after agent close detached the controlled guest, tell the renderer to unmount that tab */
  BrowserViewCloseTab: "zcode:browser-view-close-tab",
  /** Main -> Renderer: budget eviction unmounts the guest but keeps the logical tab shell. */
  BrowserViewSuspend: "zcode:browser-view-suspend",
  /** Main -> Renderer: remount the guest for a suspended shell. */
  BrowserViewRestore: "zcode:browser-view-restore",
  /** Main -> Renderer: menu-triggered new task */
  NewTask: "zcode:new-task",
  /** Main -> Renderer: menu-triggered open workspace */
  OpenWorkspace: "zcode:open-workspace",
  /** Main -> Renderer: deep link opens the given local workspace directory */
  OpenWorkspacePath: "zcode:open-workspace-path",
  /** Main -> Renderer: open the built-in feedback dialog */
  OpenFeedbackDialog: "zcode:open-feedback-dialog",
  /** Main -> Renderer: open my-tickets panel */
  OpenTicketsPanel: "zcode:open-tickets-panel",
  /** Main -> Renderer: window fullscreen state changed */
  WindowFullscreenChanged: "zcode:window-fullscreen-changed",
  /** Renderer -> Main: read window maximized state and native rounded-corner capability */
  GetDesktopWindowChromeState: "zcode:get-desktop-window-chrome-state",
  /** Main -> Renderer: maximized state / native rounded-corner capability changed */
  DesktopWindowChromeStateChanged: "zcode:desktop-window-chrome-state-changed",
  /** Main -> Renderer: native window-controls inset changed */
  WindowControlsOverlayChanged: "zcode:window-controls-overlay-changed",
  /** Preload -> Main: preload read the current window-controls inset synchronously */
  WindowControlsOverlayReady: "zcode:window-controls-overlay-ready",
  /** Resource monitor snapshot (CPU/memory, grouped by base services, built-in plugins, community plugins) */
  GetResourceUsageSnapshot: "zcode:get-resource-usage-snapshot",
  SetResourceUsageSamplingActive: "zcode:set-resource-usage-sampling-active",
  /** Open the resource monitor window (triggered from other windows) */
  OpenResourceManager: "zcode:open-resource-manager",
  /** Resource monitor storage tab: start scanning local .zcode usage (main owns StorageService, worker thread walks) */
  StorageStartScan: "zcode:storage-start-scan",
  /** Resource monitor storage tab: cancel scan */
  StorageCancelScan: "zcode:storage-cancel-scan",
  /** Resource monitor storage tab: read the latest snapshot */
  StorageGetSnapshot: "zcode:storage-get-snapshot",
  /** Resource monitor storage tab: clean up by category */
  StorageClean: "zcode:storage-clean",
  /** Resource monitor storage tab: reveal a path under the data root in the system file manager */
  StorageRevealPath: "zcode:storage-reveal-path",
  /** Main -> monitor renderer: push scan-progress snapshot */
  StorageScanProgress: "zcode:storage-scan-progress",
  /** Renderer -> Main: open an external URL (OAuth browser hop) */
  OpenExternal: "zcode:open-external",
  /** Renderer -> Main: query whether a community entry exists for the current language */
  CanOpenCommunity: "zcode:can-open-community",
  /** Renderer -> Main: open a path in the system file manager */
  OpenInFileManager: "zcode:open-in-file-manager",
  /** Renderer -> Main: open a local file with the system default app */
  OpenExternalFile: "zcode:open-external-file",
  /** Renderer -> Main: open the ZCode Computer Use permission guide */
  OpenCuaPermissionOnboarding: "zcode:open-cua-permission-onboarding",
  /** Renderer -> Main: cancel a permission-guide participant started by this renderer */
  CancelCuaPermissionOnboarding: "zcode:cancel-cua-permission-onboarding",
  /**
   * Renderer -> Main: warm and cache the verified Helper path + bundle fingerprint.
   * Must be called when the drag floater mounts - no async IO allowed in the dragstart path.
   */
  PrepareCuaHelperPermissionDrag: "zcode:prepare-cua-helper-permission-drag",
  /** Renderer -> Main: drag the verified Helper.app into the macOS permission list */
  StartCuaHelperPermissionDrag: "zcode:start-cua-helper-permission-drag",
  /**
   * Renderer -> Main: drag gesture ended.
   * Authorization completes with the drop, so the floater must yield (the user needs the settings page and the OS restart prompt). Wait for dragend, not
   * closing during dragstart: startDrag merely hands the drag session to the OS, non-blocking; an instantly
   * vanished drag source can interrupt an ongoing drag.
   */
  NotifyCuaHelperPermissionDragEnded: "zcode:notify-cua-helper-permission-drag-ended",
  /** Renderer -> Main: report OAuth state for deep link routing */
  OAuthRegisterState: "zcode:oauth-register-state",
  /** Main -> Renderer: forward deep link URL */
  OAuthCallback: "zcode:oauth-callback",
  /** Main -> Renderer: forward payment deep link URL */
  PaymentCallback: "zcode:payment-callback",
  /** Main -> Renderer: external share page requests share-code import. */
  ShareImport: "zcode:share-import",
  /** Renderer -> Main: OAuth callback handled; post-launch flow may continue */
  OAuthCallbackHandled: "zcode:oauth-callback-handled",
  /** Renderer -> Main: renderer ready to receive cached deep links */
  RendererReady: "zcode:renderer-ready",
  /** Renderer -> Main: sync this renderer's telemetry context */
  SyncTelemetryContext: "zcode:sync-telemetry-context",
  /** Renderer -> Main: report a business event via the unified telemetry layer */
  ReportTelemetryEvent: "zcode:report-telemetry-event",
  /** Renderer -> Main: report an ARMS custom event */
  ReportArmsCustomEvent: "zcode:report-arms-custom-event",
  /** Renderer -> Main: read the user-action trace rollout config. */
  GetRendererActionTraceConfig: "zcode:get-renderer-action-trace-config",
  /** Main -> Renderer: user-action trace rollout config changed. */
  RendererActionTraceConfigChanged: "zcode:renderer-action-trace-config-changed",
  /** Renderer -> Main: send a finished ui_action batch. */
  ReportRendererActionTraceBatch: "zcode:report-renderer-action-trace-batch",
  /** Renderer -> Main: main-window renderer heap sample every 60s; one-way send, no ack. */
  ReportRendererHeapSample: "zcode:report-renderer-heap-sample",
  ReportLocalTtftBatch: "zcode:report-local-ttft-batch",
  /** E2E preload -> Main: read the in-memory ring of final sendCustom args. */
  ReadFinalArmsCustomEventsE2E: "zcode:e2e:read-final-arms-custom-events",
  /** E2E preload -> Main: clear the sendCustom final-args ring. */
  ClearFinalArmsCustomEventsE2E: "zcode:e2e:clear-final-arms-custom-events",
  /** E2E preload -> Main: configure real-network suppression for one event name. */
  ConfigureFinalArmsCustomEventsE2E: "zcode:e2e:configure-final-arms-custom-events",
  /** Renderer -> Main: fire the task completed/failed system notification */
  ShowTaskNotification: "zcode:show-task-notification",
  /** Main -> Preload: tell the renderer to play the task notification sound */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** Main -> Preload: user clicked a system notification; carries taskId so the renderer jumps to it */
  TaskNotificationClick: "zcode:task-notification-click",
  /** Renderer -> Main: export logs (zip packaged ~/.zcode/v2 + external agent logs, reveal in Finder) */
  ExportLogs: "zcode:export-logs",
  /** Renderer -> Main: capture this window as a feedback attachment */
  CaptureWindowScreenshot: "zcode:capture-window-screenshot",
  /**
   * Renderer -> Main: report webContentsId after `<webview>` guest dom-ready;
   * main attaches the guest via BrowserGuestManager (fire-and-forget). CDP-on-guest pivot.
   */
  BrowserViewAttachGuest: "zcode:browser-view-attach-guest",
  /** Renderer -> Main: proactively detach the old guest's CDP before the <webview> is rebuilt. */
  BrowserViewDetachGuest: "zcode:browser-view-detach-guest",
  /** Renderer -> Main: user explicitly closed a Browser tab. */
  BrowserViewCloseTabFromRenderer: "zcode:browser-view-close-tab-from-renderer",
  /** Renderer -> Main: report Browser tab residency/display facts. */
  BrowserViewReportResidency: "zcode:browser-view-report-residency",
  /** Renderer -> Main: the guest of the given generation unmounted. */
  BrowserViewSuspendReady: "zcode:browser-view-suspend-ready",
  /** Renderer -> Main: user visited a suspended tab; request restore. */
  BrowserViewEnsureResident: "zcode:browser-view-ensure-resident",
  /** Renderer -> Main: read persisted logical shells of workspaces/tasks. */
  BrowserViewRestoreTabs: "zcode:browser-view-restore-tabs",
  /** Renderer -> Main: write back the free-size drag/toggle target guest viewport */
  BrowserViewUpdateViewport: "zcode:browser-view-update-viewport",
  /** Embedded Browser preload -> Main: synchronously request a trusted system dialog before a native page dialog opens. */
  EmbeddedBrowserJavaScriptDialog: "zcode:embedded-browser-javascript-dialog",
  /** Renderer -> Main: one-time import of auto-discovered local Chrome profile data into the built-in browser. */
  ImportChromeBrowserData: "zcode:import-chrome-browser-data",
  /** Renderer -> Main: clear built-in browser cache or all site data. */
  ClearEmbeddedBrowserData: "zcode:clear-embedded-browser-data",
  /** Main -> Renderer: a new version finished downloading; restart to install */
  UpdateReady: "zcode:update-ready",
  /** Main -> Renderer: result after the user clicked check-for-updates (for the toast) */
  UpdateCheckResult: "zcode:update-check-result",
  /** Main -> Renderer: auto-update ongoing state changed (for menu UI) */
  UpdateStateChanged: "zcode:update-state-changed",
  /** Renderer -> Main: fetch current auto-update state (compensates lost events when the menu opens) */
  GetUpdateState: "zcode:get-update-state",
  /** Renderer -> Main: start downloading the discovered update */
  DownloadUpdate: "zcode:download-update",
  /** Renderer -> Main: cancel the in-flight update download */
  CancelUpdateDownload: "zcode:cancel-update-download",
  /** Renderer -> Main: open the dedicated auto-update window */
  OpenUpdateStatusWindow: "zcode:open-update-status-window",
  /** Renderer -> Main: read auto-update preferences */
  GetAutoUpdatePreferences: "zcode:get-auto-update-preferences",
  /** Renderer -> Main: write the auto-download-and-install preference */
  SetAutoDownloadAndInstallUpdates: "zcode:set-auto-download-and-install-updates",
  /** Renderer -> Main: query the number of running desktop sessions */
  GetDesktopSessionActivity: "zcode:get-desktop-session-activity",
  /** Renderer -> Main: read this window's page zoom level */
  GetDesktopZoomLevel: "zcode:get-desktop-zoom-level",
  /** Main -> Renderer: page zoom level changed for this window */
  DesktopZoomLevelChanged: "zcode:desktop-zoom-level-changed",
  /** Renderer -> Main: read the dev-mode stdio tap proxy toggle */
  GetZCodeStdioTapDevState: "zcode:get-zcode-stdio-tap-dev-state",
  /** Main -> Renderer: settings.json updated by the main process */
  SettingsChanged: "zcode:settings-changed",
  /** Main -> Renderer: app language switched */
  ApplicationLocaleChanged: "zcode:application-locale-changed",
  /** Renderer -> Main: read the host system locale */
  GetSystemLocale: "zcode:get-system-locale",
  /** Main -> Renderer: release notes after an update was installed */
  PostUpdateReleaseNotes: "zcode:post-update-release-notes",
  /** Renderer -> Main: acknowledge release notes as read */
  AcknowledgePostUpdateReleaseNotes: "zcode:ack-post-update-release-notes",
  /** Renderer -> Main: skip the currently discovered update version */
  SkipUpdateVersion: "zcode:skip-update-version",
  /** Renderer -> Main: user confirmed restart-to-install */
  QuitAndInstallUpdate: "zcode:quit-and-install-update",
  /** Renderer -> Main: list installed editors/terminals (with icons) */
  GetInstalledEditors: "zcode:get-installed-editors",
  /** Renderer -> Main: get an app icon by bundle id */
  GetApplicationIcon: "zcode:get-application-icon",
  /** Renderer -> Main: open a path with the given editor */
  OpenInEditor: "zcode:open-in-editor",
  /** Renderer -> Main: run a desktop window-level command */
  ExecuteDesktopCommand: "zcode:execute-desktop-command",
  /** Renderer -> Main: sync app-menu language for native menu rebuild */
  SetApplicationLocale: "zcode:set-application-locale",
  /** Renderer -> Main: sync titlebar light/dark for native window-control button tinting */
  SetTitleBarTheme: "zcode:set-title-bar-theme",
  /** Renderer -> Main: migrate legacy Common MCP config */
  MigrateLegacyCommonMcp: "zcode:migrate-legacy-common-mcp",
  /** Renderer -> Main: get the device's stable identifier (deviceMid) */
  GetDeviceId: "zcode:get-device-id",
} as const;

export type PlatformChannelName = (typeof PlatformChannels)[keyof typeof PlatformChannels];

// ============================================================================
// Built-in webview channels - fixed guest preload <-> embedder renderer
// ============================================================================

/** `sendToHost` / `ipc-message` channels of an Electron <webview>; bypasses the main process. */
export const EmbeddedBrowserWebviewChannels = {
  /** When the guest cannot scroll further in a direction, hand the 2D delta to the free-size canvas. */
  WheelBoundary: "zcode:embedded-browser-wheel-boundary",
} as const;

export interface EmbeddedBrowserWheelBoundaryPayload {
  deltaX: number;
  deltaY: number;
}

// ============================================================================
// Coding Plan webview channels - website preload <-> app renderer
// ============================================================================

/**
 * `sendToHost` / `ipc-message` channels of the Electron <webview> (partition=persist:zcode-coding-plan).
 * The website calls them via the preload-injected window.zcodeBridge; the main process is not involved.
 */
export const CodingPlanWebviewChannels = {
  /** After a successful purchase the website tells the app to refresh entitlements and close the webview. */
  PurchaseComplete: "zcode:coding-plan-purchase-complete",
} as const;

/** Purchase-completion payload. provider mirrors the website CodingPlanProvider / auth-ready detail.provider. */
export interface CodingPlanPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
  /** Client timestamp for app-side dedup/logging; not part of equality. */
  timestamp: number;
}

/**
 * Values of the website's window.__zcodeLang__; matches the app IntlProvider locale.
 * On locale change the app rewrites it via executeJavaScript and dispatches lang-change.
 */
export type CodingPlanWebviewLocale = "zh-CN" | "en-US";

/**
 * detail of the website lang-change event. The app dispatches the
 * `zcode-coding-plan-lang-change` CustomEvent in the main world via executeJavaScript; the website side
 * (zcodeBridge.onLangChange or plain window.addEventListener) subscribes and switches copy.
 */
export interface CodingPlanWebviewLangChangeDetail {
  locale: CodingPlanWebviewLocale;
}

// ============================================================================
// Internal transport channels - framework-level messaging
// ============================================================================
/** Internal transport channels, e.g. MessagePort forwarding. */
export const InternalChannels = {
  DatabaseStartupState: "zcode:database-startup-state",
  DatabaseStartupControl: "zcode:database-startup-control",
  /** main -> renderer: forward a MessagePort (via webContents.postMessage) */
  ServicePort: "zcode:service-port",
  /** main -> renderer: forward the window Host's scoped MessagePort */
  ScopedServicePort: "zcode:scoped-service-port",
  /** renderer -> main: scoped MessagePort registered; attachment switching is safe */
  ScopedServicePortReady: "zcode:scoped-service-port-ready",
  /** preload -> renderer: main confirmed the system notification; the renderer may play the sound */
  TaskNotificationSound: "zcode:task-notification-sound",
} as const;

/** @deprecated `/ws` ignores this header; kept for legacy clients only. */
export const ZCODE_RPC_CLIENT_MODE_HEADER = "x-zcode-rpc-client-mode";
/** Desktop first applies via the protected HTTP endpoint, then consumes it once during the `/ws/host` handshake. */
export const ZCODE_RPC_HOST_CAPABILITY_HEADER = "x-zcode-rpc-host-capability";

// ============================================================================
// Inter-process message types - postMessage between main and the host process
// ============================================================================

/** Init message types from main to the host process */
export const HostMessageTypes = {
  DatabaseStartupControl: "database-startup-control",
  /** Initialize local services */
  InitLocal: "init-local",
  /** main -> window Host: establish a remote logical session in this window */
  ConnectRemoteWorkspace: "connect-remote-workspace",
  /** main -> window Host: cancel a pending remote connection */
  CancelRemoteWorkspaceConnect: "cancel-remote-workspace-connect",
  /** main -> window Host: bind canonical workspace identity to a logical session */
  BindRemoteWorkspaceContext: "bind-remote-workspace-context",
  /** main -> window Host: release a remote logical session */
  DisposeRemoteWorkspaceSession: "dispose-remote-workspace-session",
  /** main -> host: reuse existing services and expose them to a new RPC MessagePort */
  AttachServicePort: "attach-service-port",
  /** main -> host: release exactly one RPC MessagePort attachment */
  DetachServicePort: "detach-service-port",
  /** Window closed; release resources */
  Dispose: "dispose",
  /** Broadcast relay */
  Broadcast: "broadcast",
  /** main -> host: cross-window atomic claim result */
  BroadcastClaimResult: "broadcast-claim-result",
  /** main → host：task realtime invalidation delivery */
  TaskRealtimeDeliver: "task-realtime-deliver",
  /** main → host：task run lease acquire result */
  TaskRunLeaseResult: "task-run-lease-result",
  /** main → host：deliver owner-only task command */
  TaskOwnerCommandDeliver: "task-owner-command-deliver",
  /** main → host：deliver owner command result to requester */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** main -> host: bot remote-workspace reconnect result */
  BotRemoteWorkspaceReconnectResult: "bot-remote-workspace-reconnect-result",
  /** main -> host: bot remote-workspace connection status query result */
  BotRemoteWorkspaceConnectionStatusResult: "bot-remote-workspace-connection-status-result",
  /** main -> host: bot remote-workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePort: "bot-remote-workspace-runtime-port",
  /** main -> host: deliver a session message to the target session managed by this host */
  SessionMessageDeliver: "session-message-deliver",
  /** main -> host: write a session-delivery result back to the source session */
  SessionMessageDeliveryResult: "session-message-delivery-result",
  /** main -> host: feedback log archive creation result */
  FeedbackLogArchiveResult: "feedback-log-archive-result",
  /** main -> host: scheduled task due; in-session cron reuses targetTaskId, only unbound history creates a session */
  CronRun: "cron-run",
  /** main -> host: idle-task dispatch; first run createTask makes a session, continuations resume with conversationId/sessionId */
  OffPeakRun: "off-peak-run",
  /** main -> host: browser-use command result (returned after CDP execution, correlated by requestId) */
  BrowserExecuteResult: "browser-execute-result",
  /** main -> host: local-video canonical path authorization result */
  LocalMediaPreviewPathAuthorizeResult: "local-media-preview-path-authorize-result",
  /** Main -> Host: producer focus fact derived from the foreground ZCode window. */
  CuaPipFocusChanged: "cua-pip-focus-changed",
  /** main -> host: read the local Source now and sync the given Remote Environment. */
  ProviderProvisioningExecute: "provider-provisioning-execute",
  /** main -> host: the resource monitor asks the host to sample CPU/memory of descendant processes (agent/MCP/terminal) */
  ResourceUsageSnapshotRequest: "resource-usage-snapshot-request",
  ResourceUsageSnapshotCancel: "resource-usage-snapshot-cancel",
} as const;

/** Feedback message types from the host process to main */
export const HostResponseTypes = {
  DatabaseStartupState: "database-startup-state",
  /** window Host -> main: report remote-connection progress logs by requestId */
  RemoteWorkspaceConnectionLog: "remote-workspace-connection-log",
  /** window Host -> main: remote logical session established */
  RemoteWorkspaceConnected: "remote-workspace-connected",
  /** window Host -> main: remote logical session failed to establish */
  RemoteWorkspaceConnectFailed: "remote-workspace-connect-failed",
  /** window Host -> main: a connected remote logical session closed */
  RemoteWorkspaceClosed: "remote-workspace-closed",
  /** Host process log report */
  Log: "log",
  /** Host spawned a new agent child process */
  AgentProcessSpawned: "agent-process-spawned",
  /** Host agent runtime passed the model execution gate for the first time */
  AgentProcessReady: "agent-process-ready",
  /** Host agent child process exited */
  AgentProcessExited: "agent-process-exited",
  /** Host agent child process failed to start */
  AgentProcessError: "agent-process-error",
  AgentProcessException: "agent-process-exception",
  /** host -> main: CLI self-sampled CPU/RSS */
  AgentResourceSample: "agent-resource-sample",
  /** host -> main: host process self-sample CPU/RSS/heap every 60s (heap source for the host role in resource telemetry) */
  HostResourceSample: "host-resource-sample",
  /** host -> main: in-CLI MCP process lifetime and memory telemetry */
  McpTelemetry: "mcp-telemetry",
  McpResourceSamples: "mcp-resource-samples",
  ToolExecResource: "tool-exec-resource",
  /** Automation host reports the new session after the first accepted input. */
  SessionCreateTelemetry: "session-create-telemetry",
  /** host -> main: resource monitor sample result (correlated by requestId) */
  ResourceUsageSnapshotResult: "resource-usage-snapshot-result",
  /** Count of host agent sessions currently executing a prompt changed */
  AgentRunningTaskCountChanged: "agent-running-task-count-changed",
  /** Count of not-yet-terminal tasks for a workspace in this host changed */
  WorkspaceRunningTaskCountChanged: "workspace-running-task-count-changed",
  /** host -> main: action-hint state of a Windows desktop-local CUA turn */
  CuaOperationState: "cua-operation-state",
  /** host -> main: workspace generation is safe to attach */
  RemoteWorkspaceAcquired: "remote-workspace-acquired",
  /** Broadcast message */
  Broadcast: "broadcast",
  /** host -> main: request a cross-window atomic claim */
  BroadcastClaimRequest: "broadcast-claim-request",
  /** host -> main: commit a transient claim reservation into a permanent claim */
  BroadcastClaimCommit: "broadcast-claim-commit",
  /** host -> main: release an uncommitted claim reservation by token */
  BroadcastClaimRelease: "broadcast-claim-release",
  /** host -> main: publish a task realtime invalidation */
  TaskRealtimePublish: "task-realtime-publish",
  /** host -> main: publish a task stream mirror op */
  TaskStreamOpPublish: "task-stream-op-publish",
  /** host -> main: acquire a task run lease */
  TaskRunLeaseAcquire: "task-run-lease-acquire",
  /** host -> main: release a task run lease */
  TaskRunLeaseRelease: "task-run-lease-release",
  /** host -> main: observer asks the owner to run a task command */
  TaskOwnerCommandRequest: "task-owner-command-request",
  /** host -> main: owner returns the task command result */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** host -> main: bot requests a remote workspace session */
  BotRemoteWorkspaceReconnectRequest: "bot-remote-workspace-reconnect-request",
  /** host -> main: bot asks whether this window already has a remote workspace session */
  BotRemoteWorkspaceConnectionStatusRequest: "bot-remote-workspace-connection-status-request",
  /** host -> main: bot requests the remote workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePortRequest: "bot-remote-workspace-runtime-port-request",
  /** host -> main: agent asks to send a message to another session */
  SessionMessageSendRequested: "session-message-send-requested",
  /** host -> main: declare that a ZCode agent session belongs to this host */
  SessionRouteAnnounce: "session-route-announce",
  /** host -> main: target host finished local session-message delivery */
  SessionMessageDeliverResult: "session-message-deliver-result",
  /** host -> main: ask main to create the feedback log archive via the export-logs path */
  FeedbackLogArchiveRequest: "feedback-log-archive-request",
  /** host -> main: scheduled-task dispatch result (success fills taskId/sessionId; failure carries transient/permanent) */
  CronRunResult: "cron-run-result",
  /** host -> main: idle-task dispatch result (success fills conversationId/sessionId; failure carries transient/permanent) */
  OffPeakRunResult: "off-peak-run-result",
  /** host -> main: manual run persisted; wake the scheduler to claim dispatch now */
  CronSchedulerWakeRequest: "cron-scheduler-wake-request",
  /** host -> main: idle task became schedulable; wake the scheduler now (independent of the cron message) */
  OffPeakSchedulerWakeRequest: "off-peak-scheduler-wake-request",
  /** host -> main: run one browser-use command (main executes via WebContentsView+CDP, correlated by requestId) */
  BrowserExecuteRequest: "browser-execute-request",
  /** host -> main: request authorization of an agent-verified local video path */
  LocalMediaPreviewPathAuthorizeRequest: "local-media-preview-path-authorize-request",
  /** host -> main: RPC network telemetry batch (per channel.command success rate/latency) */
  NetworkTelemetryBatch: "network-telemetry-batch",
  /** host -> main: local provisioning source persisted. */
  ProviderProvisioningSourceChanged: "provider-provisioning-source-changed",
  /** host -> main: one Remote Environment sync finished. */
  ProviderProvisioningExecutionResult: "provider-provisioning-execution-result",
} as const;

// ============================================================================
// Platform channel type maps - request/response type safety
// ============================================================================

/** Request/response type map of the platform channels */
export interface PlatformChannelMap {
  [PlatformChannels.SelectDirectory]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.SelectFile]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.SelectFiles]: {
    request: void;
    response: string[];
  };
  [PlatformChannels.CreateTempTextAttachment]: {
    request: CreateTempTextAttachmentRequest;
    response: CreateTempTextAttachmentResult;
  };
  [PlatformChannels.SaveFile]: {
    request: SaveFileRequest;
    response: SaveFileResult;
  };
  [PlatformChannels.PrintToPdf]: {
    request: void;
    response: PrintPageToPdfResult;
  };
  [PlatformChannels.RemoteConnectionLog]: {
    request: {
      label: string;
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      source: string;
      message: string;
      timestamp: string;
    };
    response: void;
  };
  [PlatformChannels.RemoteSessionClosed]: {
    request: RemoteSessionClosedEvent;
    response: void;
  };
  [PlatformChannels.BotRemoteWorkspaceReconnected]: {
    request: BotRemoteWorkspaceReconnectedEvent;
    response: void;
  };
  [PlatformChannels.ActivateOrSetWorkspace]: {
    request: string;
    response: { activated: boolean };
  };
  [PlatformChannels.OpenWorkspacePath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ConnectRemote]: {
    request: ConnectRemoteRequest;
    response: { success: boolean; error?: string; sessionId?: string };
  };
  [PlatformChannels.CancelPendingRemoteConnection]: {
    request: CancelPendingRemoteConnectionRequest;
    response: void;
  };
  [PlatformChannels.BindRemoteWorkspaceSessionContext]: {
    request: BindRemoteWorkspaceSessionContextRequest;
    response: void;
  };
  [PlatformChannels.DisposeRemoteSession]: {
    request: string;
    response: void;
  };
  [PlatformChannels.IsDockerAvailable]: {
    request: void;
    response: boolean;
  };
  [PlatformChannels.ListWSLDistros]: {
    request: void;
    response: WSLDistro[];
  };
  [PlatformChannels.ListDockerContainers]: {
    request: void;
    response: DockerContainerInfo[];
  };
  [PlatformChannels.ListSSHConfigAliases]: {
    request: void;
    response: SSHConfigAliasOption[];
  };
  [PlatformChannels.LoadMcpFromUserDirectory]: {
    request: LoadCliMcpFromUserDirectoryRequest;
    response: LoadCliMcpFromUserDirectoryResult;
  };
  [PlatformChannels.SaveMcpToUserDirectory]: {
    request: SaveCliMcpToUserDirectoryRequest;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.MigrateLegacyCommonMcp]: {
    request: MigrateLegacyCommonMcpRequest;
    response: MigrateLegacyCommonMcpResult;
  };
  [PlatformChannels.Log]: {
    request: { level: "info" | "warn" | "error"; args: unknown[] };
    response: void;
  };
  [PlatformChannels.SyncWindowUnreadCount]: {
    request: number;
    response: void;
  };
  [PlatformChannels.SyncAppSettings]: {
    request: Partial<AppSettings>;
    response: void;
  };
  [PlatformChannels.GetResourceUsageSnapshot]: {
    request: void;
    response: ResourceUsageSnapshot;
  };
  [PlatformChannels.SetResourceUsageSamplingActive]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.StorageStartScan]: {
    request: void;
    response: { jobId: string };
  };
  [PlatformChannels.StorageCancelScan]: {
    request: string;
    response: void;
  };
  [PlatformChannels.StorageGetSnapshot]: {
    request: void;
    response: StorageUsageSnapshot | null;
  };
  [PlatformChannels.StorageClean]: {
    request: StorageCleanRequest;
    response: StorageCleanResult;
  };
  [PlatformChannels.StorageRevealPath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenExternal]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenBrowserUrl]: {
    request: EmbeddedBrowserOpenUrlRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewReady]: {
    request: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewVisibility]: {
    request: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewViewportChanged]: {
    request: BrowserViewViewportChangedPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfacePrepare]: {
    request: BrowserViewScreenshotSurfacePreparePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceReady]: {
    request: BrowserViewScreenshotSurfaceReadyPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceRelease]: {
    request: BrowserViewScreenshotSurfaceReleasePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewCloseTab]: {
    request: BrowserViewCloseTabNotification;
    response: void;
  };
  [PlatformChannels.BrowserViewSuspend]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewRestore]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.CanOpenCommunity]: {
    request: Locale;
    response: boolean;
  };
  [PlatformChannels.OpenInFileManager]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenExternalFile]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenCuaPermissionOnboarding]: {
    request: OpenCuaPermissionOnboardingOptions | undefined;
    response: CuaAccessibilitySettingsResult;
  };
  [PlatformChannels.PrepareCuaHelperPermissionDrag]: {
    request: undefined;
    response: PrepareCuaHelperPermissionDragResult;
  };
  // One-way send, not invoke: dragstart must fire synchronously and cannot wait an invoke round-trip.
  [PlatformChannels.StartCuaHelperPermissionDrag]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.NotifyCuaHelperPermissionDragEnded]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.CancelCuaPermissionOnboarding]: {
    request: { operationId: string };
    response: void;
  };
  [PlatformChannels.OAuthRegisterState]: {
    request: OAuthStateRegistration;
    response: void;
  };
  [PlatformChannels.OAuthCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.PaymentCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ShareImport]: {
    request: { shareCode: string };
    response: void;
  };
  [PlatformChannels.OAuthCallbackHandled]: {
    request: void;
    response: void;
  };
  [PlatformChannels.RendererReady]: {
    request: void;
    response: void;
  };
  [PlatformChannels.SyncTelemetryContext]: {
    request: TelemetryRendererContext;
    response: void;
  };
  [PlatformChannels.ReportTelemetryEvent]: {
    request: RendererTelemetryEventPayload;
    response: void;
  };
  [PlatformChannels.ReportArmsCustomEvent]: {
    request: ArmsCustomEventPayload;
    response: void;
  };
  [PlatformChannels.GetRendererActionTraceConfig]: {
    request: void;
    response: RendererActionTraceConfigV1;
  };
  [PlatformChannels.RendererActionTraceConfigChanged]: {
    request: RendererActionTraceConfigV1;
    response: void;
  };
  [PlatformChannels.ReportRendererActionTraceBatch]: {
    request: RendererActionTraceBatchV1;
    response: void;
  };
  // One-way send, not invoke: a bypass telemetry sample every 60s; the renderer never waits for main.
  [PlatformChannels.ReportRendererHeapSample]: {
    request: RendererHeapSample;
    response: void;
  };
  [PlatformChannels.ReadFinalArmsCustomEventsE2E]: {
    request: void;
    response: FinalArmsCustomEventE2EEntry[];
  };
  [PlatformChannels.ClearFinalArmsCustomEventsE2E]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ConfigureFinalArmsCustomEventsE2E]: {
    request: ConfigureFinalArmsCustomEventE2ERequest;
    response: void;
  };
  [PlatformChannels.ShowTaskNotification]: {
    request: TaskNotificationPayload;
    response: void;
  };
  [PlatformChannels.TaskNotificationSound]: {
    request: void;
    response: void;
  };
  [PlatformChannels.TaskNotificationClick]: {
    request: string;
    response: void;
  };
  [PlatformChannels.WindowFullscreenChanged]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.GetDesktopWindowChromeState]: {
    request: void;
    response: DesktopWindowChromeState;
  };
  [PlatformChannels.DesktopWindowChromeStateChanged]: {
    request: DesktopWindowChromeState;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayChanged]: {
    request: WindowControlsOverlayMetrics;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayReady]: {
    request: WindowControlsOverlayReadyPayload;
    response: void;
  };
  [PlatformChannels.ExportLogs]: {
    request: void;
    response: { success: boolean; path?: string; error?: string };
  };
  [PlatformChannels.CaptureWindowScreenshot]: {
    request: void;
    response: {
      dataBase64: string;
      filename: string;
      contentType: string;
      size: number;
    } | null;
  };
  // CDP-on-guest pivot: the renderer <webview> reports the guest webContentsId and main attaches.
  [PlatformChannels.BrowserViewAttachGuest]: {
    request: {
      key: string;
      webContentsId: number;
      active?: boolean;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewDetachGuest]: {
    request: { key: string; webContentsId: number };
    response: boolean;
  };
  [PlatformChannels.BrowserViewCloseTabFromRenderer]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewReportResidency]: {
    request: BrowserViewResidencyReportPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewSuspendReady]: {
    request: { tabId: string; generation: number };
    response: void;
  };
  [PlatformChannels.BrowserViewEnsureResident]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewRestoreTabs]: {
    request: BrowserViewRestoreTabsRequest;
    response: BrowserViewRestoredTabShell[];
  };
  [PlatformChannels.BrowserViewUpdateViewport]: {
    request: { tabId: string; viewport: BrowserViewportSize | null };
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserJavaScriptDialog]: {
    request: {
      type: "alert" | "confirm";
      message: string;
    };
    response: {
      handled: boolean;
      value?: boolean;
    };
  };
  [PlatformChannels.UpdateReady]: {
    request: string;
    response: void;
  };
  [PlatformChannels.UpdateCheckResult]: {
    request: UpdateCheckResultPayload;
    response: void;
  };
  [PlatformChannels.UpdateStateChanged]: {
    request: UpdateStatePayload;
    response: void;
  };
  [PlatformChannels.GetUpdateState]: {
    request: void;
    response: UpdateStatePayload;
  };
  [PlatformChannels.DownloadUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.CancelUpdateDownload]: {
    request: void;
    response: void;
  };
  [PlatformChannels.OpenUpdateStatusWindow]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetAutoUpdatePreferences]: {
    request: void;
    response: {
      autoDownloadAndInstallUpdates: boolean;
    };
  };
  [PlatformChannels.SetAutoDownloadAndInstallUpdates]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.SettingsChanged]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ApplicationLocaleChanged]: {
    request: Locale;
    response: void;
  };
  [PlatformChannels.GetSystemLocale]: {
    request: void;
    response: Locale;
  };
  [PlatformChannels.GetDesktopSessionActivity]: {
    request: void;
    response: {
      runningAgentSessionCount: number;
    };
  };
  [PlatformChannels.GetDesktopZoomLevel]: {
    request: void;
    response: DesktopZoomState;
  };
  [PlatformChannels.DesktopZoomLevelChanged]: {
    request: DesktopZoomState;
    response: void;
  };
  [PlatformChannels.PostUpdateReleaseNotes]: {
    request: PostUpdateReleaseNotesPayload;
    response: void;
  };
  [PlatformChannels.AcknowledgePostUpdateReleaseNotes]: {
    request: string;
    response: void;
  };
  [PlatformChannels.SkipUpdateVersion]: {
    request: string;
    response: void;
  };
  [PlatformChannels.QuitAndInstallUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetInstalledEditors]: {
    request: void;
    response: EditorInfo[];
  };
  [PlatformChannels.GetApplicationIcon]: {
    request: string | import("./platform.js").ApplicationIconRequest;
    response: import("./platform.js").ApplicationIconInfo | null;
  };
  [PlatformChannels.OpenInEditor]: {
    request: { editorId: string; path: string; options?: OpenInEditorOptions };
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.CloseActiveContextRequest]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ExecuteDesktopCommand]: {
    request: DesktopCommandId;
    // The return value passes through the main-process handler's return (GetCuaOsSupport returns CuaOsSupport),
    // aligned with the renderer-side IPlatformService.executeDesktopCommand Promise<unknown>.
    response: unknown;
  };
  [PlatformChannels.SetApplicationLocale]: {
    request: Locale;
    response: void;
  };
  [PlatformChannels.SetTitleBarTheme]: {
    request: DesktopTitleBarTheme;
    response: void;
  };
}
