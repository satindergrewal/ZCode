/* eslint-disable max-lines -- remote connections, OAuth callbacks, telemetry, and notification IPC share window context; central registration prevents state drift. */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import armsRum from "@arms/rum-electron";
import {
  armsCustomEventPayloadSchema,
  buildRemoteWorkspaceConnectResultTelemetry,
  classifyRemoteUsageError,
  formatZodError,
  normalizeUnknownError,
  InternalChannels,
  isTrustedCodingPlanWebviewOrigin,
  resolveZaiBusinessBaseUrl,
  PlatformChannels,
  remoteTargetSchema,
  rendererTelemetryEventPayloadSchema,
  type ArmsRumEnv,
  type RemoteTarget,
  type TelemetryEventPayload,
} from "@zcode/shared";
import { dispatchTaskNotification } from "./desktopNotifications.js";
import {
  clearOAuthRoutesForWindow,
  deliverPendingDeepLink,
  parseOAuthStateRegistration,
  registerOAuthState,
} from "./desktopOAuthDeepLink.js";
import {
  dispatchFinalArmsCustomEvent,
  enableSharedFinalArmsCustomEventE2EController,
} from "./desktopArmsCustomEvent.js";
import {
  configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms,
  type RemoteConnectionStats,
} from "./desktopRemoteUsageArmsTelemetry.js";
import { openPathInDefaultApp } from "./desktopMainIpcHelpers.js";

function isAllowedExternalOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

interface OpenExternalRequest {
  sourceUrl?: string;
  url: string;
}

function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  if (typeof payload === "string") {
    return { url: payload };
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    url: record.url,
  };
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    return (
      ["https://api.z.ai", resolveZaiBusinessBaseUrl()].includes(parsed.origin) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

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

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function shouldKeepCodingPlanOpenExternalInWebview(currentUrl: string, targetUrl: string): boolean {
  return (
    (isCodingPlanWebviewUrl(currentUrl) || isCodingPlanPaypalNavigationUrl(currentUrl)) &&
    isAllowedCodingPlanEmbeddedNavigationUrl(targetUrl)
  );
}

export function registerRemoteIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  appTelemetryRuntime: {
    onRendererReady(payload: { hasPendingOAuthCallback: boolean; rendererId: number }): void;
    syncRendererContext(payload: { rendererId: number; context: unknown }): void;
    onOAuthCallbackHandled(payload: { rendererId: number }): void;
  };
  /* /** Post-OAuth side effects (e.g. ARMS user.id refresh); never disturbs the existing runtime flow */
  onOAuthCallbackHandledSideEffect?: () => void;
  appTelemetryCore: {
    reportEvent(payload: unknown): Promise<void>;
  };
  reportRemoteUsageEvent: (rendererId: number, event: TelemetryEventPayload) => void;
  armsCustomContext: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
  };
  /* /** Opens only behind both gates: VITE_ZCODE_E2E_STORE_BRIDGE and the test runner. */
  finalArmsCustomEventE2EEnabled?: boolean;
  createRemoteWorkspaceSession: (
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: { workspacePath: string; workspaceIdentity?: string },
    lifecycle?: { remoteUsageTelemetryEligible?: boolean },
  ) => Promise<string>;
  getRemoteConnectionStats: () => RemoteConnectionStats;
  disposeRemoteWorkspaceSession: (
    sessionId: string,
    reason: string,
    signalGracePeriodMs?: number,
  ) => void;
  cancelPendingRemoteWorkspaceSessionsForWindow: (
    wcId: number,
    reason: string,
    requestId?: string,
  ) => void;
  bindRemoteWorkspaceSessionContext: (
    sessionId: string,
    context: { workspacePath: string; workspaceIdentity?: string },
    expectedWebContentsId?: number,
  ) => Promise<void>;
  confirmRendererAttachmentReady: (
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ) => void;
  isDockerDaemonAvailable: () => Promise<boolean>;
  listAvailableWSLDistros: () => Promise<unknown[]>;
  listAvailableDockerContainers: () => Promise<unknown[]>;
  listSSHConfigAliases: () => Promise<unknown[]>;
}) {
  function reportRemoteUsageEvent(rendererId: number, event: TelemetryEventPayload): void {
    try {
      options.reportRemoteUsageEvent(rendererId, event);
    } catch (error) {
      // // Telemetry is side-channel; never rewrite a successful connection as a business failure.
      options.logger.warn("[remote-usage-telemetry] dispatch failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  const finalArmsCustomEventE2E = options.finalArmsCustomEventE2EEnabled
    ? enableSharedFinalArmsCustomEventE2EController()
    : null;

  configureRemoteUsageArmsTelemetry({
    armsCustomContext: options.armsCustomContext,
    getRemoteConnectionStats: options.getRemoteConnectionStats,
    sendCustom: (payload) =>
      armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
    e2eController: finalArmsCustomEventE2E,
    logger: options.logger,
  });

  function reportRemoteConnectResultToArmsSafely(
    params: Parameters<typeof reportRemoteConnectResultToArms>[0],
  ): void {
    try {
      reportRemoteConnectResultToArms(params);
    } catch (error) {
      options.logger.warn("[remote-usage-arms] connect result reporter failed", { error });
    }
  }

  ipcMain.on(InternalChannels.ScopedServicePortReady, (event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as { sessionId?: unknown; attachmentId?: unknown };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const attachmentId =
      typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
    if (!sessionId || !attachmentId) return;
    options.confirmRendererAttachmentReady(event.sender.id, { sessionId, attachmentId });
  });
  if (finalArmsCustomEventE2E) {
    ipcMain.handle(PlatformChannels.ReadFinalArmsCustomEventsE2E, () =>
      finalArmsCustomEventE2E.read(),
    );
    ipcMain.handle(PlatformChannels.ClearFinalArmsCustomEventsE2E, () => {
      finalArmsCustomEventE2E.clear();
    });
    ipcMain.handle(
      PlatformChannels.ConfigureFinalArmsCustomEventsE2E,
      (_event, request: unknown) => {
        finalArmsCustomEventE2E.configure(
          request as Parameters<typeof finalArmsCustomEventE2E.configure>[0],
        );
      },
    );
  }

  ipcMain.on(PlatformChannels.OAuthRegisterState, (event, payload: unknown) => {
    const registration = parseOAuthStateRegistration(payload);
    if (!registration) {
      options.logger.warn("[oauth-register-state] invalid payload", payload);
      return;
    }

    registerOAuthState(event.sender.id, registration);
  });

  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    if (!isAllowedExternalOpenUrl(url)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    const sender = event.sender;
    const senderUrl = typeof sender?.getURL === "function" ? sender.getURL() : "";
    const senderFrameUrl =
      typeof event.senderFrame?.url === "string" ? event.senderFrame.url : undefined;
    const sourceUrl = senderFrameUrl ?? request.sourceUrl ?? senderUrl;
    if (
      typeof sender?.loadURL === "function" &&
      shouldKeepCodingPlanOpenExternalInWebview(sourceUrl, url)
    ) {
      // The storefront bridge's openExternal bypasses webview navigation guards;
      // the trusted post-authorize callback must return to this webview, not the system browser.
      void sender.loadURL(url).catch((error: unknown) => {
        options.logger.warn("[open-external] failed to load coding-plan callback in webview", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return;
    }
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] failed to open external URL", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );

  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    const hasPendingOAuthCallback = deliverPendingDeepLink(event.sender);
    options.appTelemetryRuntime.onRendererReady({
      hasPendingOAuthCallback,
      rendererId: event.sender.id,
    });
  });

  ipcMain.on(PlatformChannels.SyncTelemetryContext, (event, context) => {
    options.appTelemetryRuntime.syncRendererContext({
      rendererId: event.sender.id,
      context,
    });
  });

  ipcMain.handle(PlatformChannels.ReportTelemetryEvent, async (_event, payload: unknown) => {
    const result = rendererTelemetryEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-telemetry-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    await options.appTelemetryCore.reportEvent(result.data);
  });

  ipcMain.handle(PlatformChannels.ReportArmsCustomEvent, async (event, payload: unknown) => {
    const result = armsCustomEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-arms-custom-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    try {
      dispatchFinalArmsCustomEvent({
        payload: result.data,
        context: {
          ...options.armsCustomContext,
          rendererId: event.sender.id,
        },
        e2eController: finalArmsCustomEventE2E,
        // FinalArmsCustomEventPayload narrows the SDK's RumCustomEvent; the SDK also demands
        // a BaseObject index signature, though we never add undeclared fields dynamically.
        sendCustom: (payload) =>
          armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
      });
    } catch (error) {
      options.logger.warn(
        "[report-arms-custom-event] sendCustom failed:",
        normalizeUnknownError(error).message,
      );
    }
  });

  ipcMain.on(PlatformChannels.OAuthCallbackHandled, (event) => {
    options.appTelemetryRuntime.onOAuthCallbackHandled({ rendererId: event.sender.id });
    options.onOAuthCallbackHandledSideEffect?.();
  });

  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );

  app.on("browser-window-created", (_, win) => {
    const windowWebContentsId = win.webContents.id;
    win.on("closed", () => {
      // During BrowserWindow closed, Electron may already have released webContents.
      // Reading win.webContents.id directly turned normal closes into uncaught main exceptions.
      // Cache the id before cleanup so destroyed objects are never touched.
      clearOAuthRoutesForWindow(windowWebContentsId);
    });
  });

  ipcMain.handle(PlatformChannels.ConnectRemote, async (event, rawPayload: unknown) => {
    const wrappedPayload: {
      target: unknown;
      requestId?: unknown;
      workspacePath?: unknown;
      workspaceIdentity?: unknown;
      connectTrigger?: unknown;
    } =
      rawPayload && typeof rawPayload === "object" && "target" in rawPayload
        ? (rawPayload as {
            target: unknown;
            requestId?: unknown;
            workspacePath?: unknown;
            workspaceIdentity?: unknown;
            connectTrigger?: unknown;
          })
        : { target: rawPayload, requestId: undefined };
    const result = remoteTargetSchema.safeParse(wrappedPayload.target);
    if (!result.success) {
      const error = `Invalid connect-remote payload: ${formatZodError(result.error)}`;
      options.logger.warn("[connect-remote]", error);
      return { success: false, error };
    }
    const requestId =
      typeof wrappedPayload.requestId === "string" && wrappedPayload.requestId.trim().length > 0
        ? wrappedPayload.requestId.trim()
        : undefined;
    const workspacePath =
      typeof wrappedPayload.workspacePath === "string" &&
      wrappedPayload.workspacePath.trim().length > 0
        ? wrappedPayload.workspacePath
        : undefined;
    const workspaceIdentity =
      typeof wrappedPayload.workspaceIdentity === "string" &&
      wrappedPayload.workspaceIdentity.trim().length > 0
        ? wrappedPayload.workspaceIdentity
        : undefined;
    const connectTriggerValue = wrappedPayload.connectTrigger;
    const connectTrigger =
      connectTriggerValue === "reconnect" || connectTriggerValue === "restore"
        ? connectTriggerValue
        : "new";

    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error("No current window; cannot create a remote session");
      }

      const sessionId = await options.createRemoteWorkspaceSession(
        win,
        result.data,
        requestId,
        workspacePath ? { workspacePath, workspaceIdentity } : undefined,
        { remoteUsageTelemetryEligible: true },
      );
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "success",
          remoteKind: result.data.kind,
          connectTrigger,
        }),
      );
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "success",
        remoteKind: result.data.kind,
        connectTrigger,
      });
      return { success: true, sessionId };
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      const errorCategory = classifyRemoteUsageError(error);
      // Errors handed to the logger used to JSON.stringify into {} on disk.
      // Spread message/code/stack explicitly so connection failures keep real context in main logs.
      options.logger.error("[connect-remote] caught error:", {
        message: normalizedError.message,
        code: normalizedError.code,
        stack: error instanceof Error ? error.stack : undefined,
      });
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "failure",
          remoteKind: result.data.kind,
          connectTrigger,
          errorCategory,
        }),
      );
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "failure",
        remoteKind: result.data.kind,
        connectTrigger,
        errorCategory,
      });
      return { success: false, error: normalizedError.message };
    }
  });

  ipcMain.handle(
    PlatformChannels.CancelPendingRemoteConnection,
    async (event, rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === "object" ? (rawPayload as { requestId?: unknown }) : {};
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim().length > 0
          ? payload.requestId.trim()
          : undefined;
      // Before a sessionId exists the renderer could not precisely cancel an in-flight connection.
      // Cancel by requestId first, sparing concurrent connections in the same window;
      // fall back to by-window cancel for legacy callers.
      options.cancelPendingRemoteWorkspaceSessionsForWindow(
        event.sender.id,
        `cancel-pending-remote-connection:${event.sender.id}`,
        requestId,
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    async (event, rawPayload: unknown) => {
      if (!rawPayload || typeof rawPayload !== "object") {
        throw new Error("Invalid remote workspace context payload");
      }
      const payload = rawPayload as {
        remoteSessionId?: unknown;
        workspacePath?: unknown;
        workspaceIdentity?: unknown;
      };
      const remoteSessionId =
        typeof payload.remoteSessionId === "string" ? payload.remoteSessionId.trim() : "";
      const workspacePath = typeof payload.workspacePath === "string" ? payload.workspacePath : "";
      const workspaceIdentity =
        typeof payload.workspaceIdentity === "string" ? payload.workspaceIdentity.trim() : "";
      if (!remoteSessionId || !workspacePath.trim()) {
        throw new Error("Remote workspace context missing sessionId or workspacePath");
      }
      await options.bindRemoteWorkspaceSessionContext(
        remoteSessionId,
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
        event.sender.id,
      );
    },
  );

  ipcMain.handle(PlatformChannels.DisposeRemoteSession, async (_event, sessionId: string) => {
    options.disposeRemoteWorkspaceSession(sessionId, `dispose-remote-session:${sessionId}`, 150);
  });

  ipcMain.handle(PlatformChannels.IsDockerAvailable, async () => {
    try {
      return await options.isDockerDaemonAvailable();
    } catch (error) {
      options.logger.warn("[is-docker-available] detect failed:", error);
      return false;
    }
  });

  ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
    try {
      return await options.listAvailableWSLDistros();
    } catch (error) {
      options.logger.warn("[list-wsl-distros] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListDockerContainers, async () => {
    try {
      return await options.listAvailableDockerContainers();
    } catch (error) {
      options.logger.warn("[list-docker-containers] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListSSHConfigAliases, async () => {
    try {
      return await options.listSSHConfigAliases();
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // Serialized Errors collapse to {}, hiding which SSH pattern failed.
      // Spread error fields, keeping the empty-list UI contract while exposing the root cause in logs.
      options.logger.warn("[list-ssh-config-aliases] detect failed:", {
        message: normalizedError.message,
        code: normalizedError.code,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  });
}
