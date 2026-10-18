/* eslint-disable max-lines -- the external relay terminal transport keeps handshake, pairing, request waits and reconnect state in one place. */
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS,
  getWebRemoteControlHeartbeatDelayMs,
  getWebRemoteControlHeartbeatJitterMs,
  getWebRemoteControlReconnectJitterMs,
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  parseWebRemoteControlAppPayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlFailure,
  type WebRemoteControlRelayIncomingMessage,
  type WebRemoteControlRelayOutgoingMessage,
} from "@zcode/shared";

export type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

export type WebRemoteControlTerminalTransportDiagnostic =
  | {
      type: "state-transition";
      previousState: WebRemoteControlTerminalTransportState;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-close";
      code: number;
      reason: string;
      wasClean: boolean;
      wasPaired: boolean;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-error" | "recover-start" | "recover-scheduled";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "pair-status";
      pairStatus: "waiting" | "matched";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-extensions";
      state: WebRemoteControlTerminalTransportState;
      perMessageDeflate: boolean;
      extensions?: string;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    };

type WebRemoteControlTerminalTransportDiagnosticInput = {
  type: WebRemoteControlTerminalTransportDiagnostic["type"];
  previousState?: WebRemoteControlTerminalTransportState;
  state: WebRemoteControlTerminalTransportState;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  pairStatus?: "waiting" | "matched";
  perMessageDeflate?: boolean;
  extensions?: string;
};

interface WebRemoteControlTerminalTransportOptions {
  relayWsUrl: string;
  deviceSid: string;
  passHash: string;
  deviceMid?: string;
  appVersion?: string;
  WebSocketCtor?: typeof globalThis.WebSocket;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  healthCheckTimeoutMs?: number;
  desktopOfflineGraceMs?: number;
  staleWaitingRecoveryMs?: number;
  waitingTimeoutMs?: number;
  authProvider: {
    calculateProof(
      passHash: string,
      nonce: string,
      role: "terminal",
      deviceSid: string,
    ): Promise<string>;
  };
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onStateChange(state: WebRemoteControlTerminalTransportState): void;
  onFailure(failure: WebRemoteControlFailure): void;
  onError(error: Error): void;
  onDiagnostic?(diagnostic: WebRemoteControlTerminalTransportDiagnostic): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  reloadPage(): void;
}

async function readWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength <=
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
      ? data
      : null;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data as Uint8Array);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.size > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return data.text();
  }
  const text = String(data);
  return new TextEncoder().encode(text).byteLength <=
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ? text
    : null;
}

function webSocketDataByteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return new TextEncoder().encode(String(data)).byteLength;
}

async function parseRelayMessage(
  data: unknown,
): Promise<WebRemoteControlRelayIncomingMessage | null> {
  try {
    const text = await readWebSocketData(data);
    if (text === null) return null;
    const parsed = JSON.parse(text) as WebRemoteControlRelayIncomingMessage;
    return parsed && typeof parsed === "object" && "type" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

function createFailure(
  reason: WebRemoteControlFailure["reason"],
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function safePayloadMetadata(payload: unknown): Record<string, string | undefined> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    zcode_type: typeof record.zcode_type === "string" ? record.zcode_type : undefined,
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    bridgeSessionId:
      typeof record.bridgeSessionId === "string" ? record.bridgeSessionId : undefined,
  };
}

function isRawTransportCandidate(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

function summarizeRelayMessageForTrace(
  message: WebRemoteControlRelayIncomingMessage | WebRemoteControlRelayOutgoingMessage,
): Record<string, unknown> {
  if (message.type === "pair_status_ack") {
    return { type: message.type, pair_status: message.pair_status };
  }
  if (message.type === "auth_init") {
    return { type: message.type, role: message.role };
  }
  if (message.type === "data") {
    return {
      type: message.type,
      payload: safePayloadMetadata(message.payload),
    };
  }
  if (message.type === "error") {
    return { type: message.type, code: message.code };
  }
  return { type: message.type };
}

export class WebRemoteControlTerminalTransport {
  private readonly WebSocketCtor: typeof globalThis.WebSocket;
  private socket?: WebSocket;
  private state: WebRemoteControlTerminalTransportState = "idle";
  private intentionallyClosed = false;
  private wasPaired = false;
  private hadPairedSession = false;
  private staleWaitingCount = 0;
  private reconnectAttempt = 0;
  private socketGeneration = 0;
  private lastPairedSocketGeneration = 0;
  private lastPairStatusAckAt = 0;
  private hiddenStartedAt?: number;
  private lastPairStatusDiagnostic?: string;
  private pairedWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAckWatchdogTimer?: ReturnType<typeof setTimeout>;
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private staleWaitingRecoveryTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private desktopOfflineFailureTimer?: ReturnType<typeof setTimeout>;
  private readonly traceRelayMessages = import.meta.env.DEV;
  private readonly payloadSerializer = new WebRemoteControlRelayPayloadSerializer();

  constructor(private readonly options: WebRemoteControlTerminalTransportOptions) {
    this.WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
  }

  start(): void {
    this.intentionallyClosed = false;
    this.wasPaired = false;
    this.hadPairedSession = false;
    this.staleWaitingCount = 0;
    this.reconnectAttempt = 0;
    this.lastPairedSocketGeneration = 0;
    this.lastPairStatusAckAt = Date.now();
    this.setState("connecting");
    this.connect();
  }

  private connect(): void {
    this.socketGeneration += 1;
    const url = new URL(this.options.relayWsUrl);
    if (this.options.deviceMid?.trim()) {
      url.searchParams.set("mid", this.options.deviceMid);
    }
    const socket = new this.WebSocketCtor(url.toString());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (socket !== this.socket) {
        return;
      }
      const negotiatedExtensions = typeof socket.extensions === "string" ? socket.extensions : "";
      // Bugfix: the phone side is on the browser WebSocket API and cannot pass perMessageDeflate options.
      // Confirm negotiated compression via the standard extensions field only; app code cannot force it.
      this.emitDiagnostic({
        type: "socket-extensions",
        state: this.state,
        perMessageDeflate: negotiatedExtensions.includes("permessage-deflate"),
        ...(negotiatedExtensions ? { extensions: negotiatedExtensions } : {}),
      });
      this.setState("authenticating");
      this.send({
        type: "auth_init",
        role: "terminal",
        device_sid: this.options.deviceSid,
        meta: {
          platform: "web",
          version: this.options.appVersion ?? "web",
          name: "mobile-browser",
        },
        client_ts: Date.now(),
      });
    });

    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) {
        return;
      }
      void this.handleMessage(event.data);
    });

    socket.addEventListener("error", () => {
      if (socket !== this.socket) {
        return;
      }
      const error = new Error("External relay terminal socket error");
      this.emitDiagnostic({ type: "socket-error", state: this.state });
      this.options.onError(error);
    });

    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) {
        return;
      }
      this.emitDiagnostic({
        type: "socket-close",
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        wasPaired: this.wasPaired,
        state: this.state,
      });
      this.stopHeartbeat();
      this.clearWaitingTimer();
      this.clearStaleWaitingRecoveryTimer();
      if (this.intentionallyClosed) {
        return;
      }
      if (this.state === "suspended") {
        return;
      }
      if (this.hadPairedSession) {
        // Bugfix: background resume, network switches or relay blips close the paired socket.
        // A full page reload lost the user's workspace/task view; reconnect in place instead,
        // letting the upper layer restore mobile view state once paired again.
        this.scheduleReconnect();
        return;
      }
      this.setState("error");
      this.options.onFailure(
        createFailure("relay-unavailable", "Web remote control relay connection closed."),
      );
    });
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.payloadSerializer.prepare(payload).bytes;
  }

  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    const prepared = this.payloadSerializer.prepare(payload);
    if (this.payloadSerializer.isOversize(prepared)) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    if (this.state !== "paired" || this.staleWaitingCount > 0) {
      return { kind: "unavailable" };
    }
    return this.sendSerialized(prepared.message, prepared.json)
      ? { kind: "sent", bytes: prepared.bytes }
      : { kind: "unavailable" };
  }

  suspend(): void {
    if (this.state !== "paired" && this.state !== "connecting" && this.state !== "reconnecting") {
      return;
    }
    this.hiddenStartedAt = Date.now();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("suspended");
  }

  async recoverConnection(timeoutMs = 15_000): Promise<void> {
    this.emitDiagnostic({ type: "recover-start", state: this.state });
    this.clearReconnectTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.staleWaitingCount = 0;
    if (
      this.state === "suspended" &&
      this.wasPaired &&
      this.socket?.readyState === this.WebSocketCtor.OPEN
    ) {
      // Bugfix: hidden/pagehide proves only a pause, not a broken WebSocket.
      // Probe pair_status on the live socket first; a background blip must not force a reconnect.
      this.setState("reconnecting");
      if (this.sendPairStatusQuery()) {
        try {
          await this.waitForPaired(this.options.healthCheckTimeoutMs ?? 3_000);
          return;
        } catch {
          // Rebuild the socket only after the probe times out; do not fail straight away and misread slow recovery as desktop loss.
        }
      }
    }
    this.reconnectAttempt = 0;
    this.reconnectNow();
    await this.waitForPaired(timeoutMs);
  }

  recoverInBackground(): void {
    if (this.intentionallyClosed || this.state === "paired" || this.state === "kicked") {
      return;
    }
    // Bugfix: long-background recovery can exceed one recoverConnection wait window.
    // Keep reconnecting in place, never swapping to a failure screen, so drafts survive.
    this.clearReconnectTimer();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.stopHeartbeat();
    this.staleWaitingCount = 0;
    this.reconnectNow();
  }

  dispose(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.rejectPairedWaiters(new Error("Web remote control transport disposed."));
    this.socket?.close();
    this.socket = undefined;
    this.setState("idle");
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (
      webSocketDataByteLength(data) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
      return;
    }
    const message = await parseRelayMessage(data);
    if (!message) {
      return;
    }
    this.logRelayTrace("recv", summarizeRelayMessageForTrace(message));

    switch (message.type) {
      case "auth_challenge":
        this.send({
          type: "auth_response",
          device_sid: this.options.deviceSid,
          proof: await this.options.authProvider.calculateProof(
            this.options.passHash,
            message.nonce,
            "terminal",
            this.options.deviceSid,
          ),
          client_ts: Date.now(),
        });
        break;
      case "auth_ack":
      case "pair_status_ack":
        this.applyPairStatus(message.pair_status);
        break;
      case "data":
        this.handleDataPayload(message.payload);
        break;
      case "error":
        this.handleRelayError(message.code, message.message);
        break;
    }
  }

  private applyPairStatus(status: "waiting" | "matched"): void {
    this.lastPairStatusAckAt = Date.now();
    this.armHeartbeatAckWatchdog();
    this.emitDiagnostic({ type: "pair-status", pairStatus: status, state: this.state });
    if (status === "waiting") {
      if (this.wasPaired) {
        // Bugfix: zcode-remote-hub waiting is a legal pairing state - the device is merely absent from the hub,
        // not a broken terminal WS. After pairing, degrading to waiting keeps the same phone socket,
        // polling lightly, so a brief desktop reconnect never cascades into phone-side kick loops.
        this.staleWaitingCount = 0;
        this.clearStaleWaitingRecoveryTimer();
        this.clearReconnectTimer();
        this.clearWaitingTimer();
        this.clearDesktopOfflineFailureTimer();
        this.setState("waiting");
        this.startHeartbeat();
        return;
      }
      this.stopHeartbeat();
      this.setState("waiting");
      this.startWaitingTimer();
      return;
    }
    if (status === "matched") {
      const previousPairedGeneration = this.lastPairedSocketGeneration;
      const sendReadyKind =
        previousPairedGeneration === 0
          ? null
          : previousPairedGeneration === this.socketGeneration
            ? "same-socket"
            : "reconnected-socket";
      this.staleWaitingCount = 0;
      this.reconnectAttempt = 0;
      this.clearStaleWaitingRecoveryTimer();
      this.clearDesktopOfflineFailureTimer();
      this.clearReconnectTimer();
      this.clearWaitingTimer();
      this.setState("paired");
      this.wasPaired = true;
      this.hadPairedSession = true;
      this.lastPairedSocketGeneration = this.socketGeneration;
      this.startHeartbeat();
      if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
      return;
    }
  }

  private handleRelayError(
    code: "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL",
    message: string,
  ): void {
    if (code === "KICKED") {
      this.setState("kicked");
      this.enterTerminalFailure(createFailure("session-conflict", message || code));
      return;
    }
    if (code === "DEVICE_OFFLINE") {
      // Bugfix: on desktop remote-control start or relay blips the phone may see DEVICE_OFFLINE once.
      // The old code rendered the desktop-offline terminal page at once though pairing returned in a second or two.
      // Enter the recoverable window first and declare desktop offline only after the grace lapses unpaired.
      this.recoverFromDeviceOffline(message || code);
      return;
    }
    if (code === "AUTH_FAILED" || code === "WRONG_PARAM") {
      this.enterTerminalFailure(createFailure("invalid-mobile-connection", message || code));
      return;
    }
    if (code === "INTERNAL") {
      if (this.state === "paired" || (this.hadPairedSession && this.state === "waiting")) {
        this.enterWaitingForDeviceAfterRelayError(message || code);
        return;
      }
      // Bugfix: the relay briefly returns INTERNAL during desktop/phone reconnect hand-offs.
      // Mostly recoverable; throwing a failure page would force a manual restart, so recover in place.
      this.recoverFromRelayInternal(message || code);
      return;
    }
    this.enterTerminalFailure(createFailure("relay-unavailable", message || code));
  }

  private handleDataPayload(payload: unknown): void {
    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) {
      return;
    }
    const parsed = parseWebRemoteControlAppPayload(payload);
    if (!parsed) {
      return;
    }
    this.options.onPayload(parsed);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.armHeartbeatAckWatchdog();
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(
      () => {
        this.heartbeatTimer = undefined;
        if (this.state !== "paired" && this.state !== "waiting") {
          return;
        }
        this.sendPairStatusQuery();
        // Bugfix: a fixed setInterval keeps simultaneously paired devices phase-locked on heartbeats;
        // re-sample bounded jitter per send to spread phase only, keeping the 10s average.
        this.scheduleHeartbeat();
      },
      getWebRemoteControlHeartbeatDelayMs(
        this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
        this.options.heartbeatJitterMs,
      ),
    );
  }

  private armHeartbeatAckWatchdog(): void {
    if (this.state !== "paired" && this.state !== "waiting") {
      return;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
    }
    this.heartbeatAckWatchdogTimer = setTimeout(() => {
      this.heartbeatAckWatchdogTimer = undefined;
      if (this.state !== "paired" && this.state !== "waiting") {
        return;
      }
      // Bugfix: the ACK deadline must not ride the next jittered heartbeat, or random gaps drift
      // the 30s loss threshold to 32-36s while a half-open socket black-holes sends.
      this.reconnectAfterStaleWaiting(this.getReconnectJitterMs());
    }, this.options.heartbeatAckTimeoutMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS);
  }

  private getReconnectJitterMs(): number {
    const baseIntervalMs =
      this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS;
    const heartbeatJitterMs = getWebRemoteControlHeartbeatJitterMs(
      baseIntervalMs,
      this.options.heartbeatJitterMs,
    );
    return getWebRemoteControlReconnectJitterMs(
      this.options.reconnectJitterMs ??
        Math.min(heartbeatJitterMs, WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS),
    );
  }

  private sendPairStatusQuery(): boolean {
    return this.send({
      type: "pair_status_query",
      device_sid: this.options.deviceSid,
      client_ts: Date.now(),
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
      this.heartbeatAckWatchdogTimer = undefined;
    }
  }

  private startWaitingTimer(): void {
    this.clearWaitingTimer();
    this.waitingTimer = setTimeout(() => {
      if (this.state !== "waiting") {
        return;
      }
      this.enterTerminalFailure(
        createFailure(
          "invalid-mobile-connection",
          "Desktop did not match this mobile connection before the waiting timeout.",
        ),
      );
    }, this.options.waitingTimeoutMs ?? 30_000);
  }

  private clearWaitingTimer(): void {
    if (!this.waitingTimer) {
      return;
    }
    clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  private scheduleStaleWaitingRecovery(): void {
    if (this.staleWaitingRecoveryTimer) {
      return;
    }
    this.staleWaitingRecoveryTimer = setTimeout(() => {
      this.staleWaitingRecoveryTimer = undefined;
      if (
        (this.state === "paired" ||
          this.state === "reconnecting" ||
          this.state === "connecting" ||
          this.state === "authenticating") &&
        this.staleWaitingCount > 0
      ) {
        this.reconnectAfterStaleWaiting();
      }
    }, this.options.staleWaitingRecoveryMs ?? 1_500);
  }

  private clearStaleWaitingRecoveryTimer(): void {
    if (!this.staleWaitingRecoveryTimer) {
      return;
    }
    clearTimeout(this.staleWaitingRecoveryTimer);
    this.staleWaitingRecoveryTimer = undefined;
  }

  private reconnectAfterStaleWaiting(reconnectDelayMs = 0): void {
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    // Bugfix: a paired phone may see auth_ack waiting first during recovery.
    // Keep wasPaired or the next waiting reads as never-paired and hits the failure page;
    // keep paired semantics so the state machine retries the short drop to matched.
    if (reconnectDelayMs > 0) {
      const staleSocket = this.socket;
      this.socket = undefined;
      staleSocket?.close();
      this.setState("reconnecting");
      this.lastPairStatusAckAt = Date.now();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.intentionallyClosed || this.state === "suspended") {
          return;
        }
        this.connect();
      }, reconnectDelayMs);
      return;
    }
    this.reconnectNow();
  }

  private reconnectNow(): void {
    const staleSocket = this.socket;
    this.socket = undefined;
    staleSocket?.close();
    this.setState("reconnecting");
    this.lastPairStatusAckAt = Date.now();
    this.connect();
  }

  private scheduleReconnect(options?: { immediate?: boolean }): void {
    if (this.reconnectTimer) {
      return;
    }
    const delayMs = options?.immediate ? 0 : Math.min(10_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.emitDiagnostic({ type: "recover-scheduled", state: this.state });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionallyClosed || this.state === "suspended") {
        return;
      }
      this.staleWaitingCount = 0;
      this.wasPaired = false;
      const staleSocket = this.socket;
      this.socket = undefined;
      staleSocket?.close();
      this.connect();
    }, delayMs);
  }

  private recoverFromRelayInternal(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    const staleSocket = this.socket;
    this.socket = undefined;
    staleSocket?.close();
    this.scheduleReconnect({ immediate: true });
  }

  private recoverFromDeviceOffline(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    if (!this.desktopOfflineFailureTimer) {
      this.desktopOfflineFailureTimer = setTimeout(() => {
        this.desktopOfflineFailureTimer = undefined;
        this.enterTerminalFailure(createFailure("desktop-disconnected", message));
      }, this.options.desktopOfflineGraceMs ?? 15_000);
    }
    const staleSocket = this.socket;
    this.socket = undefined;
    staleSocket?.close();
    this.scheduleReconnect({ immediate: true });
  }

  private enterWaitingForDeviceAfterRelayError(message: string): void {
    // Bugfix: on authenticated links the hub returns INTERNAL when the target device is missing,
    // without closing the terminal WS. Keep the phone socket, degrade to waiting, keep polling,
    // and never amplify a desktop absence into a reconnect loop.
    this.options.onError(new Error(message));
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    this.setState("waiting");
    this.startHeartbeat();
  }

  private clearDesktopOfflineFailureTimer(): void {
    if (!this.desktopOfflineFailureTimer) {
      return;
    }
    clearTimeout(this.desktopOfflineFailureTimer);
    this.desktopOfflineFailureTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private waitForPaired(timeoutMs = 15_000): Promise<void> {
    if (this.state === "paired") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pairedWaiters.delete(waiter);
          reject(new Error("Web remote control relay did not recover before timeout."));
        }, timeoutMs),
      };
      this.pairedWaiters.add(waiter);
    });
  }

  private resolvePairedWaiters(): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.pairedWaiters.clear();
  }

  private rejectPairedWaiters(error: Error): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pairedWaiters.clear();
  }

  private enterTerminalFailure(failure: WebRemoteControlFailure): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.setState(failure.reason === "session-conflict" ? "kicked" : "error");
    this.rejectPairedWaiters(new Error(failure.message ?? failure.reason));
    this.options.onFailure(failure);
    this.socket?.close();
  }

  private setState(state: WebRemoteControlTerminalTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    this.emitDiagnostic({
      type: "state-transition",
      previousState,
      state,
    });
    this.options.onStateChange(state);
    if (state === "paired") {
      this.resolvePairedWaiters();
    }
    if (state === "error" || state === "kicked") {
      this.rejectPairedWaiters(new Error(`Web remote control transport entered ${state}.`));
    }
  }

  private send(message: WebRemoteControlRelayOutgoingMessage): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(message);
    if (
      new TextEncoder().encode(serialized).byteLength >
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      return false;
    }
    return this.sendSerialized(message, serialized);
  }

  private sendSerialized(
    message: WebRemoteControlRelayOutgoingMessage,
    serialized: string,
  ): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    this.logRelayTrace("send", summarizeRelayMessageForTrace(message));
    this.socket.send(serialized);
    return true;
  }

  private logRelayTrace(direction: "send" | "recv", fields: Record<string, unknown>): void {
    if (!this.traceRelayMessages) {
      return;
    }
    // Bugfix: remote relay volume is high; logging bodies in production balloons logs and leaks payloads.
    // Log summary fields in dev only - enough to trace, without polluting production logs.
    console.info("[web-remote-control][relay-message]", {
      direction,
      ...fields,
    });
  }

  private emitDiagnostic(diagnostic: WebRemoteControlTerminalTransportDiagnosticInput): void {
    if (diagnostic.type === "pair-status") {
      const nextPairStatusDiagnostic = `${diagnostic.state}:${diagnostic.pairStatus ?? "unknown"}`;
      if (this.lastPairStatusDiagnostic === nextPairStatusDiagnostic) {
        return;
      }
      this.lastPairStatusDiagnostic = nextPairStatusDiagnostic;
    }
    const visibilityState = typeof document === "undefined" ? "unknown" : document.visibilityState;
    const hiddenDurationMs =
      this.hiddenStartedAt && visibilityState !== "hidden"
        ? Date.now() - this.hiddenStartedAt
        : undefined;
    if (hiddenDurationMs !== undefined) {
      this.hiddenStartedAt = undefined;
    }
    this.options.onDiagnostic?.({
      ...diagnostic,
      timestamp: Date.now(),
      visibilityState,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(hiddenDurationMs !== undefined ? { hiddenDurationMs } : {}),
    } as WebRemoteControlTerminalTransportDiagnostic);
  }
}

interface WebRemoteControlAppPayloadRequesterOptions {
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  timeoutMs?: number;
}

interface WebRemoteControlAppPayloadRequestOptions {
  timeoutMs?: number;
}

interface PendingAppPayloadRequest<TResponse extends WebRemoteControlAppPayload> {
  isMatch(payload: WebRemoteControlAppPayload): payload is TResponse;
  resolve(payload: TResponse): void;
  reject(error: WebRemoteControlFailure): void;
  timer: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlRelayRequestRecoveryOptions {
  recoverTimeout?: boolean;
}

function isRecoverableRelayRequestFailure(
  error: unknown,
  options?: WebRemoteControlRelayRequestRecoveryOptions,
): boolean {
  const failure = error as Partial<WebRemoteControlFailure> | undefined;
  return (
    failure?.reason === "relay-unavailable" ||
    (options?.recoverTimeout === true && failure?.reason === "desktop-bootstrap-timeout")
  );
}

export function createWebRemoteControlRelayRequestRecovery(recoverConnection: () => Promise<void>) {
  let recoveryPromise: Promise<void> | undefined;

  async function recoverRelayRequestPath(): Promise<void> {
    if (!recoveryPromise) {
      // Bugfix: requests hitting the suspect window together must share one recovery.
      // Otherwise each triggers recoverConnection and a blip becomes a reconnect storm.
      recoveryPromise = recoverConnection().finally(() => {
        recoveryPromise = undefined;
      });
    }
    await recoveryPromise;
  }

  return async function requestWithRelayRecovery<T>(
    request: () => Promise<T>,
    options?: WebRemoteControlRelayRequestRecoveryOptions,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!isRecoverableRelayRequestFailure(error, options)) {
        throw error;
      }
      await recoverRelayRequestPath();
      return request();
    }
  };
}

export function createWebRemoteControlAppPayloadRequester({
  sendPayload,
  timeoutMs: defaultTimeoutMs = 10_000,
}: WebRemoteControlAppPayloadRequesterOptions) {
  const pending = new Map<string, PendingAppPayloadRequest<WebRemoteControlAppPayload>>();

  function rejectRequest(requestId: string, failure: WebRemoteControlFailure): boolean {
    const request = pending.get(requestId);
    if (!request) {
      return false;
    }
    clearTimeout(request.timer);
    pending.delete(requestId);
    request.reject(failure);
    return true;
  }

  return {
    requestAppPayload<TResponse extends WebRemoteControlAppPayload>(
      payload: WebRemoteControlAppPayload & { requestId: string },
      isMatch: (payload: WebRemoteControlAppPayload) => payload is TResponse,
      options?: WebRemoteControlAppPayloadRequestOptions,
    ): Promise<TResponse> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(payload.requestId);
          reject(createFailure("desktop-bootstrap-timeout", "Desktop did not respond in time."));
        }, options?.timeoutMs ?? defaultTimeoutMs);
        pending.set(payload.requestId, {
          isMatch,
          resolve: resolve as (payload: WebRemoteControlAppPayload) => void,
          reject,
          timer,
        });
        if (!sendPayload(payload)) {
          // Bugfix: sendPayload used to drop silently when not paired/suspect,
          // leaving requesters to timeout and misreport desktop silence. Fail no-link sends immediately
          // so callers can wait for reconnect or replay idempotently.
          clearTimeout(timer);
          pending.delete(payload.requestId);
          reject(
            createFailure(
              "relay-unavailable",
              "Web remote control transport is not ready to send payload.",
            ),
          );
        }
      });
    },

    acceptPayload(payload: WebRemoteControlAppPayload): boolean {
      if (
        (payload.zcode_type === "app-error" || payload.zcode_type === "workspace-bridge-error") &&
        payload.requestId
      ) {
        // Bugfix: async bridge errors like remote session close carry a synthetic requestId,
        // matching no pending request. Consume only on a real pending hit;
        // else let the upper layer react to bridge-loss with reconnect/degraded UI.
        return rejectRequest(payload.requestId, createFailure(payload.reason, payload.error));
      }

      for (const [requestId, request] of pending) {
        if (!request.isMatch(payload)) {
          continue;
        }
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.resolve(payload);
        return true;
      }
      return false;
    },

    rejectAll(failure: WebRemoteControlFailure): void {
      for (const [requestId, request] of pending) {
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.reject(failure);
      }
    },

    dispose(): void {
      this.rejectAll(createFailure("desktop-disconnected", "Web remote control transport closed."));
    },
  };
}
