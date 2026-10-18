/* eslint-disable max-lines -- channel names and request/response maps must stay centralized; never scatter cross-process channel strings. */
import type {
  ResourceUsageSnapshot,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./index.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type {
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceTarget,
} from "./web-remote-control.js";
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
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  EditorInfo,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
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
// RPC service channels -- transported via ChannelServer/ChannelClient
// ============================================================================

/** RPC service channel names. Match ServiceDescriptor.channelName. */
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
  /** Conversation share publish/preview and continuation API orchestration */
  ConversationShare: "conversation-share",
  /** File system watcher service */
  FileWatcher: "file-watcher",
  /** OAuth auth service */
  OAuth: "oauth",
  /** Settings read/write facade for the new provider config */
  ProviderSettings: "provider-settings",
  /** Model selection facade over the new provider registry */
  ModelSelection: "model-selection",
  /** Provider provisioning target inside a remote environment */
  ProviderProvisioningTarget: "provider-provisioning-target",
  /** Local usage stats service */
  UsageStats: "usage-stats",
  /** Coding Plan subscription purchase service */
  CodingPlanSubscription: "coding-plan-subscription",
  ClientConfig: "client-config",
  /** ZCode client scene config service */
  ClientScenes: "client-scenes",
  CloudContent: "cloud-content",
  MarketingTouch: "marketing-touch",
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
  /** Settings plugin management service (consolidated UI platform surface; no direct zcodeAgentService access) */
  PluginManagement: "plugin-management",
  /** Plugin UI sandbox bridge: host serves ui:// resources, registers with main, and proxies UI-initiated tool calls */
  PluginUiBridge: "plugin-ui-bridge",
  PluginUiSampling: "plugin-ui-sampling",
  PluginUiAppTools: "plugin-ui-app-tools",
  /** Subagents management service */
  Subagents: "subagents",
  /** Commands management service */
  Commands: "commands",
  /** Hooks management service */
  Hooks: "hooks",
  /** Memory management service */
  Memory: "memory",
  /** OutputStyle management service */
  OutputStyle: "output-style",
  /** First-run settings sync service */
  SettingsSync: "settings-sync",
  /** Bots remote chat control service */
  Bots: "bots",
  /** User feedback ticket service */
  Feedback: "feedback",
  /** Composer attachment staging between host-local and remote runtimes */
  PromptAttachmentTransfer: "prompt-attachment-transfer",
  /** Off-peak task service (independent of the automation surface) */
  OffPeakTask: "off-peak-task",
  /** Highspeed boost-card extraction and sharing service */
  HighspeedCard: "highspeed-card",
  /** Onboarding completion record service (local persistence, uploaded later) */
  OnboardingRecord: "onboarding-record",
} as const;

export type ServiceChannelName = (typeof ServiceChannels)[keyof typeof ServiceChannels];

// ============================================================================
// Platform channels -- operations handled only by the desktop main process (Electron IPC)
// ============================================================================

/** Electron IPC channel names. preload <-> main only. */
export const PlatformChannels = {
  /** renderer -> main: release a plugin UI sandbox (close ports, remove protocol handler, clear partition) */
  PluginSandboxDispose: "zcode:plugin-sandbox-dispose",
  PluginSandboxCopyImage: "zcode:plugin-sandbox-copy-image",
  /** renderer -> main: consume a plugin UI sandbox guest's user-gesture token once */
  PluginSandboxConsumeUserGesture: "zcode:plugin-sandbox-consume-user-gesture",
  /** renderer -> main: query own webContents id as the sandbox registration owner */
  PluginSandboxOwnerWebContentsId: "zcode:plugin-sandbox-owner-web-contents-id",
  /** Open the native directory picker */
  SelectDirectory: "zcode:select-directory",
  /** Open the native file picker */
  SelectFile: "zcode:select-file",
  /** Open the native multi-file picker */
  SelectFiles: "zcode:select-files",
  /** Renderer -> main: write a temporary text attachment under host ~/.zcode */
  CreateTempTextAttachment: "zcode:create-temp-text-attachment",
  /** Renderer -> main: materialize a dwf artifact version to a local copy (open as file) */
  MaterializeWorkflowArtifactFile: "zcode:materialize-workflow-artifact-file",
  /** Renderer -> main: save a file via the native save-as dialog */
  SaveFile: "zcode:save-file",
  /** Renderer -> main: export the page's print layout to PDF via the Chromium print pipeline */
  PrintToPdf: "zcode:print-to-pdf",
  /** main -> renderer: forward remote-connection progress logs */
  RemoteConnectionLog: "zcode:remote-connection-log",
  /** main -> renderer: remote workspace session closed */
  RemoteSessionClosed: "zcode:remote-session-closed",
  /** main -> renderer: bot-triggered remote workspace reconnect succeeded */
  BotRemoteWorkspaceReconnected: "zcode:bot-remote-workspace-reconnected",
  /** If the directory is already open in another window, activate that window */
  ActivateOrSetWorkspace: "zcode:activate-or-set-workspace",
  /** Establish an SSH remote connection */
  ConnectRemote: "zcode:connect-remote",
  /** Cancel the in-flight remote connection for this window */
  CancelPendingRemoteConnection: "zcode:cancel-pending-remote-connection",
  /** Renderer -> main: bind the canonical workspace context of a remote logical session */
  BindRemoteWorkspaceSessionContext: "zcode:bind-remote-workspace-session-context",
  /** Enable web remote control for the current workspace */
  StartWebRemoteControl: "zcode:start-web-remote-control",
  ResetWebRemoteControlPairing: "zcode:reset-web-remote-control-pairing",
  /** Disable web remote control for this window */
  StopWebRemoteControl: "zcode:stop-web-remote-control",
  /** Query the web remote control state of this window */
  GetWebRemoteControlStatus: "zcode:get-web-remote-control-status",
  /** main -> renderer: web remote control state changed for this window */
  WebRemoteControlStatusChanged: "zcode:web-remote-control-status-changed",
  /** Release a remote session held by this window */
  DisposeRemoteSession: "zcode:dispose-remote-session",
  /** Renderer -> main: check whether the local Docker daemon is available */
  IsDockerAvailable: "zcode:is-docker-available",
  /** Renderer -> main: list available local WSL distros */
  ListWSLDistros: "zcode:list-wsl-distros",
  /** Renderer -> main: list connectable Docker containers */
  ListDockerContainers: "zcode:list-docker-containers",
  /** Renderer -> main: list SSH config aliases usable for quick-fill forms */
  ListSSHConfigAliases: "zcode:list-ssh-config-aliases",
  /** Renderer -> main: load the CLI MCP config from the user directory */
  LoadMcpFromUserDirectory: "zcode:load-mcp-from-user-directory",
  /** Renderer -> main: save the CLI MCP config to the user directory */
  SaveMcpToUserDirectory: "zcode:save-mcp-to-user-directory",
  /** Renderer -> main: query close-to-tray capability (Linux disable state; spec: docs/desktop/linux-close-to-tray.md) */
  GetCloseToTrayCapability: "zcode:get-close-to-tray-capability",
  /** Renderer logs forwarded to main for unified storage */
  Log: "zcode:log",
  /** Renderer -> main: sync workspace paths of all tabs in this window */
  SyncWindowTabs: "zcode:sync-window-tabs",
  /** Renderer -> main: sync workspaces switchable via web remote control in this window */
  SyncWebRemoteControlWorkspaces: "zcode:sync-web-remote-control-workspaces",
  /** Renderer -> main: sync task snapshots shown via web remote control in this window */
  SyncWebRemoteControlTasks: "zcode:sync-web-remote-control-tasks",
  /** main -> renderer: phone requests reconnect to a remote workspace in this window */
  WebRemoteControlReconnectWorkspace: "zcode:web-remote-control-reconnect-workspace",
  /** Renderer -> main: sync this window's unread task count */
  SyncWindowUnreadCount: "zcode:sync-window-unread-count",
  /** Renderer -> main: active task of this window; updates main's transient focus map only. */
  SyncActiveTaskSession: "zcode:sync-active-task-session",
  /** Renderer -> main: sync app settings main must know immediately */
  SyncAppSettings: "zcode:sync-app-settings",
  /** Renderer -> main: shortcut recording toggle; true = main temporarily detaches configurable menu accelerators */
  SetShortcutRecordingActive: "zcode:set-shortcut-recording-active",
  /** main -> renderer: focus the tab for the given workspace path */
  FocusTab: "zcode:focus-tab",
  /** main -> renderer: menu requested a new tab */
  NewTab: "zcode:new-tab",
  /** main -> renderer: menu/shortcut requested closing the current context */
  CloseActiveContextRequest: "zcode:close-active-context-request",
  /** main -> renderer: embedded webview requested a new browser tab */
  OpenBrowserUrl: "zcode:open-browser-url",
  /** main -> renderer: embedded-browser permission/screen-share-source/device picker request */
  EmbeddedBrowserPermissionPrompt: "zcode:embedded-browser-permission-prompt",
  /** Renderer -> main: user decision for an embedded-browser permission prompt */
  EmbeddedBrowserPermissionResolve: "zcode:embedded-browser-permission-resolve",
  /** main -> renderer: agent's first browser command created the managed view; open a browser-use tab automatically */
  BrowserViewReady: "zcode:browser-view-ready",
  /** main -> renderer: agent is driving a browser-use tab; show a transient status icon */
  BrowserViewOperation: "zcode:browser-view-operation",
  /** main -> renderer: browser visibility capability shows/hides the IAB side panel */
  BrowserViewVisibility: "zcode:browser-view-visibility",
  /** main -> renderer: agent set/reset the target tab viewport */
  BrowserViewViewportChanged: "zcode:browser-view-viewport-changed",
  /** main -> renderer: ask the owner renderer to prepare an offscreen guest compositing surface before capture. */
  BrowserViewScreenshotSurfacePrepare: "zcode:browser-view-screenshot-surface-prepare",
  /** Renderer -> main: target viewport stable across two consecutive animation frames. */
  BrowserViewScreenshotSurfaceReady: "zcode:browser-view-screenshot-surface-ready",
  /** main -> renderer: capture finished or prep failed; release the temporary offscreen compositing layer. */
  BrowserViewScreenshotSurfaceRelease: "zcode:browser-view-screenshot-surface-release",
  /** main -> renderer: agent close detached the managed guest; unload the matching tab */
  BrowserViewCloseTab: "zcode:browser-view-close-tab",
  /** main -> renderer: budget eviction unloaded the guest; the logical tab shell remains. */
  BrowserViewSuspend: "zcode:browser-view-suspend",
  /** main -> renderer: remount the guest for a suspended shell. */
  BrowserViewRestore: "zcode:browser-view-restore",
  /** main -> renderer: menu requested a new task */
  NewTask: "zcode:new-task",
  /** main -> renderer: menu requested opening a workspace */
  OpenWorkspace: "zcode:open-workspace",
  /** main -> renderer: deep link opens the given local workspace directory */
  OpenWorkspacePath: "zcode:open-workspace-path",
  /** main -> renderer: open the built-in feedback dialog */
  OpenFeedbackDialog: "zcode:open-feedback-dialog",
  /** main -> renderer: open my-tickets panel */
  OpenTicketsPanel: "zcode:open-tickets-panel",
  /** main -> renderer: window fullscreen state changed */
  WindowFullscreenChanged: "zcode:window-fullscreen-changed",
  /** Renderer -> main: read window maximized state and native rounded-corner capability */
  GetDesktopWindowChromeState: "zcode:get-desktop-window-chrome-state",
  /** main -> renderer: maximized state or native rounded-corner capability changed */
  DesktopWindowChromeStateChanged: "zcode:desktop-window-chrome-state-changed",
  /** main -> renderer: native window-control inset changed */
  WindowControlsOverlayChanged: "zcode:window-controls-overlay-changed",
  /** Preload -> main: preload read this window's control inset synchronously */
  WindowControlsOverlayReady: "zcode:window-controls-overlay-ready",
  /** Resource-manager snapshot (CPU/memory, grouped by core service, built-in plugin, community plugin) */
  GetResourceUsageSnapshot: "zcode:get-resource-usage-snapshot",
  SetResourceUsageSamplingActive: "zcode:set-resource-usage-sampling-active",
  GetNetworkCaptureSnapshot: "zcode:get-network-capture-snapshot",
  ClearNetworkCapture: "zcode:clear-network-capture",
  /** Open a resource-manager window (triggered from another window) */
  OpenResourceManager: "zcode:open-resource-manager",
  /** Resource manager Storage tab: start scanning local .zcode usage (main owns StorageService; worker thread walks) */
  StorageStartScan: "zcode:storage-start-scan",
  /** Resource manager Storage tab: cancel scan */
  StorageCancelScan: "zcode:storage-cancel-scan",
  /** Resource manager Storage tab: read the latest snapshot */
  StorageGetSnapshot: "zcode:storage-get-snapshot",
  /** Resource manager Storage tab: clean by category */
  StorageClean: "zcode:storage-clean",
  /** Resource manager Storage tab: reveal a data-root path in the system file manager */
  StorageRevealPath: "zcode:storage-reveal-path",
  /** main -> resource-manager renderer: scan progress snapshot push */
  StorageScanProgress: "zcode:storage-scan-progress",
  /** Renderer -> main: open an external URL (OAuth browser hand-off) */
  OpenExternal: "zcode:open-external",
  /** Renderer -> main: whether a community entry exists for the current locale */
  CanOpenCommunity: "zcode:can-open-community",
  /** Renderer -> main: reveal a path in the system file manager */
  OpenInFileManager: "zcode:open-in-file-manager",
  /** Renderer -> main: open a local file with the default app */
  OpenExternalFile: "zcode:open-external-file",
  /** Renderer -> main: open ZCode Computer Use permission onboarding */
  OpenCuaPermissionOnboarding: "zcode:open-cua-permission-onboarding",
  /** Renderer -> main: cancel a permission-onboarding participant started by this renderer */
  CancelCuaPermissionOnboarding: "zcode:cancel-cua-permission-onboarding",
  /**
   * Renderer -> main: warm and cache the verified Helper path + bundle fingerprint.
   * Must be called when the drag overlay mounts -- no async I/O allowed on the dragstart path.
   */
  PrepareCuaHelperPermissionDrag: "zcode:prepare-cua-helper-permission-drag",
  /** Renderer -> main: synchronously drag the verified Helper.app into the macOS permission list */
  StartCuaHelperPermissionDrag: "zcode:start-cua-helper-permission-drag",
  /**
   * Renderer -> main: drag gesture ended.
   * Once the drag lands, grant is complete and the overlay must yield (the user needs the settings
   * page and the OS restart prompt). Wait for dragend instead of collapsing on dragstart:
   * startDrag just hands the session to the OS, non-blocking; vanishing early can abort the drag.
   */
  NotifyCuaHelperPermissionDragEnded: "zcode:notify-cua-helper-permission-drag-ended",
  /** Renderer -> main: report OAuth state for deep-link routing */
  OAuthRegisterState: "zcode:oauth-register-state",
  /** main -> renderer: forward deep link URL */
  OAuthCallback: "zcode:oauth-callback",
  /** main -> renderer: forward payment deep link URL */
  PaymentCallback: "zcode:payment-callback",
  /** main -> renderer: external share page requests share-code import. */
  ShareImport: "zcode:share-import",
  /** Renderer -> main: OAuth callback handled; deferred startup may proceed */
  OAuthCallbackHandled: "zcode:oauth-callback-handled",
  /** Renderer -> main: renderer ready to receive cached deep links */
  RendererReady: "zcode:renderer-ready",
  /** Renderer -> main: sync this renderer's telemetry context */
  SyncTelemetryContext: "zcode:sync-telemetry-context",
  /** Renderer -> main: report a business event via the unified telemetry layer */
  ReportTelemetryEvent: "zcode:report-telemetry-event",
  /** Renderer -> main: report an ARMS custom event */
  ReportArmsCustomEvent: "zcode:report-arms-custom-event",
  /** Renderer -> main: read the renderer interaction-trace rollout config. */
  GetRendererActionTraceConfig: "zcode:get-renderer-action-trace-config",
  /** main -> renderer: renderer interaction-trace rollout config changed. */
  RendererActionTraceConfigChanged: "zcode:renderer-action-trace-config-changed",
  /** Renderer -> main: send a finished ui_action batch. */
  ReportRendererActionTraceBatch: "zcode:report-renderer-action-trace-batch",
  /** Renderer -> main: main-window heap reading every 60s; one-way send, no ack. */
  ReportRendererHeapSample: "zcode:report-renderer-heap-sample",
  ReportLocalTtftBatch: "zcode:report-local-ttft-batch",
  /** E2E preload -> main: read the in-memory ring of final sendCustom args. */
  ReadFinalArmsCustomEventsE2E: "zcode:e2e:read-final-arms-custom-events",
  /** E2E preload -> main: clear the in-memory ring of final sendCustom args. */
  ClearFinalArmsCustomEventsE2E: "zcode:e2e:clear-final-arms-custom-events",
  /** E2E preload -> main: configure real-network suppression scoped to the given event name. */
  ConfigureFinalArmsCustomEventsE2E: "zcode:e2e:configure-final-arms-custom-events",
  /** Renderer -> main: fire the native task completed/failed notification */
  ShowTaskNotification: "zcode:show-task-notification",
  /** main -> preload: tell renderer to play the task notification sound */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** main -> preload: user clicked the system notification; taskId routes renderer to that task */
  TaskNotificationClick: "zcode:task-notification-click",
  /** Renderer -> main: export logs (zip ~/.zcode/v2 plus external agent logs, reveal in Finder) */
  ExportLogs: "zcode:export-logs",
  /** Renderer -> main: capture this window as a feedback attachment */
  CaptureWindowScreenshot: "zcode:capture-window-screenshot",
  /**
   * Renderer -> main: after `<webview>` guest dom-ready, report the webContentsId;
   * main attaches the guest via BrowserGuestManager (fire-and-forget). CDP-on-guest pivot.
   */
  BrowserViewAttachGuest: "zcode:browser-view-attach-guest",
  /** Renderer -> main: detach CDP from the old guest before rebuilding the `<webview>`. */
  BrowserViewDetachGuest: "zcode:browser-view-detach-guest",
  /** Renderer -> main: user closed a Browser tab explicitly. */
  BrowserViewCloseTabFromRenderer: "zcode:browser-view-close-tab-from-renderer",
  /** Renderer -> main: report Browser tab residency/display facts. */
  BrowserViewReportResidency: "zcode:browser-view-report-residency",
  /** Renderer -> main: guest of the given generation unloaded. */
  BrowserViewSuspendReady: "zcode:browser-view-suspend-ready",
  /** Renderer -> main: user hit a suspended tab; request restore. */
  BrowserViewEnsureResident: "zcode:browser-view-ensure-resident",
  /** Renderer -> main: read persisted logical shells for workspace/task. */
  BrowserViewRestoreTabs: "zcode:browser-view-restore-tabs",
  /** Renderer -> main: write back the target guest viewport after free-size drag/toggle */
  BrowserViewUpdateViewport: "zcode:browser-view-update-viewport",
  /** Embedded Browser preload -> main: synchronously request a trusted native dialog before the page dialog opens. */
  EmbeddedBrowserJavaScriptDialog: "zcode:embedded-browser-javascript-dialog",
  /** Renderer -> main: one-shot import of auto-detected local Chrome profile data into the embedded-browser partition. */
  ImportChromeBrowserData: "zcode:import-chrome-browser-data",
  /** Renderer -> main: clear embedded-browser cache or all site data. */
  ClearEmbeddedBrowserData: "zcode:clear-embedded-browser-data",
  /** Renderer -> main: read embedded-browser per-site permissions (settings, Site Permissions) */
  GetEmbeddedBrowserSitePermissions: "zcode:get-embedded-browser-site-permissions",
  /** Renderer -> main: upsert/delete one site permission (state="ask" deletes) */
  SetEmbeddedBrowserSitePermission: "zcode:set-embedded-browser-site-permission",
  /** Renderer -> main: clear all site permission records */
  ClearEmbeddedBrowserSitePermissions: "zcode:clear-embedded-browser-site-permissions",
  /** Renderer -> main: reset all permissions for one site (Site Permissions settings, Reset) */
  ResetEmbeddedBrowserSitePermission: "zcode:reset-embedded-browser-site-permission",
  /** main -> renderer: new version fully downloaded; ready to restart and install */
  UpdateReady: "zcode:update-ready",
  /** main -> renderer: result after a manual check-for-updates click (for the toast) */
  UpdateCheckResult: "zcode:update-check-result",
  /** main -> renderer: auto-update ongoing state changed (menu UI) */
  UpdateStateChanged: "zcode:update-state-changed",
  /** Renderer -> main: pull current auto-update state (compensates missed events on menu open) */
  GetUpdateState: "zcode:get-update-state",
  /** Renderer -> main: start downloading the discovered update */
  DownloadUpdate: "zcode:download-update",
  /** Renderer -> main: cancel the in-flight update download */
  CancelUpdateDownload: "zcode:cancel-update-download",
  /** Renderer -> main: open the dedicated auto-update window */
  OpenUpdateStatusWindow: "zcode:open-update-status-window",
  /** Renderer -> main: read auto-update preferences */
  GetAutoUpdatePreferences: "zcode:get-auto-update-preferences",
  /** Renderer -> main: write the auto-download-and-install preference */
  SetAutoDownloadAndInstallUpdates: "zcode:set-auto-download-and-install-updates",
  /** Renderer -> main: count running desktop sessions */
  GetDesktopSessionActivity: "zcode:get-desktop-session-activity",
  /** Renderer -> main: read this window's zoom level */
  GetDesktopZoomLevel: "zcode:get-desktop-zoom-level",
  /** main -> renderer: this window's zoom level changed */
  DesktopZoomLevelChanged: "zcode:desktop-zoom-level-changed",
  /** Renderer -> main: read the dev stdio tap proxy toggle state */
  GetZCodeStdioTapDevState: "zcode:get-zcode-stdio-tap-dev-state",
  /** main -> renderer: local setting.json updated by the main process */
  SettingsChanged: "zcode:settings-changed",
  /** main -> renderer: app language switched */
  ApplicationLocaleChanged: "zcode:application-locale-changed",
  /** Renderer -> main: read the host system locale */
  GetSystemLocale: "zcode:get-system-locale",
  /** main -> renderer: release notes for the installed update */
  PostUpdateReleaseNotes: "zcode:post-update-release-notes",
  /** Renderer -> main: acknowledge release notes as read */
  AcknowledgePostUpdateReleaseNotes: "zcode:ack-post-update-release-notes",
  /** Renderer -> main: skip the currently discovered update version */
  SkipUpdateVersion: "zcode:skip-update-version",
  /** Renderer -> main: user confirmed restart-to-install */
  QuitAndInstallUpdate: "zcode:quit-and-install-update",
  /** Renderer -> main: list installed editors/terminals (with icons) */
  GetInstalledEditors: "zcode:get-installed-editors",
  /** Renderer -> main: get a system app icon by bundle id */
  GetApplicationIcon: "zcode:get-application-icon",
  /** Renderer -> main: open a path in the given editor */
  OpenInEditor: "zcode:open-in-editor",
  /** Renderer -> main: run a desktop window-level command */
  ExecuteDesktopCommand: "zcode:execute-desktop-command",
  /** Renderer -> main: sync app-menu locale for native menu rebuild */
  SetApplicationLocale: "zcode:set-application-locale",
  /** Renderer -> main: sync titlebar light/dark for native window control styling */
  SetTitleBarTheme: "zcode:set-title-bar-theme",
  /** Renderer -> main: migrate legacy Common MCP config */
  MigrateLegacyCommonMcp: "zcode:migrate-legacy-common-mcp",
  /** Renderer -> main: get the stable device identifier (deviceMid) */
  GetDeviceId: "zcode:get-device-id",
} as const;

export type PlatformChannelName = (typeof PlatformChannels)[keyof typeof PlatformChannels];

// ============================================================================
// Embedded WebView channels -- fixed guest preload <-> embedder renderer
// ============================================================================

/** `sendToHost` / `ipc-message` channels of the Electron `<webview>`; bypasses the main process. */
export const EmbeddedBrowserWebviewChannels = {
  /** When the guest exhausts scrolling in a direction, hand the 2D delta to the free-size canvas. */
  WheelBoundary: "zcode:embedded-browser-wheel-boundary",
} as const;

export interface EmbeddedBrowserWheelBoundaryPayload {
  deltaX: number;
  deltaY: number;
}

// ============================================================================
// Coding Plan WebView channels -- website preload <-> app renderer
// ============================================================================

/**
 * `sendToHost` / `ipc-message` channels of the Electron `<webview>` (partition=persist:zcode-coding-plan).
 * Invoked from the website via the preload-injected window.zcodeBridge; bypasses the main process.
 */
export const CodingPlanWebviewChannels = {
  /** After a successful website purchase, tell the app to refresh entitlements and close the webview. */
  PurchaseComplete: "zcode:coding-plan-purchase-complete",
} as const;

/**
 * main -> guest-preload channel for the plugin UI sandbox guest (partition=plugin-sandbox:<id>).
 * preload only forwards the MessagePort pair to the trusted shell via window.postMessage; no contextBridge API exposed.
 */
export const PluginSandboxChannels = {
  /** main -> guest: { sandboxId, initId, names } + port1[]; shell derives the host ports from it */
  Init: "zcode:plugin-sandbox-init",
} as const;

/** Purchase-completion payload; provider mirrors the website CodingPlanProvider / auth-ready detail.provider. */
export interface CodingPlanPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
  /** Client timestamp for app-side dedup/logging; not part of equality. */
  timestamp: number;
}

/**
 * Value of the website's window.__zcodeLang__; matches the app IntlProvider locale.
 * On app locale change the app rewrites it via executeJavaScript and dispatches lang-change.
 */
export type CodingPlanWebviewLocale = "zh-CN" | "en-US";

/**
 * Detail of the website lang-change event. The app dispatches a
 * `zcode-coding-plan-lang-change` CustomEvent in the main world via executeJavaScript;
 * the website side (zcodeBridge.onLangChange or plain addEventListener) subscribes and swaps copy.
 */
export interface CodingPlanWebviewLangChangeDetail {
  locale: CodingPlanWebviewLocale;
}

// ============================================================================
// Internal transport channels -- framework-level messaging
// ============================================================================
/** Internal transport channels for framework-level messaging such as MessagePort forwarding. */
export const InternalChannels = {
  DatabaseStartupState: "zcode:database-startup-state",
  DatabaseStartupControl: "zcode:database-startup-control",
  /** main -> renderer: forward a MessagePort (via webContents.postMessage) */
  ServicePort: "zcode:service-port",
  /** main -> renderer: forward the window Host's scoped MessagePort */
  ScopedServicePort: "zcode:scoped-service-port",
  /** renderer -> main: scoped MessagePort registered; attachment switches are now safe */
  ScopedServicePortReady: "zcode:scoped-service-port-ready",
  /** preload -> renderer: main confirmed the notification; renderer may play the sound */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** main -> host renderer: plugin UI sandbox MessagePort pair (port2[]), payload { sandboxId, initId, names } */
  PluginSandboxPorts: "zcode:plugin-sandbox-ports",
} as const;

/** @deprecated `/ws` ignores this header; kept for legacy-client compatibility. */
export const ZCODE_RPC_CLIENT_MODE_HEADER = "x-zcode-rpc-client-mode";
/** Requested via a protected HTTP endpoint first, then consumed once during the `/ws/host` handshake. */
export const ZCODE_RPC_HOST_CAPABILITY_HEADER = "x-zcode-rpc-host-capability";

// ============================================================================
// Inter-process message types -- postMessage between main and the host process
// ============================================================================

/** main -> host process initialization message types */
export const HostMessageTypes = {
  DatabaseStartupControl: "database-startup-control",
  /** Initialize local services */
  InitLocal: "init-local",
  /** main -> window Host: establish a remote logical session in this window */
  ConnectRemoteWorkspace: "connect-remote-workspace",
  /** main -> window Host: cancel a pending remote connection */
  CancelRemoteWorkspaceConnect: "cancel-remote-workspace-connect",
  /** main -> window Host: bind the canonical workspace identity of a logical session */
  BindRemoteWorkspaceContext: "bind-remote-workspace-context",
  /** main -> window Host: release a remote logical session */
  DisposeRemoteWorkspaceSession: "dispose-remote-workspace-session",
  /** main -> host: reuse existing services and expose them on a new RPC MessagePort */
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
  /** main -> host: bot remote-workspace connection-state query result */
  BotRemoteWorkspaceConnectionStatusResult: "bot-remote-workspace-connection-status-result",
  /** main -> host: bot remote-workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePort: "bot-remote-workspace-runtime-port",
  /** main -> host: deliver a session message to a target session owned by this host */
  SessionMessageDeliver: "session-message-deliver",
  /** main -> host: write a session-message delivery result back to the source session */
  SessionMessageDeliveryResult: "session-message-delivery-result",
  /** main -> host: feedback log-archive creation result */
  FeedbackLogArchiveResult: "feedback-log-archive-result",
  /** main -> host: scheduled-task due dispatch; in-session cron reuses targetTaskId, legacy unbound tasks create a session */
  CronRun: "cron-run",
  /** main -> host: off-peak dispatch; first run createTask makes a session, reruns resume with conversationId/sessionId */
  OffPeakRun: "off-peak-run",
  /** main -> host: browser-use command result (returned after CDP run; correlated by requestId) */
  BrowserExecuteResult: "browser-execute-result",
  /** main -> host: local-video canonical-path grant result */
  LocalMediaPreviewPathAuthorizeResult: "local-media-preview-path-authorize-result",
  /** main -> host: plugin UI sandbox registration result (PluginSandboxRegisterResultPayload) */
  PluginSandboxRegisterResult: "plugin-sandbox-register-result",
  /** main -> host: producer focus fact derived from the global foreground ZCode window. */
  CuaPipFocusChanged: "cua-pip-focus-changed",
  /** main -> host: force the Host to re-read the local source and sync the given remote environment. */
  ProviderProvisioningExecute: "provider-provisioning-execute",
  /** main -> host: resource manager asks the Host to sample CPU/memory of descendant processes (agent/MCP/terminal) */
  ResourceUsageSnapshotRequest: "resource-usage-snapshot-request",
  ResourceUsageSnapshotCancel: "resource-usage-snapshot-cancel",
  NetworkCapture: "network-capture",
} as const;

/** host process -> main process feedback message types */
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
  /** A new agent child process spawned inside the host */
  AgentProcessSpawned: "agent-process-spawned",
  /** An agent runtime passed the model-execution gate for the first time inside the host */
  AgentProcessReady: "agent-process-ready",
  /** An agent child process inside the host exited */
  AgentProcessExited: "agent-process-exited",
  /** An agent child process inside the host failed to start */
  AgentProcessError: "agent-process-error",
  AgentProcessException: "agent-process-exception",
  /** host -> main: self-sampled CPU/RSS inside the CLI process */
  AgentResourceSample: "agent-resource-sample",
  /** host -> main: host self-sample of CPU/RSS/heap every 60s (heap source for the host role in resource telemetry) */
  HostResourceSample: "host-resource-sample",
  /** host -> main: MCP process lifecycle and memory telemetry inside the CLI */
  McpTelemetry: "mcp-telemetry",
  McpResourceSamples: "mcp-resource-samples",
  ToolExecResource: "tool-exec-resource",
  /** Automation host reports a newly created session after the first accepted input. */
  SessionCreateTelemetry: "session-create-telemetry",
  /** host -> main: resource-manager sampling result (correlated by requestId) */
  ResourceUsageSnapshotResult: "resource-usage-snapshot-result",
  NetworkCaptureBatch: "network-capture-batch",
  /** Count of agent sessions currently executing a prompt inside the host changed */
  AgentRunningTaskCountChanged: "agent-running-task-count-changed",
  /** Count of not-yet-terminal tasks for a workspace inside the host changed */
  WorkspaceRunningTaskCountChanged: "workspace-running-task-count-changed",
  /** host -> main: operation-hint state of a Windows desktop-local CUA turn */
  CuaOperationState: "cua-operation-state",
  /** host -> main: workspace generation is now safe to attach */
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
  /** host -> main: owner returns a task command result */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** host -> main: bot requests a remote workspace session */
  BotRemoteWorkspaceReconnectRequest: "bot-remote-workspace-reconnect-request",
  /** host -> main: bot asks whether this window already has a remote workspace session */
  BotRemoteWorkspaceConnectionStatusRequest: "bot-remote-workspace-connection-status-request",
  /** host -> main: bot requests the remote workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePortRequest: "bot-remote-workspace-runtime-port-request",
  /** host -> main: agent asks to send a message to another session */
  SessionMessageSendRequested: "session-message-send-requested",
  /** host -> main: declare that a ZCode Agent session is currently owned by this host */
  SessionRouteAnnounce: "session-route-announce",
  /** host -> main: the target host finished local session-message delivery */
  SessionMessageDeliverResult: "session-message-deliver-result",
  /** host -> main: ask main to reuse the export-logs path to create a feedback log archive */
  FeedbackLogArchiveRequest: "feedback-log-archive-request",
  /** host -> main: scheduled dispatch result (success fills taskId/sessionId; failure carries transient/permanent) */
  CronRunResult: "cron-run-result",
  /** host -> main: off-peak dispatch result (success fills conversationId/sessionId; failure carries transient/permanent) */
  OffPeakRunResult: "off-peak-run-result",
  /** host -> main: manual run persisted; wake the scheduler now to claim and dispatch */
  CronSchedulerWakeRequest: "cron-scheduler-wake-request",
  /** host -> main: an off-peak task became schedulable; wake the scheduler now (independent of cron messages) */
  OffPeakSchedulerWakeRequest: "off-peak-scheduler-wake-request",
  /** host -> main: run a browser-use command (main executes via WebContentsView+CDP; correlated by requestId) */
  BrowserExecuteRequest: "browser-execute-request",
  /** host -> main: request a grant for a local video path already validated by the agent */
  LocalMediaPreviewPathAuthorizeRequest: "local-media-preview-path-authorize-request",
  /** host -> main: register validated plugin UI HTML/CSP in exchange for a sandbox handle (PluginSandboxRegisterRequestPayload) */
  PluginSandboxRegisterRequest: "plugin-sandbox-register-request",
  /** host -> main: RPC network telemetry batch (per channel.command success rate/latency) */
  NetworkTelemetryBatch: "network-telemetry-batch",
  /** host -> main: local provisioning source persisted successfully. */
  ProviderProvisioningSourceChanged: "provider-provisioning-source-changed",
  /** host -> main: one remote-environment sync finished. */
  ProviderProvisioningExecutionResult: "provider-provisioning-execution-result",
} as const;

// ============================================================================
// Platform channel type maps -- request/response type safety
// ============================================================================

/** Request/response type maps for platform channels */
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
  [PlatformChannels.MaterializeWorkflowArtifactFile]: {
    request: MaterializeWorkflowArtifactFileRequest;
    response: MaterializeWorkflowArtifactFileResult;
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
  [PlatformChannels.StartWebRemoteControl]: {
    request: WebRemoteControlContext;
    response: WebRemoteControlStartOperationResult;
  };
  [PlatformChannels.ResetWebRemoteControlPairing]: {
    request: WebRemoteControlContext;
    response: WebRemoteControlStartOperationResult;
  };
  [PlatformChannels.StopWebRemoteControl]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetWebRemoteControlStatus]: {
    request: void;
    response: WebRemoteControlStatus;
  };
  [PlatformChannels.WebRemoteControlStatusChanged]: {
    request: WebRemoteControlStatus;
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
  [PlatformChannels.SyncWebRemoteControlWorkspaces]: {
    request: WebRemoteControlWorkspaceTarget[];
    response: void;
  };
  [PlatformChannels.SyncWebRemoteControlTasks]: {
    request: WebRemoteControlTaskTarget[];
    response: void;
  };
  [PlatformChannels.WebRemoteControlReconnectWorkspace]: {
    request: WebRemoteControlReconnectWorkspaceRequest;
    response: WebRemoteControlReconnectWorkspaceResult;
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
  [PlatformChannels.EmbeddedBrowserPermissionPrompt]: {
    request: EmbeddedBrowserPermissionPromptEvent;
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserPermissionResolve]: {
    request: EmbeddedBrowserPermissionResolveRequest;
    response: void;
  };
  [PlatformChannels.GetEmbeddedBrowserSitePermissions]: {
    request: void;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.SetEmbeddedBrowserSitePermission]: {
    request: EmbeddedBrowserSitePermissionUpdateRequest;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.ClearEmbeddedBrowserSitePermissions]: {
    request: void;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.ResetEmbeddedBrowserSitePermission]: {
    request: EmbeddedBrowserSitePermissionResetRequest;
    response: EmbeddedBrowserSitePermissionsSnapshot;
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
  // One-way send, not invoke: a side-channel telemetry sample every 60s; the renderer never waits on main.
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
  // CDP-on-guest pivot: the renderer `<webview>` reports the guest webContentsId and main attaches.
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
    // The return value passes through the main-process handler return (GetCuaOsSupport returns CuaOsSupport),
    // aligned with Promise<unknown> of IPlatformService.executeDesktopCommand on the renderer side.
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
