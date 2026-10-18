import type { Stats } from "node:fs";

export type ObserveLockInstance = (lockPath: string, lockStat: Stats, observedAt: number) => number;

export function createLockInstanceObserver(): ObserveLockInstance {
  const observations = new Map<string, { firstObservedAt: number; identity: string }>();

  return (lockPath, lockStat, observedAt) => {
    const identity = [lockStat.dev, lockStat.ino, lockStat.birthtimeMs, lockStat.mtimeMs].join(":");
    const previous = observations.get(lockPath);
    if (previous?.identity === identity) {
      return previous.firstObservedAt;
    }

    // With two invalid timestamps, grace starts only from when this lock instance was first seen.
    // A later writer replacing the lock must reset the wait; never inherit waiters' time on the old lock.
    observations.set(lockPath, { firstObservedAt: observedAt, identity });
    return observedAt;
  };
}
