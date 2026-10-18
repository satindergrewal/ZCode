/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createUuid } from "@zcode/shared";
import type { EmbeddedBrowserOpenUrlRequest, IPlatformService } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
// Keep-alive: the side pane terminal registry is hoisted to module level so it
// survives workspace switches. Closing a terminal tab must explicitly release it
// and kill the PTY, or the long-lived registry leaks orphan processes.
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  buildTaskSidePaneMemoryKey,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  closeSidePaneTab,
  closeSidePaneTabForParent,
  closeVisibleOtherSidePaneTabs,
  closeVisibleSidePaneTabs,
  closeGitSidePane,
  closeCodeViewerSidePane,
  openWhiteboardSidePane,
  openModelTrajectorySidePane,
  openTerminalSidePane,
  openSubagentSessionSidePane,
  openSubagentDirectorySidePane,
  openSelectionSideChatPane,
  openPlanDetailSidePane,
  openWorkflowRunSidePane,
  replaceWorkflowRunSidePane,
  openWorkflowRunDirectorySidePane,
  openWorkflowActorSessionSidePane,
  openWorkflowWorkspaceSidePane,
  openWorkflowArtifactSidePane,
  activateDeveloperToolsSidePane,
  openBrowserSidePane,
  openOrActivateBrowserSidePaneByUrl,
  findBrowserSidePaneTabByUrl,
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  applyBrowserTabResidencyEvent,
  BROWSER_USE_OPERATION_INDICATOR_DURATION_MS,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  activateGitSidePane,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  sidePaneOwnerKey,
  markBrowserUseSidePaneTabOperation,
  reorderSidePaneTab,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  setActiveSidePaneTab,
  syncSubagentSessionSidePaneTabs,
  toggleBrowserSidePane,
  toggleGitSidePane,
  updateBrowserSidePaneTab,
  stampSidePaneTabsOwnership,
  type BrowserSidePaneMetadata,
  type TreemappingSidePaneTab,
  type OpenScopedSubagentSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  openBackgroundBashSidePane,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenSelectionSideChatRequest,
  type OpenScopedPlanDetailSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenScopedWorkflowRunDirectorySideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type WorkspaceSidePaneState,
  type WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { isSidePaneTabVisibleForParent } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { getPathLeaf, joinFilePath, toFileUrl } from "@/lib/path.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { useServices } from "@/hooks/useServices.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { clearSelectionSideChat } from "@/lib/selectionSideChatRuntime.js";
import { clearConversationSelectionReferenceScope } from "@/lib/conversationSelectionReference.js";
import { subscribeTaskLifecycle } from "@/lib/taskLifecycleEvents.js";

export interface BrowserNavigationRequest {
  id: string;
  targetTabId: string;
  url: string;
}

function isAgentOpenedBrowserPopup(payload: EmbeddedBrowserOpenUrlRequest): boolean {
  // The human webview owner uses unclaimed-iab; legacy-iab and iab:<uuid> are both
  // Agent-controlled contexts. sourceTabId also keeps plain external/terminal links
  // from being mistaken for a model popup.
  return Boolean(payload.sourceTabId && payload.browserId && payload.browserId !== "unclaimed-iab");
}

export interface RecentClosedSidePaneTab {
  tab: WorkspaceSidePaneTab;
  closedAt: number;
}

const RECENT_CLOSED_SIDE_PANE_TAB_LIMIT = 8;

function createTerminalSidePaneTitle(
  current: WorkspaceSidePaneState | null,
  workspaceAbsPath: string,
): string {
  const baseTitle = getPathLeaf(workspaceAbsPath) || "Terminal";
  const usedTitles = new Set(
    current?.tabs
      .filter((tab) => tab.type === "terminal")
      .map((tab) => tab.title.trim())
      .filter(Boolean) ?? [],
  );

  if (!usedTitles.has(baseTitle)) {
    return baseTitle;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseTitle} ${index}`;
    if (!usedTitles.has(candidate)) {
      return candidate;
    }
  }
}

export function useAppPanels(options: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  /** Draft and real tasks share a stable id as the side pane conversation boundary. */
  sidePaneOwnerId: string | null;
  isDesktop?: boolean;
  /**
   * Visibility semantics: whether the view is currently presented to the user
   * (false while a settings page overlays it). This hook deliberately ignores it —
   * Browser View events are the main-side authoritative stream, so subscription must
   * not depend on visibility; see the timing note on the subscription effect below.
   * The parameter survives only as a regression guard: the four
   * useAppPanelsBrowserViewLifecycle cases express "settings overlay active" by
   * passing false. If visibility is ever written back into the subscription
   * condition, those cases fail at once. Drop the parameter and that guard goes
   * with it.
   */
  isWorkspaceVisible?: boolean;
  supportsEmbeddedBrowser?: boolean;
  defaultWhiteboardNamePrefix: string;
  platform?: Pick<
    IPlatformService,
    | "onOpenBrowserUrl"
    | "onBrowserViewReady"
    | "onBrowserViewOperation"
    | "onBrowserViewVisibility"
    | "onBrowserViewCloseTab"
    | "onBrowserViewSuspend"
    | "onBrowserViewRestore"
    | "browserViewCloseTab"
    | "browserViewEnsureResident"
  >;
}) {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
    defaultWhiteboardNamePrefix,
    platform,
  } = options;
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const activeWorkspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const { zcodeAgentService, zcodeSessionService } = useServices();
  const isOfficeMode = useIsOfficeMode();
  const sidePaneMemoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const initialSidePaneMemoryState = readTaskSidePaneMemoryState(sidePaneMemoryKey);

  // Fix note: the terminal area used to be hard-wired to the bottom of <main> and
  // mounted on page load, occupying height by default and spinning up a terminal
  // session immediately. It is now an explicit switch, off by default; Terminal
  // renders only after the user opts in, so terminals no longer open implicitly.
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // Fix note: the shared right-hand pane (browser / code-viewer) must default to
  // closed, otherwise it claims main-session space on workspace entry, against the
  // "expand only when the user looks" intent.
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    initialSidePaneMemoryState.sidePaneState,
  );
  const [isSidePaneCollapsed, setIsSidePaneCollapsed] = useState(
    getSidePaneCollapsedPreference(initialSidePaneMemoryState, sidePaneOwnerId) ??
      initialSidePaneMemoryState.isSidePaneCollapsed,
  );
  // Interaction note: the sidebar toggle lives at the App level, not inside Sidebar,
  // so the entry stays top-left even while the sidebar is hidden (no dead end after
  // collapse). This is also where the macOS traffic-light safe area is handled so the
  // button never overlaps native window controls.
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [browserNavigationRequest, setBrowserNavigationRequest] =
    useState<BrowserNavigationRequest | null>(null);
  const [allRecentClosedSidePaneTabs, setAllRecentClosedSidePaneTabs] = useState<
    RecentClosedSidePaneTab[]
  >([]);
  const lastActiveSubagentTabByRootRef = useRef<Map<string, string>>(new Map());
  const sidePaneOwnerIdRef = useRef(sidePaneOwnerId);
  sidePaneOwnerIdRef.current = sidePaneOwnerId;
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  activeWorkspaceKeyRef.current = activeWorkspaceKey;
  const activeTabByOwnerRef = useRef<Map<string, string>>(new Map());
  const activeSidePaneMemoryKeyRef = useRef<string | null>(sidePaneMemoryKey);
  const latestSidePaneMemoryRef = useRef({
    sidePaneState,
    isSidePaneCollapsed,
  });
  latestSidePaneMemoryRef.current = {
    sidePaneState,
    isSidePaneCollapsed,
  };

  const revealSidePaneForCurrentOwner = useCallback(() => {
    setIsSidePaneCollapsed(false);
    latestSidePaneMemoryRef.current = {
      ...latestSidePaneMemoryRef.current,
      isSidePaneCollapsed: false,
    };
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      false,
    );
  }, []);

  const commitSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      const next = updater(latestSidePaneMemoryRef.current.sidePaneState);
      // Plain sidebar interactions and BrowserView IPC can land adjacently in one
      // React batch. If only BrowserView updates synced the ref, a later concrete
      // value would clobber not-yet-committed open/activate/reorder updates. Every
      // sidebar writer commits the canonical ref first, so interactions and lifecycle
      // merge strictly in arrival order.
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        sidePaneState: next,
      };
      setSidePaneState(next);
      return next;
    },
    [],
  );

  const commitOpenedSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      commitSidePaneState((current) =>
        stampSidePaneTabsOwnership(updater(current), {
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
          remoteSessionId: workspaceRemoteSessionId ?? null,
        }),
      );
    },
    [commitSidePaneState, workspaceRemoteSessionId],
  );

  useEffect(() => {
    const previousKey = activeSidePaneMemoryKeyRef.current;
    if (previousKey === sidePaneMemoryKey) {
      return;
    }

    // The side pane used to be transient state inside the workspace component and was
    // clobbered by the next render on workspace switch. Before the key changes, persist
    // the old workspace's tabs/collapsed state, then restore the new workspace's, so
    // workspaces do not leak state into each other. Switching tasks within a workspace
    // must not touch the side pane, so the key is no longer split per task.
    saveTaskSidePaneMemoryState(previousKey, latestSidePaneMemoryRef.current);
    const restored = readTaskSidePaneMemoryState(sidePaneMemoryKey);
    activeSidePaneMemoryKeyRef.current = sidePaneMemoryKey;
    commitSidePaneState(() => restored.sidePaneState);
    setIsSidePaneCollapsed(
      getSidePaneCollapsedPreference(restored, sidePaneOwnerIdRef.current) ??
        restored.isSidePaneCollapsed,
    );
  }, [commitSidePaneState, sidePaneMemoryKey]);

  useEffect(() => {
    return () => {
      saveTaskSidePaneMemoryState(
        activeSidePaneMemoryKeyRef.current,
        latestSidePaneMemoryRef.current,
      );
    };
  }, []);

  const hasVisibleSidePaneTabs = useCallback(
    (next: WorkspaceSidePaneState | null) =>
      Boolean(
        next &&
        getVisibleSidePaneTabs(next.tabs, {
          workspaceKey: activeWorkspaceKey,
          ownerTaskId: sidePaneOwnerId,
        }).length,
      ),
    [activeWorkspaceKey, sidePaneOwnerId],
  );

  const syncSidePaneCollapsedWithTabs = useCallback(
    (next: WorkspaceSidePaneState | null) => {
      if (!hasVisibleSidePaneTabs(next)) {
        // Lifecycle finalization must not expand the pane just because other visible
        // tabs exist; that would override the current owner's explicit collapse
        // preference. Only force-collapse once nothing visible remains.
        setIsSidePaneCollapsed(true);
      }
    },
    [hasVisibleSidePaneTabs],
  );

  useEffect(() => {
    commitSidePaneState((current) => {
      const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
      const preferredTabId =
        activeTabByOwnerRef.current.get(scopeKey) ??
        (activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : undefined);
      const collapsedPreference = getSidePaneCollapsedPreference(
        readTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current),
        sidePaneOwnerId,
      );
      const resolved = resolveSidePaneScopeState(
        current,
        { workspaceKey: activeWorkspaceKey, ownerTaskId: sidePaneOwnerId },
        preferredTabId,
        collapsedPreference,
      );
      setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);
      logger.debug("[App] sync conversation side pane scope", {
        activeTabId: resolved.sidePaneState?.activeTabId ?? null,
        activeTaskId,
        isSidePaneCollapsed: resolved.isSidePaneCollapsed,
        ownerTaskId: sidePaneOwnerId,
        preferredTabId: preferredTabId ?? null,
        workspaceKey: activeWorkspaceKey,
      });
      return resolved.sidePaneState;
    });
  }, [activeTaskId, activeWorkspaceKey, commitSidePaneState, sidePaneOwnerId]);

  const handleOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePane(current, source, sidePaneOwnerIdRef.current);
        const activeTab = getActiveSidePaneTab(next);
        const activePath =
          activeTab?.type === "code-viewer" ? (activeTab.source.path ?? "none") : "none";
        logger.info(
          `[App] activate side pane mode=code-viewer workspace=${workspaceAbsPath} title=${source.title} path=${activePath} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenCodeViewers = useCallback(
    (sources: readonly CodeViewerSource[]) => {
      if (sources.length === 0) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePanes(current, sources, sidePaneOwnerIdRef.current, 0);
        logger.info(
          `[App] batch-open side previews workspace=${workspaceAbsPath} sources=${sources.length} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBrowserUrl = useCallback(
    (request: string | EmbeddedBrowserOpenUrlRequest) => {
      const payload: EmbeddedBrowserOpenUrlRequest =
        typeof request === "string" ? { url: request, disposition: "foreground-tab" } : request;
      const sourceWorkspaceKey = payload.workspaceKey ?? activeWorkspaceKeyRef.current;
      const sourceSessionId = payload.sessionId ?? sidePaneOwnerIdRef.current;
      const sourceRemoteSessionId =
        payload.remoteSessionId ?? workspaceRemoteSessionId ?? undefined;
      const isCurrentOwner =
        sourceWorkspaceKey === activeWorkspaceKeyRef.current &&
        (sourceRemoteSessionId ?? "") === (workspaceRemoteSessionId ?? "") &&
        sourceSessionId === sidePaneOwnerIdRef.current;
      if (!supportsEmbeddedBrowser) {
        // The web build has no embedded browser pane; fall back to a new browser tab
        // so external links stay reachable.
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }

      // Interaction note: the message area only raises the "open this URL" intent;
      // actual webview navigation, URL validation, and pane visibility are handled
      // centrally on the browser-pane side.
      const isShareUrl = /^https?:\/\/[^/]+\/(?:cn\/)?share\/[^/]+$/u.test(payload.url);
      const targetTabId = `browser:${createUuid()}`;
      // When an Agent-controlled guest triggers a popup, the page is still part of
      // the model operation chain; do not treat it as a human-opened Browser tab
      // inheriting the free-size/zoom preferences stored in setting.json.
      const agentOpened = isAgentOpenedBrowserPopup(payload);
      // The webview popup event used to carry only the URL, so a late conversation-1
      // event could get captured by the conversation-2 owner. Keep the source scope
      // and steal focus only while the source is still the current owner.
      if (!isShareUrl && isCurrentOwner) {
        setBrowserNavigationRequest({
          id: createUuid(),
          targetTabId,
          url: payload.url,
        });
      }
      if (isCurrentOwner) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${isCurrentOwner ? "activate" : "mount hidden"} side pane mode=browser workspace=${sourceWorkspaceKey} sessionId=${sourceSessionId} url=${payload.url}`,
      );
      commitOpenedSidePaneState((current) =>
        isShareUrl
          ? openOrActivateBrowserSidePaneByUrl(current, {
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
            })
          : openBrowserSidePane(current, {
              tabId: targetTabId,
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              // Both paths carry ownerTaskId, so stampSidePaneTabsOwnership will not
              // re-stamp scope; remoteSessionId must be frozen at creation or the tab
              // can never be closed on remote.
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
              activate: isCurrentOwner,
              agentOpened,
            }),
      );
    },
    [
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      supportsEmbeddedBrowser,
      workspaceAbsPath,
      workspaceRemoteSessionId,
    ],
  );

  const handleToggleBrowser = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // Capability boundary: web/mobile has no Electron webview yet; no Browser side pane.
      logger.info(`[App] shell lacks an embedded browser; ignoring activate request workspace=${workspaceAbsPath}`);
      return;
    }

    commitOpenedSidePaneState((current) => {
      const activeTab = getActiveSidePaneTab(current);
      const closingActiveBrowser =
        activeTab?.type === "browser" &&
        sidePaneOwnerKey(activeTab.ownerTaskId) === sidePaneOwnerKey(sidePaneOwnerIdRef.current);
      const next = toggleBrowserSidePane(
        current,
        sidePaneOwnerIdRef.current,
        workspaceRemoteSessionId,
      );
      if (closingActiveBrowser) {
        syncSidePaneCollapsedWithTabs(next);
      } else {
        revealSidePaneForCurrentOwner();
      }
      const nextActiveTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] activate side pane mode=${nextActiveTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenBrowserTab = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // Capability boundary: web/mobile has no Electron webview yet; no Browser side pane.
      logger.info(`[App] shell lacks an embedded browser; ignoring create request workspace=${workspaceAbsPath}`);
      return;
    }

    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openBrowserSidePane(current);
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] new browser side tab=${activeTab?.id ?? "none"} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    workspaceAbsPath,
  ]);

  // The Browser View events below are main-side authoritative forwardings. Do not gate
  // the subscription on isWorkspaceVisible (= !isSettingsTabActive): the settings page is
  // an overlay, so the App stays mounted while the flag flips false, and once effect
  // cleanup unsubscribes, events emitted by main go into a black hole — a lost ready
  // makes waitForGuest time out after 10s and durably close the tab, leaving an empty
  // side pane when the user leaves settings. Visibility only means "shown to the user
  // now", never "whether to receive authoritative events"; focus stealing is still
  // decided by shouldReveal scope matching, so this no longer reads isWorkspaceVisible.
  useEffect(() => {
    if (!supportsEmbeddedBrowser || !isDesktop || !platform?.onOpenBrowserUrl) {
      return;
    }

    return platform.onOpenBrowserUrl((request) => {
      // target=_blank/window.open inside the webview used to be either swallowed by
      // popup policy or handed to Electron's default BrowserWindow creation. Main
      // already intercepts and validates the URL; the renderer here only routes the
      // controlled request into the visible workspace's side Browser tab.
      logger.info(
        `[App] webview requests side browser tab workspace=${workspaceAbsPath} url=${request.url} disposition=${request.disposition}`,
      );
      handleOpenBrowserUrl(request);
    });
  }, [handleOpenBrowserUrl, isDesktop, platform, supportsEmbeddedBrowser, workspaceAbsPath]);

  // Browser Use events carry the workspace/session frozen at creation; late events only
  // mount hidden and never steal the active conversation's focus.
  const handleBrowserViewReady = useCallback(
    (
      payload: Parameters<NonNullable<IPlatformService["onBrowserViewReady"]>>[0] extends (
        value: infer Payload,
      ) => void
        ? Payload
        : never,
    ) => {
      if (!isDesktop) return;
      const activeScope = {
        workspaceKey: activeWorkspaceKeyRef.current,
        remoteSessionId: workspaceRemoteSessionId ?? undefined,
        ownerTaskId: sidePaneOwnerIdRef.current,
      };
      const result = applyBrowserUseSidePaneEvent(
        latestSidePaneMemoryRef.current.sidePaneState,
        payload,
        activeScope,
      );
      commitSidePaneState(() => result.state);
      if (result.shouldReveal) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${result.shouldReveal ? "expand and activate" : "mount hidden"} browser-use tab workspace=${payload.workspaceKey} sessionId=${payload.sessionId} tabId=${payload.tabId}`,
      );
    },
    [commitSidePaneState, isDesktop, revealSidePaneForCurrentOwner, workspaceRemoteSessionId],
  );

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewReady) return;
    return platform.onBrowserViewReady(handleBrowserViewReady);
  }, [handleBrowserViewReady, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewOperation) return;
    return platform.onBrowserViewOperation((payload) => {
      const operationUntil = Date.now() + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
      commitSidePaneState((current) =>
        markBrowserUseSidePaneTabOperation(current, {
          ...payload,
          operationUntil,
        }),
      );
      // Browser commands arrive at the same order of magnitude as the message stream;
      // never log them at info in production.
      logger.debug("[App] browser-use operation", {
        operationUntil,
        sessionId: payload.sessionId,
        tabId: payload.tabId,
        workspaceKey: payload.workspaceKey,
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewVisibility) return;
    return platform.onBrowserViewVisibility((payload) => {
      if (payload.visible && payload.tabId) {
        const result = applyBrowserUseSidePaneVisibilityEvent(
          latestSidePaneMemoryRef.current.sidePaneState,
          { ...payload, tabId: payload.tabId },
          {
            workspaceKey: activeWorkspaceKeyRef.current,
            remoteSessionId: workspaceRemoteSessionId ?? undefined,
            ownerTaskId: sidePaneOwnerIdRef.current,
          },
        );
        if (result.didMatch) {
          activeTabByOwnerRef.current.set(
            `${payload.workspaceKey}::${payload.sessionId}`,
            `browser-use:${payload.tabId}`,
          );
        } else {
          // Visibility events arrive as often as browser commands; late events only get
          // a dev-level log to avoid flooding production logs.
          logger.debug("[App] ignore browser-use visibility with no live shell", {
            sessionId: payload.sessionId,
            tabId: payload.tabId,
            workspaceKey: payload.workspaceKey,
          });
        }
        commitSidePaneState(() => result.state);
        if (result.shouldReveal) revealSidePaneForCurrentOwner();
        return;
      }

      const active = getActiveSidePaneTab(latestSidePaneMemoryRef.current.sidePaneState);
      if (
        active?.type === "browser-use" &&
        active.workspaceKey === payload.workspaceKey &&
        (active.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
        active.sessionId === payload.sessionId &&
        active.browserId === payload.browserId &&
        active.browserGeneration === payload.browserGeneration &&
        (payload.tabId === undefined || active.tabId === payload.tabId)
      ) {
        setIsSidePaneCollapsed(true);
      }
    });
  }, [
    commitSidePaneState,
    isDesktop,
    platform,
    revealSidePaneForCurrentOwner,
    workspaceRemoteSessionId,
  ]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewCloseTab) return;
    return platform.onBrowserViewCloseTab((payload) => {
      const findTargetId = (state: WorkspaceSidePaneState | null) =>
        state?.tabs.find(
          (tab) =>
            (tab.type === "browser-use" && tab.tabId === payload.tabId) ||
            (tab.type === "browser" && tab.id === payload.tabId),
        )?.id ?? null;

      // Side pane state is stored per workspace; looking the target tab up only in the
      // "currently active" workspace misses it. The user may have switched workspaces by
      // the time the Agent closes a tab, so the notice would be silently dropped and the
      // old workspace's persisted state keeps the tab — its main-side logical tab is long
      // gone, close stops working, and it turns into a ghost tab. With the owner scope on
      // the notice, route by workspaceKey here and delete it from that workspace's memory.
      // Route by workspaceKey only, no session filter: main has already decided the tab is
      // closed, so the renderer shell must converge regardless of owning task; tabIds are
      // globally unique, so there is no cross-workspace misdelete.
      const targetWorkspaceKey = payload.workspaceKey;
      if (targetWorkspaceKey && targetWorkspaceKey !== activeSidePaneMemoryKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(targetWorkspaceKey);
        const targetId = findTargetId(stored.sidePaneState);
        if (!targetId) return;
        const nextState = closeSidePaneTab(stored.sidePaneState, targetId);
        saveTaskSidePaneMemoryState(targetWorkspaceKey, {
          sidePaneState: nextState,
          isSidePaneCollapsed: nextState ? stored.isSidePaneCollapsed : true,
        });
        return;
      }

      let didClose = false;
      const next = commitSidePaneState((current) => {
        const targetId = findTargetId(current);
        if (!targetId) return current;
        didClose = true;
        return closeSidePaneTabForParent(current, targetId, sidePaneOwnerIdRef.current);
      });
      if (didClose) syncSidePaneCollapsedWithTabs(next);
    });
  }, [commitSidePaneState, isDesktop, platform, syncSidePaneCollapsedWithTabs]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewSuspend) return;
    return platform.onBrowserViewSuspend((payload) => {
      commitSidePaneState((current) => {
        const target = current?.tabs.find(
          (tab) =>
            ((tab.type === "browser-use" && tab.tabId === payload.tabId) ||
              (tab.type === "browser" && tab.id === payload.tabId)) &&
            tab.workspaceKey === payload.workspaceKey &&
            (tab.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
            (tab.type === "browser-use"
              ? tab.sessionId === payload.sessionId
              : (tab.ownerTaskId ?? "unscoped") === payload.sessionId),
        );
        if (!target) return current;
        return applyBrowserTabResidencyEvent(current, payload);
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewRestore) return;
    return platform.onBrowserViewRestore((payload) => {
      commitSidePaneState((current) => applyBrowserTabResidencyEvent(current, payload));
    });
  }, [commitSidePaneState, isDesktop, platform]);

  const handleToggleGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const closingActiveGit = getActiveSidePaneTab(current)?.type === "git";
      const next = toggleGitSidePane(current);
      if (closingActiveGit) {
        syncSidePaneCollapsedWithTabs(next);
      } else {
        revealSidePaneForCurrentOwner();
      }
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] activate side pane mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
  ]);

  const handleOpenGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const next = activateGitSidePane(current);
      // The file-changes lookup only needs "ensure the Git pane is open"; do not reuse
      // the toggle. If the Git tab is already active, toggling closes it and hides
      // content exactly when the user switches to file changes.
      revealSidePaneForCurrentOwner();
      logger.info(
        `[App] open side pane mode=git workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTreemapping = useCallback(
    (source?: TreemappingSidePaneTab["source"]) => {
      // Treemapping is currently hidden from the sidebar. Keep the callback shape for
      // message-chain compatibility but stop creating a side pane tab, so the header or
      // legacy entries cannot bypass the menu-level hiding.
      logger.debug(
        `[App] hid treemapping side pane entry workspace=${workspaceAbsPath} source=${source?.kind ?? "current"}`,
      );
    },
    [workspaceAbsPath],
  );

  const handleOpenWhiteboard = useCallback(() => {
    const board = useWhiteboardStore.getState().createBoard({
      defaultNamePrefix: defaultWhiteboardNamePrefix,
      workspaceIdentity,
      workspacePath: workspaceAbsPath,
    });
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openWhiteboardSidePane(current, {
        boardId: board.id,
        title: board.name,
      });
      logger.info(
        `[App] open side pane mode=whiteboard workspace=${workspaceAbsPath} board=${board.id} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    defaultWhiteboardNamePrefix,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  const handleOpenDeveloperTools = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = activateDeveloperToolsSidePane(current);
      logger.info(
        `[App] open side pane mode=developer-tools workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTerminalTab = useCallback(() => {
    if (isOfficeMode) return;
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const title = createTerminalSidePaneTitle(current, workspaceAbsPath);
      const next = openTerminalSidePane(current, {
        title,
        cwd: workspaceAbsPath,
        remoteSessionId: workspaceRemoteSessionId,
      });
      logger.info(
        `[App] new terminal side tab=${title} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenModelTrajectory = useCallback(
    (params: { taskId: string; title?: string | null }) => {
      if (!params.taskId) {
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openModelTrajectorySidePane(current, params);
        logger.info(
          `[App] open side pane mode=model-trajectory workspace=${workspaceAbsPath} taskId=${params.taskId} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBackgroundBash = useCallback(
    (request: OpenBackgroundBashSideTabRequest) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => openBackgroundBashSidePane(current, request));
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenScopedSubagentSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentSessionSidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
          childSessionId: request.childSessionId,
          subagentType: request.subagentType,
          title: request.title,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        logger.debug(
          `[App] open subagent side tab parent=${request.parentSessionId} child=${request.childSessionId} workspace=${workspaceKey}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentDirectory = useCallback(
    (request: OpenScopedSubagentDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentDirectorySidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleSyncSubagentSessionTabs = useCallback(
    (request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest) => {
      // Tabs invalidated by branch edit/retry are projection cleanup, not "recently closed".
      commitSidePaneState((current) => syncSubagentSessionSidePaneTabs(current, request));
    },
    [commitSidePaneState],
  );

  const handleOpenSelectionSideChat = useCallback(
    (request: OpenSelectionSideChatRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const staleTab = request.replacesChildSessionId
          ? current?.tabs.find(
              (tab) =>
                tab.type === "selection-side-chat" &&
                tab.workspaceKey === workspaceKey &&
                tab.parentSessionId === request.parentSessionId &&
                tab.childSessionId === request.replacesChildSessionId,
            )
          : undefined;
        const withoutStale = staleTab ? closeSidePaneTab(current, staleTab.id) : current;
        return openSelectionSideChatPane(withoutStale, {
          ...request,
          workspaceKey,
        });
      });
      logger.debug("[App] open selection side-chat pane", {
        childSessionId: request.childSessionId,
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenPlanDetail = useCallback(
    (request: OpenScopedPlanDetailSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPlanDetailSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open plan detail side tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenWorkflowRun = useCallback(
    (request: OpenScopedWorkflowRunSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // The in-place replace after "configure" is not an open: a collapsed pane stays collapsed.
      const replaceRunId = request.replaceRunId;
      if (replaceRunId === undefined) setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        replaceRunId === undefined
          ? openWorkflowRunSidePane(current, { ...request, workspaceKey })
          : replaceWorkflowRunSidePane(current, { ...request, workspaceKey, replaceRunId }),
      );
      logger.debug("[App] open workflow run detail side tab", {
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowRunDirectory = useCallback(
    (request: OpenScopedWorkflowRunDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowRunDirectorySidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open workflow run directory side tab", {
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenScopedWorkflowActorSessionSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowActorSessionSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open workflow actor session side tab", {
        actorSessionId: request.actorSessionId,
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenScopedWorkflowWorkspaceSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowWorkspaceSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open workflow workspace side tab", {
        parentSessionId: request.parentSessionId,
        phaseId: request.phaseId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  /**
   * URL-reused browser tab (landing spot for html artifacts opened directly).
   *
   * Three differences from `handleOpenBrowserUrl`:
   * (1) The landing spot is claimed by URL instead of always creating a new tab.
   * (2) When an existing tab matches, a navigation request is STILL emitted — the webview
   * sits on stale bytes, `initialUrl` is unchanged, so the mount-time navigation never
   * re-runs (UnifiedBrowserView's `lastAppliedInitialUrlRef` dedupes by URL) and v2 would
   * never show.
   * (3) Ownership is given by the caller and ALWAYS activates — only user artifact clicks
   * take this path, so there is no `isCurrentOwner`-style hidden mounting (see the
   * ownerTaskId comment below).
   */
  const openFileUrlInBrowserSidePane = useCallback(
    (params: { url: string; ownerTaskId: string; workspaceKey: string }) => {
      const state = latestSidePaneMemoryRef.current.sidePaneState;
      const existing = findBrowserSidePaneTabByUrl(state, {
        initialUrl: params.url,
        ownerTaskId: params.ownerTaskId,
        workspaceKey: params.workspaceKey,
      });
      const targetTabId = existing?.id ?? `browser:${createUuid()}`;
      setBrowserNavigationRequest({ id: createUuid(), targetTabId, url: params.url });
      // Like artifact tabs, only set the current collapsed state, no persisted preference:
      // ownership writes params.ownerTaskId, while revealSidePaneForCurrentOwner records
      // false under the CURRENT owner — on the hub path the two are not yet the same.
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openOrActivateBrowserSidePaneByUrl(current, {
          initialUrl: params.url,
          tabId: targetTabId,
          // Freeze ownership explicitly instead of letting stampSidePaneTabsOwnership
          // stamp the current owner: on the hub path the artifact chip fires
          // handleSelectTaskInChat and then handleOpenWorkflowArtifact, and within that
          // same synchronous block sidePaneOwnerIdRef still holds the previous session.
          // Browser tab visibility narrows by ownerTaskId (getVisibleSidePaneTabsByScope's
          // default branch); stamping the wrong owner makes the tab invisible once this
          // switch settles. Artifact tabs are safe from that because they narrow by
          // parentSessionId.
          ownerTaskId: params.ownerTaskId,
          workspaceKey: params.workspaceKey,
        }),
      );
      return targetTabId;
    },
    [commitOpenedSidePaneState],
  );

  /**
   * Sole arbitration point for artifact clicks: html plus a capable embedded browser
   * opens the page directly, everything else opens the artifact tab.
   *
   * What direct-open lacks is `sourcePath`: the run side pane has it (journal already
   * merged) while the pill summary deliberately omits it (state-frame size, see
   * `workflowRunArtifactSummarySchema`). When absent, look the journal up once here.
   * Query failure, older CLIs without the query, or an artifact with no provenance all
   * fall back to the artifact tab — a click never lands nowhere.
   */
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenScopedWorkflowArtifactSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const openArtifactTab = () => {
        setIsSidePaneCollapsed(false);
        commitOpenedSidePaneState((current) =>
          openWorkflowArtifactSidePane(current, {
            ...request,
            workspaceKey,
          }),
        );
        logger.debug("[App] open workflow artifact side tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          workspaceKey,
        });
      };

      if (
        !shouldOpenWorkflowArtifactInBrowser({
          contentType: request.contentType,
          supportsEmbeddedBrowser,
          workspaceIdentity: request.workspaceIdentity,
          remoteSessionId: request.remoteSessionId,
        })
      ) {
        openArtifactTab();
        return;
      }

      const openInBrowser = (sourcePath: string) => {
        // A workspace-relative sourcePath needs workspacePath prepended to become the
        // real on-disk location; same path as the artifact card's "open in browser"
        // (WorkflowArtifactSidePane's localSourcePath).
        const url = toFileUrl(joinFilePath(request.workspacePath, sourcePath));
        const tabId = openFileUrlInBrowserSidePane({
          url,
          ownerTaskId: request.parentSessionId,
          workspaceKey,
        });
        logger.debug("[App] open html artifact directly in browser tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          tabId,
          workspaceKey,
        });
      };

      const knownSourcePath = request.sourcePath?.trim();
      if (knownSourcePath) {
        openInBrowser(knownSourcePath);
        return;
      }

      void (async () => {
        try {
          // The guard already guarantees a local workspace (no workspaceIdentity /
          // remoteSessionId), so only workspacePath is needed here.
          const result = await zcodeAgentService.conversationWorkflowRunArtifactsV4({
            workspacePath: request.workspacePath,
            sessionId: request.parentSessionId,
            runId: request.runId,
          });
          const sourcePath = result.artifacts
            .find((artifact) => artifact.id === request.artifactId)
            ?.sourcePath?.trim();
          if (!sourcePath) {
            logger.debug("[App] html artifact has no workspace provenance; fall back to artifact tab", {
              artifactId: request.artifactId,
              runId: request.runId,
            });
            openArtifactTab();
            return;
          }
          openInBrowser(sourcePath);
        } catch (error) {
          logger.warn("[App] artifact provenance lookup failed; fall back to artifact tab", {
            artifactId: request.artifactId,
            error: error instanceof Error ? error.message : String(error),
            runId: request.runId,
          });
          openArtifactTab();
        }
      })();
    },
    [
      commitOpenedSidePaneState,
      openFileUrlInBrowserSidePane,
      supportsEmbeddedBrowser,
      zcodeAgentService,
    ],
  );

  const closeSelectionSideChatRuntime = useCallback(
    (tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>) => {
      clearSelectionSideChat(tab.childSessionId);
      clearConversationSelectionReferenceScope(tab.childSessionId, tab.workspaceKey);
      void zcodeSessionService
        .closeSession({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          sessionId: tab.childSessionId,
        })
        .catch((error) => {
          if (String(error).includes("sessionNotFound")) return;
          logger.warn("[App] failed to close selection side-chat runtime", {
            childSessionId: tab.childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [zcodeSessionService],
  );

  useEffect(() => {
    const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
    return subscribeTaskLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      clearConversationSelectionReferenceScope(event.taskId, event.workspaceKey);
      const closingTabs =
        latestSidePaneMemoryRef.current.sidePaneState?.tabs.filter(
          (tab): tab is Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }> =>
            tab.type === "selection-side-chat" && tab.parentSessionId === event.taskId,
        ) ?? [];
      if (closingTabs.length === 0) return;

      for (const tab of closingTabs) closeSelectionSideChatRuntime(tab);
      const closingIds = new Set(closingTabs.map((tab) => tab.id));
      commitSidePaneState((current) => {
        if (!current) return current;
        let next: WorkspaceSidePaneState | null = current;
        for (const tabId of closingIds) {
          next = closeSidePaneTabForParent(next, tabId, activeTaskId);
        }
        syncSidePaneCollapsedWithTabs(next);
        return next;
      });
      logger.info("[App] parent task ended; clean up selection side-chat sessions", {
        event: event.type,
        parentSessionId: event.taskId,
        workspaceKey,
      });
    });
  }, [
    activeTaskId,
    closeSelectionSideChatRuntime,
    commitSidePaneState,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  // Subscribe to "open model trajectory" requests: raised deep in menus via a singleton
  // store; consumed here after matching by workspaceKey.
  useModelTrajectoryOpenBridge(
    workspaceIdentity?.trim() || workspaceAbsPath,
    handleOpenModelTrajectory,
  );

  const handleToggleTerminal = useCallback(() => {
    setIsTerminalOpen((open) => {
      if (isOfficeMode && !open) return open;
      const nextOpen = !open;
      logger.info("[App] toggle bottom terminal pane", {
        open: nextOpen,
        workspace: workspaceAbsPath,
      });
      return nextOpen;
    });
  }, [isOfficeMode, workspaceAbsPath]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarVisible((visible) => !visible);
  }, []);

  const handleToggleSidePaneCollapse = useCallback(() => {
    setIsSidePaneCollapsed((collapsed) => {
      const nextCollapsed = !collapsed;
      // Tabs are reused across workspaces, but top-level collapse is an explicit per
      // conversation choice; record the owner preference so scope resolution after a
      // conversation switch is not re-expanded by visible tabs.
      saveTaskSidePaneCollapsedPreference(
        activeSidePaneMemoryKeyRef.current,
        sidePaneOwnerIdRef.current,
        nextCollapsed,
      );
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        isSidePaneCollapsed: nextCollapsed,
      };
      logger.info(
        `[App] ${nextCollapsed ? "collapse" : "expand"} side pane workspace=${workspaceAbsPath} tabs=${sidePaneState?.tabs.length ?? 0}`,
      );
      return nextCollapsed;
    });
  }, [sidePaneState, workspaceAbsPath]);

  const handleCloseCodeViewer = useCallback(() => {
    logger.info(`[App] close side pane mode=code-viewer workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeCodeViewerSidePane(current);
      syncSidePaneCollapsedWithTabs(next);
      return next;
    });
  }, [commitSidePaneState, syncSidePaneCollapsedWithTabs, workspaceAbsPath]);

  const handleCloseGit = useCallback(() => {
    logger.info(`[App] close side pane mode=git workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeGitSidePane(current);
      syncSidePaneCollapsedWithTabs(next);
      return next;
    });
  }, [commitSidePaneState, syncSidePaneCollapsedWithTabs, workspaceAbsPath]);

  const handleActivateSidePaneTab = useCallback(
    (tabId: string) => {
      const tab = latestSidePaneMemoryRef.current.sidePaneState?.tabs.find(
        (candidate) => candidate.id === tabId,
      );
      if (
        (tab?.type === "browser" || tab?.type === "browser-use") &&
        tab.residency === "suspended"
      ) {
        const logicalTabId = tab.type === "browser-use" ? tab.tabId : tab.id;
        // The human-tab attach side freezes the owner with the
        // `tab.remoteSessionId ?? workspaceRemoteSessionId` fallback; this side must match
        // or preexisting tabs created without the frozen field scope-mismatch and never
        // restore on click. The browser-use attach side has no such fallback; adding one
        // here would cause the reverse mismatch, hence the per-type split.
        const scopedRemoteSessionId =
          tab.type === "browser-use"
            ? tab.remoteSessionId
            : (tab.remoteSessionId ?? workspaceRemoteSessionId);
        void platform
          ?.browserViewEnsureResident?.({
            tabId: logicalTabId,
            workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
            ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
            sessionId: tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
          })
          .catch((error) => {
            logger.warn("[App] failed to activate suspended browser tab", {
              error: error instanceof Error ? error.message : String(error),
              tabId: logicalTabId,
            });
          });
      }
      commitSidePaneState((current) => {
        const target = current?.tabs.find((candidate) => candidate.id === tabId);
        if (target?.type === "subagent-session" || target?.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(target.rootSessionId, target.id);
        }
        return setActiveSidePaneTab(current, tabId);
      });
    },
    [commitSidePaneState, platform, workspaceRemoteSessionId],
  );

  const handleReorderSidePaneTab = useCallback(
    (activeTabId: string, overTabId: string) => {
      commitSidePaneState((current) => reorderSidePaneTab(current, activeTabId, overTabId));
    },
    [commitSidePaneState],
  );

  const rememberClosedSidePaneTabs = useCallback((tabs: WorkspaceSidePaneTab[]) => {
    const restorableTabs = tabs.filter(
      (tab) => tab.type !== "selection-side-chat" && tab.type !== "browser-use",
    );
    if (restorableTabs.length === 0) {
      return;
    }

    const closedAt = Date.now();
    setAllRecentClosedSidePaneTabs((current) => {
      const closingIds = new Set(restorableTabs.map((tab) => tab.id));
      return [
        ...restorableTabs.map((tab) => ({ tab, closedAt })),
        ...current.filter((item) => !closingIds.has(item.tab.id)),
      ].slice(0, RECENT_CLOSED_SIDE_PANE_TAB_LIMIT);
    });
  }, []);

  const closeBrowserTabsWithAuthority = useCallback(
    async (tabs: readonly WorkspaceSidePaneTab[]): Promise<boolean> => {
      const browserTabs = tabs.filter(
        (tab) => tab.type === "browser" || tab.type === "browser-use",
      );
      if (browserTabs.length === 0) return true;
      if (!platform?.browserViewCloseTab) {
        // Desktop requires main to delete the logical tab/recovery snapshot first; when
        // the bridge is missing, removing only the UI shell would resurrect closed tabs
        // after restart. Web has no guest authority, so keep the plain local-close
        // semantics there.
        if (isDesktop) {
          logger.warn("[App] missing main authority while closing browser tab");
          return false;
        }
        return true;
      }
      try {
        await Promise.all(
          browserTabs.map((tab) => {
            // Same source as the attach side: human tabs fall back to
            // workspaceRemoteSessionId, browser-use tabs do not. A mismatch scope-fails →
            // main denies the authority → the UI shell never detaches → the tab never
            // closes.
            const scopedRemoteSessionId =
              tab.type === "browser-use"
                ? tab.remoteSessionId
                : (tab.remoteSessionId ?? workspaceRemoteSessionId);
            return platform.browserViewCloseTab!({
              tabId: tab.type === "browser-use" ? tab.tabId : tab.id,
              workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
              ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
              sessionId:
                tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
            });
          }),
        );
        return true;
      } catch (error) {
        logger.warn("[App] main authority for closing browser tab failed", {
          error: error instanceof Error ? error.message : String(error),
          tabIds: browserTabs.map((tab) => (tab.type === "browser-use" ? tab.tabId : tab.id)),
        });
        return false;
      }
    },
    [isDesktop, platform, workspaceRemoteSessionId],
  );

  const handleCloseSidePaneTab = useCallback(
    (tabId: string) => {
      const closingTab = sidePaneState?.tabs.find((tab) => tab.id === tabId);
      if (closingTab?.type === "selection-side-chat") {
        closeSelectionSideChatRuntime(closingTab);
      }
      void closeBrowserTabsWithAuthority(closingTab ? [closingTab] : []).then((authorized) => {
        if (!authorized) return;
        if (closingTab) rememberClosedSidePaneTabs([closingTab]);
        // Keep-alive: explicitly closing a terminal tab must truly reclaim the PTY/xterm
        // (the registry is long-lived and does not reclaim on unmount).
        if (closingTab?.type === "terminal") {
          sidePaneTerminalSessionRegistry.release(tabId);
        }
        const next = commitSidePaneState((current) =>
          closeSidePaneTabForParent(
            current,
            tabId,
            activeTaskId,
            activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : null,
          ),
        );
        syncSidePaneCollapsedWithTabs(next);
        const activeTab = getActiveSidePaneTab(next);
        logger.info(
          `[App] close side pane tab=${tabId} mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
        );
      });
    },
    [
      activeTaskId,
      closeSelectionSideChatRuntime,
      closeBrowserTabsWithAuthority,
      commitSidePaneState,
      rememberClosedSidePaneTabs,
      sidePaneState?.tabs,
      syncSidePaneCollapsedWithTabs,
      workspaceAbsPath,
    ],
  );

  const handleCloseOtherSidePaneTabs = useCallback(
    (tabId: string) => {
      const visibleTabs =
        sidePaneState?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, activeTaskId)) ?? [];
      const targetExists = visibleTabs.some((tab) => tab.id === tabId);
      const closingTabs = targetExists ? visibleTabs.filter((tab) => tab.id !== tabId) : [];
      void closeBrowserTabsWithAuthority(closingTabs).then((authorized) => {
        if (!authorized) return;
        for (const tab of closingTabs) {
          if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
        }
        // Keep-alive: when batch-closing other tabs, reclaim the persistent PTY/xterm of
        // any terminal tab among them.
        for (const tab of closingTabs) {
          if (tab.type === "terminal") {
            sidePaneTerminalSessionRegistry.release(tab.id);
          }
        }
        rememberClosedSidePaneTabs(closingTabs);
        commitSidePaneState((current) => {
          const next = closeVisibleOtherSidePaneTabs(current, tabId, activeTaskId);
          logger.info(
            `[App] close other side pane tabs tab=${tabId} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
          );
          return next;
        });
      });
    },
    [
      activeTaskId,
      closeSelectionSideChatRuntime,
      closeBrowserTabsWithAuthority,
      commitSidePaneState,
      rememberClosedSidePaneTabs,
      sidePaneState?.tabs,
      workspaceAbsPath,
    ],
  );

  const handleCloseAllSidePaneTabs = useCallback(() => {
    const visibleTabs =
      sidePaneState?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, activeTaskId)) ?? [];
    void closeBrowserTabsWithAuthority(visibleTabs).then((authorized) => {
      if (!authorized) return;
      for (const tab of visibleTabs) {
        if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
      }
      // Keep-alive: closing every tab must reclaim the persistent PTY/xterm of any
      // terminal tab among them.
      for (const tab of visibleTabs) {
        if (tab.type === "terminal") {
          sidePaneTerminalSessionRegistry.release(tab.id);
        }
      }
      rememberClosedSidePaneTabs(visibleTabs);
      commitSidePaneState((current) => {
        logger.info(`[App] close all side pane tabs workspace=${workspaceAbsPath}`);
        const next = closeVisibleSidePaneTabs(current, activeTaskId);
        syncSidePaneCollapsedWithTabs(next);
        return next;
      });
    });
  }, [
    activeTaskId,
    closeSelectionSideChatRuntime,
    closeBrowserTabsWithAuthority,
    commitSidePaneState,
    rememberClosedSidePaneTabs,
    sidePaneState?.tabs,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
  ]);

  const handleReopenClosedSidePaneTab = useCallback(
    (tabId: string) => {
      const item = allRecentClosedSidePaneTabs.find((entry) => entry.tab.id === tabId);
      if (!item || (isOfficeMode && (item.tab.type === "terminal" || item.tab.type === "git")))
        return;

      // Interaction note: reopening a tab from the recently-closed list must also expand
      // the side pane, otherwise the tab state restores while the pane stays collapsed
      // and the click looks like a no-op.
      revealSidePaneForCurrentOwner();
      commitSidePaneState((sidePaneCurrent) => {
        let restoredTab = item.tab;
        if (item.tab.type === "browser") {
          const {
            residency: _residency,
            residencyGeneration: _residencyGeneration,
            ...browserTab
          } = item.tab;
          restoredTab = { ...browserTab, id: `browser:${createUuid()}` };
        }
        const next = restoreSidePaneTab(sidePaneCurrent, restoredTab);
        if (restoredTab.type === "subagent-session" || restoredTab.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(restoredTab.rootSessionId, restoredTab.id);
        }
        return next;
      });
      setAllRecentClosedSidePaneTabs((current) =>
        current.filter((entry) => entry.tab.id !== tabId),
      );
      logger.info(`[App] reopen recently closed side pane tab=${tabId} workspace=${workspaceAbsPath}`);
    },
    [
      isOfficeMode,
      allRecentClosedSidePaneTabs,
      commitSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
    ],
  );

  const handleBrowserNavigationRequestHandled = useCallback((requestId: string) => {
    setBrowserNavigationRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  const handleBrowserPageMetadataChange = useCallback(
    (tabId: string, metadata: BrowserSidePaneMetadata) => {
      // Interaction note: Browser title/favicon come from webview events and must be
      // written back per tab id. With multiple browser tabs coexisting, a single global
      // metadata slot would let later page loads overwrite other tabs' titles.
      commitSidePaneState((current) => updateBrowserSidePaneTab(current, tabId, metadata));
    },
    [commitSidePaneState],
  );

  const recentClosedSidePaneTabs = useMemo(
    () =>
      allRecentClosedSidePaneTabs.filter(
        (item) =>
          isSidePaneTabVisibleForParent(item.tab, activeTaskId) &&
          (!isOfficeMode || (item.tab.type !== "terminal" && item.tab.type !== "git")),
      ),
    [activeTaskId, allRecentClosedSidePaneTabs, isOfficeMode],
  );

  return {
    // Office mode only hides the create entries; filtering pane state would make open
    // terminals and reviews vanish on mode switches.
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    // Callbacks
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleToggleGit,
    handleOpenGit,
    handleOpenTreemapping,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenTerminalTab,
    handleOpenModelTrajectory,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleToggleTerminal,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
  };
}
