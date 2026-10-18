import type { IZCodeTaskService } from "@zcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";

export function releaseWorkspaceRuntimeAfterProjectRemoval({
  tab,
  zcodeTaskService,
}: {
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">;
  zcodeTaskService: Pick<IZCodeTaskService, "releaseWorkspacePreparation">;
}): void {
  const workspaceIdentity = tab.workspaceIdentity?.trim() || undefined;
  void zcodeTaskService
    .releaseWorkspacePreparation({
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .catch((error: unknown) => {
      // Windows treats agent/terminal child-process cwds as directory locks; removing a project must release the runtime.
      // A failed release never rolls back the UI removal -- log the workspace key to locate leftover processes.
      logger.error("[WorkspaceSidebarItem] Failed to release runtime after workspace removal", {
        workspaceKey: workspaceIdentity ?? tab.workspacePath,
        error,
      });
    });
}
