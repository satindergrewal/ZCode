import type {
  DesktopCommandId,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopTitleBarTheme,
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
  AppSettings,
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
  ChromeBrowserDataImportResult,
  DockerContainerInfo,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  EditorInfo,
  ApplicationIconInfo,
  ApplicationIconRequest,
  Locale,
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceTarget,
  OAuthStateRegistration,
  PostUpdateReleaseNotesPayload,
  RemoteConnectionRuntimeLog,
  RemoteSessionClosedEvent,
  BotRemoteWorkspaceReconnectedEvent,
  RemoteTarget,
  SSHConfigAliasOption,
  RendererTelemetryEventPayload,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  TelemetryRendererContext,
  TaskNotificationPayload,
  WindowScreenshotResult,
  EmbeddedBrowserDataClearResult,
  WSLDistro,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  OpenInEditorOptions,
} from "@zcode/shared";

/**
 * window.zcode typings - platform operations that need the main process only.
 *
 * Credential management moved to ICredentialService (over RPC) and no longer passes through here.
 */
declare global {
  interface Window {
    /** Plugin UI sandbox preload namespace; undefined under legacy preloads. */
    zcodePluginSandbox?: {
      supportsRetainedMove?: boolean;
      copyImage?(
        input: import("@zcode/shared/mcp-apps").PluginSandboxCaptureRequest,
      ): Promise<void>;
      getOwnerWebContentsId(): Promise<number>;
      disposeSandbox(sandboxId: string, initId?: number): Promise<void>;
      consumeUserGesture(sandboxId: string): Promise<boolean>;
    };
    zcode: {
      connectRemote(
        options: RemoteTarget,
        requestId?: string,
        context?: {
          workspacePath: string;
          workspaceIdentity?: string;
          connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
        },
      ): Promise<{ success: boolean; error?: string; sessionId?: string }>;
      /** Cancel the current window's still-pending remote connection */
      cancelPendingRemoteConnection?(requestId?: string): Promise<void>;
      /** Bind the canonical workspace context of a remote logical session */
      bindRemoteWorkspaceSessionContext?(context: {
        remoteSessionId: string;
        workspacePath: string;
        workspaceIdentity?: string;
      }): Promise<BrowserGuestAttachResult>;
      /** Enable Web remote control for the current workspace */
      startWebRemoteControl(
        context: WebRemoteControlContext,
      ): Promise<WebRemoteControlStartOperationResult>;
      /** Clear old pairing material and regenerate the Web remote control QR code */
      refreshWebRemoteControlPairing(
        context: WebRemoteControlContext,
      ): Promise<WebRemoteControlStartOperationResult>;
      /** Stop Web remote control for the current window */
      stopWebRemoteControl(): Promise<void>;
      /** Query the current window's Web remote control state */
      getWebRemoteControlStatus(): Promise<WebRemoteControlStatus>;
      /** Subscribe to Web remote control state changes for this window */
      onWebRemoteControlStatusChanged?(
        handler: (status: WebRemoteControlStatus) => void,
      ): () => void;
      /** Dispose the remote session in this window */
      disposeRemoteSession(sessionId: string): Promise<void>;
      /** Check whether the local Docker daemon is usable */
      isDockerAvailable(): Promise<boolean>;
      /** List available WSL distros on this machine */
      listWSLDistros(): Promise<WSLDistro[]>;
      /** List connectable Docker containers */
      listDockerContainers(): Promise<DockerContainerInfo[]>;
      /** List SSH config aliases usable for quick form fill on this machine */
      listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;
      /** Forward renderer logs to the main process over IPC for unified storage */
      log(level: "info" | "warn" | "error", args: unknown[]): void;
      /** Open the system directory picker; returns the path or null */
      selectDirectory(): Promise<string | null>;
      /** Open the system file picker; returns the path or null */
      selectFile(): Promise<string | null>;
      /** Open the multi-file picker; returns paths, or an empty array when cancelled */
      selectFiles?(): Promise<string[]>;
      /** Save a file via the native save-as dialog */
      saveFile?(
        payload: import("@zcode/shared").SaveFileRequest,
      ): Promise<import("@zcode/shared").SaveFileResult>;
      /** Export the page's print layout to PDF (Chromium print engine, vector text) */
      printPageToPdf?(): Promise<import("@zcode/shared").PrintPageToPdfResult>;
      /** Resolve the real local path from a drag-dropped/input Web File */
      getPathForFile?(file: File): string | null;
      /** dwf artifact open-as-file: persist a version's bytes locally and return the path */
      materializeWorkflowArtifactFile(
        payload: import("@zcode/shared").MaterializeWorkflowArtifactFileRequest,
      ): Promise<import("@zcode/shared").MaterializeWorkflowArtifactFileResult>;
      /** Subscribe to this window's remote connection progress logs; returns a disposer */
      onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;
      /** Subscribe to remote workspace session close events; returns a disposer */
      onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;
      /** Subscribe to bot-triggered remote workspace reconnect events; returns a disposer */
      onBotRemoteWorkspaceReconnected(
        handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
      ): () => void;
      /** Check whether the directory is open in another window */
      activateOrSetWorkspace?(path: string): Promise<{ activated: boolean }>;
      /** Sync all tab workspace paths in this window to the main process */
      syncWindowTabs(paths: string[]): void;
      /** Sync the workspaces Web remote control may switch to in this window */
      syncWebRemoteControlWorkspaces?(workspaces: WebRemoteControlWorkspaceTarget[]): void;
      /** Sync the task snapshots Web remote control may show in this window */
      syncWebRemoteControlTasks?(tasks: WebRemoteControlTaskTarget[]): void;
      /** Register the callback for phone-requested workspace reconnects */
      onWebRemoteControlReconnectWorkspace?(
        handler: (
          request: WebRemoteControlReconnectWorkspaceRequest,
        ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
      ): () => void;
      /** Sync this window's unread task count to the main process */
      syncWindowUnreadCount(count: number): void;
      syncActiveTaskSession(sessionId: string | null): void;
      /** Sync app settings the main process must know immediately */
      syncAppSettings?(patch: Partial<AppSettings>): void;
      /** Query close-to-tray capability (Linux greying; spec: docs/desktop/linux-close-to-tray.md) */
      getCloseToTrayCapability?(): Promise<import("@zcode/shared").DesktopCloseToTrayCapability>;
      /** Register the focus-workspace-tab callback from main; returns a disposer */
      onFocusTab(handler: (path: string) => void): () => void;
      /** Register the new-tab callback from main; returns a disposer */
      onNewTab(handler: () => void): () => void;
      /** Register the built-in browser new-page callback; returns a disposer */
      onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
      /** Register built-in browser permission/origin/device picker requests; returns a disposer */
      onEmbeddedBrowserPermissionPrompt?(
        handler: (event: EmbeddedBrowserPermissionPromptEvent) => void,
      ): () => void;
      /** Report the user's decision on a built-in browser permission prompt */
      resolveEmbeddedBrowserPermissionPrompt?(
        request: EmbeddedBrowserPermissionResolveRequest,
      ): void;
      /** Read built-in browser site permissions (Settings > Site permissions) */
      getEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
      /** Update or delete one site permission entry */
      setEmbeddedBrowserSitePermission?(
        request: EmbeddedBrowserSitePermissionUpdateRequest,
      ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
      /** Clear all site permission records */
      clearEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
      /** Reset all records for one site */
      resetEmbeddedBrowserSitePermission?(
        request: EmbeddedBrowserSitePermissionResetRequest,
      ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
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
      onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;
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
      onBrowserViewViewportChanged?(
        handler: (payload: BrowserViewViewportChangedPayload) => void,
      ): () => void;
      onBrowserViewScreenshotSurfacePrepare?(
        handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
      ): () => void;
      onBrowserViewScreenshotSurfaceRelease?(
        handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
      ): () => void;
      browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;
      onBrowserViewCloseTab?(
        handler: (payload: BrowserViewCloseTabNotification) => void,
      ): () => void;
      onBrowserViewSuspend?(
        handler: (payload: BrowserViewResidencyTransitionPayload) => void,
      ): () => void;
      onBrowserViewRestore?(
        handler: (payload: BrowserViewResidencyTransitionPayload) => void,
      ): () => void;
      /** Register the new-task callback from main; returns a disposer */
      onNewTask(handler: () => void): () => void;
      /** Register the open-workspace callback from main; returns a disposer */
      onOpenWorkspace?(handler: () => void): () => void;
      /** Register the deep-link open-local-workspace callback from main; returns a disposer */
      onOpenWorkspacePath?(handler: (path: string) => void): () => void;
      /** Register the window fullscreen-change callback; returns a disposer */
      onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;
      /** Read maximized state and native rounded-corner capability */
      getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;
      /** Subscribe to maximized-state and rounded-corner changes */
      onDesktopWindowChromeStateChanged?(
        handler: (state: DesktopWindowChromeState) => void,
      ): () => void;
      /** Read the desktop window's page zoom level */
      getDesktopZoomLevel?(): Promise<DesktopZoomState>;
      /** Subscribe to desktop window zoom changes */
      onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;
      /** Register the notification-click to-task callback; returns a disposer */
      onTaskNotificationClick(handler: (taskId: string) => void): () => void;
      /** Open an external URL */
      openExternal(url: string): void;
      /** Whether a community entry exists for the current language */
      canOpenCommunity(locale: Locale): Promise<boolean>;
      /** Reveal the path in the system file manager */
      openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open a local file with its default app */
      openExternalFile(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open the ZCode Computer Use full-permission guide */
      openCuaPermissionOnboarding?(
        options?: OpenCuaPermissionOnboardingOptions,
      ): Promise<CuaAccessibilitySettingsResult>;
      /** Cancel only this renderer's onboarding participant for the operationId. */
      cancelCuaPermissionOnboarding?(operationId: string): void;
      /** Warm and cache the verified helper path so dragstart can startDrag synchronously */
      prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
      /** Drag Helper.app from the permission sheet into macOS settings */
      startCuaHelperPermissionDrag?(): void;
      /** Report OAuth state for deep-link routing */
      registerOAuthState(payload: OAuthStateRegistration): void;
      /** Register the OAuth deep-link callback; returns a disposer */
      onOAuthCallback(cb: (url: string) => void): () => void;
      /** Register the payment deep-link callback; returns a disposer */
      onPaymentCallback(cb: (url: string) => void): () => void;
      /** Tell the main process this renderer is ready */
      notifyRendererReady(): void;
      /** Sync this renderer's telemetry context to the main process */
      syncTelemetryContext(context: TelemetryRendererContext): void;
      /** Report business telemetry events via the main process */
      reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;
      /** Read the Desktop renderer user-action trace rollout config. */
      getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
      /** Subscribe to renderer user-action trace rollout changes. */
      onRendererActionTraceConfigChanged?(
        callback: (config: RendererActionTraceConfigV1) => void,
      ): () => void;
      /** Send a finished ui_action batch; Main returns no business result. */
      reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
      /** Main window renderer's 60s heap reading; fire-and-forget, no ack. */
      reportRendererHeapSample?(sample: RendererHeapSample): void;
      /** Fire the system notification for a task state */
      showTaskNotification(payload: TaskNotificationPayload): void;
      /** Export logs: zip ~/.zcode/v2 plus external agent logs and reveal in Finder */
      exportLogs(): Promise<{
        success: boolean;
        path?: string;
        error?: string;
      }>;
      /** Capture this window for error feedback context */
      captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;
      browserViewAttachGuest?(payload: {
        key: string;
        webContentsId: number;
        active?: boolean;
        workspaceKey?: string;
        remoteSessionId?: string;
        sessionId?: string;
        residencyGeneration?: number;
      }): Promise<void>;
      /** Have main precisely detach the old guest's CDP before rebuilding the webview. */
      browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;
      browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;
      browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;
      browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewRestoreTabs?(
        payload: BrowserViewRestoreTabsRequest,
      ): Promise<BrowserViewRestoredTabShell[]>;
      /** Report free-size resize back to main. */
      browserViewUpdateViewport?(payload: {
        tabId: string;
        viewport: BrowserViewportSize | null;
      }): Promise<void>;
      /** One-shot import of discovered Chrome profile data into the built-in browser. */
      importChromeBrowserData?(
        options?: import("@zcode/shared").ChromeBrowserDataImportOptions,
      ): Promise<ChromeBrowserDataImportResult>;
      /** Clear built-in browser cache or all site data. */
      clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;
      /** Register the update-downloaded callback; returns a disposer */
      onUpdateReady(callback: (version: string) => void): () => void;
      /** Register the manual check-for-updates result callback; returns a disposer */
      onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;
      /** Subscribe to auto-update ongoing state; returns a disposer */
      onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;
      /** Read the current auto-update state */
      getUpdateState?(): Promise<UpdateStatePayload>;
      /** Start downloading the discovered update */
      downloadUpdate?(): Promise<void>;
      /** Cancel the in-flight update download */
      cancelUpdateDownload?(): Promise<void>;
      /** Open or focus the dedicated update window */
      openUpdateStatusWindow?(): Promise<void>;
      /** Read auto-update preferences */
      getAutoUpdatePreferences?(): Promise<{
        autoDownloadAndInstallUpdates: boolean;
      }>;
      /** Write the auto-download-and-install preference */
      setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;
      /** Skip the currently discovered version */
      skipUpdateVersion?(version: string): Promise<void>;
      /** Subscribe to app language changes; returns a disposer */
      onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;
      /** Subscribe to main-process settings-change notifications */
      onSettingsChanged?(callback: () => void): () => void;
      /** Query the desktop's running session count */
      getDesktopSessionActivity?(): Promise<{
        runningAgentSessionCount: number;
      }>;
      /** Register post-update release notes; returns a disposer */
      onPostUpdateReleaseNotes(
        callback: (payload: PostUpdateReleaseNotesPayload) => void,
      ): () => void;
      /** Mark current release notes as read */
      acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;
      /** User confirmed restart-to-install */
      quitAndInstallUpdate(): Promise<void>;
      /** List installed editors/terminals with icons */
      getInstalledEditors(): Promise<EditorInfo[]>;
      /** Get an app icon by bundle id or structured locator */
      getApplicationIcon?(
        request: string | ApplicationIconRequest,
      ): Promise<ApplicationIconInfo | null>;
      /** Open the path in the given editor */
      openInEditor(
        editorId: string,
        path: string,
        options?: OpenInEditorOptions,
      ): Promise<{ success: boolean; error?: string }>;
      /** Run a desktop window-level command */
      executeDesktopCommand(command: DesktopCommandId): Promise<void>;
      /** Sync the app menu language */
      setApplicationLocale(locale: Locale): Promise<void>;
      /** Read the OS language */
      getSystemLocale?(): Promise<Locale>;
      /** Sync titlebar light/dark mode */
      setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;
    };
  }
}
