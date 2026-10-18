import type { SessionEventStorePort, SessionEventStoreStats } from "../interfaces/session.port.js";
import type { SessionId } from "../interfaces/shared.js";
import type { SessionEvent } from "./session.events.js";
import {
  createSessionEventRetentionPolicy,
  isTransientSessionEvent,
  SEALED_TURN_TRANSIENT_GRACE_MS,
  slimRetainedModelRequest,
  type SessionEventRetentionMode,
  type SessionEventRetentionPolicy,
} from "./session-event-retention.js";

export interface InMemorySessionEventStoreOptions {
  /** Defaults to `turn-window`; `unbounded` for rollback and control tests. A custom per-session policy factory is injectable. */
  retention?: SessionEventRetentionMode | (() => SessionEventRetentionPolicy);
  /** Clock for tests; production uses Date.now. */
  now?: () => number;
}

interface SessionEventState {
  events: SessionEvent[];
  latestSequenceNumber: number;
  policy: SessionEventRetentionPolicy;
  evictedEvents: number;
}

/**
 * In-process session event store.
 *
 * It is the single source of live/replay/snapshot sequence numbers, so every event gets its seq via `append`;
 * transient events, though, only persist per turn window, and sealed buckets superseded by the next turn are
 * evicted from memory. Copying the full array per append with no eviction would grow memory linearly with tokens
 * in long sessions.
 */
export class InMemorySessionEventStore implements SessionEventStorePort {
  private readonly sessions = new Map<SessionId, SessionEventState>();
  private readonly createPolicy: () => SessionEventRetentionPolicy;
  private readonly now: () => number;

  constructor(options: InMemorySessionEventStoreOptions = {}) {
    const retention = options.retention ?? "turn-window";
    this.createPolicy =
      typeof retention === "function"
        ? retention
        : () => createSessionEventRetentionPolicy(retention);
    this.now = options.now ?? (() => Date.now());
  }

  private stateFor(sessionId: SessionId): SessionEventState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        events: [],
        latestSequenceNumber: 0,
        policy: this.createPolicy(),
        evictedEvents: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  async append(event: SessionEvent): Promise<SessionEvent> {
    const state = this.stateFor(event.sessionId);
    const sequenceNumber =
      event.sequenceNumber > 0 ? event.sequenceNumber : state.latestSequenceNumber + 1;
    // The counter never decreases: eviction must not let a later getLatestSequenceNumber()+1 mint duplicate seqs.
    state.latestSequenceNumber = Math.max(state.latestSequenceNumber, sequenceNumber);
    const storedEvent = { ...event, sequenceNumber };
    state.events.push(storedEvent);
    const evictTurnIds = state.policy.onAppend(storedEvent, this.now());
    if (evictTurnIds.length > 0) {
      this.evictTransientEvents(state, new Set(evictTurnIds));
    }
    return storedEvent;
  }

  /**
   * Time-based fallback (from the low-frequency 60s tick): evict transient events of sealed turns whose grace has
   * elapsed and that have no successor turn. Covers one-shot sessions such as subagent children. Returns the evicted count.
   */
  pruneTransientEvents(
    nowMs: number = this.now(),
    graceMs: number = SEALED_TURN_TRANSIENT_GRACE_MS,
  ): number {
    let evicted = 0;
    for (const state of this.sessions.values()) {
      const expired = state.policy.collectExpired(nowMs, graceMs);
      if (expired.length === 0) {
        continue;
      }
      const before = state.evictedEvents;
      this.evictTransientEvents(state, new Set(expired));
      evicted += state.evictedEvents - before;
    }
    return evicted;
  }

  private evictTransientEvents(state: SessionEventState, turnIds: ReadonlySet<string>): void {
    const retained: SessionEvent[] = [];
    for (const event of state.events) {
      if (isTransientSessionEvent(event) && event.turnId && turnIds.has(event.turnId)) {
        state.evictedEvents += 1;
        continue;
      }
      // Same eviction beat: a sealed, persisted turn keeps only metadata on its model_request copy.
      retained.push(
        event.turnId && turnIds.has(event.turnId) ? slimRetainedModelRequest(event) : event,
      );
    }
    state.events = retained;
  }

  async getEvents(sessionId: SessionId): Promise<SessionEvent[]> {
    return [...(this.sessions.get(sessionId)?.events ?? [])];
  }

  async getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]> {
    return (this.sessions.get(sessionId)?.events ?? []).filter(
      (event) => event.sequenceNumber > sequenceNumber,
    );
  }

  async getLatestSequenceNumber(sessionId: SessionId): Promise<number> {
    return this.sessions.get(sessionId)?.latestSequenceNumber ?? 0;
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** Resident size for memory diagnostics; counts lengths only, no copies. */
  getStats(): SessionEventStoreStats {
    let events = 0;
    let evictedEvents = 0;
    let retainedTransient = 0;
    for (const state of this.sessions.values()) {
      events += state.events.length;
      evictedEvents += state.evictedEvents;
      for (const event of state.events) {
        if (isTransientSessionEvent(event)) {
          retainedTransient += 1;
        }
      }
    }
    return { sessions: this.sessions.size, events, evictedEvents, retainedTransient };
  }
}

export function createInMemorySessionEventStore(
  options?: InMemorySessionEventStoreOptions,
): InMemorySessionEventStore {
  return new InMemorySessionEventStore(options);
}
