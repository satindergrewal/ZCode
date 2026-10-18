import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlRelayDataMessage,
} from "@zcode/shared";

export type WebRemoteControlPayloadSendResult =
  | { kind: "sent"; bytes: number }
  | { kind: "unavailable" }
  | { kind: "oversize"; bytes: number; maxBytes: number };

export interface SerializedWebRemoteControlRelayPayload {
  readonly message: WebRemoteControlRelayDataMessage<WebRemoteControlAppPayload>;
  readonly json: string;
  readonly bytes: number;
}

/**
 * Pin one final relay JSON per immutable app payload.
 *
 * Bugfix: the old path called Date.now()/JSON.stringify separately in meter and send, so replay accounting
 * recorded bytes the WebSocket never wrote. The WeakMap ties cache lifetime to the adapter-held frame,
 * letting GC reclaim it once the cumulative ACK releases the frame, with no second replay owner.
 */
export class WebRemoteControlRelayPayloadSerializer {
  private readonly cache = new WeakMap<object, SerializedWebRemoteControlRelayPayload>();

  prepare(
    payload: WebRemoteControlAppPayload,
    clientTimestamp = Date.now(),
  ): SerializedWebRemoteControlRelayPayload {
    const cached = this.cache.get(payload);
    if (cached) return cached;
    const message: WebRemoteControlRelayDataMessage<WebRemoteControlAppPayload> = {
      type: "data",
      payload,
      client_ts: clientTimestamp,
    };
    const json = JSON.stringify(message);
    const prepared = Object.freeze({
      message,
      json,
      bytes: new TextEncoder().encode(json).byteLength,
    });
    this.cache.set(payload, prepared);
    return prepared;
  }

  isOversize(prepared: SerializedWebRemoteControlRelayPayload): boolean {
    return prepared.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes;
  }
}
