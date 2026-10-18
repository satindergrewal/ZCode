import type { ZCodeProvider, ZCodeTaskRuntimeStatus } from "@zcode/shared";

function isBusyTaskRuntimeStatus(status: ZCodeTaskRuntimeStatus): boolean {
  return status === "creating" || status === "restoring" || status === "streaming";
}

function buildTaskProviderByTaskId(
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
): Record<string, ZCodeProvider | undefined> {
  const providerByTaskId: Record<string, ZCodeProvider | undefined> = {};

  for (const task of taskListCache ?? []) {
    if (!task.provider) {
      continue;
    }
    providerByTaskId[task.taskId] = task.provider;
  }

  for (const [taskId, meta] of Object.entries(optimisticTaskMetaByTaskId)) {
    if (!meta.provider) {
      continue;
    }
    providerByTaskId[taskId] = meta.provider;
  }

  return providerByTaskId;
}

export function hasBusyTaskInWorkspaceProvider(
  selectedProvider: ZCodeProvider,
  taskRuntimeByTaskId: Record<string, { status: ZCodeTaskRuntimeStatus; provider?: ZCodeProvider }>,
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
  activeTaskId?: string | null,
): boolean {
  const providerByTaskId = buildTaskProviderByTaskId(optimisticTaskMetaByTaskId, taskListCache);
  const normalizedActiveTaskId = activeTaskId?.trim() ?? "";

  for (const [taskId, runtimeState] of Object.entries(taskRuntimeByTaskId)) {
    if (!isBusyTaskRuntimeStatus(runtimeState.status)) {
      continue;
    }

    // The runtime map also holds non-optimistic tasks; a missing provider must not be treated as a fixed provider,
    // or unrelated tasks get misjudged busy and reload/sync menus stay disabled for long.
    // The busy lock guards provider processes inside the workspace; prefer the runtime provider closest to the
    // live state, then taskList/cache; if still undecidable, lock only the current activeTask as a fallback.
    const taskProvider = runtimeState.provider ?? providerByTaskId[taskId];
    if (!taskProvider) {
      // During first-send / runtime switch the task provider may not have landed in taskList yet.
      // Judging not-busy there would allow cross-supplier model switches while loading.
      // Fall back to locking the activeTask busy state, preventing provider switches mid-load.
      if (normalizedActiveTaskId.length > 0 && normalizedActiveTaskId === taskId) {
        return true;
      }
      continue;
    }

    if (taskProvider === selectedProvider) {
      return true;
    }
  }

  return false;
}
