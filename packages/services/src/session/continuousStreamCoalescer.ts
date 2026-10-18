import type { ZCodeStreamEvent } from "@zcode/shared";

const CONTINUOUS_CHUNK_FLUSH_DELAY_MS = 16;
const CONTINUOUS_CHUNK_MAX_CHARS = 4096;
const CONTINUOUS_CHUNK_MAX_EVENTS = 128;
const CONTINUOUS_CHUNK_KEY_SEPARATOR = "\u0000";

type ContinuousCoalescibleChunk =
  | Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }>
  | Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" }>;

type ContinuousCoalescibleState =
  | Extract<ZCodeStreamEvent, { type: "usage_update" }>
  | Extract<ZCodeStreamEvent, { type: "session_info_update" }>;

interface PendingContinuousChunkItem {
  kind: "chunk";
  event: ContinuousCoalescibleChunk;
  chunkCount: number;
  charCount: number;
}

interface PendingContinuousStateItem {
  kind: "state";
  event: ContinuousCoalescibleState;
  stateKey: string;
}

type PendingContinuousItem = PendingContinuousChunkItem | PendingContinuousStateItem;

interface ContinuousStreamCoalescer {
  accept(event: ZCodeStreamEvent): void;
  flush(): void;
  dispose(): void;
}

function isContinuousCoalescibleChunk(
  event: ZCodeStreamEvent,
): event is ContinuousCoalescibleChunk {
  return (
    event.type === "agent_thought_chunk" ||
    (event.type === "agent_message_chunk" && !event.zcodeTimeline)
  );
}

function isContinuousCoalescibleState(
  event: ZCodeStreamEvent,
): event is ContinuousCoalescibleState {
  if (event.type === "usage_update") {
    return true;
  }

  // Bugfix: api_retry floods session_info_update, yet title/target are session metadata changes.
  // Coalesce retry state only, or delayed title/target patches desync the task list and target display.
  return (
    event.type === "session_info_update" &&
    event.title === undefined &&
    event.target === undefined &&
    "apiRetry" in event
  );
}

function normalizeChunkParentToolUseId(event: ContinuousCoalescibleChunk): string {
  return event.parentToolUseId ?? "";
}

function getContinuousChunkMergeKey(event: ContinuousCoalescibleChunk): string {
  return [
    event.type,
    event.taskId,
    event.traceId,
    normalizeChunkParentToolUseId(event),
    event.type === "agent_message_chunk" ? (event.messageId ?? "") : "",
  ].join(CONTINUOUS_CHUNK_KEY_SEPARATOR);
}

function getContinuousStateMergeKey(event: ContinuousCoalescibleState): string {
  return [event.type, event.taskId, event.traceId].join(CONTINUOUS_CHUNK_KEY_SEPARATOR);
}

function mergeContinuousChunks(
  current: ContinuousCoalescibleChunk,
  next: ContinuousCoalescibleChunk,
): ContinuousCoalescibleChunk {
  return {
    ...current,
    content: `${current.content}${next.content}`,
  };
}

export function createContinuousStreamCoalescer(params: {
  emit: (event: ZCodeStreamEvent) => void;
  flushDelayMs?: number;
  maxChars?: number;
  maxEvents?: number;
}): ContinuousStreamCoalescer {
  const flushDelayMs = params.flushDelayMs ?? CONTINUOUS_CHUNK_FLUSH_DELAY_MS;
  const maxChars = params.maxChars ?? CONTINUOUS_CHUNK_MAX_CHARS;
  const maxEvents = params.maxEvents ?? CONTINUOUS_CHUNK_MAX_EVENTS;
  let pendingItems: PendingContinuousItem[] = [];
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
    if (pendingItems.length === 0) {
      clearFlushTimer();
      return;
    }
    const events = pendingItems.map((item) => item.event);
    pendingItems = [];
    clearFlushTimer();
    for (const event of events) {
      params.emit(event);
    }
  }

  function scheduleFlush(): void {
    if (flushTimer || disposed || flushDelayMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, flushDelayMs);
  }

  function startPendingChunk(event: ContinuousCoalescibleChunk): void {
    pendingItems.push({
      kind: "chunk",
      event,
      chunkCount: 1,
      charCount: event.content.length,
    });
    if (event.content.length >= maxChars || pendingItems.length >= maxEvents || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  function acceptPendingState(event: ContinuousCoalescibleState): void {
    const stateKey = getContinuousStateMergeKey(event);
    const existingItem = pendingItems.find(
      (item): item is PendingContinuousStateItem =>
        item.kind === "state" && item.stateKey === stateKey,
    );
    if (existingItem) {
      existingItem.event = event;
      return;
    }

    // Bugfix: usage/apiRetry state events arrive at body-stream frequency. Forwarding each one to desktop continuous
    // makes the renderer rewrite the store per event; keep only the latest per frame to preserve UI semantics.
    pendingItems.push({ kind: "state", event, stateKey });
    if (pendingItems.length >= maxEvents || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  return {
    accept(event: ZCodeStreamEvent): void {
      if (disposed) {
        return;
      }

      if (isContinuousCoalescibleState(event)) {
        acceptPendingState(event);
        return;
      }

      if (!isContinuousCoalescibleChunk(event)) {
        // Bugfix: desktop continuous used to push thousands of 1-5 char chunks as individual RPCs,
        // queueing terminal/sendPrompt returns behind them. Flush before structured events,
        // preserving tool/permission/snapshot/terminal ordering while collapsing body text to frame granularity.
        flushPending();
        params.emit(event);
        return;
      }

      const lastItem = pendingItems[pendingItems.length - 1];
      if (!lastItem) {
        startPendingChunk(event);
        return;
      }

      if (
        lastItem.kind !== "chunk" ||
        getContinuousChunkMergeKey(lastItem.event) !== getContinuousChunkMergeKey(event)
      ) {
        startPendingChunk(event);
        return;
      }

      const nextItem: PendingContinuousChunkItem = {
        kind: "chunk",
        event: mergeContinuousChunks(lastItem.event, event),
        chunkCount: lastItem.chunkCount + 1,
        charCount: lastItem.charCount + event.content.length,
      };
      pendingItems[pendingItems.length - 1] = nextItem;
      if (nextItem.charCount >= maxChars || nextItem.chunkCount >= maxEvents) {
        flushPending();
      }
    },

    flush(): void {
      flushPending();
    },

    dispose(): void {
      disposed = true;
      pendingItems = [];
      clearFlushTimer();
    },
  };
}
