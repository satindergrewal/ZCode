import { BrowserWindow, ipcMain } from "electron";
import type { WebContents } from "electron";
import {
  buildWebRemoteControlStartResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  PlatformChannels,
  type TelemetryEventPayload,
  type WebRemoteControlContext,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
} from "@zcode/shared";
import type { WebRemoteControlStartAuthorization } from "./webRemoteControlManager.js";

export interface WebRemoteControlIpcManager {
  authorizeStart: (
    windowId: number,
    context: WebRemoteControlContext,
  ) => WebRemoteControlStartAuthorization;
  startAuthorized: (
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ) => Promise<WebRemoteControlStartResult>;
  resetPairingAuthorized: (
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ) => Promise<WebRemoteControlStartResult>;
  stop(windowId: number): Promise<void>;
  getStatus(windowId: number): WebRemoteControlStatus;
}

interface WebRemoteControlIpcDependencies {
  reportRemoteUsageEvent: (rendererId: number, event: TelemetryEventPayload) => void;
  webRemoteControlManager: WebRemoteControlIpcManager;
}

function reportRemoteUsageEventSafely(
  reportRemoteUsageEvent: WebRemoteControlIpcDependencies["reportRemoteUsageEvent"],
  rendererId: number,
  event: TelemetryEventPayload,
): void {
  try {
    reportRemoteUsageEvent(rendererId, event);
  } catch {
    // Regression root cause: the telemetry callback used to live inside the business operation's
    // try; a callback throw misjudged an already-successful start as failed and could even
    // overwrite the real business error. Telemetry is a side-channel — swallow exceptions here
    // and preserve the operation's original outcome.
  }
}

function resolveWorkspaceKind(context: WebRemoteControlContext): "local" | "remote" {
  return context.workspaceIdentity?.trim() || context.remoteSessionId?.trim() ? "remote" : "local";
}

async function runStartOperation(input: {
  context: WebRemoteControlContext;
  sender: WebContents;
  missingWindowMessage: string;
  operation: (windowId: number) => Promise<WebRemoteControlStartResult>;
  reportRemoteUsageEvent: WebRemoteControlIpcDependencies["reportRemoteUsageEvent"];
}): Promise<WebRemoteControlStartResult> {
  const workspaceKind = resolveWorkspaceKind(input.context);
  const remoteKind = input.context.workspaceIdentity
    ? parseRemoteWorkspaceIdentity(input.context.workspaceIdentity)?.kind
    : undefined;
  const rendererId = input.sender.id;
  try {
    const win = BrowserWindow.fromWebContents(input.sender);
    if (!win) {
      throw new Error(input.missingWindowMessage);
    }
    // Interaction boundary: the remote-control panel and QR refresh are already explicit user
    // actions; main only validates the window and binds the target, without stacking a native
    // confirm dialog (which would mean two confirmations per action).
    const response = await input.operation(win.id);
    reportRemoteUsageEventSafely(
      input.reportRemoteUsageEvent,
      rendererId,
      buildWebRemoteControlStartResultTelemetry({
        result: "success",
        workspaceKind,
        remoteKind,
      }),
    );
    return response;
  } catch (error) {
    reportRemoteUsageEventSafely(
      input.reportRemoteUsageEvent,
      rendererId,
      buildWebRemoteControlStartResultTelemetry({
        result: "failure",
        workspaceKind,
        remoteKind,
        errorCategory: classifyRemoteUsageError(error),
      }),
    );
    throw error;
  }
}

export function registerWebRemoteControlIpcHandlers(
  dependencies: WebRemoteControlIpcDependencies,
): void {
  ipcMain.handle(
    PlatformChannels.StartWebRemoteControl,
    async (event, context: WebRemoteControlContext) =>
      runStartOperation({
        context,
        sender: event.sender,
        missingWindowMessage: "Current window not found; cannot start web remote control",
        operation: (windowId) => {
          const manager = dependencies.webRemoteControlManager;
          const authorization = manager.authorizeStart(windowId, context);
          return manager.startAuthorized(windowId, context, authorization);
        },
        reportRemoteUsageEvent: dependencies.reportRemoteUsageEvent,
      }),
  );

  ipcMain.handle(
    PlatformChannels.ResetWebRemoteControlPairing,
    async (event, context: WebRemoteControlContext) =>
      runStartOperation({
        context,
        sender: event.sender,
        missingWindowMessage:
          "Current window not found; cannot refresh the web remote-control QR code",
        operation: (windowId) => {
          const manager = dependencies.webRemoteControlManager;
          const authorization = manager.authorizeStart(windowId, context);
          return manager.resetPairingAuthorized(windowId, context, authorization);
        },
        reportRemoteUsageEvent: dependencies.reportRemoteUsageEvent,
      }),
  );

  ipcMain.handle(PlatformChannels.StopWebRemoteControl, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      await dependencies.webRemoteControlManager.stop(win.id);
    }
  });

  ipcMain.handle(PlatformChannels.GetWebRemoteControlStatus, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win
      ? dependencies.webRemoteControlManager.getStatus(win.id)
      : { status: "idle" as const };
  });
}
