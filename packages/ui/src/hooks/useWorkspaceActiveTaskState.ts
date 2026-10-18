import { useMemo, useRef } from "react";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { useActiveTaskSnapshotMeta } from "@/hooks/useActiveTaskSnapshotMeta.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import {
  getTaskMeta,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

interface UseWorkspaceActiveTaskStateParams {
  workspaceAbsPath: string;
  activeTaskId: string | null;
  workspaceRemoteSessionId?: string | null;
  workspaceIdentity?: string;
  selectedProvider: ZCodeProvider;
  intl: {
    formatMessage(descriptor: { id: string }): string;
  };
}

function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areResolvedTaskMetasEqual(left: ZCodeTaskMeta | null, right: ZCodeTaskMeta | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.title === right.title &&
    left.titleOverridden === right.titleOverridden &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.mode === right.mode &&
    left.model === right.model &&
    left.thoughtLevel === right.thoughtLevel &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.provider === right.provider &&
    left.migrationSource === right.migrationSource &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.unreadAt === right.unreadAt &&
    left.status === right.status &&
    areTaskMetaJsonFieldsEqual(left.lastError, right.lastError) &&
    areTaskMetaJsonFieldsEqual(left.repairState, right.repairState) &&
    areTaskMetaJsonFieldsEqual(left.changeSummary, right.changeSummary) &&
    areTaskMetaJsonFieldsEqual(left.target, right.target)
  );
}

export function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {
  const stableTaskMetaRef = useRef<ZCodeTaskMeta | null>(null);
  const stableTaskMeta = stableTaskMetaRef.current;
  // Stream chunks can rebuild meta with equal fields but new references;
  // reuse the old reference when equal so Header/Shell memos hold through bursts.
  if (!areResolvedTaskMetasEqual(stableTaskMeta, taskMeta)) {
    stableTaskMetaRef.current = taskMeta;
  }
  return stableTaskMetaRef.current;
}

export function useWorkspaceActiveTaskState({
  workspaceAbsPath,
  activeTaskId,
  workspaceRemoteSessionId,
  workspaceIdentity,
  selectedProvider,
  intl,
}: UseWorkspaceActiveTaskStateParams) {
  const workspaceState = useZCodeSessionStore((state) =>
    selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity),
  );
  const activeTaskQueryMeta = useTaskQueryCacheStore((state) => {
    if (!activeTaskId) {
      return null;
    }
    return (
      state.taskMetaByEntityKey[
        buildTaskEntityKey({
          taskId: activeTaskId,
          workspacePath: workspaceAbsPath,
          workspaceIdentity,
        })
      ] ?? null
    );
  });
  const activeTaskMeta = useMemo(() => {
    if (!activeTaskId) {
      return null;
    }

    // App once subscribed to plain+pinned lists just to find the active meta,
    // rerendering everything on any list refresh.
    // Read the merged taskListCache + optimistic meta from the workspace store:
    // plain tasks hit synchronously, pinned/archived fall back to snapshot meta.
    // After restart, raw snapshot meta can land before the sqlite/list caches,
    // which keep titleOverridden manual titles; merge both by the same
    // title authority or the task reads as regenerated.
    return (
      mergeTaskMetaCandidates(getTaskMeta(workspaceState, activeTaskId), activeTaskQueryMeta) ??
      null
    );
  }, [activeTaskId, activeTaskQueryMeta, workspaceState]);

  const activeTaskSnapshotMeta = useActiveTaskSnapshotMeta(
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    activeTaskMeta,
  );
  const resolvedActiveTaskMeta = useStableResolvedActiveTaskMeta(
    activeTaskMeta ?? activeTaskSnapshotMeta,
  );
  // Store tail: taskMessagesByTaskId has no writers left (legacy ChatView/replay gone),
  // stream-derived summaries are always empty; display falls back to meta.changeSummary.
  const activeTaskChangeSummary = null;
  const activeTraceId = resolvedActiveTaskMeta?.traceId ?? null;
  const activeSessionId = resolvedActiveTaskMeta?.taskId ?? null;
  const activeTaskProvider = resolvedActiveTaskMeta?.provider ?? null;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    selectedProvider,
  );
  const activeTaskBaseTitle = resolvedActiveTaskMeta?.title?.trim()
    ? resolvedActiveTaskMeta.title
    : intl.formatMessage({
        id: resolvedActiveTaskMeta?.forkedFromTaskId
          ? "taskList.forkedUntitled"
          : "taskList.newThread",
      });
  const activeTaskTitle = activeTaskBaseTitle;
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspaceAbsPath,
    activeTaskId,
    activeTaskProvider,
    workspaceIdentity,
  );
  const taskSessionFile = useTaskSessionFilePath(workspaceAbsPath, activeTaskId, workspaceIdentity);

  return {
    activeTaskMeta,
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  };
}
