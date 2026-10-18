/* oxlint-disable eslint(max-lines) - WorkbenchLeafPane deliberately centralizes pane focus, per-pane providers, recovery guards, and the session drop target; splitting would force DnD/focus/session binding chains across files; revisit once stable. */
// Split leaf pane: focus shell + per-pane data wiring + recovery guards. Host = V4WorkspaceChatArea.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { TID_V4_PANE_SHELL, testId } from "@zcode/shared";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
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
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import {
  paneWorkspaceKey,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneSplitSide,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutStore.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  parseWorkbenchSessionDragPayload,
  resolveWorkbenchDropSide,
  type WorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { registerWorkbenchPointerDropTarget } from "@/v4/workbenchPointerDragDrop.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import { rectStyle, type RectExpr } from "@/v4/workbenchLayout.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

interface ChatPaneShellProps {
  containerRef?: (element: HTMLDivElement | null) => void;
  paneId: string;
  focused: boolean;
  /** No focus ring in single-pane layouts (unambiguous; avoids visual noise). */
  showFocusIndicator: boolean;
  onFocusRequest: (paneId: string) => void;
  /** Absolute rect (calc expression computed by the layout layer). */
  style: CSSProperties;
  dropSide?: PaneSplitSide | null;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  children: ReactNode;
  restoredUnvalidated?: boolean;
}

const DROP_PREVIEW_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-brand) 14%, transparent)",
  boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-brand) 34%, transparent)",
};

const INACTIVE_PANE_OVERLAY_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-background) 34%, transparent)",
  backdropFilter: "brightness(0.94) saturate(0.94)",
};

function dropPreviewClassName(side: PaneSplitSide): string {
  switch (side) {
    case "left":
      return "left-1 top-1 bottom-1 w-1/2";
    case "right":
      return "right-1 top-1 bottom-1 w-1/2";
    case "up":
      return "left-1 right-1 top-1 h-1/2";
    case "down":
      return "left-1 right-1 bottom-1 h-1/2";
  }
}

/**
 * Focus shell: click/focus anywhere in the pane -> focus it (capture phase, never disturbing the subtree).
 * memo + stable callbacks: focus flips data-focused/border classes only; the pane content subtree is untouched.
 */
const ChatPaneShell = memo(function ChatPaneShell({
  containerRef,
  paneId,
  focused,
  showFocusIndicator,
  onFocusRequest,
  style,
  dropSide,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
  restoredUnvalidated = false,
}: ChatPaneShellProps) {
  const handleFocusRequest = useCallback(() => {
    onFocusRequest(paneId);
  }, [onFocusRequest, paneId]);

  return (
    <div
      ref={containerRef}
      data-testid={testId(TID_V4_PANE_SHELL, paneId)}
      data-pane-id={paneId}
      data-focused={focused ? "true" : "false"}
      data-restored-unvalidated={restoredUnvalidated ? "true" : "false"}
      onPointerDownCapture={handleFocusRequest}
      onFocusCapture={handleFocusRequest}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={style}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        showFocusIndicator && focused && "ring-1 ring-inset ring-[var(--color-brand)]",
      )}
    >
      {showFocusIndicator && !focused ? (
        <div
          aria-hidden="true"
          data-v4-pane-inactive-overlay="true"
          style={INACTIVE_PANE_OVERLAY_STYLE}
          className="pointer-events-none absolute inset-0 z-30 rounded-md transition-[background-color,backdrop-filter]"
        />
      ) : null}
      {dropSide ? (
        <div className="pointer-events-none absolute inset-0 z-50">
          <div
            aria-hidden="true"
            style={DROP_PREVIEW_STYLE}
            className={cn(
              "absolute rounded-md transition-[background-color,box-shadow]",
              dropPreviewClassName(dropSide),
            )}
          />
        </div>
      ) : null}
      {children}
    </div>
  );
});

interface PaneRestoredGuardProps {
  paneId: string;
  scope: PaneWorkspaceScope;
  sessionId: string;
  onConfirmed: (paneId: string) => void;
  onMissing: (paneId: string) => void;
}

/**
 * Persistence recovery guard (per pane): a localStorage-restored binding may reference a deleted session
 * (deleted in a previous run/another window). Using the pane-scoped sessions-index (isolated by
 * endpoint + workspaceKey), wait for the first real snapshot (workspaceId ready) and verify once:
 * present -> clear restoredUnvalidated; deleted -> collapse gracefully via closePane.
 * Not useWorkspaceSessionsIndexItems - its aggregated memo computes over an empty store before the
 * subscription effect and misreads loaded-but-absent; bind the registry store directly,
 * and while subscription errors/remote endpoints are absent (disconnected proxy rejects) make no verdict:
 * the pane stays in error/waiting for its own retry path, never mis-closed.
 * Must mount inside V4PaneConversationProvider: useServices reads the pane accessor
 * (remote panes use that remote connection sessions-index, never the local host).
 */
function PaneRestoredGuard({
  paneId,
  scope,
  sessionId,
  onConfirmed,
  onMissing,
}: PaneRestoredGuardProps) {
  const services = useServices();
  const agentService = services.zcodeAgentService;
  const { workspacePath, workspaceIdentity, remoteSessionId } = scope;

  useEffect(() => {
    if (!agentService) {
      return;
    }
    const indexScope: SessionsIndexScope = {
      workspaceKey: paneWorkspaceKey({ workspacePath, workspaceIdentity }),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
    };
    const store = acquireSessionsIndex(indexScope, agentService);
    let disposed = false;
    let settled = false;
    const evaluate = () => {
      if (disposed || settled || store.getState().workspaceId === null) {
        return;
      }
      settled = true;
      const exists = store.getSessions().some((summary) => summary.sessionId === sessionId);
      if (exists) {
        onConfirmed(paneId);
      } else {
        onMissing(paneId);
      }
    };
    const unsubscribe = store.subscribe(evaluate);
    evaluate();
    return () => {
      disposed = true;
      unsubscribe();
      releaseSessionsIndex(indexScope, store);
    };
  }, [
    agentService,
    paneId,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onConfirmed,
    onMissing,
  ]);

  return null;
}

/** Shell-side binding of the primary pane (activeTaskId selection state + callbacks; never into paneLayoutStore). */
export interface WorkbenchShellBinding {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Prompt template telemetry currently covers Desktop only. */
  isDesktop?: boolean;
  readOnly?: boolean;
  sessionId: string | null;
  /** The task the shell has actually activated; differs from primary sessionId while a split pane owns the active task. */
  activeSessionId?: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  onSessionDeleted?: () => void;
  draftComposerHeader?: ReactNode;
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

interface WorkbenchLeafPaneProps {
  paneId: string;
  rect: RectExpr;
  focused: boolean;
  showFocusIndicator: boolean;
  canSplit: boolean;
  shellWorkspaceKey: string;
  /** Binding for non-primary panes; primary passes null (uses the shell binding). */
  binding: PaneBinding | null;
  /** Explicit binding of the primary pane inside a session workbench group; null without a group. */
  primaryBinding?: WorkbenchSessionBinding | null;
  shell: WorkbenchShellBinding;
  onFocusRequest: (paneId: string) => void;
  onSplit?: (paneId: string, direction: SplitDirection, scope: PaneWorkspaceScope) => void;
  onClosePane: (paneId: string) => void;
  onConfirmRestoredSession: (paneId: string) => void;
  onBindSession: (paneId: string, sessionId: string) => boolean | void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string) => void;
  canDropSession?: (payload: WorkbenchSessionDragPayload) => boolean;
  onDropSession?: (
    paneId: string,
    side: PaneSplitSide,
    payload: WorkbenchSessionDragPayload,
  ) => void;
}

function workspaceBadgeFor(scope: PaneWorkspaceScope): PaneWorkspaceBadge {
  const label = scope.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? scope.workspacePath;
  return {
    label,
    workspacePath: scope.workspacePath,
    remote: Boolean(scope.workspaceIdentity || scope.remoteSessionId),
  };
}

export function WorkbenchLeafPane({
  paneId,
  rect,
  focused,
  showFocusIndicator,
  canSplit,
  shellWorkspaceKey,
  binding,
  primaryBinding,
  shell,
  onFocusRequest,
  onSplit,
  onClosePane,
  onConfirmRestoredSession,
  onBindSession,
  onPaneActiveSessionChange,
  canDropSession,
  onDropSession,
}: WorkbenchLeafPaneProps) {
  const [dropSide, setDropSide] = useState<PaneSplitSide | null>(null);
  const isPrimary = paneId === V4_PRIMARY_PANE_ID;
  const isGroupPrimary = isPrimary && Boolean(primaryBinding);
  const scope = useMemo<PaneWorkspaceScope>(() => {
    if (!isPrimary && binding) {
      return binding.workspaceScope;
    }
    if (isPrimary && primaryBinding) {
      return primaryBinding.workspaceScope;
    }
    return {
      workspacePath: shell.workspacePath,
      ...(shell.workspaceIdentity ? { workspaceIdentity: shell.workspaceIdentity } : {}),
      ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
    };
  }, [
    isPrimary,
    binding,
    primaryBinding,
    shell.workspacePath,
    shell.workspaceIdentity,
    shell.remoteSessionId,
  ]);

  const style = useMemo(() => rectStyle(rect), [rect]);

  const handleSplitRight = useCallback(() => {
    onSplit?.(paneId, "row", scope);
  }, [onSplit, paneId, scope]);
  const handleSplitDown = useCallback(() => {
    onSplit?.(paneId, "column", scope);
  }, [onSplit, paneId, scope]);
  const handleClosePane = useCallback(() => {
    onClosePane(paneId);
  }, [onClosePane, paneId]);
  const handleSessionDeleted = useCallback(() => {
    if (isGroupPrimary) {
      // Group-primary deletion used to only close the layout while the shell still pointed at the deleted session.
      // Once accepted, dissolve the group first, then return the shell to the current workspace draft; secondaries
      // only restore plain session identity and must not be silently promoted here.
      handleClosePane();
      shell.onSessionDeleted?.();
      return;
    }
    if (isPrimary) {
      shell.onSessionDeleted?.();
      return;
    }
    handleClosePane();
  }, [handleClosePane, isGroupPrimary, isPrimary, shell.onSessionDeleted]);
  const handleBindSession = useCallback(
    (createdSessionId: string) => {
      const shouldSyncShellActive = onBindSession(paneId, createdSessionId) !== false;
      if (shouldSyncShellActive) {
        onPaneActiveSessionChange?.(scope, createdSessionId);
      }
    },
    [onBindSession, onPaneActiveSessionChange, paneId, scope],
  );
  const handleSessionCreated = useCallback(
    (createdSessionId: string) => {
      if (isPrimary && !primaryBinding) {
        // When the dragged-in session already sits next to the primary draft, the first send must not update the shell alone.
        // The workbench host must bind the draft pane in place and take over the whole layout first; otherwise the
        // subsequent secondary focus rewrites shell activeTaskId and the primary falls back to draft for lack of a binding.
        onBindSession(paneId, createdSessionId);
        shell.onSessionCreated?.(createdSessionId);
        return;
      }
      handleBindSession(createdSessionId);
    },
    [handleBindSession, isPrimary, onBindSession, paneId, primaryBinding, shell.onSessionCreated],
  );
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDropSession || !canSplit) {
        return;
      }
      const payload = parseWorkbenchSessionDragPayload(event.dataTransfer);
      if (!payload || (canDropSession && !canDropSession(payload))) {
        setDropSide(null);
        return;
      }
      const side = resolveWorkbenchDropSide(
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      if (!side) {
        setDropSide(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropSide(side);
    },
    [canDropSession, canSplit, onDropSession],
  );
  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDropSide(null);
  }, []);
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDropSession || !canSplit) {
        setDropSide(null);
        return;
      }
      const payload = parseWorkbenchSessionDragPayload(event.dataTransfer);
      const side =
        dropSide ??
        resolveWorkbenchDropSide(
          event.currentTarget.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        );
      setDropSide(null);
      if (!payload || !side || (canDropSession && !canDropSession(payload))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onDropSession(paneId, side, payload);
    },
    [canDropSession, canSplit, dropSide, onDropSession, paneId],
  );
  const pointerDropTargetRef = useRef<HTMLDivElement | null>(null);
  const setPointerDropTargetRef = useCallback((element: HTMLDivElement | null) => {
    pointerDropTargetRef.current = element;
  }, []);
  useEffect(() => {
    const element = pointerDropTargetRef.current;
    if (!element || !onDropSession || !canSplit) {
      return undefined;
    }
    return registerWorkbenchPointerDropTarget(element, {
      canDrop: (payload) => !canDropSession || canDropSession(payload),
      onPreview: setDropSide,
      onDrop: (side, payload) => onDropSession(paneId, side, payload),
    });
  }, [canDropSession, canSplit, onDropSession, paneId]);

  if (!isPrimary && !binding) {
    // sanitize/migration guarantee non-primary leaves always hold bindings; this is defensive rendering during the handover.
    return null;
  }

  const isShellWorkspace = paneWorkspaceKey(scope) === shellWorkspaceKey;
  const sessionId = isPrimary
    ? (primaryBinding?.sessionId ?? shell.sessionId)
    : (binding?.sessionId ?? null);
  const readOnly = Boolean(
    (isPrimary ? primaryBinding?.readOnly : binding?.readOnly) ||
    (isShellWorkspace && shell.readOnly),
  );
  const shouldUseShellStatusPanel = isShellWorkspace;
  const paneSearchResultHighlightRequest =
    sessionId === shell.searchResultHighlightRequest?.taskId
      ? shell.searchResultHighlightRequest
      : null;

  return (
    <ChatPaneShell
      containerRef={setPointerDropTargetRef}
      paneId={paneId}
      focused={focused}
      showFocusIndicator={showFocusIndicator}
      onFocusRequest={onFocusRequest}
      style={style}
      dropSide={dropSide}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      restoredUnvalidated={Boolean((isPrimary ? primaryBinding : binding)?.restoredUnvalidated)}
    >
      <V4PaneConversationProvider scope={scope}>
        {(isPrimary ? primaryBinding : binding)?.restoredUnvalidated && sessionId ? (
          <PaneRestoredGuard
            paneId={paneId}
            scope={scope}
            sessionId={sessionId}
            onConfirmed={onConfirmRestoredSession}
            onMissing={onClosePane}
          />
        ) : null}
        <SessionPane
          paneId={paneId}
          readOnly={readOnly}
          sessionId={sessionId}
          openTrigger={isPrimary ? "sidebar" : "split"}
          activeSelectionSideChatSessionId={resolvePaneActiveSelectionSideChatSessionId(
            sessionId,
            shell.activeSessionId ?? shell.sessionId,
            shell.activeSelectionSideChatSessionId,
          )}
          workspacePath={scope.workspacePath}
          workspaceIdentity={scope.workspaceIdentity}
          remoteSessionId={scope.remoteSessionId}
          isDesktop={shell.isDesktop}
          provider={isPrimary && isShellWorkspace ? shell.provider : undefined}
          onSessionCreated={handleSessionCreated}
          onSessionDeleted={handleSessionDeleted}
          focused={focused}
          onSplitRight={canSplit && onSplit ? handleSplitRight : undefined}
          onSplitDown={canSplit && onSplit ? handleSplitDown : undefined}
          onClosePane={isPrimary ? undefined : handleClosePane}
          workspaceBadge={!isPrimary && !isShellWorkspace ? workspaceBadgeFor(scope) : undefined}
          draftComposerHeader={isPrimary && !primaryBinding ? shell.draftComposerHeader : undefined}
          onDropTargetControllerChange={
            isPrimary && !primaryBinding
              ? shell.onPrimaryDraftDropTargetControllerChange
              : undefined
          }
          gitSummary={shouldUseShellStatusPanel ? shell.gitSummary : undefined}
          gitDirtyFileCount={shouldUseShellStatusPanel ? shell.gitDirtyFileCount : undefined}
          gitWorktreeReviewSourceId={
            shouldUseShellStatusPanel ? shell.gitWorktreeReviewSourceId : undefined
          }
          gitWorktreeChangeSummary={
            shouldUseShellStatusPanel ? shell.gitWorktreeChangeSummary : undefined
          }
          activeTaskChangeSummary={isPrimary ? shell.activeTaskChangeSummary : undefined}
          summaryPanelVariantOverride={
            shouldUseShellStatusPanel ? shell.summaryPanelVariantOverride : undefined
          }
          onSummaryPanelVariantOverrideChange={
            shouldUseShellStatusPanel ? shell.onSummaryPanelVariantOverrideChange : undefined
          }
          onRefreshGit={shouldUseShellStatusPanel ? shell.onRefreshGit : undefined}
          onOpenGitReview={shouldUseShellStatusPanel ? shell.onOpenGitReview : undefined}
          onOpenBrowserUrl={shell.onOpenBrowserUrl}
          onOpenAutomationsMain={shell.onOpenAutomationsMain}
          onOpenCodeViewer={shell.onOpenCodeViewer}
          onAutoOpenAssistantPptx={shell.onAutoOpenAssistantPptx}
          onOpenFileLink={shell.onOpenFileLink}
          onOpenSubagentSession={shell.onOpenSubagentSession}
          onOpenBackgroundBash={shell.onOpenBackgroundBash}
          onOpenSubagentDirectory={shell.onOpenSubagentDirectory}
          onSyncSubagentSessionTabs={shell.onSyncSubagentSessionTabs}
          onOpenSelectionSideChat={shell.onOpenSelectionSideChat}
          onOpenPlanDetail={shell.onOpenPlanDetail}
          onOpenWorkflowRun={shell.onOpenWorkflowRun}
          onOpenWorkflowArtifact={shell.onOpenWorkflowArtifact}
          onOpenWorkflowRunDirectory={shell.onOpenWorkflowRunDirectory}
          onOpenWorkflowActorSession={shell.onOpenWorkflowActorSession}
          onOpenWorkflowWorkspace={shell.onOpenWorkflowWorkspace}
          conversationFindQuery={focused ? shell.conversationFindQuery : ""}
          conversationFindActiveIndex={focused ? (shell.conversationFindActiveIndex ?? -1) : -1}
          conversationFindNavigationRequestId={
            focused ? (shell.conversationFindNavigationRequestId ?? 0) : 0
          }
          onConversationFindMatchStateChange={
            focused ? shell.onConversationFindMatchStateChange : undefined
          }
          searchResultHighlightRequest={paneSearchResultHighlightRequest}
          onSearchResultHighlightDone={shell.onSearchResultHighlightDone}
        />
      </V4PaneConversationProvider>
    </ChatPaneShell>
  );
}

function resolvePaneActiveSelectionSideChatSessionId(
  paneSessionId: string | null,
  shellActiveSessionId: string | null,
  activeSelectionSideChatSessionId: string | null | undefined,
): string | null {
  return paneSessionId && paneSessionId === shellActiveSessionId
    ? (activeSelectionSideChatSessionId ?? null)
    : null;
}
