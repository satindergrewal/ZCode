// subscribe ACK activation barrier: notifications may reach the renderer before the RPC response.
// The transport stages by topic with a bound; the store activates explicitly once it writes the ACK subscriptionId;
// only the physical wire stages here; logical assembly runs once ownership activates.
interface PendingFrameSubscription<T> {
  topic: string;
  subscriptionId: string | null;
  frames: T[];
  stagedBytes: number;
  overflowReason: string | null;
}

const MAX_STAGED_FRAMES = 1024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const STAGING_OVERFLOW_REASON = "fault.subscription.initialFrameStagingOverflow";

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

interface AckActivationBarrier<T extends { topic: string; subscriptionId: string }> {
  begin(topic: string): object;
  bind(token: object, subscriptionId: string): void;
  cancel(token: object): void;
  activate(
    subscriptionId: string,
  ): { topic: string; previousSubscriptionId: string | null } | undefined;
  forget(subscriptionId: string): void;
  accept(frame: T): void;
  /** Runtime/attachment generation invalidation: drop all active/pending ownership. */
  clear(): void;
}

/** Transport-local physical-wire barrier; concurrent same-topic pendings each wait for their ACK to win ownership. */
export function createAckActivationBarrier<T extends { topic: string; subscriptionId: string }>(
  deliver: (frame: T) => void,
): AckActivationBarrier<T> {
  const pendingByTopic = new Map<string, Set<PendingFrameSubscription<T>>>();
  const pendingBySubscriptionId = new Map<string, PendingFrameSubscription<T>>();
  const activeByTopic = new Map<string, string>();
  const topicByActiveSubscription = new Map<string, string>();

  const removePending = (pending: PendingFrameSubscription<T>): void => {
    const group = pendingByTopic.get(pending.topic);
    group?.delete(pending);
    if (group?.size === 0) pendingByTopic.delete(pending.topic);
    if (pending.subscriptionId) {
      pendingBySubscriptionId.delete(pending.subscriptionId);
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  return {
    begin(topic) {
      const pending: PendingFrameSubscription<T> = {
        topic,
        subscriptionId: null,
        frames: [],
        stagedBytes: 0,
        overflowReason: null,
      };
      const group = pendingByTopic.get(topic) ?? new Set();
      group.add(pending);
      pendingByTopic.set(topic, group);
      return pending;
    },
    bind(token, subscriptionId) {
      const pending = token as PendingFrameSubscription<T>;
      if (pending.overflowReason) {
        const reason = pending.overflowReason;
        removePending(pending);
        throw new Error(reason);
      }
      pending.subscriptionId = subscriptionId;
      pendingBySubscriptionId.set(subscriptionId, pending);
    },
    cancel(token) {
      removePending(token as PendingFrameSubscription<T>);
    },
    activate(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (!pending) return;
      const previous = activeByTopic.get(pending.topic);
      if (previous && previous !== subscriptionId) {
        topicByActiveSubscription.delete(previous);
      }
      activeByTopic.set(pending.topic, subscriptionId);
      topicByActiveSubscription.set(subscriptionId, pending.topic);
      const frames = pending.frames.filter((frame) => frame.subscriptionId === subscriptionId);
      removePending(pending);
      for (const frame of frames) deliver(frame);
      return {
        topic: pending.topic,
        previousSubscriptionId: previous ?? null,
      };
    },
    forget(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (pending) removePending(pending);
      const topic = topicByActiveSubscription.get(subscriptionId);
      if (topic && activeByTopic.get(topic) === subscriptionId) {
        activeByTopic.delete(topic);
      }
      topicByActiveSubscription.delete(subscriptionId);
    },
    accept(frame) {
      if (activeByTopic.get(frame.topic) === frame.subscriptionId) {
        deliver(frame);
        return;
      }
      const group = pendingByTopic.get(frame.topic);
      if (!group) return;
      const bytes = encodedBytes(frame);
      for (const pending of group) {
        if (pending.overflowReason) continue;
        if (
          bytes > MAX_STAGED_BYTES ||
          pending.frames.length + 1 > MAX_STAGED_FRAMES ||
          pending.stagedBytes + bytes > MAX_STAGED_BYTES
        ) {
          // Trimming from the head to hold the cap leaves a physical batch that looks activatable
          // but is missing slices. Out-of-range must clear the whole batch and fail the subscribe explicitly.
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = STAGING_OVERFLOW_REASON;
          continue;
        }
        pending.frames.push(frame);
        pending.stagedBytes += bytes;
      }
    },
    clear() {
      for (const group of pendingByTopic.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
        }
      }
      pendingByTopic.clear();
      pendingBySubscriptionId.clear();
      activeByTopic.clear();
      topicByActiveSubscription.clear();
    },
  };
}
