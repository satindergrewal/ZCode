import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";

export interface PendingGuideQueueProjection {
  pendingGuides: readonly QueueItem[];
  visibleQueue: QueueState;
}

/**
 * The CLI carries guided input and the future queue in one queue fact; the old UI rendered
 * queue.items directly, painting a guide awaiting model-step injection as the next message.
 * Split display by the authoritative admitted delivery only - no copying, no rewriting of
 * accepted-input state.
 */
export function projectPendingGuideQueue(
  queue: QueueState,
): PendingGuideQueueProjection {
  const pendingGuides: QueueItem[] = [];
  const visibleItems: QueueItem[] = [];
  for (const item of queue.items) {
    if (item.delivery.admitted === "guide") {
      pendingGuides.push(item);
    } else {
      visibleItems.push(item);
    }
  }
  return {
    pendingGuides,
    visibleQueue:
      visibleItems.length === queue.items.length
        ? queue
        : { ...queue, items: visibleItems },
  };
}
