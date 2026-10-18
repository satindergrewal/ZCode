import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Registers runtime-owned work that escapes the current synchronous stack.
 *
 * The session-resident pool watched only the active turn and task registry; title, MCP startup,
 * ledger writes and other detached Promises appear in neither and could be reaped as idle mid-use.
 * The count increments in the launch synchronous slice and releases only in finally.
 */
export function trackResidencyBlockingWork<T>(
  this: AgentRuntimeInternal,
  work: Promise<T>,
): Promise<T> {
  this.residencyBlockingWorkCount += 1;
  return work.finally(() => {
    this.residencyBlockingWorkCount = Math.max(0, this.residencyBlockingWorkCount - 1);
  });
}

/** The resident pool consumes this one entry; new sidecars no longer edit the bootstrap guess list. */
export function hasResidencyBlockingWork(this: AgentRuntimeInternal): boolean {
  return (
    this.hasActiveOrQueuedTurnWork() ||
    this.hasRunningBackgroundTasks() ||
    this.residencyBlockingWorkCount > 0 ||
    (this.memoryExtractionScheduler?.hasPendingWork() ?? false) ||
    (this.memoryRecallPrefetch !== undefined && !this.memoryRecallPrefetch.settled)
  );
}
