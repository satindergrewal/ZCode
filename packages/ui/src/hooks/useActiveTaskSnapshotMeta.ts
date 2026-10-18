import { useEffect, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { zcodeSessionSnapshotToTaskMeta } from "@/lib/zcodeSessionProjection.js";

export function resolveImmediateActiveTaskSnapshotMeta(
  previousSnapshotMeta: ZCodeTaskMeta | null,
  taskId: string | null,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  if (!taskId || taskMetaFromLists) {
    return null;
  }

  // When switching to a pin/archive task that is missing from the list data sources, the
  // previous task's snapshot meta must not carry over until the new snapshot returns;
  // otherwise the Header shows the old title first and corrects it async, which reads as a
  // laggy rename. Only reuse a snapshot for the exact same taskId; clear it across tasks.
  return previousSnapshotMeta?.taskId === taskId ? previousSnapshotMeta : null;
}

/**
 * Snapshot-meta fallback for the currently active task.
 *
 * Archived tasks are absent from the normal taskListCache / pinnedTasks sources, so opening
 * one directly leaves the app without title, provider, traceId, etc. from list metadata alone.
 * When the task is not found in the lists, read snapshot.meta once as a display fallback.
 * This serves the active task only; archived tasks are not mixed back into the normal list.
 */
export function useActiveTaskSnapshotMeta(
  workspacePath: string,
  taskId: string | null,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  const zcodeSessionService = useZCodeSessionService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [snapshotMeta, setSnapshotMeta] = useState<ZCodeTaskMeta | null>(null);

  useEffect(() => {
    let cancelled = false;

    setSnapshotMeta((currentSnapshotMeta) =>
      resolveImmediateActiveTaskSnapshotMeta(currentSnapshotMeta, taskId, taskMetaFromLists),
    );

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    if (taskMetaFromLists) {
      return () => {
        cancelled = true;
      };
    }

    void zcodeSessionService
      // The active header only needs a session meta/title fallback; use the lightweight
      // ZCode Protocol read instead of pulling the full task message payload via legacy
      // snapshot into the UI.
      .readSession({
        workspacePath,
        workspaceIdentity,
        sessionId: taskId,
        messageLimit: 1,
      })
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(zcodeSessionSnapshotToTaskMeta(snapshot));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(null);
      });

    return () => {
      cancelled = true;
    };
  }, [zcodeSessionService, taskId, taskMetaFromLists, workspaceIdentity, workspacePath]);

  return snapshotMeta;
}
