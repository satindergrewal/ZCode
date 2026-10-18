import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  providerConfigFile: TaskPathState;
  fileManagerLabel: string;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
  handleOpenProviderConfig: () => Promise<void>;
}

export function resolveProviderConfigOpenTargetPath(path: string, exists: boolean): string {
  if (exists) {
    return path;
  }

  // Bugfix: before the provider config file first lands, the more-menu fully disabled go-to-config:
  // no visible directory, no way to create the file. Fall back to the parent folder,
  // keeping the navigate semantic and never handing a missing path to the editor.
  const trimmedPath = path.replace(/[\\/]+$/, "");
  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));

  if (lastSeparatorIndex < 0) {
    return path;
  }

  if (lastSeparatorIndex === 0) {
    return trimmedPath[0] ?? path;
  }

  const parentPath = trimmedPath.slice(0, lastSeparatorIndex);
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}\\`;
  }

  return parentPath || path;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  intl,
  loadTaskPaths = true,
  loadProviderConfig = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  loadTaskPaths?: boolean;
  loadProviderConfig?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskProvider = provider ?? "glm";
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // Session/log paths feed menu items only; no RPC bursts on reorder while closed.
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspacePath,
    taskProvider,
    remoteSessionId,
    workspaceIdentity,
    {
      // Bugfix: in remote workspaces go-to-config must open a locally editable file.
      // The remote zcodeTaskService path is the remote absolute path (/root/...),
      // which the local platform layer misopens or fails on.
      // Remote cases force the base service so the UI gets a locally openable path.
      serviceScope: remoteSessionId ? "base" : "workspace",
      // Bugfix: every row mounts these actions; reading config paths on mount
      // multiplies remote base RPCs per row. Load when the menu actually opens.
      enabled: loadProviderConfig,
    },
  );

  const handleCopyText = useCallback(async (label: string, value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      logger.info(`[TaskListItem] ${label} copied: ${value}`);
    } catch (error) {
      logger.warn("[TaskListItem] failed to copy text", {
        label,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // Remote project paths are not host paths; fail closed when WSL mapping is impossible,
        // so SSH/Docker Linux paths never reach native file managers.
        logger.warn("[TaskListItem] remote workspace has no native file manager", {
          taskId,
          path: workspacePath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", workspacePath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] failed to open WSL workspace path", {
          taskId,
          path: workspacePath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, workspacePath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      // Header/task-menu open-in-finder means the project directory;
      // it bound the session file and greyed out before that snapshot resolved.
      // Always open workspacePath,
      // matching copy-path = project path.
      logger.warn("[TaskListItem] failed to open workspace path", {
        taskId,
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
  ]);

  const handleOpenProviderConfig = useCallback(async () => {
    if (!providerConfigFile.path) {
      return;
    }

    const openTargetPath = resolveProviderConfigOpenTargetPath(
      providerConfigFile.path,
      providerConfigFile.exists,
    );

    try {
      const preferredEditorId = readLastSelectedEditorId();
      const editors = await platform.getInstalledEditors();
      const sortedEditors = sortInstalledEditorsForOpenWith(editors);
      const preferredEditor =
        sortedEditors.find((editor) => editor.id === preferredEditorId) ?? sortedEditors[0] ?? null;

      // Bugfix: the sidebar menu lacks the Header's local selectedEditor state;
      // hardcoding one here would split the two go-to-config paths.
      // Read the persisted editor pref, shared with the Header button.
      if (preferredEditor) {
        const result = await platform.openInEditor(preferredEditor.id, openTargetPath);
        if (result.success) {
          return;
        }
      }

      const result = await platform.openInFileManager(openTargetPath);
      if (!result.success) {
        logger.warn("[TaskListItem] failed to open provider config", {
          taskId,
          provider: taskProvider,
          path: providerConfigFile.path,
          openTargetPath,
          error: result.error ?? "unknown-error",
        });
      }
    } catch (error) {
      logger.warn("[TaskListItem] failed to open provider config", {
        taskId,
        provider: taskProvider,
        path: providerConfigFile.path,
        openTargetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [platform, providerConfigFile.exists, providerConfigFile.path, taskId, taskProvider]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel: getFileManagerLabel(intl),
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
