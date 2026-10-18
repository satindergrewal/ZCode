type ProgressSubscriber = {
  reading: boolean;
  poll: (isActive: () => boolean) => Promise<void>;
};
type PollingGroup = {
  subscribers: Set<ProgressSubscriber>;
  timer: NodeJS.Timeout;
};

// Shared interval by design: the product runs a single 1s poller; custom periods do not change others' cadence.
const pollingGroups = new Map<number, PollingGroup>();

export function subscribeBashOutputProgress(
  intervalMs: number,
  poll: ProgressSubscriber["poll"],
): () => void {
  let group = pollingGroups.get(intervalMs);
  if (!group) {
    const subscribers = new Set<ProgressSubscriber>();
    const timer = setInterval(() => {
      for (const subscriber of subscribers) {
        if (subscriber.reading) continue;
        subscriber.reading = true;
        const isActive = () => subscribers.has(subscriber);
        void Promise.resolve()
          .then(() => {
            if (isActive()) return subscriber.poll(isActive);
          })
          // Preview is best-effort; one file or callback failure must not stop other Bash progress.
          .catch(() => undefined)
          .finally(() => {
            subscriber.reading = false;
          });
      }
    }, intervalMs);
    timer.unref();
    group = { subscribers, timer };
    pollingGroups.set(intervalMs, group);
  }
  const subscriber = { reading: false, poll };
  const { subscribers, timer } = group;
  subscribers.add(subscriber);
  return () => {
    // Re-cleanup of an old subscription must not remove a newer poller at the same period.
    if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
    clearInterval(timer);
    pollingGroups.delete(intervalMs);
  };
}
