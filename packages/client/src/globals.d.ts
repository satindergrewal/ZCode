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
  EditorInfo,
  ApplicationIconInfo,
  ApplicationIconRequest,
  Locale,
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
 * window.zcode type definitions -- platform operations that need the main process.
 *
 * Credential management moved to ICredentialService (over RPC) and no longer goes through this interface.
 */
declare global {
  interface Window {
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
      /** Cancel a remote connection not yet established for the current window */
      cancelPendingRemoteConnection?(requestId?: string): Promise<void>;
      /** Bind the canonical workspace context of a remote logical session */
      bindRemoteWorkspaceSessionContext?(context: {
        remoteSessionId: string;
        workspacePath: string;
        workspaceIdentity?: string;
      }): Promise<BrowserGuestAttachResult>;
      /** Dispose the remote session held in the current window */
      disposeRemoteSession(sessionId: string): Promise<void>;
      /** Check whether the local Docker daemon is available */
      isDockerAvailable(): Promise<boolean>;
      /** List WSL distros available on this machine */
      listWSLDistros(): Promise<WSLDistro[]>;
      /** List Docker containers available for connecting */
      listDockerContainers(): Promise<DockerContainerInfo[]>;
      /** List SSH config aliases usable for quick form fill */
      listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;
      /** Forward renderer logs over IPC to the main process for unified storage */
      log(level: "info" | "warn" | "error", args: unknown[]): void;
      /** Open the system directory picker; resolves to the selected path or null */
      selectDirectory(): Promise<string | null>;
      /** Open the system file picker; resolves to the selected file path or null */
      selectFile(): Promise<string | null>;
      /** Open the multi-file picker; resolves to selected paths, or [] when canceled */
      selectFiles?(): Promise<string[]>;
      /** Save a file via the native save-as dialog */
      saveFile?(
        payload: import("@zcode/shared").SaveFileRequest,
      ): Promise<import("@zcode/shared").SaveFileResult>;
      /** Export the page's print layout as PDF (Chromium print engine, vector text) */
      printPageToPdf?(): Promise<import("@zcode/shared").PrintPageToPdfResult>;
      /** Resolve the local path of a Web File obtained via drag-and-drop or file input */
      getPathForFile?(file: File): string | null;
      /** Subscribe to remote-connection progress logs in this window; returns a disposer */
      onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;
      /** Subscribe to remote workspace session closed events; returns a disposer */
      onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;
      /** Subscribe to bot-triggered remote workspace reconnection success; returns a disposer */
      onBotRemoteWorkspaceReconnected(
        handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
      ): () => void;
      /** Check whether the directory is already open in another window */
      activateOrSetWorkspace?(path: string): Promise<{ activated: boolean }>;
      /** Sync the workspace paths of all tabs in this window to the main process */
      syncWindowTabs(paths: string[]): void;
      /** Sync this window's unread task count to the main process */
      syncWindowUnreadCount(count: number): void;
      syncActiveTaskSession(sessionId: string | null): void;
      /** Sync app settings the main process must learn immediately */
      syncAppSettings?(patch: Partial<AppSettings>): void;
      /** Register the callback for the main process focusing a workspace tab; returns a disposer */
      onFocusTab(handler: (path: string) => void): () => void;
      /** Register the callback for the main process triggering a new tab; returns a disposer */
      onNewTab(handler: () => void): () => void;
      /** Register the callback for the embedded browser webview requesting a new page; returns a disposer */
      onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
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
      /** Register the callback for the main process triggering a new task; returns a disposer */
      onNewTask(handler: () => void): () => void;
      /** Register the callback for the main process opening the workspace; returns a disposer */
      onOpenWorkspace?(handler: () => void): () => void;
      /** Register the callback for the main process opening a local workspace dir via deep link; returns a disposer */
      onOpenWorkspacePath?(handler: (path: string) => void): () => void;
      /** Register the window fullscreen-change callback; returns a disposer */
      onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;
      /** Read window maximized state and native rounded-corner capability */
      getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;
      /** Subscribe to window maximized state and native rounded-corner changes */
      onDesktopWindowChromeStateChanged?(
        handler: (state: DesktopWindowChromeState) => void,
      ): () => void;
      /** Read the desktop window page zoom level */
      getDesktopZoomLevel?(): Promise<DesktopZoomState>;
      /** Subscribe to desktop window page zoom level changes */
      onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;
      /** Register the callback for jumping to a task after its system notification is clicked; returns a disposer */
      onTaskNotificationClick(handler: (taskId: string) => void): () => void;
      /** Open an external URL */
      openExternal(url: string): void;
      /** Check whether a community entry exists for the current language */
      canOpenCommunity(locale: Locale): Promise<boolean>;
      /** Open the given path in the system file manager */
      openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open a local file with the system default app */
      openExternalFile(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open the full ZCode Computer Use permission onboarding */
      openCuaPermissionOnboarding?(
        options?: OpenCuaPermissionOnboardingOptions,
      ): Promise<CuaAccessibilitySettingsResult>;
      /** Cancel only the onboarding participant started by this renderer with the given operationId. */
      cancelCuaPermissionOnboarding?(operationId: string): void;
      /** Warm and cache the verified helper path so dragstart can startDrag synchronously */
      prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
      /** Drag Helper.app into the macOS permission list from the permission popover */
      startCuaHelperPermissionDrag?(): void;
      /** Report an OAuth state for deep link routing */
      registerOAuthState(payload: OAuthStateRegistration): void;
      /** Register the OAuth deep link callback; returns a disposer */
      onOAuthCallback(cb: (url: string) => void): () => void;
      /** Register the payment deep link callback; returns a disposer */
      onPaymentCallback(cb: (url: string) => void): () => void;
      /** Tell the main process the renderer is ready */
      notifyRendererReady(): void;
      /** Sync this renderer's telemetry context to the main process */
      syncTelemetryContext(context: TelemetryRendererContext): void;
      /** Report product telemetry events via the main process */
      reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;
      /** Read the desktop renderer user-action trace rollout config. */
      getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
      /** Subscribe to desktop renderer user-action trace rollout config changes. */
      onRendererActionTraceConfigChanged?(
        callback: (config: RendererActionTraceConfigV1) => void,
      ): () => void;
      /** Send a finished ui_action batch; Main returns no business result. */
      reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
      /** 60-second heap reading of the main-window renderer; one-way send, no ack from Main. */
      reportRendererHeapSample?(sample: RendererHeapSample): void;
      /** Trigger the system notification for a task state change */
      showTaskNotification(payload: TaskNotificationPayload): void;
      /** Export logs: zip ~/.zcode/v2 plus external agent logs and reveal in Finder */
      exportLogs(): Promise<{
        success: boolean;
        path?: string;
        error?: string;
      }>;
      /** Capture the current window for error feedback attachments */
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
      /** Let main precisely detach the old guest's CDP before rebuilding `<webview>`. */
      browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;
      browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;
      browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;
      browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewRestoreTabs?(
        payload: BrowserViewRestoreTabsRequest,
      ): Promise<BrowserViewRestoredTabShell[]>;
      /** Renderer-reported free-form viewport size. */
      browserViewUpdateViewport?(payload: {
        tabId: string;
        viewport: BrowserViewportSize | null;
      }): Promise<void>;
      /** One-time import of embedded-browser data from an auto-discovered Chrome profile. */
      importChromeBrowserData?(
        options?: import("@zcode/shared").ChromeBrowserDataImportOptions,
      ): Promise<ChromeBrowserDataImportResult>;
      /** Clear embedded-browser cache or all site data. */
      clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;
      /** Register the new-version-downloaded callback; returns a disposer */
      onUpdateReady(callback: (version: string) => void): () => void;
      /** Register the "manual update check" result callback; returns a disposer */
      onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;
      /** Subscribe to auto-update progress state changes; returns a disposer */
      onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;
      /** Read the current auto-update state */
      getUpdateState?(): Promise<UpdateStatePayload>;
      /** Start downloading the discovered update */
      downloadUpdate?(): Promise<void>;
      /** Cancel the in-progress update download */
      cancelUpdateDownload?(): Promise<void>;
      /** Open or focus the dedicated update window */
      openUpdateStatusWindow?(): Promise<void>;
      /** Read auto-update preferences */
      getAutoUpdatePreferences?(): Promise<{
        autoDownloadAndInstallUpdates: boolean;
      }>;
      /** Write the "download and install updates automatically" preference */
      setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;
      /** Skip the discovered update version */
      skipUpdateVersion?(version: string): Promise<void>;
      /** Subscribe to application locale changes; returns a disposer */
      onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;
      /** Subscribe to main-process settings-change notifications */
      onSettingsChanged?(callback: () => void): () => void;
      /** Query the number of sessions running on the desktop */
      getDesktopSessionActivity?(): Promise<{
        runningAgentSessionCount: number;
      }>;
      /** Register post-update release notes; returns a disposer */
      onPostUpdateReleaseNotes(
        callback: (payload: PostUpdateReleaseNotesPayload) => void,
      ): () => void;
      /** Mark the current release notes as read */
      acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;
      /** Quit and install the update after user confirmation */
      quitAndInstallUpdate(): Promise<void>;
      /** List installed editors/terminals (with icons) */
      getInstalledEditors(): Promise<EditorInfo[]>;
      /** Get a system app icon by bundle id or structured locator */
      getApplicationIcon?(
        request: string | ApplicationIconRequest,
      ): Promise<ApplicationIconInfo | null>;
      /** Open a path with the given editor */
      openInEditor(
        editorId: string,
        path: string,
        options?: OpenInEditorOptions,
      ): Promise<{ success: boolean; error?: string }>;
      /** Run a desktop-window-level command */
      executeDesktopCommand(command: DesktopCommandId): Promise<void>;
      /** Sync the application menu language */
      setApplicationLocale(locale: Locale): Promise<void>;
      /** Read the host system locale */
      getSystemLocale?(): Promise<Locale>;
      /** Sync the title-bar light/dark theme */
      setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;
    };
  }
}
