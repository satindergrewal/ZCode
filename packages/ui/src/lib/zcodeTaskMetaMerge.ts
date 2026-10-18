import type { ZCodeTaskMeta } from "@zcode/shared";

function hasOwnTaskMetaField<T extends keyof ZCodeTaskMeta>(task: ZCodeTaskMeta, key: T) {
  return Object.prototype.hasOwnProperty.call(task, key);
}

function isPlaceholderTaskTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  return normalizedTitle.length === 0 || normalizedTitle === "new session";
}

function resolveMergedTaskTitle(preferredTask: ZCodeTaskMeta, fallbackTask: ZCodeTaskMeta): string {
  if (fallbackTask.titleOverridden && !preferredTask.titleOverridden) {
    return fallbackTask.title;
  }
  // session/send ACKs immediately, so the post-ACK readSession can precede the background first_input title projection.
  // The snapshot then carries the agent default placeholder "New session"; with a newer updatedAt, the old merge
  // briefly clobbered the optimistic query title. Only empty/placeholder titles yield to real ones; generated titles still win.
  if (isPlaceholderTaskTitle(preferredTask.title) && !isPlaceholderTaskTitle(fallbackTask.title)) {
    return fallbackTask.title;
  }
  return preferredTask.title;
}

export function mergeTaskWithOptimisticMeta(
  task: ZCodeTaskMeta,
  optimisticTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const shouldKeepOptimisticTask =
    optimisticTask.updatedAt > task.updatedAt ||
    (optimisticTask.updatedAt === task.updatedAt &&
      optimisticTask.title.length > task.title.length);
  const preferredTask = shouldKeepOptimisticTask ? optimisticTask : task;
  const fallbackTask = shouldKeepOptimisticTask ? task : optimisticTask;

  const unreadAt = hasOwnTaskMetaField(optimisticTask, "unreadAt")
    ? optimisticTask.unreadAt
    : (preferredTask.unreadAt ?? fallbackTask.unreadAt);

  return {
    ...preferredTask,
    changeSummary: preferredTask.changeSummary ?? fallbackTask.changeSummary,
    model: preferredTask.model ?? fallbackTask.model,
    provider: preferredTask.provider ?? fallbackTask.provider,
    title: resolveMergedTaskTitle(preferredTask, fallbackTask),
    titleOverridden:
      preferredTask.titleOverridden === true || fallbackTask.titleOverridden === true
        ? true
        : (preferredTask.titleOverridden ?? fallbackTask.titleOverridden),
    // The remote home screen's "running" relies on task.meta.status when no runtime is subscribed.
    // A newer optimistic meta without status used to overwrite the persisted status with undefined,
    // making the list show idle. Fall status back so running/completed/error survive the optimistic layer.
    status: preferredTask.status ?? fallbackTask.status,
    unreadAt,
  };
}

export function mergeTaskMetaCandidates(
  ...candidates: Array<ZCodeTaskMeta | null | undefined>
): ZCodeTaskMeta | undefined {
  let merged: ZCodeTaskMeta | undefined;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    merged = merged ? mergeTaskWithOptimisticMeta(candidate, merged) : candidate;
  }
  return merged;
}
