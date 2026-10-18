import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import {
  buildTaskSidePaneMemoryKey,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";

export function useTaskSidePaneMemoryBridge({
  activeTaskId,
  gitSelectedSourceId,
  setGitSelectedSourceId,
  workspaceAbsPath,
  workspaceIdentity,
}: {
  activeTaskId: string | null;
  gitSelectedSourceId: GitChangeSourceId;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
}) {
  const memoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const activeGitSourceMemoryKeyRef = useRef<string | null>(memoryKey);
  const [browserRestoreUrls, setBrowserRestoreUrls] = useState(() => {
    const restored = readTaskSidePaneMemoryState(memoryKey);
    return restored.browserUrl
      ? { browser: restored.browserUrl, ...restored.browserUrls }
      : restored.browserUrls;
  });
  const latestGitSourceRef = useRef(gitSelectedSourceId);
  latestGitSourceRef.current = gitSelectedSourceId;

  useEffect(() => {
    const previousKey = activeGitSourceMemoryKeyRef.current;
    if (previousKey === memoryKey) {
      return;
    }

    // The Git pane source and the Browser URL are workspace-level side-pane UI state.
    // Write the old key back before a workspace switch and restore the new one after, so Review/Browser tabs survive.
    // Within one workspace, task switches keep the same key and no longer read as separate state.
    saveTaskSidePaneMemoryState(previousKey, {
      activeGitSourceId: latestGitSourceRef.current,
    });
    const restored = readTaskSidePaneMemoryState(memoryKey);
    activeGitSourceMemoryKeyRef.current = memoryKey;
    setGitSelectedSourceId(restored.activeGitSourceId);
    setBrowserRestoreUrls(
      restored.browserUrl
        ? { browser: restored.browserUrl, ...restored.browserUrls }
        : restored.browserUrls,
    );
  }, [memoryKey, setGitSelectedSourceId]);

  useEffect(() => {
    return () => {
      saveTaskSidePaneMemoryState(activeGitSourceMemoryKeyRef.current, {
        activeGitSourceId: latestGitSourceRef.current,
      });
    };
  }, []);

  const handleBrowserUrlChange = useCallback(
    (tabId: string, url: string) => {
      setBrowserRestoreUrls((current) => ({
        ...current,
        [tabId]: url,
      }));
      saveTaskSidePaneMemoryState(memoryKey, {
        browserUrls: {
          ...readTaskSidePaneMemoryState(memoryKey).browserUrls,
          [tabId]: url,
        },
      });
    },
    [memoryKey],
  );

  return {
    browserRestoreUrls,
    handleBrowserUrlChange,
  };
}
