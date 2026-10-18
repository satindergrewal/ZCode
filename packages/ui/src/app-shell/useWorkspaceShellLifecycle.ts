import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import type { BrowserNavigationRequest } from "@/hooks/useAppPanels.js";
import { logger } from "@/logger.js";
import {
  getWorkspaceDisplayedTaskState,
  getWorkspaceInitState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";

export function useWorkspaceShellLifecycle({
  workspaceAbsPath,
  workspaceIdentity,
  services,
  setBrowserNavigationRequest,
  setTestMessages,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  services: IServiceAccessor;
  setBrowserNavigationRequest: Dispatch<SetStateAction<BrowserNavigationRequest | null>>;
  setTestMessages: Dispatch<SetStateAction<TestChatMessage[] | null>>;
}) {
  const previousWorkspaceAbsPathRef = useRef(workspaceAbsPath);

  useEffect(() => {
    if (previousWorkspaceAbsPathRef.current === workspaceAbsPath) {
      return;
    }

    previousWorkspaceAbsPathRef.current = workspaceAbsPath;

    // Root used to rely on keying by workspacePath so a workspace switch remounted the
    // whole App. That wiped local state but also unmounted the sidebar/TaskList, flashing
    // whole columns on task switches. With one persistent App instance, only state truly
    // bound to the old workspace is cleaned here, so the previous project's code previews or
    // test-override messages cannot bleed into the new one.
    // The side pane now restores from memory per workspaceIdentity/workspacePath.
    // Do not clear Git/source or tabs on workspacePath change, or switching back across
    // workspaces would overwrite their caches.
    setBrowserNavigationRequest(null);
    setTestMessages(null);
  }, [setBrowserNavigationRequest, setTestMessages, workspaceAbsPath]);

  useEffect(() => {
    return () => {
      const currentWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspaceAbsPath);
      const displayedTaskState = getWorkspaceDisplayedTaskState(currentWorkspaceState);
      if (
        currentWorkspaceState.activeTaskId ||
        displayedTaskState.taskStatus === "creating" ||
        displayedTaskState.taskStatus === "streaming"
      ) {
        return;
      }

      // A prewarmed session keeps a ZCode Agent process alive even with no task. Leaving
      // such "prewarmed, never used" sessions running while switching tabs accumulates
      // idle processes across workspace switches; reclaim best-effort on exit. The
      // workspace init state must also be reset to idle, or the next entry could still see
      // the stale ready/failed. With a single ZCode Agent there is no per-provider loop.
      const workspaceInitState = getWorkspaceInitState(currentWorkspaceState);
      if (workspaceInitState.status === "idle") {
        return;
      }

      const provider = currentWorkspaceState.selectedProvider;
      logger.info(
        `[App] revert workspace warmup state workspace=${workspaceAbsPath} provider=${provider}`,
      );
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitState(workspaceAbsPath, "idle", null, workspaceIdentity);

      void services.zcodeTaskService
        .releaseWorkspacePreparation({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
        })
        .catch((error: unknown) => {
          logger.error(
            `[App] failed to release workspace warmup state workspace=${workspaceAbsPath} provider=${provider}:`,
            error,
          );
        });
    };
  }, [services.zcodeTaskService, workspaceIdentity, workspaceAbsPath]);
}
