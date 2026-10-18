import type { ZCodeSessionEvent } from "@zcode/shared";
import type { ZCodeAgentServiceEvent } from "#src/zcode-agent/zcodeAgent.js";

const DEFAULT_BACKGROUND_SESSION_EVENT_COALESCE_MS = 1_500;
const DEFAULT_BACKGROUND_SESSION_EVENT_MAX_ITEMS = 96;
const SESSION_EVENT_KEY_SEPARATOR = "\u0000";
const COALESCIBLE_MODEL_STREAMING_KINDS = new Set([
  "text_delta",
  "reasoning_delta",
  "tool_input_delta",
]);

type SessionServiceEvent = Extract<ZCodeAgentServiceEvent, { type: "session.event" }>;

interface PendingBackgroundSessionEvent {
  key: string;
  event: SessionServiceEvent;
}

export interface BackgroundSessionEventCoalescer {
  accept(event: ZCodeAgentServiceEvent): void;
  flush(): void;
  dispose(): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getBackgroundSessionEventCoalesceKey(event: ZCodeSessionEvent): string | null {
  const payload = asRecord(event.payload);
  if (event.type === "model.streaming") {
    const kind = stringField(payload, "kind");
    if (!kind || !COALESCIBLE_MODEL_STREAMING_KINDS.has(kind)) {
      return null;
    }
    if (stringField(payload, "delta") === undefined) {
      return null;
    }
    return [
      event.type,
      event.sessionId,
      event.turnId ?? "",
      kind,
      stringField(payload, "inputId") ?? "",
      stringField(payload, "assistantMessageId") ?? "",
      stringField(payload, "toolCallId") ?? "",
      stringField(payload, "parentToolUseId") ?? "",
      stringField(payload, "parentToolCallId") ?? "",
    ].join(SESSION_EVENT_KEY_SEPARATOR);
  }

  if (event.type === "tool.updated" && stringField(payload, "kind") === "progress") {
    return [
      event.type,
      event.sessionId,
      event.turnId ?? "",
      stringField(payload, "inputId") ?? "",
      stringField(payload, "toolCallId") ?? "",
    ].join(SESSION_EVENT_KEY_SEPARATOR);
  }

  if (event.type === "streamRecovery.updated") {
    return [
      event.type,
      event.sessionId,
      event.turnId ?? "",
      stringField(payload, "inputId") ?? "",
      event.traceId ?? "",
    ].join(SESSION_EVENT_KEY_SEPARATOR);
  }

  return null;
}

function mergeBackgroundSessionEvents(
  current: ZCodeSessionEvent,
  next: ZCodeSessionEvent,
): ZCodeSessionEvent {
  if (current.type === "model.streaming" && next.type === "model.streaming") {
    const currentPayload = asRecord(current.payload);
    const nextPayload = asRecord(next.payload);
    const currentDelta = stringField(currentPayload, "delta") ?? "";
    const nextDelta = stringField(nextPayload, "delta") ?? "";
    return {
      ...next,
      payload: {
        ...nextPayload,
        delta: `${currentDelta}${nextDelta}`,
      },
    } as ZCodeSessionEvent;
  }

  // Perf: background tool progress only feeds the still-running summary; latest state is enough.
  return next;
}

export function createBackgroundSessionEventCoalescer(params: {
  emit: (event: ZCodeAgentServiceEvent) => void;
  flushDelayMs?: number;
  maxItems?: number;
}): BackgroundSessionEventCoalescer {
  const flushDelayMs = params.flushDelayMs ?? DEFAULT_BACKGROUND_SESSION_EVENT_COALESCE_MS;
  const maxItems = params.maxItems ?? DEFAULT_BACKGROUND_SESSION_EVENT_MAX_ITEMS;
  let pendingEvents: PendingBackgroundSessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearFlushTimer(): void {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function flushPending(): void {
    if (pendingEvents.length === 0) {
      clearFlushTimer();
      return;
    }
    const events = pendingEvents.map((item) => item.event);
    pendingEvents = [];
    clearFlushTimer();
    for (const event of events) {
      params.emit(event);
    }
  }

  function scheduleFlush(): void {
    if (disposed || flushTimer || flushDelayMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!disposed) {
        flushPending();
      }
    }, flushDelayMs);
  }

  function acceptSessionEvent(event: SessionServiceEvent): void {
    const key = getBackgroundSessionEventCoalesceKey(event.event);
    if (!key) {
      // Downsampling may only drop reassemblable deltas. Permission/terminal/tool-result events
      // flush the pending summary first, preserving task interaction boundaries.
      flushPending();
      params.emit(event);
      return;
    }

    const existing = pendingEvents.find((item) => item.key === key);
    if (existing) {
      existing.event = {
        type: "session.event",
        event: mergeBackgroundSessionEvents(existing.event.event, event.event),
      };
    } else {
      pendingEvents.push({ key, event });
    }

    if (pendingEvents.length >= maxItems || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  return {
    accept(event: ZCodeAgentServiceEvent): void {
      if (disposed) {
        return;
      }
      if (event.type !== "session.event") {
        flushPending();
        params.emit(event);
        return;
      }
      acceptSessionEvent(event);
    },

    flush(): void {
      flushPending();
    },

    dispose(): void {
      // When the foreground takes over the background subscription the coalescer is disposed;
      // pending text/reasoning deltas are user-visible content, not disposable cleanup,
      // or the resumed message starts mid-way at the next delta.
      flushPending();
      disposed = true;
      clearFlushTimer();
    },
  };
}
