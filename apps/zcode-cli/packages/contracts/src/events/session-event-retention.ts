import type { SessionEvent } from "./session.events.js";
import { SessionEventType } from "./session.events.js";

/**
 * Transient events that ride with the message stream.
 *
 * They still get seq from the event store and reach live sinks, but once their turn ends and a later turn supersedes
 * it they are evictable: the finished turn's text is re-synthesized from persisted messages, and reducer/rewind/fork/
 * checkpoint never consume these types.
 */
export const TRANSIENT_SESSION_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  SessionEventType.ModelStreaming,
  SessionEventType.ToolCallProgress,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ModelNetworkStatus,
]);

/**
 * Time-based fallback for sealed turns with no successor.
 * A subagent child session has one turn and never sees another turn_started; on real devices one child session left
 * ~10k deltas until the record was pooled. `collectExpired` runs on the 60s tick and evicts sealed turns past grace.
 */
export const SEALED_TURN_TRANSIENT_GRACE_MS = 120_000;

export function isTransientSessionEvent(event: Pick<SessionEvent, "type">): boolean {
  return TRANSIENT_SESSION_EVENT_TYPES.has(event.type);
}

/**
 * sealed turn 淘汰时 `model_request` 驻留副本的元数据瘦身（spec 同上"model_request 元数据瘦身"）。
 * Bug 根因：`messages` 是每次模型请求的完整上下文，每个工具迭代一条且作为非瞬态永久驻留；
 * compact 只截断后续请求，不回收已驻留事件，长会话实测 event store 驻留随轮次线性涨约 150MB。
 * 内存 store 的读者只用 `messages.length`，live sink（debug JSONL）拿的是 append 返回的完整对象，
 * 因此只把驻留副本换成 `messageCount`，事件 id / seq / 其它 payload 字段保持不变。
 */
export function slimRetainedModelRequest(event: SessionEvent): SessionEvent {
  if (event.type !== SessionEventType.ModelRequest) {
    return event;
  }
  const payload = event.payload as { messages?: unknown } | null | undefined;
  if (!payload || !Array.isArray(payload.messages)) {
    return event;
  }
  const { messages, ...metadata } = payload;
  return { ...event, payload: { ...metadata, messageCount: messages.length } } as SessionEvent;
}

export type SessionEventRetentionMode = "unbounded" | "turn-window";

export interface SessionEventRetentionPolicy {
  /**
   * Called once per append. Returns the turnIds whose transient events should be evicted; empty array means none.
   * The policy looks only at the event sequence, never at persistence outcomes.
   */
  onAppend(event: Pick<SessionEvent, "type" | "turnId">, nowMs: number): readonly string[];
  /**
   * Time-based fallback: returns sealed turnIds that ended before `nowMs - graceMs` with no successor turn,
   * removing them from the pending-eviction set. Called from the low-frequency tick.
   */
  collectExpired(nowMs: number, graceMs: number): readonly string[];
}

const NO_EVICTION: readonly string[] = [];

function createUnboundedRetention(): SessionEventRetentionPolicy {
  return { onAppend: () => NO_EVICTION, collectExpired: () => NO_EVICTION };
}

/**
 * Turn-window policy: `turn_complete` / `turn_error` only mark the turn sealed; the next `turn_started` evicts all
 * sealed turns' transient events at once (one-turn lag). Why lag: right after a turn ends its messages may not be
 * persisted yet and cold recovery still needs the in-memory transient events to reassemble text; a new turn means
 * the user sent another message, so the previous turn is guaranteed persisted.
 */
function createTurnWindowRetention(): SessionEventRetentionPolicy {
  const openTurns = new Set<string>();
  const sealedAt = new Map<string, number>();
  return {
    onAppend(event, nowMs) {
      const turnId = event.turnId;
      if (!turnId) {
        return NO_EVICTION;
      }
      switch (event.type) {
        case SessionEventType.TurnStarted: {
          const evict = [...sealedAt.keys()].filter((sealed) => sealed !== turnId);
          sealedAt.clear();
          openTurns.add(turnId);
          return evict;
        }
        case SessionEventType.TurnComplete:
        case SessionEventType.TurnError: {
          openTurns.delete(turnId);
          if (!sealedAt.has(turnId)) {
            sealedAt.set(turnId, nowMs);
          }
          return NO_EVICTION;
        }
        default:
          return NO_EVICTION;
      }
    },
    collectExpired(nowMs, graceMs) {
      const expired: string[] = [];
      for (const [turnId, at] of sealedAt) {
        if (nowMs - at >= graceMs) {
          expired.push(turnId);
        }
      }
      for (const turnId of expired) {
        sealedAt.delete(turnId);
      }
      return expired;
    },
  };
}

export function createSessionEventRetentionPolicy(
  mode: SessionEventRetentionMode,
): SessionEventRetentionPolicy {
  return mode === "unbounded" ? createUnboundedRetention() : createTurnWindowRetention();
}
