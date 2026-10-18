/* eslint-disable max-lines -- the root workspace action hook centralizes project/remote/conversation entry points; keep action boundaries intact until it can be split by domain. */
import { useCallback, useEffect, useState } from "react";
import {
  DesktopCommandIds,
  type AppSettings,
  type IPlatformService,
  type RemoteTarget,
  type UserInfo,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { parseWslUncWorkspacePath } from "@/lib/wslUncWorkspace.js";
import { logger } from "@/logger.js";
import { openFolderFromWorkspaceEntry } from "@/root/openWorkspaceFolderEntry.js";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { isWorkspaceReadOnly, type TabStore, type TabStoreState } from "@/store/tabStore.js";
import type { RootProps } from "@/root/types.js";
import {
  hadPersistedPaneLayoutAtModuleLoad,
  INITIAL_PANE_LAYOUT,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";
import type { WorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { persistV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";

interface OpenRemoteConnectionPreference {
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
}

/** New-task target: a missing identity is always normalized to null, consumed uniformly by read-only checks and focus/addTab. */
interface NewTaskTargetResolution {
  workspacePath: string;
  workspaceIdentity: string | null;
}

/**
 * Resolves the new-task target: an explicit targetWorkspace in the request (cross-project saved workflow) wins without consulting workbench focus;
 * otherwise fall back lazily to resolveWorkbenchNewTaskTarget. A missing identity normalizes to null.
 */
function resolveNewTaskTargetFromRequest(
  request: CreateTaskRequest | undefined,
  resolveFallback: () => WorkbenchNewTaskTarget | null,
): NewTaskTargetResolution | null {
  const targetWorkspace =
    typeof request === "string" || !request ? undefined : request.targetWorkspace;
  if (targetWorkspace) {
    return {
      workspacePath: targetWorkspace.workspacePath,
      workspaceIdentity: targetWorkspace.workspaceIdentity ?? null,
    };
  }
  const fallback = resolveFallback();
  if (!fallback) {
    return null;
  }
  return {
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity ?? null,
  };
}

export function useRootWorkspaceActions({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
  refreshProviderState,
  updateAppSettings,
  setOAuthError,
  setUser,
  onProviderFamilyDomainClearedAfterLogout,
  userId,
  onOpenRemoteConnection,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser?: () => void;
  refreshProviderState: () => Promise<void>;
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setOAuthError: (error: string | null) => void;
  setUser: (user: UserInfo | null) => void;
  onProviderFamilyDomainClearedAfterLogout?: () => void;
  userId?: string;
  onOpenRemoteConnection?: (preference?: OpenRemoteConnectionPreference) => void;
  workbenchGroupClientMode?: ZCodeTaskClientMode;
}) {
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const requestConfirmation = useConfirmDialog();
  const {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  } = useConversationWorkspaceActions({
    services,
    addTab,
    setWorkspaceActionError,
  });

  useEffect(() => {
    useWorkbenchGroupStore.getState().configureClientMode(workbenchGroupClientMode);
    if (workbenchGroupClientMode === "desktop-continuous" && !isRendererReloadNavigation()) {
      // group/pane are renderer-persisted UI state. Activating them on app cold start would
      // surface historical sessions even with activeTaskId=null, breaking fresh-draft startup semantics.
      // A renderer reload keeps restore eligibility for refresh-resume while output is streaming.
      const workbenchState = useWorkbenchGroupStore.getState();
      const activeGroup = workbenchState.activeGroupId
        ? workbenchState.groups[workbenchState.activeGroupId]
        : null;
      const activeGroupWasRestored = Boolean(
        activeGroup &&
        [activeGroup.primaryBinding, ...Object.values(activeGroup.panes)].some(
          (binding) => binding.restoredUnvalidated,
        ),
      );
      if (activeGroupWasRestored) {
        workbenchState.deactivateActiveGroup();
      }
      if (hadPersistedPaneLayoutAtModuleLoad()) {
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
    }
  }, [workbenchGroupClientMode]);

  const startDraftInWorkspace = useCallback(
    (workspacePath: string, workspaceIdentity?: string) => {
      if (workbenchGroupClientMode === "desktop-continuous") {
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      useZCodeSessionStore.getState().startDraft(workspacePath, undefined, workspaceIdentity);
    },
    [workbenchGroupClientMode],
  );

  const startNewTaskFromActiveWorkspace = useCallback(
    (source: string, request?: CreateTaskRequest) => {
      const state = tabStoreApi.getState();
      const {
        activeWorkspacePath: currentActiveWorkspacePath,
        activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
        activateTabByPath: focusWorkspace,
      } = state;
      const workbenchGroupState = useWorkbenchGroupStore.getState();
      const activeGroup =
        workbenchGroupClientMode === "desktop-continuous" && workbenchGroupState.activeGroupId
          ? (workbenchGroupState.groups[workbenchGroupState.activeGroupId] ?? null)
          : null;
      // A cross-project saved workflow must land in the workflow's project, not the active one:
      // an explicit targetWorkspace on the request wins,
      // else fall back to workbench focus resolution, behavior identical to the old version when no target is given.
      const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>
        resolveWorkbenchNewTaskTarget({
          activeWorkspacePath: currentActiveWorkspacePath,
          activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
          activeGroup,
          // Remote hides paneLayout, but a desktop-focused secondary pane may still exist in the renderer;
          // the new task must target the visible shell workspace, never a hidden pane.
          paneLayout:
            workbenchGroupClientMode === "desktop-continuous"
              ? usePaneLayoutStore.getState()
              : INITIAL_PANE_LAYOUT,
        }),
      );

      if (
        typeof request === "object" &&
        request.expectedWorkspaceKey &&
        request.expectedWorkspaceKey !==
          (newTaskTarget?.workspaceIdentity?.trim() || newTaskTarget?.workspacePath)
      ) {
        return;
      }
      if (!newTaskTarget) {
        logger.error(`[Root] ${source} failed: no active workspace`);
        setWorkspaceActionError(intl.formatMessage({ id: "workspace.noActiveForNewTask" }));
        return;
      }

      // Disabling the button cannot cover desktop menus and shortcuts; a workspace that became
      // invalid during startup must be revalidated at the action boundary so a read-only history page is never silently made sendable.
      if (
        isWorkspaceReadOnly(
          state,
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity ?? undefined,
        )
      ) {
        return;
      }

      if (
        !focusWorkspace(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity
            ? { workspaceIdentity: newTaskTarget.workspaceIdentity }
            : undefined,
        )
      ) {
        addTab(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity
            ? { workspaceIdentity: newTaskTarget.workspaceIdentity }
            : undefined,
        );
      }

      setWorkspaceActionError(null);
      const provider = typeof request === "string" ? request : request?.provider;
      const groupedDraftPlacement =
        typeof request === "string" ? undefined : request?.groupedDraftPlacement;
      const rawInitialPrompt = typeof request === "string" ? undefined : request?.initialPrompt;
      // The trailing space after a skill mention decides whether the caret lands past the chip; trimming before save
      // swallows that editable gap. Only use trim for the empty check and keep the caller's text for non-empty drafts.
      const initialPrompt = rawInitialPrompt?.trim() ? rawInitialPrompt : undefined;
      const initialPromptMention =
        typeof request === "string" ? undefined : request?.initialPromptMention;
      logger.info(`[Root] ${source}:`, newTaskTarget.workspacePath, provider ?? "default-provider");
      // Cmd/Ctrl+N creates a new single-pane draft; it does not split yet another draft
      // off the current workbench group/paneLayout. The target workspace is the focused pane.
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore
        .getState()
        .startDraft(
          newTaskTarget.workspacePath,
          provider,
          newTaskTarget.workspaceIdentity ?? undefined,
          {
            groupedDraftPlacement,
            createSource: typeof request === "string" ? undefined : request?.createSource,
          },
        );
      if (initialPrompt) {
        // The insert request is cleared once the first composer consumes it; a later remount after a pane/config
        // change would restore the new composer from an empty __draft__ and overwrite the prefilled text. Write the draft source of truth
        // first, then fire the immediate insert: the current composer updates at once and later remounts restore the same text.
        persistV4ComposerDraft(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity ?? undefined,
          V4_DRAFT_SCOPE_ROOT,
          {
            text: initialPrompt,
            ...(initialPromptMention ? { mention: initialPromptMention } : {}),
          },
        );
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(
            newTaskTarget.workspacePath,
            initialPrompt,
            newTaskTarget.workspaceIdentity ?? undefined,
            initialPromptMention,
          );
      }
    },
    [addTab, intl, tabStoreApi, workbenchGroupClientMode],
  );

  const handleLogout = useCallback(async () => {
    let runningAgentSessionCount: number | null = null;
    try {
      const sessionActivity = await platform.getDesktopSessionActivity?.();
      runningAgentSessionCount =
        typeof sessionActivity?.runningAgentSessionCount === "number"
          ? sessionActivity.runningAgentSessionCount
          : null;
    } catch (error) {
      logger.warn("[Root] Failed to query running desktop sessions; using conservative sign-out copy", { error });
    }

    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "logout.confirm.title" }),
      description:
        runningAgentSessionCount !== null && runningAgentSessionCount > 0
          ? intl.formatMessage(
              { id: "logout.confirm.descriptionWithRunningSessions" },
              { count: String(runningAgentSessionCount) },
            )
          : intl.formatMessage({ id: "logout.confirm.descriptionDefault" }),
      confirmLabel: intl.formatMessage({ id: "logout.confirm.ok" }),
      cancelLabel: intl.formatMessage({ id: "logout.confirm.cancel" }),
    });
    if (!confirmed) {
      return;
    }

    // Root cause: telemetry is a side channel; awaiting network retries delays sign-out and, in the old
    // timeout-less implementation, blocked the main flow forever. Only enqueue here; Main owns bounded retries and sign-out drain.
    void reportAppTelemetryEvent(
      platform,
      {
        elementName: "app_user_logout",
        eventRegion: "app_profile",
        eventType: "ck",
        eventExtraDetail: {},
        userId,
      },
      "Root",
    );
    const settingsBeforeLogout = await services.settingService.get();
    const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
      currentDomain: settingsBeforeLogout.providerFamilyDomain,
    });
    await services.oauthService.logout();
    await updateAppSettings({
      providerFamilyDomain: (nextProviderFamilyDomain ?? "") as AppSettings["providerFamilyDomain"],
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyDomainMigrated: true,
    });
    if (!nextProviderFamilyDomain) {
      onProviderFamilyDomainClearedAfterLogout?.();
    }
    // The ZAI/BigModel provider has been restored to mirror the app login.
    // Derived Coding/Start keys are cleaned up by the OAuth logout host hook; Root only refreshes display state.
    setOAuthError(null);
    setUser(null);
    // Refresh Account Source and the registry after sign-out so pre-sign-out provider state is no longer shown.
    await refreshProviderState();
    // The Coding Plan site webview uses its own persistent partition; app logout must clear it too.
    await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [
    intl,
    requestConfirmation,
    refreshProviderState,
    onProviderFamilyDomainClearedAfterLogout,
    platform,
    services.oauthService,
    services.modelSelectionService,
    services.settingService,
    setOAuthError,
    setUser,
    updateAppSettings,
    userId,
  ]);

  const handleSelectProject = useCallback(
    async (path: string) => {
      logger.info("[Root] handleSelectProject called with path:", path);
      try {
        const wslUncWorkspace = parseWslUncWorkspacePath(path);
        if (wslUncWorkspace && onOpenRemoteConnection) {
          const shouldOpenWslConnection = await requestConfirmation({
            title: intl.formatMessage({ id: "workspace.wslUncPrompt.title" }),
            description: intl.formatMessage(
              { id: "workspace.wslUncPrompt.description" },
              {
                path,
              },
            ),
            confirmLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.openWsl" }),
            cancelLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.continuePath" }),
          });
          if (shouldOpenWslConnection) {
            logger.info("[Root] User chose to open the UNC workspace via a WSL remote connection", {
              distro: wslUncWorkspace.distro,
              path,
            });
            onOpenRemoteConnection({
              preferredKind: "wsl",
              preferredWslDistro: wslUncWorkspace.distro,
            });
            return;
          }
        }

        // Desktop: if another window already has this directory open, activate that window's tab instead
        const result = await platform.activateOrSetWorkspace(path);
        if (result.activated) {
          logger.info("[Root] Directory already open in another window; activated its tab and skipped the reopen");
          return;
        }

        // Add a tab (or activate it if already open in this window)
        addTab(path);
        // Opening a workspace is workspace-only intent, not "resume last session":
        // even on an existing tab, clear that workspace's activeTaskId and return to the single-pane draft.
        startDraftInWorkspace(path);
        setWorkspaceActionError(null);

        // Update the recent-projects list
        if (supportsSettings) {
          // Remote-window hosts expose no settingService; updating recentProjects here used to
          // hit a missing setting channel on SSH right after opening the project.
          // Only local windows maintain recent projects; remote windows just open the current workspace.
          logger.info("[Root] calling settingService.get()...");
          const settings = await services.settingService.get();
          const updated = [
            path,
            ...settings.recentProjects.filter((projectPath) => projectPath !== path),
          ].slice(0, 10);
          await services.settingService.update({ recentProjects: updated });
          // The OS recent-documents entries (Dock/Jump List) are retired; keep only the in-app recentProjects
          // so two lists do not have to be maintained in sync and drift apart.
          logger.info("[Root] settingService.update() done");
        }
      } catch (err) {
        logger.error("[Root] handleSelectProject error:", err);
      }
    },
    [
      addTab,
      intl,
      onOpenRemoteConnection,
      platform,
      requestConfirmation,
      services.settingService,
      startDraftInWorkspace,
      supportsSettings,
    ],
  );

  const handleOpenWorkspace = useCallback(() => {
    if (!allowOpenWorkspace) {
      // Web remote control only guarantees entering a workspace the desktop already has open.
      // "Open workspace" used to fall through to the intermediate picker page,
      // but the new-workspace/new-session flows are not wired up in web remote mode, so the page just looked stuck.
      // Block the entry outright instead of leaving users half-supported.
      logger.info("[Root] Current mode cannot open other workspaces; request ignored");
      return;
    }
    setWorkspaceActionError(null);

    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    // The open-workspace intermediate page used to take over as a "new tab" from the startup empty state, Cmd/Ctrl+O,
    // and the menu. Opening a workspace is now action-only: local shells pop the OS directory picker directly
    // with no intermediate page; shells without it rely on the startup fallback to create a default workspace.
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] Failed to create conversation workspace", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleOpenFolderFromWorkspaceMenu = useCallback(() => {
    if (!allowOpenWorkspace) {
      logger.info("[Root] Current mode cannot open folders from the empty-state menu; request ignored");
      return;
    }

    // Open folder in the empty-state workspace menu reuses the root open-workspace action:
    // call the same entry function and inject Root's selectDirectory and project-selection callbacks.
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] Failed to create conversation workspace from the empty-state menu", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleCreateScratchWorkspace = useCallback(
    async (name: string) => {
      if (!allowOpenWorkspace) {
        logger.info("[Root] Current mode cannot create workspaces from the empty-state menu; request ignored");
        return null;
      }

      const result = await services.fileService.createScratchWorkspace({ name });
      await handleSelectProject(result.path);
      return result.path;
    },
    [allowOpenWorkspace, handleSelectProject, services.fileService],
  );

  const handleCreateTask = useCallback(
    (request?: CreateTaskRequest) => {
      startNewTaskFromActiveWorkspace("sidebar new task", request);
    },
    [startNewTaskFromActiveWorkspace],
  );

  const handleBackFromSettings = useCallback(() => {
    if (!activeWorkspacePath) {
      return;
    }

    // Returning to a recent workspace from settings must not activate by path alone:
    // one path can map to several remote identities, and dropping activeWorkspaceIdentity lands the remote workspace in the path-only bucket.
    tabStoreApi
      .getState()
      .activateTabByPath(
        activeWorkspacePath,
        activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
      );
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabStoreApi]);

  return {
    workspaceActionError,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateScratchWorkspace,
    handleCreateTask,
    handleBackFromSettings,
  };
}
