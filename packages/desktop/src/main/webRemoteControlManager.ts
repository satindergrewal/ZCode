import type { RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- the web remote-control manager owns external relay app payload routing and workspace bridge orchestration. */
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { MessagePortProtocol, type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  buildWebRemoteControlExternalQrUrl,
  buildWebRemoteControlBridgeResultTelemetry,
  buildWebRemoteControlPairResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS,
  type ZCodeEndpointUrls,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlContext,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDeviceInfo,
  type WebRemoteControlMobileViewState,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlRpcTransportPayload,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridgeOpenPayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceTarget,
  type RemoteUsageRemoteKind,
  type TelemetryEventPayload,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
} from "@zcode/shared";
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportAuth,
  type WebRemoteControlDeviceTransportOptions,
  type WebRemoteControlDeviceTransportState,
} from "./webRemoteControlTransport.js";
import type { WebRemoteControlRelayAuthProvider } from "./webRemoteControlRelayAuthProvider.js";
import type { WebRemoteControlRelayAuthStorageProvider } from "./webRemoteControlRelayAuthStorageProvider.js";
import type { WebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";

interface WebRemoteControlHostAttachmentHandle {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

interface WorkspaceBridgeRuntime {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  hostEntryId: string;
  attachmentId: string;
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  hostProtocol?: MessagePortProtocol;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  disposeBridge?: () => void;
  readyAnnounced: boolean;
  degraded: boolean;
}

interface WebRemoteControlDeviceTransportLike {
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult?(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult;
  measurePayloadBytes?(payload: WebRemoteControlAppPayload): number;
  dispose(): void;
}

interface WebRemoteControlStartupRestoreContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartAuthorization {
  token: string;
  expiresAt: number;
  windowId: number;
  workspaceKey: string;
  remoteSessionId?: string;
}

const WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS = 30_000;

interface WindowControlRuntime {
  windowId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlContext["theme"];
  status: WebRemoteControlStatus["status"];
  error?: string;
  failure?: WebRemoteControlFailure;
  deviceSid: string;
  passHash: string;
  deviceMid: string;
  connectUrl: string;
  qrUrl: string;
  transport: WebRemoteControlDeviceTransportLike;
  mobileConnected: boolean;
  hasEverPaired: boolean;
  transportState?: WebRemoteControlDeviceTransportState;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  currentBridge?: WorkspaceBridgeRuntime;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileDisconnectGraceTimer?: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlManagerDependencies {
  getEndpointUrls?: () => Promise<ZCodeEndpointUrls> | ZCodeEndpointUrls;
  relayWsUrl: string;
  mobileRemoteControlUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  authProvider: WebRemoteControlRelayAuthProvider;
  authStorageProvider: WebRemoteControlRelayAuthStorageProvider;
  startupRestoreStorageProvider: {
    load(): Promise<WebRemoteControlStartupRestoreContext | undefined>;
    save(context: WebRemoteControlStartupRestoreContext): Promise<void>;
    clear(): Promise<void>;
  };
  featureGate: WebRemoteControlFeatureGate;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  platformHandlers: {
    [K in WebRemoteControlPlatformMethod]: (
      args: WebRemoteControlPlatformMethodArgsMap[K],
    ) => Promise<WebRemoteControlPlatformMethodResultMap[K]>;
  };
  reconnectWorkspace: (windowId: number, workspaceKey: string) => Promise<void>;
  reportRemoteUsageEvent?: (windowId: number, event: TelemetryEventPayload) => void;
  reportRendererTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  onStatusChanged?: (windowId: number, status: WebRemoteControlStatus) => void;
  attachWorkspaceHost: (
    windowId: number,
    context: WebRemoteControlContext & { kind: "local" | "remote" },
  ) => Promise<WebRemoteControlHostAttachmentHandle>;
  releaseWorkspaceHostAttachment: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  createDeviceTransport?: (
    options: WebRemoteControlDeviceTransportOptions,
  ) => WebRemoteControlDeviceTransportLike;
}

// Bugfix: the external relay's first authentication is subject to edge cold starts and network
// jitter; in practice it can slightly exceed 15s. Wait up to 30s here so a usable connection is
// not destroyed too early while the device is about to enter waiting_terminal.
const EXTERNAL_RELAY_QR_READY_TIMEOUT_MS = 30_000;
const MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000;

function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function mapWorkspaceBridgeFailureReason(error: unknown): WebRemoteControlFailureReason {
  switch (getErrorCode(error)) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
      return "unsupported-action";
    default:
      return "unexpected-error";
  }
}

function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

function getPathLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

function isBridgeableRemoteTarget(target: WebRemoteControlWorkspaceTarget): boolean {
  return target.kind !== "remote" || Boolean(target.workspaceIdentity && target.remoteSessionId);
}

function isBridgeableRemoteTask(task: WebRemoteControlTaskTarget): boolean {
  return task.workspaceKind !== "remote" || Boolean(task.workspaceIdentity && task.remoteSessionId);
}

function toExternalBridge(
  runtime: WorkspaceBridgeRuntime,
): WebRemoteControlExternalWorkspaceBridge {
  const base = {
    bridgeSessionId: runtime.bridgeSessionId,
    ...(runtime.bridgeGeneration !== undefined
      ? { bridgeGeneration: runtime.bridgeGeneration }
      : {}),
    ...(runtime.recoveryId ? { recoveryId: runtime.recoveryId } : {}),
    workspaceKey: runtime.workspaceKey,
    workspacePath: runtime.workspacePath,
    initialTaskId: runtime.initialTaskId,
  };

  if (runtime.kind === "remote") {
    if (!runtime.workspaceIdentity || !runtime.remoteSessionId) {
      throw new Error("Remote workspace bridge is missing workspaceIdentity or remoteSessionId.");
    }
    return {
      ...base,
      kind: "remote",
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
    };
  }

  return {
    ...base,
    kind: "local",
  };
}

async function resetExternalRelayDeviceAuth(
  authStorageProvider: WebRemoteControlRelayAuthStorageProvider,
  logger: WebRemoteControlManagerDependencies["logger"],
  reason: "manual" | "auth-failed" | "device-not-found" | "leaked-qr",
): Promise<void> {
  await authStorageProvider.clear();
  logger.info("[web-remote-control] external relay auth reset", { reason });
}

export function createWebRemoteControlManager(dependencies: WebRemoteControlManagerDependencies) {
  const runtimes = new Map<number, WindowControlRuntime>();
  const startAuthorizations = new Map<string, WebRemoteControlStartAuthorization>();
  const availableWorkspacesByWindowId = new Map<number, WebRemoteControlWorkspaceTarget[]>();

  function reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void {
    try {
      dependencies.reportRemoteUsageEvent?.(windowId, event);
    } catch (error) {
      // Telemetry is a side-channel; no exception here may alter the remote-control pairing or
      // bridge business outcome.
      dependencies.logger.warn("[web-remote-control] remote usage telemetry failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  function resolveRemoteKind(
    target: WebRemoteControlWorkspaceTarget,
    acquired?: WebRemoteControlHostAttachmentHandle,
  ): RemoteUsageRemoteKind | undefined {
    if (target.kind !== "remote") {
      return undefined;
    }
    return (
      acquired?.remoteKind ??
      (target.workspaceIdentity
        ? parseRemoteWorkspaceIdentity(target.workspaceIdentity)?.kind
        : undefined)
    );
  }

  function resolveRuntimeWorkspaceDimensions(runtime: WindowControlRuntime): {
    workspaceKind: "local" | "remote";
    remoteKind?: RemoteUsageRemoteKind;
  } {
    const remoteKind = runtime.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(runtime.workspaceIdentity)?.kind
      : undefined;
    return {
      workspaceKind:
        runtime.workspaceIdentity?.trim() || runtime.remoteSessionId ? "remote" : "local",
      remoteKind,
    };
  }
  const availableTasksByWindowId = new Map<number, WebRemoteControlTaskTarget[]>();
  const pushedWorkspaceListSignaturesByWindowId = new Map<number, string>();
  const startupRestoreContextPromise = dependencies.startupRestoreStorageProvider
    .load()
    .catch((error) => {
      dependencies.logger.warn("[web-remote-control] load startup restore context failed", error);
      return undefined;
    });
  let startupRestoreClaimed = false;

  function createTransport(options: WebRemoteControlDeviceTransportOptions) {
    return dependencies.createDeviceTransport
      ? dependencies.createDeviceTransport(options)
      : new WebRemoteControlDeviceTransport(options);
  }

  function clearStartAuthorizationsForWindow(windowId: number): void {
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.windowId === windowId) {
        startAuthorizations.delete(token);
      }
    }
  }

  function authorizeStart(
    windowId: number,
    context: WebRemoteControlContext,
  ): WebRemoteControlStartAuthorization {
    const now = Date.now();
    // Keep only the internal ticket from the most recent IPC dispatch per window, so stale
    // requests never coexist with the new workspace context.
    clearStartAuthorizationsForWindow(windowId);
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.expiresAt <= now) {
        startAuthorizations.delete(token);
      }
    }

    const authorization: WebRemoteControlStartAuthorization = {
      token: randomUUID(),
      expiresAt: now + WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS,
      windowId,
      workspaceKey: resolveWebRemoteControlWorkspaceKey(context),
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    };
    startAuthorizations.set(authorization.token, authorization);
    return authorization;
  }

  function consumeStartAuthorization(
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ): void {
    const stored = startAuthorizations.get(authorization.token);
    startAuthorizations.delete(authorization.token);
    if (!stored || stored !== authorization) {
      throw new Error("Web remote control authorization is invalid or already used");
    }
    if (stored.expiresAt <= Date.now()) {
      throw new Error("Web remote control authorization expired");
    }
    if (
      stored.windowId !== windowId ||
      stored.workspaceKey !== resolveWebRemoteControlWorkspaceKey(context) ||
      stored.remoteSessionId !== context.remoteSessionId
    ) {
      throw new Error("Web remote control authorization target mismatch");
    }
  }

  function disposeRuntimeBridgeResources(runtime: WindowControlRuntime): void {
    const bridge = runtime.currentBridge;
    if (!bridge) {
      return;
    }

    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    try {
      bridge.hostProtocol?.disconnect();
    } catch {
      // A dispose failure after MessagePortProtocol already closed must not affect the main flow.
    }
    if (bridge.attachmentId) {
      dependencies.releaseWorkspaceHostAttachment(bridge.attachmentId);
    }

    runtime.currentBridge = undefined;
  }

  function isCurrentBridgeRuntime(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
  ): boolean {
    return runtimes.get(runtime.windowId) === runtime && runtime.currentBridge === bridge;
  }

  function degradeBridgeAfterRawFault(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
    reasonCode: string,
  ): void {
    if (!isCurrentBridgeRuntime(runtime, bridge) || bridge.degraded) return;
    bridge.degraded = true;
    dependencies.logger.warn("[web-remote-control] raw relay bridge degraded", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    sendAppPayload(runtime, {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix: checksum/oversize/future-ACK faults must not masquerade as a frame gap;
      // app control passes only the generic recovery reason, the typed reasonCode stays in the
      // safety log above.
      reason: "rpc-transport-fault",
    });
  }

  function clearPendingOutboundPayloadTimer(runtime: WindowControlRuntime): void {
    if (!runtime.pendingOutboundPayloadTimer) {
      return;
    }
    clearTimeout(runtime.pendingOutboundPayloadTimer);
    runtime.pendingOutboundPayloadTimer = undefined;
  }

  function clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void {
    if (!runtime.mobileDisconnectGraceTimer) {
      return;
    }
    clearTimeout(runtime.mobileDisconnectGraceTimer);
    runtime.mobileDisconnectGraceTimer = undefined;
  }

  function buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus {
    const target = getRuntimeStatusTarget(runtime);
    return {
      status: runtime.status,
      sessionId: runtime.deviceSid,
      windowControlSessionId: runtime.deviceSid,
      mobileConnected: runtime.mobileConnected,
      mobileViewState: runtime.mobileViewState,
      mobileDeviceInfo: runtime.mobileDeviceInfo,
      qrUrl: runtime.qrUrl,
      connectUrl: runtime.connectUrl,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: runtime.currentBridge?.initialTaskId ?? runtime.initialTaskId,
      error: runtime.error,
      failure: runtime.failure,
    };
  }

  function emitRuntimeStatus(runtime: WindowControlRuntime): void {
    dependencies.onStatusChanged?.(runtime.windowId, buildRuntimeStatus(runtime));
  }

  function emitIdleStatus(windowId: number): void {
    dependencies.onStatusChanged?.(windowId, { status: "idle" });
  }

  function scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void {
    if (runtime.mobileDisconnectGraceTimer) {
      return;
    }
    runtime.mobileDisconnectGraceTimer = setTimeout(() => {
      runtime.mobileDisconnectGraceTimer = undefined;
      if (runtimes.get(runtime.windowId) !== runtime || runtime.status === "error") {
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
    }, MOBILE_DISCONNECT_STATUS_GRACE_MS);
  }

  function schedulePendingOutboundPayloadTimeout(runtime: WindowControlRuntime): void {
    if (runtime.pendingOutboundPayloadTimer || runtime.pendingOutboundPayloads.length === 0) {
      return;
    }
    runtime.pendingOutboundPayloadTimer = setTimeout(() => {
      runtime.pendingOutboundPayloadTimer = undefined;
      const droppedCount = runtime.pendingOutboundPayloads.splice(0).length;
      dependencies.logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  function sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult {
    if (runtime.transport.sendPayloadResult) {
      return runtime.transport.sendPayloadResult(payload);
    }
    return runtime.transport.sendPayload(payload)
      ? { kind: "sent", bytes: 0 }
      : { kind: "unavailable" };
  }

  function bufferOutboundPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length >= 50) {
      const droppedCount = runtime.pendingOutboundPayloads.length + 1;
      runtime.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(runtime);
      dependencies.logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
      return;
    }
    runtime.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(runtime);
  }

  function flushPendingOutboundPayloads(runtime: WindowControlRuntime): void {
    while (runtime.pendingOutboundPayloads.length > 0) {
      const payload = runtime.pendingOutboundPayloads[0];
      if (!payload) {
        break;
      }
      const result = sendPayloadToTransport(runtime, payload);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(runtime);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix: a permanently oversize payload must not pose as temporarily unsendable and
        // re-enter the 50-item buffer forever.
        dependencies.logger.warn("[web-remote-control] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      runtime.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(runtime);
  }

  function sendAppPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(runtime, payload);
      flushPendingOutboundPayloads(runtime);
      return;
    }
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "sent") {
      return;
    }
    if (result.kind === "oversize") {
      dependencies.logger.warn("[web-remote-control] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: inside the relay suspect window sendPayload returns false.
    // Response/RPC frames sent by desktop must not be dropped silently; buffer briefly and
    // flush once paired recovers.
    bufferOutboundPayload(runtime, payload);
  }

  function preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void {
    if (runtime.status === "error" && runtime.failure?.reason === failure.reason) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: failure.reason,
      error: failure.message ?? failure.reason,
    });
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    runtime.status = "error";
    runtime.error = failure.message;
    runtime.failure = failure;
    runtimes.set(windowId, runtime);
    dependencies.logger.warn(
      `[web-remote-control] runtime closed window=${windowId} session=${runtime.deviceSid} reason=${reason} failure=${failure.reason} message=${failure.message ?? "<none>"}`,
    );
    emitRuntimeStatus(runtime);
  }

  async function stopWindowRuntime(windowId: number, reason: string): Promise<void> {
    const runtime = runtimes.get(windowId);
    if (!runtime) {
      return;
    }

    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: "desktop-disconnected",
      error: "Desktop disconnected this Web remote control session.",
    });
    runtimes.delete(windowId);
    pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    dependencies.disposeWorkspaceHostAttachmentsForWindow(windowId, reason);

    dependencies.logger.info(
      `[web-remote-control] stopped window=${windowId} session=${runtime.deviceSid} reason=${reason}`,
    );
    emitIdleStatus(windowId);
  }

  function getRuntimeWorkspaceTarget(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget {
    const bridge = runtime.currentBridge;
    if (bridge) {
      return {
        workspacePath: bridge.workspacePath,
        workspaceIdentity: bridge.workspaceIdentity,
        remoteSessionId: bridge.remoteSessionId,
        label: getPathLabel(bridge.workspacePath),
        kind: bridge.kind,
      };
    }

    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getRuntimeStatusTarget(runtime: WindowControlRuntime): WebRemoteControlWorkspaceTarget {
    // Bugfix: the phone can switch to another workspace inside the same remote-control session.
    // getStatus() used to reuse the current bridge target, so when the desktop popup polled by
    // launch workspace it misjudged "not the same session", and reopening the popup restarted
    // remote control and kicked the phone offline. The status endpoint keeps the window remote
    // session's original target; the phone's current workspace is still expressed via
    // mobileViewState / workspace list.
    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  function getAvailableWorkspaces(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget[] {
    const workspaceByKey = new Map<string, WebRemoteControlWorkspaceTarget>();

    for (const workspace of availableWorkspacesByWindowId.get(runtime.windowId) ?? []) {
      // Bugfix: the phone workspace list must show disconnected SSH projects exactly like
      // desktop. Keep only the list entry here; real bridge creation still validates
      // remoteSessionId so unconnected projects cannot open chat directly.
      workspaceByKey.set(resolveWebRemoteControlWorkspaceKey(workspace), workspace);
    }

    const currentTarget = getRuntimeWorkspaceTarget(runtime);
    if (isBridgeableRemoteTarget(currentTarget)) {
      const currentKey = resolveWebRemoteControlWorkspaceKey(currentTarget);
      if (!workspaceByKey.has(currentKey)) {
        workspaceByKey.set(currentKey, currentTarget);
      }
    }

    return [...workspaceByKey.values()];
  }

  function getAvailableTasks(runtime: WindowControlRuntime): WebRemoteControlTaskTarget[] {
    const availableWorkspaceKeys = new Set(
      getAvailableWorkspaces(runtime).map((workspace) =>
        resolveWebRemoteControlWorkspaceKey(workspace),
      ),
    );

    return (availableTasksByWindowId.get(runtime.windowId) ?? [])
      .filter(
        (task) =>
          isBridgeableRemoteTask(task) &&
          availableWorkspaceKeys.has(resolveWebRemoteControlWorkspaceKey(task)),
      )
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        if (right.createdAt !== left.createdAt) {
          return right.createdAt - left.createdAt;
        }
        return right.taskId.localeCompare(left.taskId);
      });
  }

  function getRuntimeInitialViewState(
    runtime: WindowControlRuntime,
  ): WebRemoteControlMobileViewState | undefined {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    if (!runtime.initialTaskId || !isBridgeableRemoteTarget(activeTarget)) {
      return undefined;
    }

    return {
      activeWorkspaceKey: resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId: runtime.initialTaskId,
      updatedAt: Date.now(),
    };
  }

  function buildBootstrapResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWindowBootstrapResult {
    return {
      windowControlSessionId: runtime.deviceSid,
      desktopAppVersion: dependencies.appVersion,
      workspaces: getAvailableWorkspaces(runtime),
      tasks: getAvailableTasks(runtime),
      initialViewState: getRuntimeInitialViewState(runtime),
      mobileViewState: runtime.mobileViewState,
    };
  }

  function buildWorkspaceListResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceListResult {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    const initialViewState = getRuntimeInitialViewState(runtime);
    return {
      workspaces: getAvailableWorkspaces(runtime),
      tasks: getAvailableTasks(runtime),
      activeWorkspaceKey:
        runtime.mobileViewState?.activeWorkspaceKey ??
        initialViewState?.activeWorkspaceKey ??
        resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId:
        runtime.mobileViewState?.activeTaskId ??
        runtime.currentBridge?.initialTaskId ??
        initialViewState?.activeTaskId,
    };
  }

  function buildWorkspaceListPushSignature(result: WebRemoteControlWorkspaceListResult): string {
    const workspaceSignatureEntries = result.workspaces
      .map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        return JSON.stringify([
          workspaceKey,
          workspace.kind,
          workspace.connectionState ?? "connected",
          workspace.remoteSessionId ?? "",
          // Bugfix: connection state is more than the enum; within the same disconnected state
          // the error reason can change, and the phone workspace card renders
          // lastConnectionError directly, so a new snapshot must be triggered.
          workspace.lastConnectionError ?? "",
        ]);
      })
      .sort();
    const taskSignatureEntries = result.tasks
      .map((task) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(task);
        return JSON.stringify([
          workspaceKey,
          task.taskId,
          // Bugfix: auto-title and user renames do not change task identity/membership, but the
          // title itself must participate in home snapshot dedup or the phone keeps the stale
          // text forever.
          task.title,
          // Bugfix: after a remote workspace reconnect the workspaceKey can stay the same while
          // the task target's remoteSessionId rotates; the phone must adopt the new connection
          // identity, not treat it as a duplicate task.
          task.remoteSessionId ?? "",
          // Bugfix: the phone home status comes from the renderer-computed displayStatus; the
          // old signature compared membership only, so running/completed/error transitions were
          // misjudged as duplicate snapshots. Missing values normalize to idle like the phone
          // fallback.
          task.displayStatus ?? "idle",
          // Background work start/stop decides the phone list's running-layer placement
          // (ordering); emit a new snapshot even when displayStatus is unchanged.
          Boolean(task.hasBackgroundWork),
          // Workflow run-row data: phase light flips, run completion, and subagent count changes
          // must all make the phone redraw that row.
          task.workflowActivity ?? null,
          // Bugfix: unreadAt is the phone blue-dot's source of truth; when opening a task clears
          // unread, task membership is unchanged, so the timestamp→missing transition must
          // trigger a new snapshot.
          typeof task.unreadAt === "number" ? task.unreadAt : "",
          Boolean(task.pinned),
          Boolean(task.archived),
        ]);
      })
      .sort();

    // Bugfix: title/connection error are arbitrary user-visible strings; stop gluing tuples with
    // control characters, otherwise field values containing the separator could yield identical
    // signatures across different snapshots. A JSON tuple keeps field boundaries and still
    // ignores array order.
    return JSON.stringify([workspaceSignatureEntries, taskSignatureEntries]);
  }

  function pushWorkspaceListUpdated(runtime: WindowControlRuntime): void {
    const result = buildWorkspaceListResult(runtime);
    const signature = buildWorkspaceListPushSignature(result);
    if (pushedWorkspaceListSignaturesByWindowId.get(runtime.windowId) === signature) {
      return;
    }

    pushedWorkspaceListSignaturesByWindowId.set(runtime.windowId, signature);
    sendAppPayload(runtime, {
      zcode_type: "workspace-list-updated",
      result,
    });
  }

  async function respondToPlatformRequest(
    runtime: WindowControlRuntime,
    request: WebRemoteControlPlatformRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlPlatformResponsePayload;

    try {
      const result = await dependencies.platformHandlers[request.method](request.args as never);
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: true,
        result,
      } as WebRemoteControlPlatformResponsePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] platform request failed window=${runtime.windowId} session=${runtime.deviceSid} method=${request.method} error=${message}`,
      );
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: false,
        error: message,
      };
    }

    sendAppPayload(runtime, response);
  }

  async function createWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    const target = getAvailableWorkspaces(runtime).find(
      (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
    );
    if (!target) {
      throw new Error(
        "Target workspace is not in this desktop window; cannot create a web remote-control bridge.",
      );
    }
    if (!isBridgeableRemoteTarget(target)) {
      throw new Error(
        "Target remote workspace is not connected; reconnect before creating a bridge.",
      );
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    disposeRuntimeBridgeResources(runtime);
    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.failure = undefined;
    emitRuntimeStatus(runtime);

    const bridgeRuntime: WorkspaceBridgeRuntime = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      hostEntryId: "",
      attachmentId: "",
      kind: target.kind,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    runtime.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control] attaching workspace bridge window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    let acquired: WebRemoteControlHostAttachmentHandle | undefined;
    try {
      acquired = await dependencies.attachWorkspaceHost(runtime.windowId, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        initialTaskId: request.taskId,
        kind: target.kind,
      });
      if (!isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
        acquired = undefined;
        throw new Error("Workspace bridge request was superseded.");
      }
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(acquired.port));
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        measureFrameBytes: (frame) =>
          runtime.transport.measurePayloadBytes?.(frame) ??
          measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result = sendPayloadToTransport(runtime, payload);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });

      // Bugfix: the raw adapter is the only replay owner; main no longer puts rpc-frames into the
      // ordinary 50-item buffer.
      const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
        relayProtocol.protocol.send(buffer);
      });
      const disposeRelayToHost = relayProtocol.protocol.onMessage((buffer) => {
        hostProtocol.send(buffer);
      });
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(runtime, bridgeRuntime, fault.reasonCode);
      });
      const disposeSaturated = relayProtocol.onSaturated(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("saturated");
      });
      const disposeDrained = relayProtocol.onDrained(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("drained");
      });

      bridgeRuntime.hostEntryId = acquired.entryId;
      bridgeRuntime.attachmentId = acquired.attachmentId;
      bridgeRuntime.hostProtocol = hostProtocol;
      bridgeRuntime.relayProtocol = relayProtocol;
      bridgeRuntime.disposeBridge = () => {
        disposeHostToRelay.dispose();
        disposeRelayToHost.dispose();
        disposeDegraded.dispose();
        disposeSaturated.dispose();
        disposeDrained.dispose();
      };
      runtime.status = "active";
      runtime.error = undefined;
      runtime.failure = undefined;
      emitRuntimeStatus(runtime);

      dependencies.logger.info(
        `[web-remote-control] workspace bridge active window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId}`,
      );
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "success",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
        }),
      );

      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "failure",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
          errorCategory: classifyRemoteUsageError(error),
        }),
      );
      if (acquired) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
      }
      if (isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        disposeRuntimeBridgeResources(runtime);
        runtime.status = runtime.mobileConnected ? "active" : "running";
        emitRuntimeStatus(runtime);
      }
      throw error;
    }
  }

  async function respondToWorkspaceBridgeOpen(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(runtime, request);
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge,
      });
      const currentBridge = runtime.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready must enter the ordinary app transport before queued raw frames may open
        // the gate.
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace bridge failed window=${runtime.windowId} session=${runtime.deviceSid} workspaceKey=${request.workspaceKey} error=${message}`,
      );
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: mapWorkspaceBridgeFailureReason(error),
        error: message,
      });
    }
  }

  async function respondToWorkspaceReconnectRequest(
    runtime: WindowControlRuntime,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    try {
      await dependencies.reconnectWorkspace(runtime.windowId, request.workspaceKey);
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: true,
      });
    } catch (error) {
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function applyMobileViewStateUpdate(
    runtime: WindowControlRuntime,
    viewState: WebRemoteControlMobileViewState,
    deviceInfo?: WebRemoteControlMobileDeviceInfo,
  ): void {
    runtime.mobileViewState = viewState;
    if (deviceInfo) {
      runtime.mobileDeviceInfo = deviceInfo;
    }
  }

  function routeRpcTransportPayload(
    runtime: WindowControlRuntime,
    frame: WebRemoteControlRpcTransportPayload,
  ): void {
    routeRawTransportCandidate(runtime, frame);
  }

  function routeRawTransportCandidate(runtime: WindowControlRuntime, payload: unknown): boolean {
    const bridge = runtime.currentBridge;
    if (!bridge || bridge.degraded) return false;
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  function logMobileDiagnostic(
    runtime: WindowControlRuntime,
    payload: Extract<WebRemoteControlAppPayload, { zcode_type: "mobile-diagnostic" }>,
  ): void {
    dependencies.logger.info("[web-remote-control] mobile diagnostic", {
      window: runtime.windowId,
      session: runtime.deviceSid,
      event: payload.event,
      state: payload.state,
      previousState: payload.previousState,
      pairStatus: payload.pairStatus,
      closeCode: payload.closeCode,
      closeReason: payload.closeReason,
      wasClean: payload.wasClean,
      wasPaired: payload.wasPaired,
      failureReason: payload.failureReason,
      failureMessage: payload.failureMessage,
      visibilityState: payload.visibilityState,
      online: payload.online,
      hiddenDurationMs: payload.hiddenDurationMs,
      timestamp: payload.timestamp,
    });
  }

  function routePayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void {
    switch (payload.zcode_type) {
      case "bootstrap-request":
        sendAppPayload(runtime, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: buildBootstrapResult(runtime),
        });
        break;
      case "workspace-list-request":
        sendAppPayload(runtime, {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: buildWorkspaceListResult(runtime),
        });
        break;
      case "platform-request":
        void respondToPlatformRequest(runtime, payload);
        break;
      case "mobile-view-state-update":
        applyMobileViewStateUpdate(runtime, payload.viewState, payload.deviceInfo);
        break;
      case "workspace-bridge-open":
        void respondToWorkspaceBridgeOpen(runtime, payload);
        break;
      case "workspace-reconnect-request":
        void respondToWorkspaceReconnectRequest(runtime, payload);
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        routeRpcTransportPayload(runtime, payload);
        break;
      case "telemetry-report":
        // The phone already built the event at the creation boundary; Main only forwards and keeps
        // no session facts, nor intervenes in the replayable chain.
        dependencies.reportRendererTelemetryEvent?.(payload.event);
        break;
      case "mobile-diagnostic":
        logMobileDiagnostic(runtime, payload);
        break;
      default:
        break;
    }
  }

  function mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void {
    const previousTransportState = runtime.transportState;
    runtime.transportState = state;
    if (state === "connecting" || state === "registering" || state === "authenticating") {
      if (runtime.mobileConnected) {
        // Bugfix: a paired session's brief relay jitter passes through connecting/authenticating
        // first. The old logic switched the dialog to "starting" immediately and made users think
        // remote control restarted; keep active during the grace window.
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "starting";
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "waiting_terminal") {
      if (runtime.mobileConnected) {
        // Bugfix: when a paired session recovers, the relay may briefly return to waiting. The old
        // logic pulled the dialog from active back to "waiting for phone match"; debounce first
        // and downgrade only if still unpaired after the timeout.
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "paired") {
      if (previousTransportState !== "paired") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "success",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
          }),
        );
      }
      runtime.hasEverPaired = true;
      clearMobileDisconnectGraceTimer(runtime);
      runtime.status = "active";
      runtime.mobileConnected = true;
      emitRuntimeStatus(runtime);
      // Bugfix: on ordinary reconnect, re-pairing does not necessarily fire onSendReady on the
      // transport; flush actively once state returns to sendable so buffered response/RPC frames
      // within the reconnect window are not dropped on timeout.
      flushPendingOutboundPayloads(runtime);
      return;
    }
    if (state === "kicked") {
      if (previousTransportState !== "kicked") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      preserveWindowRuntimeFailure(
        runtime.windowId,
        runtime,
        "external-relay-kicked",
        createFailure("session-conflict", "Web remote control connection was kicked by relay."),
      );
      return;
    }
    if (state === "error") {
      if (previousTransportState !== "error") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      runtime.status = "error";
      emitRuntimeStatus(runtime);
    }
  }

  function createQrUrl(
    auth: { deviceSid: string; passHash: string },
    mobileRemoteControlUrl: string,
    theme?: WebRemoteControlContext["theme"],
  ): string {
    return buildWebRemoteControlExternalQrUrl({
      baseUrl: mobileRemoteControlUrl,
      deviceSid: auth.deviceSid,
      passHash: auth.passHash,
      timestamp: Date.now(),
      deviceMid: dependencies.deviceMid,
      deviceName: dependencies.deviceName,
      appVersion: dependencies.appVersion,
      theme,
    });
  }

  return {
    authorizeStart,
    async startAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      return this.start(windowId, context);
    },
    async start(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      clearStartAuthorizationsForWindow(windowId);
      dependencies.featureGate.assertEnabled();
      startupRestoreClaimed = true;
      await stopWindowRuntime(windowId, "restart");
      const endpointUrls = await dependencies.getEndpointUrls?.();
      const relayWsUrl = endpointUrls?.relayWsUrl ?? dependencies.relayWsUrl;
      const mobileRemoteControlUrl = endpointUrls?.remoteUrl ?? dependencies.mobileRemoteControlUrl;

      dependencies.logger.info(
        `[web-remote-control] start window=${windowId} workspace=${context.workspacePath} remoteSession=${context.remoteSessionId ?? "none"} relay=${relayWsUrl}`,
      );

      const storedAuth = await dependencies.authStorageProvider.load();
      const transportAuth: WebRemoteControlDeviceTransportAuth = storedAuth
        ? {
            mode: "persisted",
            deviceSid: storedAuth.deviceSid,
            passHash: storedAuth.passHash,
          }
        : {
            mode: "register",
            passHash: dependencies.authProvider.createPassHash(
              dependencies.authProvider.createPassword(),
            ),
          };
      let readyAuth =
        transportAuth.mode === "persisted"
          ? { deviceSid: transportAuth.deviceSid, passHash: transportAuth.passHash }
          : undefined;
      let registeredAuth: { deviceSid: string; passHash: string } | undefined;
      let runtime: WindowControlRuntime;

      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("External relay device did not reach QR-ready state before timeout."));
        }, EXTERNAL_RELAY_QR_READY_TIMEOUT_MS);

        const resolveReady = () => {
          clearTimeout(timeout);
          resolve();
        };

        const transport = createTransport({
          relayWsUrl,
          deviceMid: dependencies.deviceMid,
          auth: transportAuth,
          meta: {
            platform: process.platform,
            version: dependencies.appVersion,
            name: dependencies.deviceName,
          },
          authProvider: dependencies.authProvider,
          logger: dependencies.logger,
          relayMessageLogger: dependencies.relayMessageLogger,
          onRegisteredAuth: (auth) => {
            registeredAuth = auth;
            readyAuth = auth;
          },
          onStateChange: (state) => {
            mapTransportState(runtime, state);
            if ((state === "waiting_terminal" || state === "paired") && readyAuth) {
              resolveReady();
            }
          },
          onPayload: (payload) => routePayload(runtime, payload),
          onRawTransportPayload: (payload) => routeRawTransportCandidate(runtime, payload),
          onRawTransportFault: (reasonCode) => {
            runtime.currentBridge?.relayProtocol?.markDegraded(reasonCode);
          },
          onSendReady: () => {
            flushPendingOutboundPayloads(runtime);
            const relayProtocol = runtime.currentBridge?.relayProtocol;
            if (!relayProtocol || relayProtocol.isDegraded()) return;
            // Bug fix: the relay's matched only proves the current peer is sendable; the local
            // WebSocket not being regenerated does not mean the peer was not, nor that previous
            // data was delivered. Must replay the same bridge's un-ACKed batches; the adapter
            // dedups by messageSeq and replay does not refresh the original 45s queued age.
            relayProtocol.replayUnacknowledged();
          },
          onError: (error) => {
            dependencies.logger.warn("[web-remote-control] external relay device error", {
              message: error.message,
            });
          },
          onInvalidPersistedAuth: async () => {
            await resetExternalRelayDeviceAuth(
              dependencies.authStorageProvider,
              dependencies.logger,
              "auth-failed",
            );
          },
        });

        runtime = {
          windowId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          remoteSessionId: context.remoteSessionId,
          initialTaskId: context.initialTaskId,
          theme: context.theme,
          status: "starting",
          deviceSid: readyAuth?.deviceSid ?? "pending",
          passHash: readyAuth?.passHash ?? transportAuth.passHash,
          deviceMid: dependencies.deviceMid,
          connectUrl: "",
          qrUrl: "",
          transport,
          mobileConnected: false,
          hasEverPaired: false,
          pendingOutboundPayloads: [],
        };
        runtimes.set(windowId, runtime);
        emitRuntimeStatus(runtime);
        transport.start();
      });

      try {
        await readyPromise;
      } catch (error) {
        runtimes.delete(windowId);
        clearPendingOutboundPayloadTimer(runtime!);
        clearMobileDisconnectGraceTimer(runtime!);
        runtime!.pendingOutboundPayloads.length = 0;
        runtime!.transport.dispose();
        throw error;
      }

      const auth = readyAuth;
      if (!auth) {
        throw new Error("External relay auth was not available after transport became ready.");
      }

      if (registeredAuth) {
        await dependencies.authStorageProvider.save(registeredAuth);
      }

      try {
        await dependencies.startupRestoreStorageProvider.save({
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          initialTaskId: context.initialTaskId,
        });
      } catch (error) {
        await stopWindowRuntime(windowId, "startup-restore-persist-failed");
        throw error;
      }

      const qrUrl = createQrUrl(auth, mobileRemoteControlUrl, context.theme);
      runtime!.deviceSid = auth.deviceSid;
      runtime!.passHash = auth.passHash;
      runtime!.qrUrl = qrUrl;
      runtime!.connectUrl = qrUrl;
      emitRuntimeStatus(runtime!);

      return {
        status: runtime!.status === "active" ? "active" : "running",
        sessionId: auth.deviceSid,
        windowControlSessionId: auth.deviceSid,
        qrUrl,
        connectUrl: qrUrl,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        remoteSessionId: context.remoteSessionId,
        initialTaskId: context.initialTaskId,
      };
    },

    async stop(windowId: number): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      // Bugfix: clearing auto-resume settings writes to disk; on failure the user must still be
      // able to close the current remote-control connection. Release transport and attachment
      // first, then surface the persistence error to the UI, guaranteeing this run stops now.
      await stopWindowRuntime(windowId, "manual-stop");
      await dependencies.startupRestoreStorageProvider.clear();
    },

    async suspend(windowId: number, reason: string): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, reason);
    },

    async restorePreviouslyEnabled(
      windowId: number,
      candidates: WebRemoteControlContext[],
    ): Promise<boolean> {
      if (startupRestoreClaimed || runtimes.has(windowId)) {
        return false;
      }

      const persistedContext = await startupRestoreContextPromise;
      if (startupRestoreClaimed || !persistedContext) {
        return false;
      }

      const persistedWorkspaceKey = resolveWebRemoteControlWorkspaceKey(persistedContext);
      const currentContext = candidates.find(
        (candidate) => resolveWebRemoteControlWorkspaceKey(candidate) === persistedWorkspaceKey,
      );
      if (!currentContext) {
        return false;
      }

      startupRestoreClaimed = true;
      dependencies.logger.info(
        `[web-remote-control] restoring previous enabled state window=${windowId} workspace=${currentContext.workspacePath} remoteSession=${currentContext.remoteSessionId ?? "none"}`,
      );
      try {
        await this.start(windowId, {
          workspacePath: currentContext.workspacePath,
          workspaceIdentity: currentContext.workspaceIdentity,
          remoteSessionId: currentContext.remoteSessionId,
          initialTaskId: persistedContext.initialTaskId,
        });
        return true;
      } catch (error) {
        startupRestoreClaimed = false;
        dependencies.logger.warn(
          "[web-remote-control] restore previous enabled state failed",
          error,
        );
        return false;
      }
    },

    async resetPairing(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      // Bugfix: the refresh entry is guarded by the feature flag exactly like start. The gate
      // check used to hide inside the later start, so with the feature disabled it would clear
      // local pairing material first and only then throw. Validate up front so the disabled-state
      // IPC has no destructive side effects.
      dependencies.featureGate.assertEnabled();
      // Bugfix: if the sid/hash carried in the QR URL leaks, restarting the runtime would still
      // reuse persisted pairing material. Close the old connection and clear local relay auth
      // before re-registering the device, ensuring the old URL no longer represents this
      // desktop session.
      await stopWindowRuntime(windowId, "leaked-qr");
      await resetExternalRelayDeviceAuth(
        dependencies.authStorageProvider,
        dependencies.logger,
        "leaked-qr",
      );
      return this.start(windowId, context);
    },
    async resetPairingAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      return this.resetPairing(windowId, context);
    },

    getStatus(windowId: number): WebRemoteControlStatus {
      if (!dependencies.featureGate.isEnabled()) {
        return {
          status: "idle",
          failure: createFailure(
            "unsupported-action",
            "Web remote control is disabled in this build.",
          ),
        };
      }

      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return { status: "idle" };
      }

      return buildRuntimeStatus(runtime);
    },

    syncAvailableWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void {
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      availableWorkspacesByWindowId.set(windowId, workspaces);
      pushWorkspaceListUpdated(runtime);
    },

    syncAvailableTasks(windowId: number, tasks: WebRemoteControlTaskTarget[]): void {
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      availableTasksByWindowId.set(windowId, tasks);
      pushWorkspaceListUpdated(runtime);
    },

    async disposeWindow(windowId: number): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, "window-disposed");
      availableWorkspacesByWindowId.delete(windowId);
      availableTasksByWindowId.delete(windowId);
      pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    },

    failRemoteSession(
      remoteSessionId: string,
      reason: string,
      failure: WebRemoteControlFailure,
    ): void {
      for (const [windowId, runtime] of runtimes) {
        const bridge = runtime.currentBridge;
        const bridgeUsesRemoteSession = bridge?.remoteSessionId === remoteSessionId;
        const runtimeUsesRemoteSession = runtime.remoteSessionId === remoteSessionId;

        if (!bridgeUsesRemoteSession && !runtimeUsesRemoteSession) {
          continue;
        }

        // Bugfix: a remote workspace session is merely a dependency of some workspace/bridge; its
        // disconnect must not be escalated to a window-level web remote-control device WS
        // failure, or a single remote idle-exit would wrongly close the desktop's global
        // remote-control entry.
        if (bridgeUsesRemoteSession) {
          disposeRuntimeBridgeResources(runtime);
          sendAppPayload(runtime, {
            zcode_type: "workspace-bridge-error",
            bridgeSessionId: bridge.bridgeSessionId,
            ...(bridge.bridgeGeneration !== undefined
              ? { bridgeGeneration: bridge.bridgeGeneration }
              : {}),
            ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
            requestId: `remote-session-closed:${remoteSessionId}`,
            reason: failure.reason,
            error: failure.message ?? failure.reason,
          });
        }
        if (runtimeUsesRemoteSession) {
          runtime.remoteSessionId = undefined;
        }
        runtime.status = runtime.mobileConnected ? "active" : "running";
        runtime.error = undefined;
        runtime.failure = undefined;
        runtimes.set(windowId, runtime);
        emitRuntimeStatus(runtime);
      }
      dependencies.disposeWorkspaceHostAttachmentsForRemoteSession(remoteSessionId, reason);
    },
  };
}
