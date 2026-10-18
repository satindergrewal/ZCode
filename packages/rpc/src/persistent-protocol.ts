/**
 * PersistentProtocol -- the reliability layer (split out of protocol.ts to bound file size).
 *
 * Adds on top of SocketProtocol:
 * - message ACK bookkeeping
 * - keep-alive heartbeats
 * - replay of unacknowledged messages on reconnect (bounded: byte cap + grace window)
 * - congestion signal: unacknowledgedBytes watermark + onSaturated/onDrained
 *   (the only frame-level-to-event-level surface; event layers pause draining with it,
 *   while drop/downgrade always happens in the channel layer before rpc -- a frame
 *   handed to send() is never lost)
 *
 * Key: the Channel RPC layer never knows PersistentProtocol exists -- it only sees
 * IMessagePassingProtocol. That is the power of the layering.
 */

import { VSBuffer } from "./buffer.js";
import { Emitter, DisposableStore } from "./foundation.js";
import {
  ChunkStream,
  HEADER_SIZE,
  ProtocolMessage,
  ProtocolMessageType,
  writeProtocolMessage,
  type ConnectionFlowControl,
  type IMessagePassingProtocol,
  type ISocket,
} from "./protocol.js";

/** PersistentProtocol tunables (v4 channel-layer patch). */
export interface PersistentProtocolOptions {
  /** Unacked-byte high watermark: crossing fires onSaturated (upper layers pause drain; coalesce absorbs). */
  saturationHighWaterMarkBytes?: number;
  /** Unacked-byte low watermark: falling back to it fires onDrained (upper layers resume drain). */
  saturationLowWaterMarkBytes?: number;
  /** Replay buffer byte cap: exceeding it abandons the protocol session (onClose); clients recover via subscribe(base). */
  replayBufferMaxBytes?: number;
  /** Replay buffer grace window (ms): an over-age unacked message also abandons the session. */
  replayBufferGraceMs?: number;
}

interface UnackEntry {
  msg: ProtocolMessage;
  queuedAt: number;
}

export class PersistentProtocol implements IMessagePassingProtocol, ConnectionFlowControl {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  private readonly _onClose = new Emitter<void>();
  readonly onClose = this._onClose.event;

  private readonly _onSocketClose = new Emitter<void>();
  readonly onSocketClose = this._onSocketClose.event;

  // Congestion signal: high watermark saturates -> onSaturated; falling back -> onDrained.
  private readonly _onSaturated = new Emitter<void>();
  readonly onSaturated = this._onSaturated.event;

  private readonly _onDrained = new Emitter<void>();
  readonly onDrained = this._onDrained.event;

  private socket: ISocket;
  private chunkStream = new ChunkStream();
  private disposables = new DisposableStore();

  // ACK bookkeeping (bounded queue; entries carry their enqueue time for grace-window checks)
  private outgoingMsgId = 0;
  private outgoingUnackMsg: UnackEntry[] = [];
  private incomingAckId = 0;
  private unackBytes = 0;
  private saturated = false;
  private overflowed = false;

  // Keep-alive
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly KEEP_ALIVE_INTERVAL = 5000; // 5s

  // ACK timeout
  private ackCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ACK_TIMEOUT = 20000; // drop after 20s without an ACK
  private lastAckTime = Date.now();

  // Watermark/cap defaults: high watermark 1MiB (approx. the v4 single-frame cap),
  // low watermark a quarter of it; replay buffer 8MiB / 45s -- abandon the session
  // instead of growing the heap unboundedly when the peer sleeps or never ACKs.
  private readonly saturationHighWaterMarkBytes: number;
  private readonly saturationLowWaterMarkBytes: number;
  private readonly replayBufferMaxBytes: number;
  private readonly replayBufferGraceMs: number;

  constructor(socket: ISocket, options: PersistentProtocolOptions = {}) {
    this.saturationHighWaterMarkBytes = options.saturationHighWaterMarkBytes ?? 1024 * 1024;
    this.saturationLowWaterMarkBytes =
      options.saturationLowWaterMarkBytes ?? Math.floor(this.saturationHighWaterMarkBytes / 4);
    this.replayBufferMaxBytes = options.replayBufferMaxBytes ?? 8 * 1024 * 1024;
    this.replayBufferGraceMs = options.replayBufferGraceMs ?? 45_000;
    this.socket = socket;
    this.bindSocket();
    this.startKeepAlive();
    this.startAckCheck();
  }

  /** Payload bytes not yet ACKed by the peer (read-only congestion observation). */
  get unacknowledgedBytes(): number {
    return this.unackBytes;
  }

  private bindSocket(): void {
    this.disposables.add(
      this.socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        this.readMessages();
      }),
    );

    this.disposables.add(
      this.socket.onClose(() => {
        this._onSocketClose.fire();
      }),
    );
  }

  send(buffer: VSBuffer): void {
    const msg = new ProtocolMessage(
      ProtocolMessageType.Regular,
      ++this.outgoingMsgId,
      this.incomingAckId,
      buffer,
    );
    this.outgoingUnackMsg.push({ msg, queuedAt: Date.now() });
    this.unackBytes += buffer.byteLength;
    this.writeMessage(msg);
    // Replay buffer over the byte cap -> abandon the session (synchronous, no timer wait).
    if (this.unackBytes > this.replayBufferMaxBytes) {
      this.abandonSession();
      return;
    }
    // Crossing the high watermark saturates (edge-triggered, no repeat notifications).
    if (!this.saturated && this.unackBytes > this.saturationHighWaterMarkBytes) {
      this.saturated = true;
      this._onSaturated.fire();
    }
  }

  /**
   * Replace the underlying socket on reconnect and replay every unacknowledged message.
   * This is why Remote mode loses no messages across a disconnect.
   */
  replaceSocket(newSocket: ISocket): void {
    this.disposables.dispose();
    this.disposables = new DisposableStore();
    this.chunkStream = new ChunkStream();
    this.socket = newSocket;
    this.bindSocket();

    // Replay unacknowledged messages
    for (const entry of this.outgoingUnackMsg) {
      this.writeMessage(entry.msg);
    }
  }

  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  private readMessages(): void {
    while (true) {
      if (this.chunkStream.byteLength < HEADER_SIZE) {
        break;
      }

      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      const type = header.readUInt8(0) as ProtocolMessageType;
      const id = header.readUInt32BE(1);
      const ack = header.readUInt32BE(5);
      const length = header.readUInt32BE(9);

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // Like SocketProtocol, this runs over a stream: consume the header only once the
        // whole frame is buffered, or fragmentation would eat the message header.
        break;
      }

      this.chunkStream.skip(HEADER_SIZE);

      let body = VSBuffer.alloc(0);
      if (length > 0) {
        const readBody = this.chunkStream.read(length);
        if (!readBody) {
          throw new Error("PersistentProtocol: body must not be empty once the full frame length is known");
        }
        body = readBody;
      }

      // Apply the peer ACK: drop acknowledged entries from the send queue
      this.processAck(ack);

      switch (type) {
        case ProtocolMessageType.Regular:
          this.incomingAckId = id;
          this._onMessage.fire(body);
          break;
        case ProtocolMessageType.Ack:
          // Pure ACK: only the sequence number matters
          break;
        case ProtocolMessageType.KeepAlive:
          // Heartbeat: refresh last-activity time
          break;
        case ProtocolMessageType.Disconnect:
          this._onClose.fire();
          break;
      }

      this.lastAckTime = Date.now();
    }
  }

  /** Drop messages acknowledged by the peer ACK number */
  private processAck(ack: number): void {
    while (this.outgoingUnackMsg.length > 0 && this.outgoingUnackMsg[0].msg.id <= ack) {
      const entry = this.outgoingUnackMsg.shift()!;
      this.unackBytes -= entry.msg.data.byteLength;
    }
    // Falling back to the low watermark after saturation -> onDrained (edge-triggered).
    if (this.saturated && this.unackBytes <= this.saturationLowWaterMarkBytes) {
      this.saturated = false;
      this._onDrained.fire();
    }
  }

  /**
   * Replay buffer exceeded (bytes/grace window): lossless continuation is impossible.
   * Disconnect via onClose; clients recover at the semantic layer with subscribe(base).
   */
  private abandonSession(): void {
    if (this.overflowed) {
      return;
    }
    this.overflowed = true;
    this.writeMessage(
      new ProtocolMessage(ProtocolMessageType.Disconnect, 0, this.incomingAckId, VSBuffer.alloc(0)),
    );
    this._onClose.fire();
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      this.writeMessage(
        new ProtocolMessage(
          ProtocolMessageType.KeepAlive,
          0,
          this.incomingAckId,
          VSBuffer.alloc(0),
        ),
      );
    }, this.KEEP_ALIVE_INTERVAL);
  }

  private startAckCheck(): void {
    this.ackCheckTimer = setInterval(() => {
      if (this.outgoingUnackMsg.length > 0 && Date.now() - this.lastAckTime > this.ACK_TIMEOUT) {
        this._onSocketClose.fire();
      }
      // Oldest unacked message beyond the grace window (peer asleep/backgrounded) -> abandon.
      const oldest = this.outgoingUnackMsg[0];
      if (oldest && Date.now() - oldest.queuedAt > this.replayBufferGraceMs) {
        this.abandonSession();
      }
    }, this.ACK_TIMEOUT);
  }

  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }
    if (this.ackCheckTimer) {
      clearInterval(this.ackCheckTimer);
    }
    this.disposables.dispose();
    this._onMessage.dispose();
    this._onClose.dispose();
    this._onSocketClose.dispose();
    this._onSaturated.dispose();
    this._onDrained.dispose();
    this.socket.dispose();
  }
}
