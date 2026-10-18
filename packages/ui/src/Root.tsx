import {
  RequestSecurityHost,
  RequestSecurityWorkspaceBridge,
  setRequestSecurityReporter,
} from "@/request-security-edition/index.js";
/* eslint-disable max-lines -- Root centralizes startup and workspace shell wiring for now; keeping one entry avoids scattering state across layers. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LucideProvider, RefreshCw } from "lucide-react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  DesktopCommandIds,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  useDynamicWorkflowAvailabilityLoader,
  useDynamicWorkflowUserModeSync,
} from "@/hooks/useDynamicWorkflowAvailability.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import { useTokenRefresh } from "@/hooks/useTokenRefresh.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SSHDialog } from "@/SSHDialog.js";
import { SettingsPage } from "@/SettingsPage.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RewardsProvider } from "@/rewards/RewardsProvider.js";
import { WelcomeScreen, type LoginCompleteReason } from "@/WelcomeScreen.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { readRendererLaunchTimings, shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";
import { reportUiLaunchToInput } from "@/lib/uiPerfArmsTelemetry.js";
import { countAllUnreadTasks } from "@/lib/unreadTaskCount.js";
import {
  isProviderStartupSyncPending,
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceTabLifecycle } from "@/root/useRemoteWorkspaceTabLifecycle.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { consumeZcodeJwtInvalidRestartMarker } from "@/root/zcodeJwtInvalidRestartMarker.js";
import { useDesktopNativeThemeSync } from "@/root/useDesktopNativeThemeSync.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import type { RootProps } from "@/root/types.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import {
  buildWebRemoteControlTaskRuntimeByWorkspaceKey,
  buildWebRemoteControlTaskTargets,
} from "@/lib/webRemoteControlTaskIndex.js";
import {
  logDeferredWebRemoteControlTaskSnapshot,
  shouldSyncWebRemoteControlTaskSnapshot,
} from "@/lib/webRemoteControlTaskSync.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import {
  WebRemoteControlFeatureProvider,
  useWebRemoteControlFeatureEnabled,
} from "@/WebRemoteControlFeatureProvider.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { setSessionOpenArmsReporter } from "@/lib/sessionOpenArmsTelemetry.js";
import { setSendFunnelArmsReporter } from "@/lib/sendFunnelArmsTelemetry.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  disposeConversationTelemetrySupervisors,
  reconcileConversationTelemetryWorkspaceScopes,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import { installConversationTelemetryParityE2EBridge } from "@/v4/telemetry/conversationTelemetryParityE2E.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;
interface RemoteConnectionOpenPreference {
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
}

type WelcomeScreenOpenReason =
  | "startup-provider-required"
  | "manual-login"
  | "provider-request"
  | "logout-provider-required"
  | "session-expired";

function WebRemoteControlTaskSync({
  syncWebRemoteControlTasks,
  workspaceTabs,
}: {
  syncWebRemoteControlTasks: NonNullable<RootProps["platform"]["syncWebRemoteControlTasks"]>;
  workspaceTabs: WorkspaceTabState[];
}) {
  const workspaceStates = useZCodeSessionStore((state) => state.workspaces);
  const timelineTaskList = useGlobalTaskList({
    kind: "timeline",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 100,
  });
  const pinnedTaskList = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 100,
  });
  const archivedTaskList = useGlobalTaskList({
    kind: "archived",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 100,
  });
  const taskTargets = useMemo(() => {
    const runtimeByWorkspaceKey = buildWebRemoteControlTaskRuntimeByWorkspaceKey(workspaceStates);
    // Bugfix: with web remote off, Root must not subscribe to the whole workspace table. The remote task
    // index runs only once its component mounts, keeping desktop continuous streaming from waking the
    // Root/App/Shell spine.
    // Bugfix: the phone remote home synced the timeline only, and that query filters pinned=1; sync the
    // sqlite pinned list to the phone separately so pinned tasks never vanish from the remote list.
    const pinnedTargets = buildWebRemoteControlTaskTargets({
      workspaceTabs,
      tasks: pinnedTaskList.items,
      taskRuntimeByWorkspaceKey: runtimeByWorkspaceKey,
      pinned: true,
    });
    const timelineTargets = buildWebRemoteControlTaskTargets({
      workspaceTabs,
      tasks: timelineTaskList.items,
      taskRuntimeByWorkspaceKey: runtimeByWorkspaceKey,
    });
    // Bugfix: the wide-screen web remote archived view fell back to the current bridge workspace query
    // because the synced task index carried no archived members. Archived feeds only the remote list; the
    // desktop task area is untouched.
    const archivedTargets = buildWebRemoteControlTaskTargets({
      workspaceTabs,
      tasks: archivedTaskList.items,
      taskRuntimeByWorkspaceKey: runtimeByWorkspaceKey,
      archived: true,
    });

    return [...pinnedTargets, ...timelineTargets, ...archivedTargets].sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }
      return right.taskId.localeCompare(left.taskId);
    });
  }, [
    archivedTaskList.items,
    pinnedTaskList.items,
    timelineTaskList.items,
    workspaceStates,
    workspaceTabs,
  ]);
  const shouldSyncTasks = shouldSyncWebRemoteControlTaskSnapshot({
    archivedLoading: archivedTaskList.loading,
    enabled: true,
    pinnedLoading: pinnedTaskList.loading,
    timelineLoading: timelineTaskList.loading,
  });

  useEffect(() => {
    if (!shouldSyncTasks) {
      logDeferredWebRemoteControlTaskSnapshot(logger, {
        pinnedLoading: pinnedTaskList.loading,
        archivedLoading: archivedTaskList.loading,
        timelineLoading: timelineTaskList.loading,
      });
      return;
    }

    syncWebRemoteControlTasks(taskTargets);
  }, [
    archivedTaskList.loading,
    pinnedTaskList.loading,
    shouldSyncTasks,
    syncWebRemoteControlTasks,
    taskTargets,
    timelineTaskList.loading,
  ]);

  return null;
}

/**
 * Root, the application root component.
 *
 * Outer layers mount StoreProvider (connection broadcast) plus TabStoreProvider; the inner layer handles auth and routing.
 */
export function Root(props: RootProps) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * lucide.tsx used to wrap every icon, pinning the default strokeWidth to 1.5.
       * With the wrapper gone, icons across buttons, lists and toolbars would fall back to 2 without a
       * root-level default, reading bolder and tighter at the same size classes. The official
       * LucideProvider restores the default while per-icon strokeWidth overrides still win.
       */}
      <TooltipProvider>
        {/*
         * Conversation message actions spawn large numbers of tooltips; a Provider per tooltip instance
         * would build a same-order Radix context tree synchronously on task-switch clicks. One shared
         * provider at the root keeps the zero-delay configuration.
         */}
        <ServiceProvider services={props.services}>
          <PlatformProvider platform={props.platform}>
            <StoreProvider
              broadcastService={props.services.broadcastService}
              initialIsRestoringOAuthSession
            >
              <TabStoreProvider>
                <DiffsWorkerPoolProvider>
                  <WebRemoteControlFeatureProvider enabled={props.webRemoteControlFeatureEnabled}>
                    <AssistantCodeCommentFeatureProvider
                      enabled={props.assistantCodeCommentCardsEnabled}
                    >
                      <CodingPlanUpgradeDialogProvider>
                        <RewardsProvider desktop={props.isDesktop === true}>
                          <RequestSecurityHost />
                          <MarketingTouchProvider desktop={props.isDesktop === true}>
                            <RootInner {...props} />
                          </MarketingTouchProvider>
                        </RewardsProvider>
                      </CodingPlanUpgradeDialogProvider>
                    </AssistantCodeCommentFeatureProvider>
                  </WebRemoteControlFeatureProvider>
                </DiffsWorkerPoolProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
  allowRemoteWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialWebRemoteControlMobileNavigationIntent,
  initialWebRemoteControlWorkspaceList,
  webRemoteControlTerminalTransportState,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  useEffect(() => {
    setRequestSecurityReporter(platform);
    setMcpStorePlatform(platform);
    // Conversation UI perf belongs to desktop-continuous alone; Web/mobile never mount a reporter even when they can see authoritative state.
    setUiPerfArmsReporter(isDesktop ? platform : null);
    setSessionOpenArmsReporter(isDesktop ? platform : null);
    // Same for the send funnel: reported on Electron desktop only; the Web/mobile reportArmsCustomEvent is a no-op.
    setSendFunnelArmsReporter(isDesktop ? platform : null);
    return () => {
      setRequestSecurityReporter(null);
      setMcpStorePlatform(null);
      setUiPerfArmsReporter(null);
      setSessionOpenArmsReporter(null);
      setSendFunnelArmsReporter(null);
    };
  }, [isDesktop, platform]);

  useEffect(
    () =>
      installConversationTelemetryParityE2EBridge({
        platform,
        isDesktop: isDesktop === true,
      }),
    [isDesktop, platform],
  );

  useEffect(
    () => () => {
      disposeConversationTelemetrySupervisors();
    },
    [],
  );

  // The single fetch point for the dynamic-workflow rollout snapshot: taken once at the app-level
  // ServiceProvider, read-only for the automations page and run panes. Consumers may sit inside a
  // workspace-level ServiceProvider (a remote host accessor); fetching there would answer from another host.
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService);

  const { intl, locale } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const user = useZCodeStore((state) => state.user);
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  const setUser = useZCodeStore((state) => state.setUser);
  const setIsRestoringOAuthSession = useZCodeStore((state) => state.setIsRestoringOAuthSession);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const oauthPollingActive = useZCodeStore((state) => state.oauthPollingActive);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);
  const markOAuthSuccess = useZCodeStore((state) => state.markOAuthSuccess);
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
    update: updateAppSettings,
  } = useSettings();
  // docs/dynamic-workflow/launch.md "The user's choice": when the settings choice changes, tell this
  // window's host to re-send CLI policy (forwarding to remote hosts), then re-read the rollout snapshot.
  useDynamicWorkflowUserModeSync({
    settingsLoaded: Boolean(appSettings),
    userMode: appSettings?.dynamicWorkflowMode,
    zcodeAgentService: services.zcodeAgentService,
    codingPlanSubscriptionService: services.codingPlanSubscriptionService,
  });
  const [welcomeScreenOpenReason, setWelcomeScreenOpenReason] =
    useState<WelcomeScreenOpenReason | null>(() =>
      consumeZcodeJwtInvalidRestartMarker() ? "session-expired" : null,
    );
  const [providerFamilyDomainMigrationComplete, setProviderFamilyDomainMigrationComplete] =
    useState(false);
  const loginEntryRequest = useZCodeStore((state) => state.loginEntryRequest);
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const rootModelSelectionView =
    rootModelSelectionRead.state.status === "ready" ? rootModelSelectionRead.state.view : null;
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  const readRootModelSelectionView = useCallback(
    () => services.modelSelectionService.getView(),
    [services.modelSelectionService],
  );
  const [remoteConnectionDialogOpen, setRemoteConnectionDialogOpen] = useState(false);
  const [remoteConnectionOpenPreference, setRemoteConnectionOpenPreference] =
    useState<RemoteConnectionOpenPreference | null>(null);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [remoteConnectionInProgress, setRemoteConnectionInProgress] = useState(false);
  const [remoteConnectionRequestId, setRemoteConnectionRequestId] = useState<string | null>(null);
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const { connectionLogs: remoteConnectionLogs, resetConnectionLogs: resetRemoteConnectionLogs } =
    useRemoteConnectionLogs(remoteConnectionRequestId);
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  const acknowledgingReleaseNotesVersionRef = useRef<string | null>(null);
  const previousRemoteConnectionInProgressRef = useRef(false);
  const didRequestFallbackWorkspaceRef = useRef(false);
  const rootInnerMountedRef = useRef(true);
  const [hasEnteredNativeThemeSyncSurface, setHasEnteredNativeThemeSyncSurface] = useState(false);

  useEffect(() => {
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          logger.warn("[settings] dropping invalid runtime-preference broadcast", {
            issues: parsed.error.issues,
          });
          return;
        }
        void refreshAppSettings();
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] cross-window preference sync failed", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] cross-window bot preference sync failed", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // Closing the file tab unmounts PreviewPane, so its own cross-window cleanup listener is gone.
      // Clear the renderer-level preview store within Root's lifetime, or reopening the file after send
      // resurrects the old comment.
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    if (!appSettings) {
      return;
    }
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] runtime-preference init failed", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] bot runtime-preference init failed", error);
      });
  }, [
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);

  const tabs = useTabStore((state) => state.tabs);
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // When Settings covers a tab, keep the covered tab's full remote identity so notifications and sidebar do not double-subscribe.
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );

  const localWorkspacePathForRemoteConnection = useTabStore((state) => {
    const activeTab = state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : null;
    if (
      !activeTab ||
      !isWorkspaceTab(activeTab) ||
      activeTab.remoteSessionId ||
      activeTab.remoteTarget ||
      activeTab.workspaceIdentity ||
      activeTab.workspacePurpose === "conversation"
    ) {
      return undefined;
    }
    return activeTab.workspacePath;
  });
  const totalUnreadTaskCount = useZCodeSessionStore((state) =>
    countAllUnreadTasks(state.workspaces),
  );
  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();
  const webRemoteControlFeatureEnabled = useWebRemoteControlFeatureEnabled();
  // Bugfix: WebRemoteControlDialog is a toggleable surface, not the owner of global remote state.
  // Root polls the main process directly, binding task-snapshot sync to a real running/active remote session.
  const webRemoteControlStatus = useWebRemoteControlStatus({
    enabled: Boolean(
      webRemoteControlFeatureEnabled && isDesktop && platform.syncWebRemoteControlTasks,
    ),
  });
  const webRemoteControlSessionActive =
    webRemoteControlStatus.status === "running" || webRemoteControlStatus.status === "active";
  const webRemoteControlTaskSyncEnabled = Boolean(
    webRemoteControlFeatureEnabled &&
    webRemoteControlSessionActive &&
    isDesktop &&
    platform.syncWebRemoteControlTasks,
  );
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);
  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        await ensureProviderFamilyDomainMigration(services);
      } catch (error) {
        logger.warn("[Root] provider family domain migration failed, continuing startup", {
          error,
        });
      } finally {
        if (!disposed) {
          setProviderFamilyDomainMigrationComplete(true);
          try {
            await refreshAppSettings();
            await refreshProviderState();
          } catch (refreshError) {
            logger.warn("[Root] post-migration provider state refresh failed", {
              error: refreshError,
            });
          }
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [refreshAppSettings, refreshProviderState, services]);

  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const isResolvingStartupAuthState = isRestoringOAuthSession;
  const rootProviderAvailability = resolveProviderAvailabilityState({
    modelSelectionView: rootModelSelectionView,
  });
  const providerStartupSyncPending = isProviderStartupSyncPending({
    providerFamilyDomainMigrationComplete,
    modelSelectionViewHydrated:
      rootProviderAvailability.hydrated || rootModelSelectionRead.state.status === "error",
  });
  const isWebRemoteControlRoot = Boolean(webRemoteControlWorkspaceSwitcher);
  const providerAvailabilityLoginEntryGuardEnabled =
    shouldEnableProviderAvailabilityLoginEntryGuard({
      isWebRemoteControlRoot,
    });
  const { startupCheckCompleted: providerAvailabilityStartupCheckCompleted } =
    useProviderAvailabilityLoginEntryGuard({
      enabled: providerAvailabilityLoginEntryGuardEnabled,
      user,
      isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
      providerFamilyDomain: appSettings?.providerFamilyDomain,
      modelSelectionView: rootModelSelectionView,
      modelSelectionError:
        rootModelSelectionRead.state.status === "error"
          ? rootModelSelectionRead.state.error
          : undefined,
      refreshProviderState,
      readModelSelectionView: readRootModelSelectionView,
      setLoginEntryOpen: (open) => {
        setWelcomeScreenOpenReason((currentReason) => {
          if (open) {
            return "startup-provider-required";
          }
          // Once the JWT-expiry notice is confirmed it writes session-expired, and the provider startup
          // gate closes with open=false. Clearing unconditionally here would cover the re-login page and
          // return to the workspace. A gate closes only the login state it owns; reasons from other
          // interactions are not its to clear.
          return currentReason === "startup-provider-required" ? null : currentReason;
        });
      },
    });
  const isResolvingProviderStartupState = shouldResolveProviderStartupState({
    isWebRemoteControlRoot,
    providerStartupSyncPending,
    providerAvailabilityStartupCheckCompleted,
  });
  const isStartupProviderLoginEntryOpen = welcomeScreenOpenReason === "startup-provider-required";
  // On first install the provider-login gate resolves after workspace injection, so ChatView mounts
  // first and warms a draft. Fold the provider check into the workspace-restore gate; no ZCode session
  // starts before an account connects.
  const canRestoreWorkspaceSession =
    !isResolvingStartupAuthState &&
    !isResolvingProviderStartupState &&
    !isStartupProviderLoginEntryOpen;

  useEffect(() => {
    // The cross-workspace task list needs a stable local/root-services handle. The desktop renderer
    // registers once at startup, but Web and test entries mount Root directly; register again from Root
    // props as the fallback, so with a remote workspace active the local list never borrows the remote host.
    registerBaseWorkspaceServices(services);
  }, [services]);

  useBotBroadcastEffects(services, tabStoreApi);

  const handleOpenRemoteConnection = useCallback((preference?: RemoteConnectionOpenPreference) => {
    setRemoteConnectionOpenPreference(preference ?? null);
    setRemoteConnectionDialogOpen(true);
  }, []);
  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, []);
  const handleReauthenticationRequired = useCallback(() => {
    setWelcomeScreenOpenReason("session-expired");
  }, []);
  const {
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
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    setOAuthError,
    setUser,
    onProviderFamilyDomainClearedAfterLogout: () => {
      setWelcomeScreenOpenReason("logout-provider-required");
    },
    userId: user?.id,
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
    workbenchGroupClientMode: isWebRemoteControlRoot
      ? "web-remote-replayable"
      : "desktop-continuous",
  });
  const handleRemoteWorkspaceActivated = useCallback(
    ({
      workspacePath,
      workspaceIdentity,
    }: {
      workspacePath: string;
      workspaceIdentity: string;
    }) => {
      startDraftInWorkspace(workspacePath, workspaceIdentity);
    },
    [startDraftInWorkspace],
  );

  const {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleRemoteWorkspaceTabsClosed,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings,
    allowRemoteWorkspace,
    // The conversation backing workspace belongs to the local desktop restore path alone; remote windows
    // and phone shared-host attachment must not spawn a local runtime or move the replayable boundary.
    ensureConversationWorkspaceOnRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    deferInactiveWorkspaceRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    unavailableWorkspacePath,
    tabStoreApi,
    activateTabByPath,
    addTab,
    onWorkspaceActivated: handleRemoteWorkspaceActivated,
  });

  useEffect(() => {
    if (!platform.onWebRemoteControlReconnectWorkspace) {
      return;
    }

    return platform.onWebRemoteControlReconnectWorkspace(async (request) => {
      try {
        await handleReconnectRemoteWorkspace(request.workspaceKey, {
          activateWorkspaceAfterReconnect: false,
          showErrorToast: false,
          throwOnFailure: true,
        });
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: true,
        };
      } catch (error) {
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }, [handleReconnectRemoteWorkspace, platform]);

  useEffect(() => {
    // Bugfix: fileDisplay without a basePath must land on the active workspace. The pure util had no
    // window workspace context and fell back to absolute paths, making mentions and file chips verbose.
    // Root mirrors the current context on workspace switch: the util stays reusable, no Zustand dependency
    // smuggled into it.
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }

    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // On first install without a connected account, the provider-login gate lands after workspace
    // restore. Restoring first would have ChatView mount, warm a draft session, and error behind the
    // login page.
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: restoreSession && canRestoreWorkspaceSession,
    restorePersistedSession,
    buildPersistPatch: buildPersistedTabPatch,
  });

  useEffect(() => {
    if (!isDesktop || !hasCompletedFullRestore) return;
    // Bug: an active-first single workspace is only the renderer's first-paint projection; syncing it
    // outward at once briefly drops the other workspaces' telemetry scope. Publish the full set only
    // once complete.
    reconcileConversationTelemetryWorkspaceScopes(
      windowWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      })),
    );
  }, [hasCompletedFullRestore, isDesktop, windowWorkspaceTabs]);

  const webRemoteControlTaskSyncNode =
    hasCompletedFullRestore &&
    webRemoteControlTaskSyncEnabled &&
    platform.syncWebRemoteControlTasks ? (
      <WebRemoteControlTaskSync
        syncWebRemoteControlTasks={platform.syncWebRemoteControlTasks}
        workspaceTabs={windowWorkspaceTabs}
      />
    ) : null;

  // Bug (2026-08-16 web remote hang): the Start Plan request-validation responder mounted only with the
  // desktop's visible session pane. A new remote-session creation had no desktop pane and no responder,
  // so the headers request pending forever and the task stuck at working. The responder must live in the
  // desktop window across every open workspace tab, decoupled from visibility; Web stays subscription-free
  // and desktop remains the single authority.
  const requestSecurityBridgeNode = isDesktop ? (
    <RequestSecurityWorkspaceBridge workspaceTabs={windowWorkspaceTabs} />
  ) : null;

  const { tryRefresh, clearCredentials } = useTokenRefresh();
  void tryRefresh;
  void clearCredentials;
  // The startup block is a desktop-window protection window; phone web remote already has pairing and
  // loading pages before Root. Reusing the gate on Web renders an empty RootShell before tabs inject,
  // flashing the browser background.
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    isResolvingStartupAuthState,
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });

  const launchReportedRef = useRef(false);
  useEffect(() => {
    if (
      !shouldReportLaunchToInput({
        isStartupRenderBlocked,
        welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
        alreadyReported: launchReportedRef.current,
      })
    ) {
      return;
    }
    launchReportedRef.current = true;
    const timings = readRendererLaunchTimings();
    if (!timings || !timings.marks) {
      return; // no anchor (non-desktop / marks not injected): skip the whole batch
    }
    reportUiLaunchToInput({
      marks: timings.marks,
      rendererStart: timings.rendererStart,
      reactCommit: timings.reactCommit,
      inputReady: Date.now(), // T6
      sessionId: `launch-${timings.marks.createdAt}`,
    });
  }, [isStartupRenderBlocked, welcomeScreenOpenReason]);

  useRootPlatformEffects({
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    // When a cold start passes initialWorkspacePath (OS context menu, service), restore the historical
    // tabs first, then merge and activate the target. addTab before restoreTabs would be replaced
    // wholesale; disabling restoreSession instead would drop every other workspace.
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: (path) => {
      void handleSelectProject(path);
    },
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    locale,
    tabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    totalUnreadTaskCount,
    webRemoteControlFeatureEnabled,
    webRemoteControlSessionActive,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
    isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
  });

  useEffect(() => {
    if (!platform.onCloseActiveContextRequest) {
      return;
    }

    return platform.onCloseActiveContextRequest(() => {
      const event = new Event(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, { cancelable: true });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      // Close requests broadcast to the workspace layer first, which closes the side pane's active tab.
      // Only with no visible workspace, or nothing closable in the side pane, does it fall back to closing the window.
      void platform.executeDesktopCommand(DesktopCommandIds.CloseWindow);
    });
  }, [platform]);

  useRootOAuthEffects({
    accountIntentKey: JSON.stringify([
      user?.id,
      appSettings?.providerFamilyDomain,
      appSettings?.providerFamilyConnectionSelections,
    ]),
    platform,
    services,
    refreshProviderState,
    refreshAppSettings,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    onReauthenticationRequired: handleReauthenticationRequired,
  });

  useEffect(
    () =>
      platform.onPostUpdateReleaseNotes((payload) => {
        logger.info("[Root] release notes received, acknowledging silently", {
          version: payload.version,
          title: payload.title,
        });
        if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
          return;
        }

        // Every pending-release-notes hit lands here. Root used to push the payload straight into dialog
        // state, interrupting each update with a modal. This change only removes the dialog: acknowledge
        // silently on receipt, leaving the update-downloaded button/menu/install path intact and making
        // sure no pending state survives to retrigger on next launch.
        acknowledgingReleaseNotesVersionRef.current = payload.version;
        void platform
          .acknowledgePostUpdateReleaseNotes(payload.version)
          .then(() => {
            logger.info("[Root] release notes silently acknowledged", {
              version: payload.version,
            });
          })
          .catch((error) => {
            logger.error("[Root] release notes silent-ack failed", {
              version: payload.version,
              error,
            });
          })
          .finally(() => {
            if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
              acknowledgingReleaseNotesVersionRef.current = null;
            }
          });
      }),
    [platform],
  );

  const canEnterNativeThemeSyncSurface = Boolean(
    !isStartupRenderBlocked &&
    !welcomeScreenOpenReason &&
    (workspaceShellPath || isSettingsTabActive),
  );

  useEffect(() => {
    if (!canEnterNativeThemeSyncSurface) {
      return;
    }

    // macOS nativeTheme drives window vibrancy. Allow theme sync one tick after RootStartupLoading exits
    // into the main UI or settings, so the startup shell's background is not repainted early.
    setHasEnteredNativeThemeSyncSurface(true);
  }, [canEnterNativeThemeSyncSurface]);

  useDesktopNativeThemeSync({
    enabled: hasEnteredNativeThemeSyncSurface,
    isDesktop,
    platform,
    theme,
  });

  useRemoteWorkspaceTabLifecycle({
    tabs,
    activeWorkspaceTab,
    platform,
    onRemoteWorkspaceTabsClosed: handleRemoteWorkspaceTabsClosed,
  });

  useEffect(() => {
    if (
      shouldBlockRootRender({
        isResolvingStartupAuthState,
        isResolvingProviderStartupState,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      isStartupProviderLoginEntryOpen ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // The tab store's default empty state used to route Root through an open-workspace interstitial.
    // With that page gone, an empty restore or a missing initialWorkspacePath must fall back to the
    // default workspace here, or the user glimpses an interstitial/blank page. The effect's cleanup
    // cannot serve as the async cancel flag: setIsCreatingFallbackWorkspace or the post-addTab
    // workspaceShellPath change runs cleanup first, and skipping finally on that would hold the startup
    // loading gate true forever.
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // The startup fallback mkdir can start before restore and return after it; re-check the tab
        // store's latest active workspace on return, so a late default project cannot steal the restored tab.
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] startup fallback default-workspace creation failed", { error });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingProviderStartupState,
    isResolvingStartupAuthState,
    isRestoring,
    isSettingsTabActive,
    isStartupProviderLoginEntryOpen,
    services.fileService,
    setWorkspaceActionError,
    tabStoreApi,
    workspaceShellPath,
  ]);

  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);

  useEffect(() => {
    if (!loginEntryRequest) {
      return;
    }
    // Login moved from modal into WelcomeScreen. A provider connect must still exit the first-run
    // onboarding state first, or completion mis-creates the default workspace.
    setWelcomeScreenOpenReason("provider-request");
  }, [loginEntryRequest]);

  const handleOpenLoginEntry = () => {
    setWelcomeScreenOpenReason("manual-login");
  };
  const handleWelcomeScreenComplete = useCallback(
    async (reason: LoginCompleteReason) => {
      await refreshAppSettings();
      if (
        welcomeScreenOpenReason !== "startup-provider-required" ||
        workspaceShellPath ||
        !allowOpenWorkspace
      ) {
        setWelcomeScreenOpenReason(null);
        return;
      }

      try {
        await handleEnsureConversationWorkspace();
      } catch (error) {
        logger.error("[Root] post-login default workspace creation failed", {
          error,
          reason,
        });
      } finally {
        setWelcomeScreenOpenReason(null);
      }
    },
    [
      allowOpenWorkspace,
      handleEnsureConversationWorkspace,
      refreshAppSettings,
      welcomeScreenOpenReason,
      workspaceShellPath,
    ],
  );
  const handleRemoteConnectionDialogOpenChange = useCallback((open: boolean) => {
    setRemoteConnectionDialogOpen(open);
    if (!open) {
      setRemoteConnectionOpenPreference(null);
    }
  }, []);

  const remoteConnectionDialog = allowRemoteWorkspace ? (
    <SSHDialog
      onConnect={handleConnectRemote}
      onSelectProject={handleSelectRemoteProject}
      onCancelSession={handleCancelRemoteProject}
      localWorkspacePath={localWorkspacePathForRemoteConnection}
      isWindowsDesktop={isWindowsDesktop}
      remoteWorkspaceSessions={remoteWorkspaceSessions}
      open={remoteConnectionDialogOpen}
      onOpenChange={handleRemoteConnectionDialogOpenChange}
      onFlowActiveChange={setRemoteConnectionInProgress}
      onFlowRequestIdChange={setRemoteConnectionRequestId}
      preferredKind={remoteConnectionOpenPreference?.preferredKind}
      preferredWslDistro={remoteConnectionOpenPreference?.preferredWslDistro}
      hideTriggerWhenClosed
    />
  ) : null;
  const directoryBrowserDialog = directoryBrowserOpen ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        onCancel={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => {
          setDirectoryBrowserOpen(false);
          void handleSelectProject(path);
        }}
      />
    </ScopedErrorBoundary>
  ) : null;

  useEffect(() => {
    const wasInProgress = previousRemoteConnectionInProgressRef.current;
    if (!wasInProgress && remoteConnectionInProgress) {
      resetRemoteConnectionLogs();
    }
    previousRemoteConnectionInProgressRef.current = remoteConnectionInProgress;
  }, [remoteConnectionInProgress, resetRemoteConnectionLogs]);

  const settingsLayerProps = {
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    isWebRemoteControl: Boolean(webRemoteControlWorkspaceSwitcher),
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
    onLogin: !user ? handleOpenLoginEntry : undefined,
    onLogout: user ? handleLogout : undefined,
    user,
  };

  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {webRemoteControlTaskSyncNode}
        {requestSecurityBridgeNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        {/* Fix rationale: the HTML boot shell already shows the ZCode mark, but React replacing the root
            swaps the whole shell. While tabs restore or the initial workspace injects, the fallback used to
            render plain text, splitting startup into two loadings. Reuse the same SVG splash and keep the
            wording only in aria-label: visuals stay continuous, accessibility intact. */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  if (welcomeScreenOpenReason) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {webRemoteControlTaskSyncNode}
        {requestSecurityBridgeNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        <WelcomeScreen
          mode={
            welcomeScreenOpenReason === "manual-login" ||
            welcomeScreenOpenReason === "provider-request"
              ? "login-entry"
              : "startup"
          }
          onComplete={handleWelcomeScreenComplete}
        />
      </RootShell>
    );
  }

  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // Non-desktop entries inject the workspace tab via effect; the first frame cannot return null. Hold
    // the entry loading until the task list carries a workspaceShellPath, never flashing the browser
    // background.
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {webRemoteControlTaskSyncNode}
        {requestSecurityBridgeNode}
        {initialWorkspaceLoadingFallback}
        {directoryBrowserDialog}
      </RootShell>
    );
  }

  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {webRemoteControlTaskSyncNode}
      {requestSecurityBridgeNode}
      {remoteConnectionDialog}
      {directoryBrowserDialog}
      <OccupationOnboarding
        showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}
        showChildrenWhileLoading={!workspaceShellPath && isSettingsTabActive}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        {/* Onboarding is an app-level preference; mount it even with no project so the settings page's manual open works. */}
        {!workspaceShellPath ? (
          isSettingsTabActive ? (
            <ScopedErrorBoundary
              scope="settings-page"
              resetKeys={["settings-root"]}
              variant="panel"
              className="h-full"
            >
              <SettingsPage {...settingsLayerProps} />
            </ScopedErrorBoundary>
          ) : null
        ) : (
          <RootWorkspaceContent
            workspaceScopedServices={workspaceScopedServices}
            baseFeedbackService={services.feedbackService}
            workspaceShellPath={workspaceShellPath}
            workspaceIdentity={workspaceShellIdentity}
            workspaceRemoteSessionId={workspaceShellRemoteSessionId}
            activeWorkspacePath={activeWorkspacePath}
            isSettingsTabActive={isSettingsTabActive}
            handleConnectRemote={handleConnectRemote}
            handleSelectRemoteProject={handleSelectRemoteProject}
            handleCancelRemoteProject={handleCancelRemoteProject}
            handleReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
            handleCreateTask={handleCreateTask}
            handleCreateConversationTask={handleCreateConversationTask}
            handleResolveConversationWorkspace={handleResolveConversationWorkspace}
            handleOpenWorkspace={handleOpenWorkspace}
            handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
            handleOpenRemoteWorkspace={
              allowRemoteWorkspace ? handleOpenRemoteConnection : undefined
            }
            handleCreateScratchWorkspace={handleCreateScratchWorkspace}
            remoteConnectionInProgress={remoteConnectionInProgress}
            remoteWorkspaceSessions={remoteWorkspaceSessions}
            allowRemoteWorkspace={allowRemoteWorkspace}
            handleBackFromSettings={handleBackFromSettings}
            handleLogout={user ? handleLogout : undefined}
            onLogin={!user ? handleOpenLoginEntry : undefined}
            user={user}
            reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
            remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
            reconnectingRemoteWorkspaceLogsByWorkspaceKey={
              reconnectingRemoteWorkspaceLogsByWorkspaceKey
            }
            remoteConnectionLogs={remoteConnectionLogs}
            allowOpenWorkspace={allowOpenWorkspace}
            webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
            initialWebRemoteControlMobileNavigationIntent={
              initialWebRemoteControlMobileNavigationIntent
            }
            initialWebRemoteControlWorkspaceList={initialWebRemoteControlWorkspaceList}
            webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            supportsEmbeddedBrowser={supportsEmbeddedBrowser}
          />
        )}
        <ScopedErrorBoundary
          scope="onboarding-dialog"
          resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
          variant="silent"
        >
          <OnboardingDialog
            workspacePath={workspaceShellPath || undefined}
            workspaceIdentity={workspaceShellIdentity}
            isDesktop={isDesktop}
          />
        </ScopedErrorBoundary>
      </OccupationOnboarding>
    </RootShell>
  );
}
