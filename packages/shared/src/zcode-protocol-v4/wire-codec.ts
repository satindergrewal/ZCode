// V4 physical wire encoder: metered against the caller's real JSON/RPC envelope; an over-cap logical frame
// fragments at the UTF-8 bytes layer only, never changing seq/apply semantics.
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from "./core.js";
import { crc32WireBytes, encodeWireBytesBase64 } from "./wire-binary.js";
import type {
  TopicFrameDeliveryKind,
  TopicWireChecksum,
  TopicWireFrame,
  TopicWireFrameCandidate,
} from "./wire.js";

const CHANNEL_EVENT_RESPONSE_TYPE = 204;
const SOCKET_PROTOCOL_HEADER_BYTES = 13;

function vqlByteLength(value: number): number {
  let bytes = 1;
  for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) bytes += 1;
  return bytes;
}

/**
 * Metered against the three real production bearers of a topic notification. The mobile relay
 * base64s the Channel binary, so measuring only the CLI's logical JSON falls short.
 */
export function measureTopicNotificationEnvelopeBytes(wire: TopicWireFrameCandidate): {
  cliNdjsonBytes: number;
  channelSocketBytes: number;
  mobileRelayBytes: number;
  maxBytes: number;
} {
  const cliNdjsonBytes =
    utf8JsonByteLength({
      method: "v4/conversation/frame",
      params: wire,
    }) + 1;

  const wireJsonBytes = utf8JsonByteLength(wire);
  // @zcode/rpc serialization: Array tag+length+[EventFire,id], plus Object tag+length+JSON.
  // ChannelClient ids do not 31-bit wrap; past signed-int range serialize falls back to Object JSON,
  // so the worst-case header is sized as Number.MAX_SAFE_INTEGER's 16-byte JSON form.
  const maxEventIdJsonBytes = String(Number.MAX_SAFE_INTEGER).length;
  const maxEventIdSerializedBytes = 1 + vqlByteLength(maxEventIdJsonBytes) + maxEventIdJsonBytes;
  const channelHeaderBytes =
    1 +
    vqlByteLength(2) +
    1 +
    vqlByteLength(CHANNEL_EVENT_RESPONSE_TYPE) +
    maxEventIdSerializedBytes;
  const channelPayloadBytes = channelHeaderBytes + 1 + vqlByteLength(wireJsonBytes) + wireJsonBytes;
  // SocketProtocol/PersistentProtocol add a fixed 13-byte frame header outside the Channel payload.
  const channelSocketBytes = channelPayloadBytes + SOCKET_PROTOCOL_HEADER_BYTES;
  // The topic encoder keeps the legacy single-chunk outer as a conservative logical budget; production no longer sends that shape--
  // the Channel payload fragments again via the acknowledged raw adapter, metered by the final JSON.
  // The two budgets bound the topic logical frame and the relay physical frame; neither substitutes for the other.
  const dataBase64Bytes = 4 * Math.ceil(channelPayloadBytes / 3);
  const transportId = "x".repeat(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars);
  const mobileRelayFixedBytes = utf8JsonByteLength({
    type: "data",
    payload: {
      zcode_type: "rpc-frame",
      bridgeSessionId: transportId,
      bridgeGeneration: Number.MAX_SAFE_INTEGER,
      recoveryId: transportId,
      seq: Number.MAX_SAFE_INTEGER,
      dataBase64: "",
    },
    client_ts: Number.MAX_SAFE_INTEGER,
    server_ts: Number.MAX_SAFE_INTEGER,
  });
  const mobileRelayBytes = mobileRelayFixedBytes + dataBase64Bytes;
  return {
    cliNdjsonBytes,
    channelSocketBytes,
    mobileRelayBytes,
    maxBytes: Math.max(cliNdjsonBytes, channelSocketBytes, mobileRelayBytes),
  };
}

export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export class TopicWireFrameEncodingError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "TopicWireFrameEncodingError";
  }
}

function hardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TopicWireFrameEncodingError(`proto.invalidLimit.${name}`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

export interface EncodeTopicWireFramesOptions<F> {
  deliveryKind: TopicFrameDeliveryKind;
  topic: string;
  subscriptionId: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  maxPhysicalFrameBytes?: number;
  maxAssemblyBytes?: number;
  measurePhysicalFrameBytes(wire: TopicWireFrame<F>): number;
}

function makeFragment<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  dataBase64: string;
}): TopicWireFrame<F> {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "fragment",
    deliveryKind: params.options.deliveryKind,
    logicalFrameId: params.options.logicalFrameId,
    logicalFrameOrdinal: params.options.logicalFrameOrdinal,
    topic: params.options.topic,
    subscriptionId: params.options.subscriptionId,
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    logicalBytes: params.logicalBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

function findFragmentByteBudget<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  maxPhysicalFrameBytes: number;
}): number {
  let low = 1;
  let high = Math.min(params.logicalBytes, params.maxPhysicalFrameBytes);
  let best = 0;
  // Measured with worst-case index digits; a real fragment's envelope is only smaller.
  const worstCount = params.logicalBytes;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const dataBase64 = "A".repeat(4 * Math.ceil(candidate / 3));
    const wire = makeFragment({
      options: params.options,
      fragmentIndex: Math.max(0, worstCount - 1),
      fragmentCount: worstCount,
      logicalBytes: params.logicalBytes,
      checksum: params.checksum,
      dataBase64,
    });
    if (params.options.measurePhysicalFrameBytes(wire) <= params.maxPhysicalFrameBytes) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

export function encodeTopicWireFrames<F>(
  frame: F,
  options: EncodeTopicWireFramesOptions<F>,
): TopicWireFrame<F>[] {
  const maxPhysicalFrameBytes = hardBound(
    options.maxPhysicalFrameBytes,
    PROTOCOL_V4_LIMITS.maxFrameBytes,
    "maxPhysicalFrameBytes",
  );
  const maxAssemblyBytes = hardBound(
    options.maxAssemblyBytes,
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    "maxAssemblyBytes",
  );
  const logical = encodeJson(frame);
  if (logical.byteLength > maxAssemblyBytes) {
    throw new TopicWireFrameEncodingError("proto.frameAssemblyTooLarge");
  }

  const complete: TopicWireFrame<F> = {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: options.deliveryKind,
    logicalFrameId: options.logicalFrameId,
    logicalFrameOrdinal: options.logicalFrameOrdinal,
    topic: options.topic,
    subscriptionId: options.subscriptionId,
    frame,
  };
  if (options.measurePhysicalFrameBytes(complete) <= maxPhysicalFrameBytes) {
    return [complete];
  }

  const checksum: TopicWireChecksum = {
    algorithm: "crc32",
    value: crc32WireBytes(logical),
  };
  const chunkBytes = findFragmentByteBudget({
    options,
    logicalBytes: logical.byteLength,
    checksum,
    maxPhysicalFrameBytes,
  });
  if (chunkBytes < 1) {
    throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
  }
  const fragmentCount = Math.ceil(logical.byteLength / chunkBytes);
  if (fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    throw new TopicWireFrameEncodingError("proto.frameFragmentCountExceeded");
  }

  const frames: TopicWireFrame<F>[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, logical.byteLength);
    const wire = makeFragment({
      options,
      fragmentIndex,
      fragmentCount,
      logicalBytes: logical.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(logical.subarray(start, end)),
    });
    if (options.measurePhysicalFrameBytes(wire) > maxPhysicalFrameBytes) {
      // The physical cap includes the caller's real envelope; any estimation drift must
      // fail closed--never hand an over-cap frame downstream for silent truncation.
      throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
    }
    frames.push(wire);
  }
  return frames;
}
