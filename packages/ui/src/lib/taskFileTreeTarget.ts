import type { ZCodeTaskMeta } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface TaskFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function resolveTaskFileTreeTarget(
  task: ZCodeTaskMeta,
  tab: WorkspaceTabState | undefined,
): TaskFileTreeTarget | null {
  // Legacy local tasks carry no workspaceIdentity; the key falls back to workspacePath. If a remote tab on the same
  // path also lacks identity, key-only matching would drag in the remote session. Verify local/remote kind before matching.
  const taskIsRemote = Boolean(task.workspaceIdentity?.trim());
  const tabIsRemote = Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteTarget || tab?.remoteSessionId,
  );
  const matchingTab =
    tab &&
    buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) &&
    taskIsRemote === tabIsRemote
      ? tab
      : undefined;
  if (tab && !matchingTab) {
    return null;
  }
  const isRemoteWorkspace = Boolean(
    task.workspaceIdentity?.trim() || matchingTab?.remoteTarget || matchingTab?.remoteSessionId,
  );
  // A remote task workspacePath can equal the local workspace. Without the matching remoteSessionId
  // the file tree must not open, or reads silently degrade to the local service.
  if (isRemoteWorkspace && !matchingTab?.remoteSessionId) {
    return null;
  }

  return {
    workspacePath: task.workspacePath,
    workspaceName: matchingTab?.label || getPathLeaf(task.workspacePath) || task.workspacePath,
    ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(matchingTab?.remoteSessionId
      ? { workspaceRemoteSessionId: matchingTab.remoteSessionId }
      : {}),
  };
}

export function resolveTaskFileTreeTargetFromTabs(
  task: ZCodeTaskMeta,
  tabs: readonly WorkspaceTabState[],
): TaskFileTreeTarget | null {
  // Local and legacy remote tabs of the same path can produce the same key; never collapse to a single-value Map:
  // keep all candidates, and let the single-tab resolver validate workspace kind and the remote session.
  for (const tab of tabs) {
    const target = resolveTaskFileTreeTarget(task, tab);
    if (target) {
      return target;
    }
  }
  // Local tasks need no open tab: open the file tree by path even when the workspace is closed.
  // Remote tasks must hit a tab for the identity-isolated remoteSessionId; no such fallback.
  if (!task.workspaceIdentity?.trim()) {
    return resolveTaskFileTreeTarget(task, undefined);
  }
  return null;
}
