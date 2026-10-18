/* oxlint-disable eslint(max-lines) - V4WorkspaceChatArea is the split workbench host, owning pane layout/focus/session binding; splitting would force store-action and shell-binding chains across files. */
import { useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  effectiveFocusedPaneId,
  MAX_WORKBENCH_PANES,
  paneWorkspaceKey,
  PRIMARY_LEAF,
  usePaneLayoutStore,
  V4_PRIMARY_PANE_ID,
  type PaneSplitSide,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import { collectWorkbenchLayout, dividerStyle, SPLIT_VAR_PREFIX } from "@/v4/workbenchLayout.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { WorkbenchSplitDivider } from "@/v4/WorkbenchSplitDivider.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  closeWorkbenchGroupPane,
  selectWorkbenchGroupActiveBinding,
  selectWorkbenchGroupPaneBinding,
  useWorkbenchGroupStore,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  type WorkbenchSessionTarget,
} from "@/v4/workbenchSessionPlacement.js";

function dragPayloadSessionTarget(payload: WorkbenchSessionDragPayload): WorkbenchSessionTarget {
  return {
    workspacePath: payload.workspacePath,
    ...(payload.workspaceIdentity?.trim() ? { workspaceIdentity: payload.workspaceIdentity } : {}),
    ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
    sessionId: payload.sessionId,
  };
}

export interface V4WorkspaceChatAreaProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt-template telemetry covers Desktop only; Web/phone remote keep the UI behavior without emitting the event. */
  isDesktop?: boolean;
  readOnly?: boolean;
  /** False while overlays like Settings are open; a hidden pane must not consume one-shot Composer requests. */
  foregroundEnabled?: boolean;
  remoteSessionId?: string;
  compactForRemoteControl?: boolean;
  /** The CLI session bound to the primary pane (the existing activeTaskId selection); null = draft. */
  sessionId: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  /** Primary pane joins the existing selection path (handleSelectTask) after createSession/fork. */
  onSessionCreated?: (sessionId: string) => void;
  /** Primary pane returns to draft once its session is deleted (the shell starts a new draft). */
  onSessionDeleted?: () => void;
  /**
   * Draft-state composer contextHeader (m5: workspace menu + Git branch),
   * handed to the primary pane only - other panes drafts carry no shell-level workspace switch.
   */
  draftComposerHeader?: ReactNode;
  /** The desktop lightweight draft title bar reuses the main draft composer drop controller. */
  onPrimaryDraftDropTargetControllerChange?: (
    controller: ConversationDropTargetController | null,
  ) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

/**
 * Split-workspace main chat area: the multi-pane cross-workspace workbench.
 *
 * - Layout: the paneLayoutStore binary split tree -> absolute rects (CSS-variable-driven ratios);
 *   leaves render flattened (key = paneId); split/close remounts no living pane.
 * - Data plane: one V4PaneConversationProvider per pane - connections refcount-reuse per
 *   endpoint+workspaceKey via workspaceConnectionRegistry
 *   (panes on one workspace share a transport + SessionDataLayer).
 * - The primary keeps the activeTaskId binding (shell prop, follows workspace tabs);
 *   other pane bindings live in paneLayoutStore with their own workspaceScope, persisting across tabs.
 * - Focus layer: shortcuts (Esc stop) / add-to-chat route to the focused pane only.
 * - Recovery guard: restoredUnvalidated panes validate against their own scope sessions-index.
 */
export function V4WorkspaceChatArea({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  foregroundEnabled = true,
  remoteSessionId,
  compactForRemoteControl = false,
  sessionId,
  activeSelectionSideChatSessionId = null,
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
  onPrimaryDraftDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onPaneActiveSessionChange,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenCodeViewer,
  onAutoOpenAssistantPptx,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenSelectionSideChat,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  onOpenWorkflowRunDirectory,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: V4WorkspaceChatAreaProps) {
  const shellWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  // The selector returns existing references/primitives from the store; no re-render while unchanged.
  const paneRoot = usePaneLayoutStore((state) => state.root);
  const paneBindings = usePaneLayoutStore((state) => state.panes);
  const paneFocusedPaneId = usePaneLayoutStore((state) => effectiveFocusedPaneId(state));
  // Zustand action references are stable.
  const splitPaneAction = usePaneLayoutStore((state) => state.splitPane);
  const closePaneAction = usePaneLayoutStore((state) => state.closePane);
  const confirmRestoredPaneSessionAction = usePaneLayoutStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const focusPaneAction = usePaneLayoutStore((state) => state.focusPane);
  const bindPaneSessionAction = usePaneLayoutStore((state) => state.bindPaneSession);
  const setSplitRatioAction = usePaneLayoutStore((state) => state.setSplitRatio);
  const resetPaneLayoutAction = usePaneLayoutStore((state) => state.resetToPrimaryPane);
  const activeGroup = useWorkbenchGroupStore((state) =>
    compactForRemoteControl || !state.activeGroupId
      ? null
      : (state.groups[state.activeGroupId] ?? null),
  );
  const focusGroupPaneAction = useWorkbenchGroupStore((state) => state.focusPane);
  const closeGroupPaneAction = useWorkbenchGroupStore((state) => state.closePane);
  const confirmRestoredGroupPaneSessionAction = useWorkbenchGroupStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const bindGroupPaneSessionAction = useWorkbenchGroupStore((state) => state.bindPaneSession);
  const setGroupSplitRatioAction = useWorkbenchGroupStore((state) => state.setSplitRatio);
  const promotePaneLayoutToGroupAction = useWorkbenchGroupStore(
    (state) => state.promotePaneLayoutToGroup,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  const root = compactForRemoteControl ? PRIMARY_LEAF : (activeGroup?.root ?? paneRoot);
  const panes = compactForRemoteControl ? {} : (activeGroup?.panes ?? paneBindings);
  const focusedPaneId = compactForRemoteControl
    ? V4_PRIMARY_PANE_ID
    : (activeGroup?.focusedPaneId ?? paneFocusedPaneId);
  const layout = useMemo(() => collectWorkbenchLayout(root), [root]);
  const shellSessionOwnedBySplitPane = useMemo(() => {
    if (compactForRemoteControl || activeGroup || !sessionId) {
      return false;
    }
    return Object.values(paneBindings).some(
      (binding) =>
        binding.sessionId === sessionId &&
        paneWorkspaceKey(binding.workspaceScope) === shellWorkspaceKey,
    );
  }, [activeGroup, compactForRemoteControl, paneBindings, sessionId, shellWorkspaceKey]);
  // 修复原因：primary draft 没有自己的 sessionId；拖入 session 时 shell active
  // may already sit on the right panes session - never hand that sessionId to the primary too.
  const primaryPaneSessionId = shellSessionOwnedBySplitPane ? null : sessionId;

  // Ratio wiring: the store value changes only on commit (pointerup/restore); while dragging, the divider writes CSS variables directly.
  const containerStyle = useMemo<CSSProperties>(() => {
    const style: Record<string, string> = {};
    for (const divider of layout.dividers) {
      style[`${SPLIT_VAR_PREFIX}${divider.splitId}`] = String(divider.ratio);
    }
    return style as CSSProperties;
  }, [layout]);

  const paneCount = layout.leaves.length;
  const showFocusIndicator = paneCount > 1;
  const canSplit = paneCount < MAX_WORKBENCH_PANES;

  const shellScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspacePath, workspaceIdentity],
  );
  const placementShellBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      primaryPaneSessionId ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId } : null,
    [primaryPaneSessionId, shellScope],
  );

  const shell = useMemo<WorkbenchShellBinding>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      isDesktop,
      compactForRemoteControl,
      readOnly,
      sessionId: primaryPaneSessionId,
      // primaryPaneSessionId is deliberately emptied while a split pane owns the active task;
      // auxiliary-conversation selection routing still needs the shell real active task id.
      activeSessionId: sessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary: primaryPaneSessionId ? activeTaskChangeSummary : null,
      summaryPanelVariantOverride,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx,
      onOpenFileLink,
      onOpenSubagentSession,
      onOpenBackgroundBash,
      onOpenSubagentDirectory,
      onSyncSubagentSessionTabs,
      onOpenSelectionSideChat,
      onOpenPlanDetail,
      onOpenWorkflowRun,
      onOpenWorkflowArtifact,
      onOpenWorkflowRunDirectory,
      onOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    }),
    [
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      compactForRemoteControl,
      readOnly,
      primaryPaneSessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary,
      summaryPanelVariantOverride,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx,
      onOpenFileLink,
      onOpenSubagentSession,
      onOpenBackgroundBash,
      onOpenSubagentDirectory,
      onSyncSubagentSessionTabs,
      onOpenSelectionSideChat,
      onOpenPlanDetail,
      onOpenWorkflowRun,
      onOpenWorkflowArtifact,
      onOpenWorkflowRunDirectory,
      onOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    ],
  );

  const resolvePaneSessionBinding = useMemo(
    () =>
      (paneId: string): WorkbenchSessionBinding | null => {
        if (activeGroup) {
          return selectWorkbenchGroupPaneBinding(activeGroup, paneId);
        }
        if (paneId === V4_PRIMARY_PANE_ID) {
          return primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        }
        const binding = paneBindings[paneId];
        return binding?.sessionId
          ? {
              workspaceScope: binding.workspaceScope,
              sessionId: binding.sessionId,
              ...(binding.readOnly ? { readOnly: true } : {}),
            }
          : null;
      },
    [activeGroup, paneBindings, primaryPaneSessionId, shellScope],
  );

  const syncShellActiveSession = useCallback(
    (binding: WorkbenchSessionBinding | null) => {
      if (!binding || binding.readOnly) {
        return;
      }
      // A readOnly subagent pane is an observation view inside the workbench, not a left
      // task-navigation target; writing back shell activeTaskId would mis-highlight or switch to the child.
      onPaneActiveSessionChange?.(binding.workspaceScope, binding.sessionId);
    },
    [onPaneActiveSessionChange],
  );

  const handleFocusRequest = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        focusGroupPaneAction(activeGroup.id, paneId);
      } else {
        focusPaneAction(paneId);
      }
      syncShellActiveSession(resolvePaneSessionBinding(paneId));
    },
    [
      activeGroup,
      focusGroupPaneAction,
      focusPaneAction,
      resolvePaneSessionBinding,
      syncShellActiveSession,
    ],
  );

  const handleClosePane = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        const nextGroup = closeWorkbenchGroupPane(activeGroup, paneId);
        const nextActiveBinding =
          activeGroup.focusedPaneId === paneId
            ? nextGroup
              ? selectWorkbenchGroupActiveBinding(nextGroup)
              : paneId === V4_PRIMARY_PANE_ID
                ? null
                : activeGroup.primaryBinding
            : null;
        closeGroupPaneAction(activeGroup.id, paneId);
        // The close store only collapses layout; when the closed pane is the focused one,
        // shell activeTaskId must return to a still-navigable session, never stay on the closed one.
        syncShellActiveSession(nextActiveBinding);
      } else {
        const nextActiveBinding =
          focusedPaneId === paneId && primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        closePaneAction(paneId);
        syncShellActiveSession(nextActiveBinding);
      }
    },
    [
      activeGroup,
      closeGroupPaneAction,
      closePaneAction,
      focusedPaneId,
      primaryPaneSessionId,
      shellScope,
      syncShellActiveSession,
    ],
  );

  const handleConfirmRestoredSession = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        confirmRestoredGroupPaneSessionAction(activeGroup.id, paneId);
      } else {
        confirmRestoredPaneSessionAction(paneId);
      }
    },
    [activeGroup, confirmRestoredGroupPaneSessionAction, confirmRestoredPaneSessionAction],
  );

  const handleCommitSplitRatio = useMemo(
    () => (splitId: string, ratio: number) => {
      if (activeGroup) {
        setGroupSplitRatioAction(activeGroup.id, splitId, ratio);
      } else {
        setSplitRatioAction(splitId, ratio);
      }
    },
    [activeGroup, setGroupSplitRatioAction, setSplitRatioAction],
  );

  const handleBindSession = useMemo(
    () => (paneId: string, createdSessionId: string) => {
      if (activeGroup) {
        bindGroupPaneSessionAction(activeGroup.id, paneId, createdSessionId);
        return true;
      }
      if (paneId === V4_PRIMARY_PANE_ID) {
        const sourceLayout = usePaneLayoutStore.getState();
        if (Object.keys(sourceLayout.panes).length > 0) {
          // A draft primary has no entry in paneLayout.panes. Once a first-send is accepted, letting
          // only the shell remember the new session lets the bound secondary override shell activeTaskId
          // and the primary loses identity back to draft. Promote the visible layout with the new
          // session as primaryBinding first, then let the upper layer sync the shell active; both panes keep a stable owner.
          const promoted = promotePaneLayoutToGroupAction(
            { workspaceScope: shellScope, sessionId: createdSessionId },
            sourceLayout,
          );
          if (promoted) {
            resetPaneLayoutAction();
            logger.info("[v4-workbench] primary draft promoted to session group", {
              createdSessionId,
              workspaceKey: paneWorkspaceKey(shellScope),
            });
          }
        }
        return true;
      }
      bindPaneSessionAction(paneId, createdSessionId);
      if (!sessionId) {
        return false;
      }
      // A non-primary draft first-send mints a new session; writing shell activeTaskId directly
      // would drag the primary (still driven by shell.sessionId) to the new right-hand session.
      // Promote the current paneLayout to a group first,
      // pin the original session via primaryBinding, then let the shell active follow the new pane.
      const promoted = promotePaneLayoutToGroupAction(
        { workspaceScope: shellScope, sessionId },
        usePaneLayoutStore.getState(),
      );
      if (promoted) {
        // Promotion transfers layout ownership; it is not copy-then-double-write. Once the group holds the full
        // workspace scope/binding, consume the source immediately so a refresh or group GC cannot revive the old split.
        resetPaneLayoutAction();
      }
      return promoted;
    },
    [
      activeGroup,
      bindGroupPaneSessionAction,
      bindPaneSessionAction,
      promotePaneLayoutToGroupAction,
      resetPaneLayoutAction,
      sessionId,
      shellScope,
    ],
  );

  const canDropSession = useCallback(
    (payload: WorkbenchSessionDragPayload) => {
      return canPlaceWorkbenchSessionInSplit(
        placementShellBinding,
        dragPayloadSessionTarget(payload),
        { mode: "drag", side: "right" },
      );
    },
    [placementShellBinding],
  );

  const handleDropSession = useCallback(
    (paneId: string, side: PaneSplitSide, payload: WorkbenchSessionDragPayload) => {
      placeWorkbenchSessionInSplit(placementShellBinding, dragPayloadSessionTarget(payload), {
        anchorPaneId: paneId,
        mode: "drag",
        side,
      });
    },
    [placementShellBinding],
  );

  return (
    <div ref={containerRef} style={containerStyle} className="relative h-full min-h-0 w-full">
      {layout.leaves.map((leaf) => (
        <WorkbenchLeafPane
          key={leaf.paneId}
          paneId={leaf.paneId}
          rect={leaf.rect}
          // Settings only marks the workspace inert while the pane stayed focused=true, which would
          // consume the Plugin trial one-shot prefill while hidden. With visibility folded into focus,
          // only the Composer interactive again after returning to the workspace consumes the request.
          focused={foregroundEnabled && focusedPaneId === leaf.paneId}
          showFocusIndicator={showFocusIndicator}
          canSplit={canSplit}
          shellWorkspaceKey={shellWorkspaceKey}
          binding={leaf.paneId === V4_PRIMARY_PANE_ID ? null : (panes[leaf.paneId] ?? null)}
          primaryBinding={
            leaf.paneId === V4_PRIMARY_PANE_ID ? (activeGroup?.primaryBinding ?? null) : null
          }
          shell={shell}
          onFocusRequest={handleFocusRequest}
          onSplit={compactForRemoteControl || activeGroup ? undefined : splitPaneAction}
          onClosePane={handleClosePane}
          onConfirmRestoredSession={handleConfirmRestoredSession}
          onBindSession={handleBindSession}
          onPaneActiveSessionChange={onPaneActiveSessionChange}
          canDropSession={compactForRemoteControl ? undefined : canDropSession}
          onDropSession={compactForRemoteControl ? undefined : handleDropSession}
        />
      ))}
      {layout.dividers.map((divider) => (
        <WorkbenchSplitDivider
          key={divider.splitId}
          containerRef={containerRef}
          splitId={divider.splitId}
          direction={divider.direction}
          ratio={divider.ratio}
          regionFraction={divider.regionFraction}
          style={dividerStyle(divider)}
          onCommitRatio={handleCommitSplitRatio}
        />
      ))}
    </div>
  );
}
