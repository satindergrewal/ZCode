import type { IZCodeTaskService } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { logger } from "@/logger.js";

export interface ArchivedTaskDeletionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export interface ArchivedTaskDeletionWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  service?: Pick<IZCodeTaskService, "listArchivedTasks" | "deleteArchivedTasks">;
}

export async function collectArchivedTaskDeletion(workspaces: ArchivedTaskDeletionWorkspace[]) {
  const unique = new Map(
    workspaces.map((workspace) => [
      buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
      workspace,
    ]),
  );
  const results = await Promise.all(
    [...unique.values()].map(async (workspace) => {
      if (!workspace.service) return { workspace, targets: null };
      try {
        // Read the full archived set directly; never the UI-collapsed/filtered items.
        const tasks = await workspace.service.listArchivedTasks({
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
        });
        const targets = [...new Set(tasks.map((task) => task.taskId))].map((taskId) => ({
          taskId,
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
        }));
        return { workspace, targets };
      } catch (error) {
        logger.warn("[ArchivedTaskDeletion] Failed to list archived tasks", {
          workspaceKey: buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
          error,
        });
        return { workspace, targets: null };
      }
    }),
  );
  return {
    groups: results.filter((result) => result.targets !== null),
    count: results.reduce((count, result) => count + (result.targets?.length ?? 0), 0),
    unavailableWorkspaces: results
      .filter((result) => result.targets === null)
      .map((result) => result.workspace.label),
  };
}

export async function deleteArchivedTaskSelection(
  selection: Awaited<ReturnType<typeof collectArchivedTaskDeletion>>,
  onDeleted: (target: ArchivedTaskDeletionTarget) => void,
) {
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  // One RPC per workspace so the owning source emits events once after the per-item transaction;
  // independent sources run in parallel.
  await Promise.all(
    selection.groups.map(async ({ workspace, targets }) => {
      if (!targets?.length) return;
      let result: Awaited<ReturnType<IZCodeTaskService["deleteArchivedTasks"]>>;
      try {
        result = await workspace.service!.deleteArchivedTasks({
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          taskIds: targets.map((target) => target.taskId),
        });
      } catch (error) {
        failed += targets.length;
        logger.warn("[ArchivedTaskDeletion] Workspace batch delete failed", {
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          error,
        });
        return;
      }
      const deletedIds = new Set(result.deletedTaskIds);
      const skippedIds = new Set(result.skippedTaskIds);
      for (const target of targets) {
        if (deletedIds.has(target.taskId)) {
          deleted += 1;
          onDeleted(target);
        } else if (skippedIds.has(target.taskId)) {
          skipped += 1;
        } else {
          failed += 1;
        }
      }
    }),
  );
  return { deleted, skipped, failed, unavailableWorkspaces: selection.unavailableWorkspaces };
}
