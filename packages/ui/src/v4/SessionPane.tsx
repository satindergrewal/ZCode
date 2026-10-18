import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import type { SessionCreateSource } from "@zcode/shared";
import { reportSessionCreate } from "@/lib/sessionCreateTelemetry.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
/* oxlint-disable eslint(max-lines) -- SessionPane is the single-pane vertical slice owning command orchestration (subscribe/send/stop/fork/edit/retry/queue/slash), same granularity as the old ChatView; HEAD already exceeds the limit (693 by count) and splitting the command groups would break the dispatchCommand/snapshotRef closure discipline. */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hand } from "lucide-react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildCustomSupplierKey,
  TID_CHAT_EMPTY,
  TID_V4_SESSION_PANE,
  testId,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  ConversationShareAccessMode,
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  CommandType,
  ConversationSnapshot,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionModelTransition,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
  sanitizeConversationShareWarnings,
} from "@/lib/conversationShareError.js";
import { localizeConversationShareUrl } from "@zcode/shared";
import type {
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  ImportedConversationShare,
} from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import { buildChatSessionScrollMemoryKey } from "@/lib/chatSessionScrollMemory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";
import {
  workflowSessionModelOf,
  type WorkflowRunSettingsChange,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { usePlanIdentitySnapshot } from "@/hooks/usePlanIdentitySnapshot.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { captureComposerRecentSubmission } from "@/lib/composerRecent.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import {
  buildDraftCreateConfigPayload,
  useDraftConfigControl,
} from "@/v4/composer/useDraftConfigControl.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import {
  createComposerSubmissionConfig,
  type ComposerSubmissionConfig,
} from "@/v4/composer/composerSubmissionConfig.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
  getConversationShareDockState,
  getConversationShareSelectedProductTurnIds,
  getConversationShareSelectedRowIds,
  useConversationShareSelectionStore,
  type ConversationShareDisplayWarnings,
} from "@/store/conversationShareSelectionStore.js";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";
import {
  ConversationComposer,
  type ComposerRestoreRequest,
  type ConversationComposerSendOptions,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { shouldIgnoreEscapeForStopGeneration } from "@/v4/composer/escapeStop.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { ConversationHeader, type PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import { WorkspaceHookPendingBanner } from "@/v4/WorkspaceHookPendingBanner.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import {
  ConversationShareSelectionDock,
  type ConversationShareSelectionPreflightState,
} from "@/v4/ConversationShareSelectionDock.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationShareSelectionReopenTab } from "@/v4/ConversationShareSelectionReopenTab.js";
import { ConversationShareSelectionScrim } from "@/v4/ConversationShareSelectionScrim.js";
import {
  buildConversationSharePreflightCacheEntries,
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  dedupeConversationShareIssues,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
import { ConversationBottomDockTransition } from "@/v4/ConversationBottomDockTransition.js";
import { ensureConversationShareAttempt } from "@/v4/conversationShareAttempt.js";
import { useConversationShareSelectionOutsideDismiss } from "@/v4/useConversationShareSelectionOutsideDismiss.js";
import {
  resolveConversationSelectionTooltipEnabled,
  resolveConversationShareBackgroundScrollLocked,
  resolveConversationShareSelectionPanelVisible,
} from "@/v4/conversationShareModePolicy.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";
import { SessionPluginReferenceIconBoundary } from "@/v4/SessionPluginReferenceIconProvider.js";
import {
  resolveConversationStatusPanelVariant,
  shouldUseConversationStatusPanelInlineLayout,
} from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  resolveSoleRunningWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  buildWorkflowRunByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  buildWorkflowGraphByToolCallId,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";
import {
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
  type AssistantPreviewPptxAutoOpenTarget,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import {
  hasPluginReferenceUserRows,
  isSessionPluginCatalogReady,
} from "@/v4/pluginReferenceIconProjection.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  useScopedConversationTelemetryForegroundEnabled,
  useScopedConversationTelemetrySupervisor,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { resolveSendAckSettlement } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { useSessionSubscriptionErrorTelemetry } from "@/v4/telemetry/useSessionSubscriptionErrorTelemetry.js";
import { useSessionOpenArmsTelemetry } from "@/v4/telemetry/useSessionOpenArmsTelemetry.js";
import {
  parseV4VisibleSlashCommand,
  parseSelectionSideSlashCommand,
  v4QueuedCommandText,
  type V4VisibleSlashCommand,
} from "@/v4/slashCommands.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { usePendingCommandRecovery } from "@/v4/usePendingCommandRecovery.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
import { resolveMcpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  SyncSubagentSessionTabsRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildSelectionSideChatKey,
  clearSelectionSideChat,
  createSelectionSideChat,
  isSelectionSideChatBlocked,
  registerSelectionSideChatOpener,
  setSelectionSideChatBlocked,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import {
  normalizeSlashCommandValue,
  shouldOfferSideSlashCommand,
  type AppSlashCommand,
} from "@/slashCommandHelpers.js";
import {
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

export interface SessionPaneProps {
  paneId: string;
  sessionId: string | null;
  /** Low-traffic open entry, provided by the pane host; the default exists only for legacy callers. */
  openTrigger?: SessionOpenTrigger;
  rootSessionId?: string;
  /** Observer views such as the subagent side detail: no composer/input and no inline-edit commands. */
  readOnly?: boolean;
  /** Explicit observer-view exception: the file summary may restore the workspace, but session editing stays disabled. */
  allowWorkspaceFileRewind?: boolean;
  /** Selection side pane: keeps the normal composer/tools but hides and disables edit/retry/fork/goal. */
  selectionSideChat?: boolean;
  /** Main-session selection actions are delivered only to the Side Pane's currently active auxiliary child. */
  activeSelectionSideChatSessionId?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Prompt-template telemetry currently covers Desktop only; Web/mobile remote keeps the UI behavior but does not fire the event. */
  isDesktop?: boolean;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession: return to a draft after deleting the current session (the shell starts a fresh draft). */
  onSessionDeleted?: () => void;
  /** When a hidden side pane's child no longer exists, the host removes its tab. */
  onSelectionSideChatUnavailable?: () => void;
  /**
   * Focus layer: global shortcuts (Esc stop) and add-to-chat events route only to
   * the focused pane. Single-pane consumers (V4ChatPane) default to true.
   */
  focused?: boolean;
  /**
   * Whether the pane is actually visible. Non-focused split panes still pass true; forceMounted hidden sidebar tabs pass false.
   * Affects foreground UI telemetry only, never the live subscription or background /event/report.
   */
  telemetryVisible?: boolean;
  /** Split a new draft pane to the right (the host omits it at the leaf limit). */
  onSplitRight?: () => void;
  /** Split a new draft pane downward. */
  onSplitDown?: () => void;
  /** Close this pane (non-primary panes only; closing a pane never stops the session). */
  onClosePane?: () => void;
  /** Ownership badge for cross-workspace panes (present when the pane workspace differs from the shell workspace). */
  workspaceBadge?: PaneWorkspaceBadge;
  /**
   * contextHeader above the draft composer (m5: workspace switcher + Git branch).
   * Constructed by the app shell (needs shell capabilities such as workspaceTabs / remote
   * connection callbacks); omitted on non-primary panes (workspace switching is a shell action).
   */
  draftComposerHeader?: ReactNode;
  /** The primary draft exposes its drop controller to the app-shell title bar; other panes consume it only on their own surface. */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
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
  /** Notification-row artifact chip -> full-size viewer tab. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  /** Subagent pill on a tool card -> transcript tab; same host handler as the detail page's subagent row. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** Script pill on a tool card -> script transcript tab; same host handler as the detail page's script row. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}
function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ZCodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // The V4 snapshot already carries security attribution; pass the attribution fields
    // through so errors cluster by it.
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as ComposerSubmissionConfig["modelSelection"],
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}

/**
 * Single-pane vertical slice: subscribe -> render rows -> composer send/stop.
 *
 * React performance (vercel-react-best-practices):
 * - leaf components (Header/Timeline/QueuePanel/InputControls/Composer/GoalBanner) are memoized;
 * - every callback is useCallback and **does not depend on the fast-changing snapshot** -
 *   snapshot/composer text is read via refs, keeping callback identities stable across streaming
 *   deltas so memoized children never re-render for nothing;
 * - the model form's local input state lives in the child components, so typing never re-renders
 *   the whole pane.
 */
export function SessionPane({
  paneId,
  sessionId,
  openTrigger,
  rootSessionId,
  readOnly = false,
  allowWorkspaceFileRewind = false,
  selectionSideChat = false,
  activeSelectionSideChatSessionId = null,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isDesktop = false,
  provider,
  onSessionCreated,
  onSelectionSideChatUnavailable,
  focused = true,
  telemetryVisible = true,
  onSplitRight,
  onSplitDown,
  onClosePane,
  workspaceBadge,
  draftComposerHeader,
  onDropTargetControllerChange,
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
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: SessionPaneProps) {
  const {
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
  } = useV4Conversation();
  const platform = useOptionalPlatform();
  const { conversationShareService, modelSelectionService, zcodeSessionService, zcodeTaskService } =
    useServices();
  const { intl, locale } = useZCodeIntl();
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const baseWorkspaceServices = useBaseWorkspaceServices();
  const workspaceHomePath = useWorkspaceHomePath({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  });
  // SessionPane already sits inside the target Workspace's ServiceProvider; subscribe to the
  // Host service directly instead of re-resolving workspace/remote routing in a view component.
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundEnabled = useScopedConversationTelemetryForegroundEnabled({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundOwnerRef = useRef<object>({});
  useEffect(() => {
    if (
      !conversationTelemetry ||
      !conversationTelemetryForegroundEnabled ||
      !telemetryVisible ||
      !sessionId
    ) {
      return undefined;
    }
    return conversationTelemetry.attachForeground(
      conversationTelemetryForegroundOwnerRef.current,
      sessionId,
    );
  }, [conversationTelemetry, conversationTelemetryForegroundEnabled, sessionId, telemetryVisible]);
  const [lease, setLease] = useState<SessionLease | null>(null);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  const newlyCreatedSessionIdRef = useRef<string | null>(null);
  const shareDraft = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.drafts[sessionId] : undefined,
  );
  const shareDockState = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.dockStates[sessionId] : undefined,
  );
  const shareDock = shareDockState ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  const shareTitle = shareDock.title ?? snapshot?.meta.title?.trim() ?? sessionId ?? "";
  const shareDisclosureAccepted = shareDock.disclosureAccepted;
  const sharePublishing = shareDock.publishing;
  const shareProgress = shareDock.progress;
  const shareCompletedArtifacts = shareDock.completedArtifacts;
  const shareTotalArtifacts = shareDock.totalArtifacts;
  const publishedShareUrl = shareDock.publishedShareUrl;
  const shareError = shareDock.error;
  const shareWarnings = shareDock.warnings;
  const shareActive = shareDraft?.scope === "partial";
  const shareInSelectionStage = shareActive && (shareDraft?.stage ?? "selection") === "selection";
  // Scrim, selection panel, and background scroll lock must share one verdict, or the scrim
  // lingers after the panel collapses.
  const shareSelectionPanelVisible = resolveConversationShareSelectionPanelVisible({
    partialShareActive: shareActive,
    stage: shareDraft?.stage ?? "selection",
    view: shareDraft?.view,
  });
  const finishShare = useConversationShareSelectionStore((value) => value.finishSelection);
  const updateShareDockState = useConversationShareSelectionStore((value) => value.updateDockState);
  const goToShareConfiguration = useConversationShareSelectionStore(
    (value) => value.goToConfiguration,
  );
  const goToShareSelection = useConversationShareSelectionStore((value) => value.goToSelection);
  const syncAvailableTurns = useConversationShareSelectionStore(
    (value) => value.syncAvailableTurns,
  );
  const toggleShareRow = useConversationShareSelectionStore((value) => value.toggleRow);
  const deselectShareProductTurn = useConversationShareSelectionStore(
    (value) => value.deselectProductTurn,
  );
  const setAllShareRowsSelected = useConversationShareSelectionStore(
    (value) => value.setAllRowsSelected,
  );
  const setShareAccessMode = useConversationShareSelectionStore((value) => value.setAccessMode);
  const showShareTimeline = useConversationShareSelectionStore((value) => value.showTimeline);
  const showShareSelectionPanel = useConversationShareSelectionStore(
    (value) => value.showSelectionPanel,
  );
  const dismissShareSelectionPanel = useCallback(() => {
    if (sessionId) showShareTimeline(sessionId);
  }, [sessionId, showShareTimeline]);
  useConversationShareSelectionOutsideDismiss({
    enabled: shareSelectionPanelVisible,
    onDismiss: dismissShareSelectionPanel,
  });
  const shareRenderUnits = useMemo(
    () => buildConversationTurnRenderUnits(snapshot?.rows.window ?? []),
    [snapshot?.rows.window],
  );
  const shareItems = useMemo(
    () =>
      buildConversationTurnNavigatorItems(shareRenderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, shareRenderUnits],
  );
  const eligibleShareItems = useMemo(
    () => shareItems.filter((item) => !item.isRunning),
    [shareItems],
  );
  const eligibleShareRowIds = useMemo(
    () => new Set(eligibleShareItems.map((item) => item.rowId)),
    [eligibleShareItems],
  );
  useEffect(() => {
    if (!sessionId || !shareActive) return;
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    syncAvailableTurns(
      sessionId,
      eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }, [eligibleShareItems, sessionId, shareActive, snapshot?.rows.window, syncAvailableTurns]);
  const selectedShareRowIds = useMemo(
    () =>
      new Set(
        sessionId
          ? getConversationShareSelectedRowIds(
              useConversationShareSelectionStore.getState(),
              sessionId,
            )
          : [],
      ),
    [sessionId, shareDraft],
  );
  const selectedShareProductTurnIds = useMemo(
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
          )
        : [],
    [sessionId, shareDraft],
  );
  const sharePreflightMetaRef = useRef<{
    revision: number;
    logEpoch: string;
    capabilitiesFingerprint: string;
    supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  }>({
    revision: 0,
    logEpoch: "",
    capabilitiesFingerprint: "",
    supportedArtifactTypes: [],
  });
  const [sharePreflightVersion, setSharePreflightVersion] = useState(0);
  const selectedShareTurnFingerprints = useMemo(
    () =>
      new Map(
        selectedShareProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(
            snapshot?.rows.window ?? [],
            productTurnId,
            workspacePath,
            {
              workspaceKey: workspaceIdentity?.trim() || workspacePath,
              remoteSessionId: remoteSessionId ?? "",
              sessionId: sessionId ?? "",
              revision: snapshot?.revision,
              logEpoch: snapshot?.logEpoch,
              capabilitiesFingerprint: sharePreflightMetaRef.current.capabilitiesFingerprint,
            },
          ),
        ]),
      ),
    [
      remoteSessionId,
      selectedShareProductTurnIds,
      sessionId,
      sharePreflightVersion,
      snapshot?.logEpoch,
      snapshot?.revision,
      snapshot?.rows.window,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const eligibleShareProductTurnIds = useMemo(() => {
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    const seen = new Set<string>();
    return eligibleShareItems.flatMap((item) => {
      const productTurnId = rowsById.get(item.rowId)?.productTurnId;
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
  }, [eligibleShareItems, snapshot?.rows.window]);
  const sharePreflightCacheRef = useRef(new Map<string, ConversationShareTurnPreflightResult>());
  // Transport-class failures are cached per turn as blocking issues, so a selection change
  // alone cannot retrigger the RPC. Clear the cache and restart when the retry token changes
  // so one network blip cannot strand the user at the selection step.
  const [sharePreflightRetryToken, setSharePreflightRetryToken] = useState(0);
  const sharePreflightScopeKey = `${workspaceIdentity?.trim() || workspacePath}\u0000${remoteSessionId ?? ""}\u0000${sessionId ?? ""}`;
  const sharePreflightScopeKeyRef = useRef<string | null>(null);
  const sharePreflightCacheKey = useCallback(
    (productTurnId: string) =>
      conversationSharePreflightCacheKey(sharePreflightScopeKey, productTurnId),
    [sharePreflightScopeKey],
  );
  const retrySharePreflight = useCallback(() => {
    for (const productTurnId of selectedShareProductTurnIds) {
      sharePreflightCacheRef.current.delete(sharePreflightCacheKey(productTurnId));
    }
    setSharePreflightRetryToken((token) => token + 1);
    setSharePreflightVersion((version) => version + 1);
  }, [selectedShareProductTurnIds, sharePreflightCacheKey]);
  const shareHydratedSessionRef = useRef<string | null>(null);
  const sharePreflight = useMemo<ConversationShareSelectionPreflightState>(() => {
    if (!shareInSelectionStage || !sessionId) {
      return { status: "idle" };
    }
    if (selectedShareProductTurnIds.length === 0) {
      return { status: "idle" };
    }
    const entries = selectedShareProductTurnIds.map((productTurnId) => {
      const entry = sharePreflightCacheRef.current.get(sharePreflightCacheKey(productTurnId));
      return entry?.turnFingerprint === selectedShareTurnFingerprints.get(productTurnId)
        ? entry
        : undefined;
    });
    if (entries.some((entry) => entry === undefined)) {
      return { status: "checking" };
    }
    const resolvedEntries = entries.filter(
      (entry): entry is ConversationShareTurnPreflightResult => entry !== undefined,
    );
    return {
      status: "ready",
      ...sharePreflightMetaRef.current,
      blockingIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.blockingIssues),
      ),
      skippableWarnings: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.skippableWarnings),
      ),
      deferredIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.deferredIssues),
      ),
      turnResults: resolvedEntries,
    };
  }, [
    sessionId,
    selectedShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    shareInSelectionStage,
    sharePreflightVersion,
  ]);

  useEffect(() => {
    if (sharePreflightScopeKeyRef.current === sharePreflightScopeKey) return;
    sharePreflightScopeKeyRef.current = sharePreflightScopeKey;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sharePreflightScopeKey]);

  useEffect(() => {
    if (shareActive && sessionId) return;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sessionId, shareActive]);

  useEffect(() => {
    // Preflight results are cached per turn: select/deselect only re-aggregates the current
    // selection, and the RPC fires on first add or a turn-fingerprint change. Publishing still
    // runs its own authoritative stat/read/SHA checks; this cache is never final truth.
    const requestScopeKey = sharePreflightScopeKey;
    if (!shareInSelectionStage || !sessionId || selectedShareProductTurnIds.length === 0) {
      return undefined;
    }
    const missingProductTurnIds = getMissingConversationSharePreflightTurnIds(
      sharePreflightScopeKey,
      selectedShareProductTurnIds,
      sharePreflightCacheRef.current,
      selectedShareTurnFingerprints,
    );
    if (missingProductTurnIds.length === 0) return undefined;
    const requestRows = snapshot?.rows.window ?? [];
    const timer = setTimeout(() => {
      void conversationShareService
        .preflight({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          selection: {
            kind: "productTurns",
            productTurnIds: missingProductTurnIds,
          },
        })
        .then(
          (result) => {
            if (!shareActive || requestScopeKey !== sharePreflightScopeKeyRef.current) return;
            sharePreflightMetaRef.current = {
              revision: result.revision,
              logEpoch: result.logEpoch,
              capabilitiesFingerprint: result.capabilitiesFingerprint,
              supportedArtifactTypes: result.supportedArtifactTypes,
            };
            // In dev the host process does not restart with services, so an old host returns
            // no turnResults and a bare .map throws, surfacing as "server preflight failed" in
            // the downstream catch. Per-item degradation lives in the helper, see
            // conversationSharePreflightCache.
            const resultTurnFingerprints = new Map(
              missingProductTurnIds.map((productTurnId) => [
                productTurnId,
                conversationShareTurnFingerprint(requestRows, productTurnId, workspacePath, {
                  workspaceKey: workspaceIdentity?.trim() || workspacePath,
                  remoteSessionId: remoteSessionId ?? "",
                  sessionId,
                  revision: result.revision,
                  logEpoch: result.logEpoch,
                  capabilitiesFingerprint: result.capabilitiesFingerprint,
                }),
              ]),
            );
            const entries = buildConversationSharePreflightCacheEntries(
              result,
              missingProductTurnIds,
              resultTurnFingerprints,
            );
            for (const entry of entries) {
              sharePreflightCacheRef.current.set(
                sharePreflightCacheKey(entry.productTurnId),
                entry,
              );
            }
            setSharePreflightVersion((version) => version + 1);
          },
          (error: unknown) => {
            // Only genuine RPC/server failures land here; renderer exceptions inside the
            // success callback are caught by the final catch below and no longer masquerade as
            // preflight verdicts. Missing issues degrade to unknown; the log is the only clue.
            const details = getConversationShareErrorDetails(error);
            logger.warn("[v4-share] conversation share preflight failed", {
              sessionId,
              turnCount: missingProductTurnIds.length,
              name: details.name,
              kind: details.kind,
              reasonCode: details.reasonCode,
              issueCount: details.issueCount ?? 0,
              message: error instanceof Error ? error.message : String(error),
            });
            if (!shareActive || requestScopeKey !== sharePreflightScopeKeyRef.current) return;
            const issues =
              details.issues && details.issues.length > 0
                ? details.issues
                : [
                    {
                      code: resolveConversationShareFallbackIssueCode(details),
                      scope: "transport" as const,
                    },
                  ];
            for (const productTurnId of missingProductTurnIds) {
              sharePreflightCacheRef.current.set(sharePreflightCacheKey(productTurnId), {
                productTurnId,
                turnFingerprint: selectedShareTurnFingerprints.get(productTurnId),
                blockingIssues: issues,
                skippableWarnings: [],
                deferredIssues: [],
              });
            }
            setSharePreflightVersion((version) => version + 1);
          },
        )
        .catch((error: unknown) => {
          // Renderer-side exception: log only, never write the preflight cache, so a frontend
          // bug is not displayed again as a share failure.
          logger.error("[v4-share] conversation share preflight result handling error", {
            sessionId,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [
    conversationShareService,
    remoteSessionId,
    selectedShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    sharePreflightRetryToken,
    sharePreflightScopeKey,
    sessionId,
    shareActive,
    shareInSelectionStage,
    snapshot?.rows.window,
    workspaceIdentity,
    workspacePath,
  ]);
  const sessionLeaseReady = lease?.sessionId === sessionId;
  const shouldMeasureExistingSessionOpen =
    sessionLeaseReady && newlyCreatedSessionIdRef.current !== sessionId;
  useSessionOpenArmsTelemetry({
    sessionId,
    snapshot,
    openTiming: sessionLeaseReady ? state.openTiming : undefined,
    rendererTiming: sessionLeaseReady ? state.rendererTiming : undefined,
    openKind: sessionLeaseReady ? lease?.openKind : undefined,
    openTrigger,
    startedAt: sessionLeaseReady ? lease?.startedAt : undefined,
    status: state.status,
    lastError: state.lastError,
    enabled: shouldMeasureExistingSessionOpen,
    readOnly,
    reporter: platform,
  });
  useEffect(() => {
    const newlyCreatedSessionId = newlyCreatedSessionIdRef.current;
    if (newlyCreatedSessionId !== null && newlyCreatedSessionId !== sessionId) {
      newlyCreatedSessionIdRef.current = null;
    }
  }, [sessionId]);
  const mobilePlanInteractionReconcileTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    const timers = mobilePlanInteractionReconcileTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [lease, sessionId]);
  const pluginReferenceIconsEnabled =
    isSessionPluginCatalogReady(state.status, sessionId, snapshot?.sessionId) &&
    hasPluginReferenceUserRows(snapshot?.rows.window ?? []);
  // send_result settlement signal: the user message is actually painted into the history.
  // z-code has no optimistic rendering - the bubble appears only once the projection echoes a
  // userInput row - so an accepted ACK is not "sent". An effect, not a store subscription
  // callback: effects run after the DOM commit, when the bubble is already on screen.
  useEffect(() => {
    const rows = snapshot?.rows.window;
    if (!rows || rows.length === 0) return;
    // Do not just take the last userInput: a background result row may be inserted right after
    // it, and a tail-only check would miss the user's own row, misreporting render_timeout. The
    // supervisor filters against its pending-render table in O(1), so backfilled/reloaded rows
    // never trigger it by accident.
    for (const row of rows) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        conversationTelemetry?.notifyUserInputRendered(row.sourceCommandId);
      }
    }
  }, [conversationTelemetry, snapshot]);
  const fileChangesRequestCache = useMemo(
    () => new Map<string, Promise<V4ConversationFileChangesResult>>(),
    [fileChanges, sessionId, snapshot?.logEpoch],
  );
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<readonly string[]>([]);
  const [sendSubmissionError, setSendSubmissionError] = useState<ZCodeUiError | null>(null);
  const [paneLocalSummaryPanelVariantOverride, setPaneLocalSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const [terminalSectionOpen, setTerminalSectionOpen] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(false);
  const [dropTargetController, setDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const handleDropTargetControllerChange = useCallback(
    (controller: ConversationDropTargetController | null) => {
      setDropTargetController(controller);
      onDropTargetControllerChange?.(controller);
    },
    [onDropTargetControllerChange],
  );
  const readOnlyDropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: false,
      kind: null,
      onDragLeave: () => {},
      onDragOver: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      },
      onDrop: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );
  const effectiveDropTargetController = readOnly
    ? readOnlyDropTargetController
    : dropTargetController;

  // Stable callbacks read the latest values through refs, never depending on the fast-changing snapshot/text.
  const snapshotRef = useRef<ConversationSnapshot | null>(snapshot);
  const autoOpenedAssistantPptxKeysRef = useRef<Set<string>>(new Set());
  const assistantPreviewPptxGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] =
    useState<AssistantPreviewPptxAutoOpenTarget | null>(null);
  const autoLoadIncompleteTurnCursorRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!onAutoOpenAssistantPptx || request.sources.length === 0) return;
      if (autoOpenedAssistantPptxKeysRef.current.has(request.key)) return;
      autoOpenedAssistantPptxKeysRef.current.add(request.key);
      onAutoOpenAssistantPptx(request);
    },
    [onAutoOpenAssistantPptx],
  );
  const composerDraftStateRef = useRef({ hasContent: false, busy: false });
  const [queueEditOperation, setQueueEditOperation] = useState<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>(null);
  const queueEditOperationRef = useRef(queueEditOperation);
  queueEditOperationRef.current = queueEditOperation;
  const [composerRestoreRequest, setComposerRestoreRequest] =
    useState<ComposerRestoreRequest | null>(null);
  const nextComposerRestoreRequestIdRef = useRef(1);
  const timelineScrollToBottomRef = useRef<(() => void) | null>(null);
  const timelineScrollToQueryRef = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  const conversationLayoutContainerRef = useRef<HTMLDivElement>(null);
  const hasExternalSummaryPanelVariantControl = Boolean(onSummaryPanelVariantOverrideChange);
  const effectiveSummaryPanelVariantOverride = hasExternalSummaryPanelVariantControl
    ? (summaryPanelVariantOverride ?? null)
    : paneLocalSummaryPanelVariantOverride;
  const handleSummaryPanelVariantChange = useCallback(
    (variant: ChatViewSummaryPanelVariant | null) => {
      if (onSummaryPanelVariantOverrideChange) {
        onSummaryPanelVariantOverrideChange(variant);
        return;
      }
      setPaneLocalSummaryPanelVariantOverride(variant);
    },
    [onSummaryPanelVariantOverrideChange],
  );

  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const workspaceConfigOptions = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).configOptions,
  );
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      !snapshot.config.provider.trim() ||
      !snapshot.config.model.trim() ||
      !workspaceConfigOptions?.length
    ) {
      return;
    }
    // Bug: V4 session config lives only in ConversationSnapshot, so the legacy task config
    // bucket stays empty; starting a task from a custom-model session could only inherit the
    // workspace default model. Overlay the authoritative config onto the full catalog, cached
    // per task; session/workspace sources of truth are untouched.
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        sessionId,
        projectSessionConfigToTaskConfigOptions(workspaceConfigOptions, snapshot.config),
        workspaceIdentity,
      );
  }, [
    sessionId,
    snapshot?.config.mode,
    snapshot?.config.model,
    snapshot?.config.provider,
    snapshot?.config.thought,
    snapshot?.sessionId,
    workspaceConfigOptions,
    workspaceIdentity,
    workspacePath,
  ]);
  useEffect(() => {
    const scopeKey = `${workspaceKey}\u0000${sessionId ?? "draft"}`;
    const enabled = Boolean(onAutoOpenAssistantPptx && focused && sessionId);
    const result = advanceAssistantPreviewPptxAutoOpenGate(assistantPreviewPptxGateRef.current, {
      enabled,
      scopeKey,
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(snapshot?.rows.window ?? []),
    });
    assistantPreviewPptxGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    focused,
    onAutoOpenAssistantPptx,
    sessionId,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    snapshot?.rows.window,
    workspaceKey,
  ]);
  useEffect(() => {
    // Avoid reusing keys across workspace/session/logEpoch switches; keys are already isolated,
    // so this cleanup is just a lifecycle boundary keeping the Set from tracking every session
    // in long-lived workbenches.
    autoOpenedAssistantPptxKeysRef.current.clear();
  }, [sessionId, snapshot?.logEpoch, workspaceKey]);
  const composerTextInsertRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest,
  );
  const timelineBottomRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).timelineBottomRequest,
  );
  const draftRuntimeInvalidationVersion = useZCodeSessionStore(
    (store) =>
      store.getWorkspaceState(workspacePath, workspaceIdentity).draftRuntimeInvalidationVersion,
  );
  const handleExternalTextInsertApplied = useCallback(
    (requestId: number) => {
      useZCodeSessionStore
        .getState()
        .clearComposerTextInsertRequest(workspacePath, requestId, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );
  const composerBindingRef = useRef({ sessionId, workspaceKey });
  composerBindingRef.current = { sessionId, workspaceKey };
  const configCommandBarrier = useMemo(() => createConfigCommandBarrier(), []);
  // Soft review is not a blocking interaction: never hide the Composer or disable selection quotes.
  const blockingInteractionId =
    snapshot?.pendingInteractions.find(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    )?.interactionId ?? null;
  const selectionSideChatKey = sessionId
    ? buildSelectionSideChatKey(workspaceKey, sessionId)
    : null;
  const selectionSideActionBlocked = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      activeSelectionSideChatSessionId
        ? isSelectionSideChatBlocked(activeSelectionSideChatSessionId)
        : false,
    () => false,
  );
  const timelineScrollMemoryKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });

  const {
    agentStartupAllowed: draftAgentStartupAllowed,
    error: draftModelReadinessError,
    dismissError: dismissDraftModelReadinessError,
    ensureReadyForSend: ensureDraftModelReadyForSend,
    markProviderNotReady: markDraftProviderNotReady,
  } = useDraftModelReadinessGate({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSelectionService,
  });

  // The Composer holds the renderer intent for the next Submission; the prewarm session only carries draft prewarming.
  const {
    composerDraft,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    updateComposerContent,
  } = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig: snapshot?.sessionId === sessionId ? snapshot.config : null,
    agentStartupAllowed: draftAgentStartupAllowed,
    modelSelectionService,
  });
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const draftModelSelectionRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionId !== null) {
      draftModelSelectionRevisionRef.current = null;
      return;
    }
    const revision = modelSelectionView?.revision ?? null;
    const previousRevision = draftModelSelectionRevisionRef.current;
    draftModelSelectionRevisionRef.current = revision;
    if (
      revision === null ||
      previousRevision === null ||
      revision === previousRevision ||
      (draftConfigRef.current.provider && draftConfigRef.current.model)
    ) {
      return;
    }
    // Bug: on cold start the plain Provider lets the draft prewarm first and the Account
    // Overlay enters the Selection View only later. The prewarm session froze the early
    // fallback, so the renderer stayed on the old model forever even after the latest View
    // included the current account connection. A draft with no send and no explicit choice is
    // not an execution fact: recycle and rebuild from the latest selection on View change;
    // explicit choices and real sessions stay frozen.
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [draftConfigRef, modelSelectionView?.revision, sessionId, workspaceIdentity, workspacePath]);
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const createSubmissionFromComposer = useCallback(
    () => createComposerSubmissionConfig(draftConfigRef.current, modelSelectionView),
    [draftConfigRef, modelSelectionView],
  );
  const composerSubmissionReady = useMemo(
    () => createComposerSubmissionConfig(draftConfig, modelSelectionView) !== null,
    [draftConfig, modelSelectionView],
  );
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const promoteGroupedDraftTask = useZCodeSessionStore((state) => state.promoteGroupedDraftTask);
  // The first-send commandId already exists at accepted time and is also the completion message_id; no need to wait for the reply.
  const reportDraftCreated = useCallback(
    (createdSessionId: string, source: SessionCreateSource, messageId: string) => {
      void reportSessionCreate(platform, {
        sessionId: createdSessionId,
        messageId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        source,
        clientKind: isDesktop ? "desktop" : "web",
      });
    },
    [platform, workspacePath, workspaceIdentity, remoteSessionId, isDesktop],
  );
  const handleDraftSessionCreated = useCallback(
    (
      createdSessionId: string,
      groupedDraftTask: GroupedDraftTaskState | null | undefined,
      createSource?: SessionCreateSource,
      messageId?: string,
    ) => {
      if (messageId) {
        reportDraftCreated(
          createdSessionId,
          createSource ?? (groupedDraftTask ? "group" : "session"),
          messageId,
        );
      }
      // Root cause: the session-open metric measures existing sessions only, yet draft
      // first-send handed the newly created/promoted prewarm sessionId to the same hook. The
      // prewarm lease keeps the draft-era startedAt and empty snapshot timing, recording hours
      // of idle as total/react. Mark this pane's first binding at the creation boundary; the
      // flag clears when the same session is explicitly reopened after leaving, restoring the
      // normal existing-session open measurement.
      newlyCreatedSessionIdRef.current = createdSessionId;
      promoteComposerDraft(createdSessionId);
      // Only the draft create/promote accepted boundary inherits grouped placement. Fork and
      // plain task navigation still reuse onSessionCreated without polluting existing task grouping.
      if (groupedDraftTask) {
        promoteGroupedDraftTask(
          workspacePath,
          createdSessionId,
          groupedDraftTask,
          workspaceIdentity,
        );
        logger.debug("[v4-pane] grouped draft explicitly promoted", {
          createdSessionId,
          draftId: groupedDraftTask.draftId,
        });
      }
      onSessionCreated?.(createdSessionId);
    },
    [
      reportDraftCreated,
      onSessionCreated,
      promoteComposerDraft,
      promoteGroupedDraftTask,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const { settings: sharedSettings } = useSettings();
  const readPlanIdentitySnapshot = usePlanIdentitySnapshot(
    sharedSettings?.providerFamilyDomain,
    sharedSettings?.providerFamilyDomain
      ? sharedSettings.providerFamilyConnectionSelections?.[sharedSettings.providerFamilyDomain]
      : undefined,
    baseWorkspaceServices.usageStatsService,
  );
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const messageStreamShowReasoning = sharedSettings?.messageStreamShowReasoning ?? true;
  const messageStreamShowTodos = sharedSettings?.messageStreamShowTodos ?? false;
  const toolGroupingExploreEnabled = sharedSettings?.toolGroupingExploreEnabled ?? true;
  const toolGroupingTerminalEnabled = sharedSettings?.toolGroupingTerminalEnabled ?? true;
  const toolGroupingChangesEnabled = sharedSettings?.toolGroupingChangesEnabled ?? false;
  const snapshotSessionId = snapshot?.sessionId ?? null;
  const snapshotFollowupMode = snapshot?.config.followupMode ?? null;
  const snapshotRevision = snapshot?.revision ?? null;

  // Injection mirrors PermissionDialog: the host reads theme/codePreviewSettings from the
  // store and delivers them via the stable-reference rowContext to memoized row components
  // (MessageResponse/ToolCallBlocks).
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // Tier 1 fork jump: clicking a child session's forkNotice switches this pane in place to the
  // parent session, reusing the same onSessionCreated as the fork flow (primary ->
  // setActiveTaskId, split -> bindPaneSession). rowId is reserved for Tier 2 exact scrolling:
  // forkNotice.parentRowId is always the 0 placeholder, ignored here.
  const handleNavigateToRow = useCallback(
    (targetSessionId: string, _rowId: number) => {
      if (!targetSessionId || targetSessionId === sessionId) {
        return;
      }
      onSessionCreated?.(targetSessionId);
    },
    [onSessionCreated, sessionId],
  );
  const dispatchCommand = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      baseRevision?: number,
      baseLogEpoch?: string,
      telemetrySeed?: ConversationPromptTelemetrySeed,
      onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
      sessionCreateSource?: SessionCreateSource,
    ): Promise<CommandAck> => {
      const submission = submissionConfigFromCommand(type, payload);
      const acceptRecent = submission
        ? captureComposerRecentSubmission(workspacePath, submission, workspaceIdentity)
        : undefined;
      const acceptSelection =
        submission && (sessionId === null || targetSessionId === sessionId)
          ? captureAcceptedModelSelection(submission.modelSelection)
          : undefined;
      const envelope = createCommandEnvelope({
        type,
        sessionId: targetSessionId,
        payload: payload as never,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(baseLogEpoch ? { baseLogEpoch } : {}),
      });
      onEnvelopeCreated?.(envelope);
      // Must run before the first upstream send: keeps a queryable clue across transport errors/renderer refreshes.
      const groupedDraftTask =
        type === "createSession"
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .groupedDraftTask
          : null;
      pendingCommandRegistry.record(
        envelope,
        type === "createSession"
          ? {
              workspace: {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
              ...(groupedDraftTask ? { groupedDraftTask } : {}),
              sessionCreateSource:
                sessionCreateSource ??
                useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftCreateSource,
            }
          : undefined,
      );
      if (lease?.store && type !== "createSession") {
        lease.store.markCommandPending({
          commandId: envelope.commandId,
          type: envelope.type,
          issuedAt: envelope.issuedAt,
        });
      }
      let ack: CommandAck;
      try {
        if (telemetrySeed?.localTtft && !workspaceIdentity?.trim()) {
          envelope.ttft = getLocalTtftObserver()?.dispatch(
            telemetrySeed.localTtft,
            workspacePath,
            envelope.commandId,
            targetSessionId,
          );
        }
        ack = await sendCommand(envelope);
        if (telemetrySeed?.localTtft && ack.reasonCode === "guard.heldQueueConfirmationStale")
          getLocalTtftObserver()?.confirmationRetry(telemetrySeed.localTtft);
        else if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.ack(telemetrySeed.localTtft, ack.status, ack.ttftExcluded);
      } catch (error) {
        if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        if (lease?.store) {
          lease.store.settleCommand(envelope.commandId);
        }
        if (isProviderNotReadyError(error)) {
          // provider_not_ready deterministically rejects before Host getClient, so the CLI
          // cannot have admitted it yet. Keeping the renderer recovery ledger would make the
          // reconnect query return unknown for sure; unknown now settles silently, and a
          // deterministic rejection must not leave an invalid recovery record.
          pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
        }
        recordV4CommandAck({
          type,
          status: "transport-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        // Send-funnel settlement: only real user sends carry telemetrySeed; two-step
        // createSession and background tasks have no seed and cannot fake send_result.
        if (telemetrySeed) {
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: targetSessionId,
            commandId: envelope.commandId,
            status: "fail",
            reasonCode: isProviderNotReadyError(error) ? "provider_not_ready" : "transport_error",
          });
        }
        throw error;
      }
      pendingCommandRegistry.applyAck(envelope, ack);
      if (ack.status === "accepted") {
        acceptSelection?.();
        acceptRecent?.();
      }
      if (
        lease?.store &&
        type === "sendText" &&
        (ack.status === "accepted" || ack.status === "duplicate")
      ) {
        // An ACK means CLI admission only; if the conversation topic goes silent afterwards,
        // the store watchdog reuses the same owned subscription after the grace period to
        // recover authoritative rows/queue, without replaying the command.
        lease.store.expectAcceptedInputProjection(envelope.commandId);
      }
      if (ack.status === "accepted" && telemetrySeed) {
        const acceptedSessionId =
          ack.result?.type === "createSelectionSideSession"
            ? ack.result.sessionId
            : (targetSessionId ??
              (ack.result?.type === "createSession" ? ack.result.sessionId : null));
        if (acceptedSessionId) {
          conversationTelemetry?.acceptPromptSeed({
            ...telemetrySeed,
            sessionId: acceptedSessionId,
            sourceCommandId: envelope.commandId,
            memoryEnabled: ack.memoryEnabled,
          });
        }
      }
      if (telemetrySeed) {
        // The queue double-confirm ACK returns null (non-terminal); settling there would let first-wins swallow the real result.
        const outcome = resolveSendAckSettlement(ack);
        if (outcome) {
          const settledSessionId =
            ack.result?.type === "createSelectionSideSession"
              ? ack.result.sessionId
              : (targetSessionId ??
                (ack.result?.type === "createSession" ? ack.result.sessionId : null));
          if (outcome.kind === "awaitRender") {
            // An ACK only means the Host accepted the command; the user bubble is not
            // painted yet. Settle the end-to-end timing once the projection echoes a userInput
            // row (or on the 30s timeout).
            conversationTelemetry?.awaitSendRender({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              ackStatus: outcome.ackStatus,
            });
          } else {
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              status: outcome.status,
              ackStatus: outcome.ackStatus,
              reasonCode: outcome.reasonCode,
            });
          }
        }
      }
      // Production renderer logs are off; the ack summary goes to a bounded debug buffer for e2e/field probes.
      recordV4CommandAck({
        type,
        status: ack.status,
        ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
        revisionAtDecision: ack.revisionAtDecision,
        at: Date.now(),
      });
      if (shouldResyncForStaleAuthority(ack)) {
        // Once epoch/entity authority changes, clearing only the optimistic overlay keeps
        // sending commands at the stale target; same-sub recovery must run first so the next
        // verdict is made against same-generation rowId/entityId.
        lease?.store?.recoverFromStaleAuthority();
      }
      // Without settling on rejected/stale/failed, the optimistic overlay lingers forever.
      if (
        lease?.store &&
        type !== "createSession" &&
        ack.status !== "accepted" &&
        ack.status !== "duplicate"
      ) {
        lease.store.settleCommand(envelope.commandId);
      }
      return ack;
    },
    [
      captureAcceptedModelSelection,
      conversationTelemetry,
      lease,
      provider,
      sendCommand,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleFetchFileChanges = useCallback(
    (target: ConversationRowTarget, options: ConversationFileChangesRequestOptions) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
      }
      const cacheKey = JSON.stringify([
        options.cachePolicy,
        sessionId,
        current.logEpoch,
        // rewind flips active to reverted under the same logEpoch/row/entity; the terminal
        // cache must carry that semantic version and not reuse the pre-undo full diff.
        options.cachePolicy === "in-flight"
          ? current.revision
          : (options.fileChangesState ?? "unknown"),
        target.rowId,
        target.entityId,
      ]);
      const cachedRequest = fileChangesRequestCache.get(cacheKey);
      if (cachedRequest) {
        fileChangesRequestCache.delete(cacheKey);
        fileChangesRequestCache.set(cacheKey, cachedRequest);
        return cachedRequest;
      }

      // Unmounting a virtualized row loses its local state, so a remounted preview card
      // would refetch fileChanges containing the full patch; the cache must live in
      // SessionPane to share one request with the file-changes panel.
      let request: Promise<V4ConversationFileChangesResult>;
      request = fileChanges({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).then(
        (result) => {
          // A success while still running may be a partial diff for the current revision;
          // share only the in-flight Promise and drop it once settled, so the final card
          // never reuses an early result.
          if (
            options.cachePolicy === "in-flight" &&
            fileChangesRequestCache.get(cacheKey) === request
          ) {
            fileChangesRequestCache.delete(cacheKey);
          }
          return result;
        },
        (error: unknown) => {
          // A failure must not poison later retries; delete only the current Promise so an old request cannot remove a newer same-key one.
          if (fileChangesRequestCache.get(cacheKey) === request) {
            fileChangesRequestCache.delete(cacheKey);
          }
          if (shouldResyncForStaleAuthority(error)) {
            lease?.store?.recoverFromStaleAuthority();
          }
          throw error;
        },
      );
      fileChangesRequestCache.set(cacheKey, request);
      while (fileChangesRequestCache.size > MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES) {
        const oldestKey = fileChangesRequestCache.keys().next().value;
        if (oldestKey === undefined) break;
        fileChangesRequestCache.delete(oldestKey);
      }
      return request;
    },
    [fileChanges, fileChangesRequestCache, lease, sessionId],
  );

  const handlePreviewFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          canApply: false,
          safeFiles: [],
          unsafeFiles: [],
          ignoredFiles: [],
        });
      }
      return fileRewindPreview({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).catch((error: unknown) => {
        if (shouldResyncForStaleAuthority(error)) {
          lease?.store?.recoverFromStaleAuthority();
        }
        throw error;
      });
    },
    [fileRewindPreview, lease, sessionId],
  );

  const handleApplyFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        throw new Error("Cannot apply file rewind without an active session revision");
      }
      return dispatchCommand(
        "applyFileRewind",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentSession, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenSubagentDirectory = useCallback(
    (request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest) => {
      onOpenSubagentDirectory?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentDirectory, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenPlanDetail = useCallback(
    (request: OpenPlanDetailSideTabRequest) => {
      onOpenPlanDetail?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenPlanDetail, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Mirrors plan-detail exactly: the card emits intent only (runId + toolCallId + display
  // name); session/workspace identity is always filled in by the host (here) - the card never
  // knows the scope.
  const handleOpenWorkflowRun = useCallback(
    (request: OpenWorkflowRunSideTabRequest) => {
      onOpenWorkflowRun?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRun, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Pill -> subagent transcript: same shape as plan-detail/workflow-run; the card yields only the instance identity, scope filled in here.
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenWorkflowActorSessionSideTabRequest) => {
      onOpenWorkflowActorSession?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowActorSession, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Script pill, same shape: the card yields run + origin row + phase; scope filled in here.
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenWorkflowWorkspaceSideTabRequest) => {
      onOpenWorkflowWorkspace?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowWorkspace, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Artifact chip mirrors run detail: card/notification row emit intent only; scope filled in here.
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenWorkflowArtifactSideTabRequest) => {
      onOpenWorkflowArtifact?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowArtifact, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Tool card -> workflow run join. The authoritative source is each run's toolCallId in the
  // workflowRuns projection (the schema comment names it the tool-card -> detail key); in v4 a
  // tool row's own output is just the prose picked by formatCreateWorkflowModelContent, with
  // no structured fields.
  //
  // The value is more than runId: a run-state card renders status wording and step counts,
  // so the join computes the summary in one pass (counting rules in
  // buildWorkflowRunByToolCallId; its unit tests enumerate the settled/observed semantics).
  // The projection is no longer empty after a restart: CLI cold materialization replays the
  // journal into the same reducer, and the card join reads the projection only - no merged
  // discovery queries. Discovery queries keep exactly one purpose here:
  //
  // `limit`/`refreshKey` serve the task list's finished-workflows footer row:
  // - depth reuses the run-directory page's constant, otherwise the footer count and the
  //   page rows drift into two conventions;
  // - the trigger is the same derived function (run count + settled count), so the footer and
  //   the directory page it opens share one freshness; subscribing to the projection
  //   `revision` instead would turn a single paged read into a stream following node events.
  const workflowRunJournalSummaries = useWorkflowRunJournalSummaries({
    sessionId,
    // Root cause (observed 2026-08-24): nested read-only transcripts (dwf actor/subagent)
    // are SessionPanes too; firing this query from all of them asks a parent-session-keyed
    // journal with a child session id. The CLI cold-session prestep then materializes a second
    // ghost runtime for the running detached actor, double-writes the event log, and freezes
    // the live view at working-for-xx-seconds. Read-only panes consume neither the join
    // fallback nor the task-list footer: turn it off entirely.
    enabled: !readOnly,
    live: state.status === "live",
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(snapshot?.workflowRuns?.runs),
  });
  const endedWorkflowRunCount = useMemo(
    () => countEndedWorkflowRuns(workflowRunJournalSummaries),
    [workflowRunJournalSummaries],
  );
  const workflowRunByToolCallId = useMemo(
    () => buildWorkflowRunByToolCallId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // runId-keyed sibling table: join entry for ResumeWorkflowRun tool rows (display carries
  // the runId; in the projection toolCallId keeps referencing the original CreateWorkflow row
  // across resumes, so resume rows are not found by toolCallId).
  const workflowRunByRunId = useMemo(
    () => buildWorkflowRunByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // Origin toolCallId -> static graph: the graph belongs to the run, and turn-end run cards
  // from all three sources fetch it from this one table. Built in one pass over the row
  // window, rebuilt with it.
  const workflowGraphByToolCallId = useMemo(
    () => buildWorkflowGraphByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Workflow tool row -> draft position: both the draft number and whether a newer draft
  // follows are readable only from row order. Built in one pass over the row window, rebuilt
  // with it.
  const workflowDraftByToolCallId = useMemo(
    () => buildWorkflowDraftByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Join table for Waiting->Answered upgrades in the Workflow notification manifest (runId -> parked qid set).
  const workflowRunPendingQuestionsByRunId = useMemo(
    () => buildWorkflowRunPendingQuestionsByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // Detail-page entry (rows in the panel Workflows section). The row yields only which run to
  // open (runId + toolCallId); session/workspace identity is filled in here as usual - the same
  // handler as the tool card, never a second open path.
  const handleOpenWorkflowRunFromPanel = useCallback(
    (target: ConversationStatusPanelWorkflowRunTarget) => {
      if (!sessionId) return;
      handleOpenWorkflowRun({ ...target, parentSessionId: sessionId });
    },
    [handleOpenWorkflowRun, sessionId],
  );
  // Run-directory entry (the same footer row). Also fills in scope only; no extra open path here.
  const handleOpenWorkflowRunDirectoryFromPanel = useCallback(
    (request: OpenWorkflowRunDirectorySideTabRequest) => {
      onOpenWorkflowRunDirectory?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRunDirectory, remoteSessionId, workspaceIdentity, workspacePath],
  );
  const handleAddSelectionToCurrentTask = useCallback(
    (reference: ConversationSelectionReference) => {
      if (!sessionId) return;
      dispatchConversationSelectionAdd({
        targetSessionId: sessionId,
        workspaceKey,
        reference,
      });
    },
    [sessionId, workspaceKey],
  );
  const handleOpenSelectionSideConversation = useCallback(
    async (reference?: ConversationSelectionReference, forceNew = false) => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) return;
      try {
        let targetChildSessionId = reference && !forceNew ? activeSelectionSideChatSessionId : null;
        let replacesChildSessionId: string | undefined;
        if (targetChildSessionId) {
          try {
            await zcodeSessionService.readSession({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId: targetChildSessionId,
              messageLimit: 1,
            });
          } catch (error) {
            if (!String(error).includes("sessionNotFound")) throw error;
            // With multiple opens the tab id includes the child, so the old singleton trick
            // of a new child overwriting the same parent tab no longer holds. Carry
            // replacesChildSessionId explicitly and let the host delete-then-add atomically.
            replacesChildSessionId = targetChildSessionId;
            clearSelectionSideChat(targetChildSessionId);
            clearConversationSelectionReferenceScope(targetChildSessionId, workspaceKey);
            targetChildSessionId = null;
          }
        }

        if (targetChildSessionId) {
          onOpenSelectionSideChat({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            parentSessionId: sessionId,
            childSessionId: targetChildSessionId,
          });
          if (reference) {
            dispatchConversationSelectionAdd({
              targetSessionId: targetChildSessionId,
              workspaceKey,
              reference,
            });
          }
          return;
        }

        const childSessionId = await createSelectionSideChat(selectionSideChatKey, async () => {
          const ack = await dispatchCommand("createSelectionSideSession", {}, sessionId);
          if (
            (ack.status !== "accepted" && ack.status !== "duplicate") ||
            ack.result?.type !== "createSelectionSideSession"
          ) {
            throw new Error(ack.reasonCode ?? "createSelectionSideSession rejected");
          }
          return ack.result.sessionId;
        });
        onOpenSelectionSideChat({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          parentSessionId: sessionId,
          childSessionId,
          ...(replacesChildSessionId ? { replacesChildSessionId } : {}),
        });
        if (reference) {
          dispatchConversationSelectionAdd({
            targetSessionId: childSessionId,
            workspaceKey,
            reference,
          });
        }
      } catch (error) {
        logger.warn("[v4-pane] failed to create selection side session", {
          error: error instanceof Error ? error.message : String(error),
          parentSessionId: sessionId,
          workspaceKey,
        });
      }
    },
    [
      activeSelectionSideChatSessionId,
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      zcodeSessionService,
    ],
  );

  const handleOpenSelectionSideConversationWithPrompt = useCallback(
    async (text: string, telemetrySeed?: ConversationPromptTelemetrySeed): Promise<boolean> => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) {
        throw new Error("selection side chat is unavailable");
      }
      const inherited = resolveSelectionSideInheritedModel(
        snapshotRef.current?.config,
        modelSelectionView,
      );
      const chosen = inherited ? await recommendStartPlan(inherited) : undefined;
      if (chosen === null) return false;
      const modelSelection = chosen && chosen !== inherited ? chosen : undefined;
      // Every argument command spawns a new child; while the ACK is outstanding, retrying
      // the same text reuses pending, but different text must not merge with bare `/side` or
      // another prompt.
      const pendingKey = `${selectionSideChatKey}\u0000prompt\u0000${text}`;
      const childSessionId = await createSelectionSideChat(pendingKey, async () => {
        const ack = await dispatchCommand(
          "createSelectionSideSession",
          { firstInput: { text, ...(modelSelection ? { modelSelection } : {}) } },
          sessionId,
          undefined,
          undefined,
          telemetrySeed,
        );
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "createSelectionSideSession"
        ) {
          throw new Error(ack.reasonCode ?? "createSelectionSideSession rejected");
        }
        return ack.result.sessionId;
      });
      onOpenSelectionSideChat({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        parentSessionId: sessionId,
        childSessionId,
      });
      return true;
    },
    [
      dispatchCommand,
      modelSelectionView,
      recommendStartPlan,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  useEffect(() => {
    if (
      !selectionSideChatKey ||
      !sessionId ||
      readOnly ||
      selectionSideChat ||
      !onOpenSelectionSideChat
    ) {
      return;
    }

    // The Side Pane fixed entry has no session Provider; register only the command
    // orchestration the main pane already has. The parent session stays registered even while
    // blocked in Permission/AskUser, so the direct entry can still create/focus side panes.
    return registerSelectionSideChatOpener(
      selectionSideChatKey,
      // A merge once dropped the reference, leaving Markdown entries with blank side panes; reuse the existing reference routing.
      (reference) => handleOpenSelectionSideConversation(reference, !reference),
      focused,
      Boolean(blockingInteractionId) || selectionSideActionBlocked,
    );
  }, [
    blockingInteractionId,
    selectionSideActionBlocked,
    focused,
    handleOpenSelectionSideConversation,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    selectionSideChatKey,
    sessionId,
  ]);

  const cliSlashCommandNames = useMemo(
    () =>
      new Set(
        (slashCommands ?? []).map((command) =>
          normalizeSlashCommandValue(command.name).toLowerCase(),
        ),
      ),
    [slashCommands],
  );
  const availableSelectionSideSlashCommandNames = useMemo(
    () => ["side", "btw"].filter((name) => !cliSlashCommandNames.has(name)),
    [cliSlashCommandNames],
  );

  // App-level `/side` slash command. The CLI catalog stays authoritative; the renderer only
  // injects the gated local open-side-chat-from-selection command. Not offered in draft state
  // (no parent session to attach a child), inside a side chat itself, read-only mode, or the
  // mobile viewport.
  const appSlashCommands = useMemo<AppSlashCommand[] | undefined>(() => {
    if (
      !sessionId ||
      !onOpenSelectionSideChat ||
      !shouldOfferSideSlashCommand({
        isDraft: sessionId === null,
        selectionSideChat,
        readOnly,
        isMobileViewport: false,
      })
    ) {
      return undefined;
    }
    const openNewSelectionSideChat = () => {
      void handleOpenSelectionSideConversation(undefined, true);
    };
    // Keywords always include English and Chinese aliases so side/btw and the zh spellings
    // match in any locale. `/btw` is an equivalent alias of `/side` for different typing
    // habits; both are listed separately in the panel.
    const sharedKeywords = ["side", "btw", "side chat", "auxiliary", "辅助对话", "辅助", "侧边"];
    const description = intl.formatMessage({ id: "chat.slash.app.side.description" });
    return [
      { value: "side", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
      { value: "btw", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
    ].filter((command) => !cliSlashCommandNames.has(command.value));
  }, [
    cliSlashCommandNames,
    handleOpenSelectionSideConversation,
    intl,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    sessionId,
  ]);

  const chatLoadingBlockedByInteraction = hasChatLoadingBlockingInteraction(
    snapshot?.pendingInteractions ?? [],
  );
  const chatLoadingBlockedByActiveWork = hasChatLoadingBlockingActiveWork(
    snapshot?.control.activeWorks ?? [],
  );
  // Subagent detail conversation content stays read-only; file undo restores the workspace and is gated as its own capability.
  const workspaceFileRewindEnabled = !readOnly || allowWorkspaceFileRewind;
  // cancelBackgroundWork: the Cancel entry on spawn/background-task cards. Defined before
  // the rowContext memo so the memo can bind it (onOpenWorkflowRun is likewise pre-memo);
  // read-only panes never issue it (same rule as the submission guard).
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      if (!sessionId) return;
      void dispatchCommand("cancelBackgroundWork", { workId }, sessionId).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] cancelBackgroundWork rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // Dynamic-workflow rollout snapshot: a read-only store, fetched once in Root. While
  // unavailable, enabled is false and it is treated as a miss.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();

  // resumeWorkflowRun: the Resume action on tool-card footers. Same v4 command as the
  // detail page, without baseRevision; `name` feeds the resumed run completion notification subject.
  const handleResumeWorkflowRun = useCallback(
    (workId: string, name?: string) => {
      if (!sessionId) return;
      void dispatchCommand(
        "resumeWorkflowRun",
        { workId, ...(name ? { name } : {}) },
        sessionId,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] resumeWorkflowRun rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // amendWorkflowRunSettings: Configure on the run card. The ACK returns to the dialog - rejection reasons render there, not as a console warn. Same gate as Resume.
  const handleAmendWorkflowRunSettings = useCallback(
    (workId: string, change: WorkflowRunSettingsChange): Promise<CommandAck> =>
      dispatchCommand("amendWorkflowRunSettings", { workId, ...change }, sessionId),
    [dispatchCommand, sessionId],
  );
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(snapshot?.sessionId === sessionId ? snapshot?.config : undefined),
    [sessionId, snapshot?.config, snapshot?.sessionId],
  );

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      workspaceRemoteSessionId: remoteSessionId ?? undefined,
      modelSelectionView,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId: rootSessionId ?? sessionId,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      onNavigateToRow: handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx: handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession: onOpenSubagentSession ? handleOpenSubagentSession : undefined,
      onOpenPlanDetail: onOpenPlanDetail ? handleOpenPlanDetail : undefined,
      onOpenWorkflowRun: onOpenWorkflowRun ? handleOpenWorkflowRun : undefined,
      onOpenWorkflowActor: onOpenWorkflowActorSession ? handleOpenWorkflowActorSession : undefined,
      onOpenWorkflowWorkspace: onOpenWorkflowWorkspace ? handleOpenWorkflowWorkspace : undefined,
      onOpenWorkflowArtifact: onOpenWorkflowArtifact ? handleOpenWorkflowArtifact : undefined,
      onCancelBackgroundWork: readOnly ? undefined : handleCancelBackgroundWork,
      // The only supply point for Resume entering a session context; both the rollout and
      // read-only gates live in resolveWorkflowResumeHandler. Breaking here hides the buttons
      // on tool-card footers and summary cards alike.
      onResumeWorkflowRun: resolveWorkflowResumeHandler({
        readOnly,
        dynamicWorkflowEnabled,
        handler: handleResumeWorkflowRun,
      }),
      onAmendWorkflowRunSettings: sessionId
        ? resolveWorkflowResumeHandler({
            readOnly,
            dynamicWorkflowEnabled,
            handler: handleAmendWorkflowRunSettings,
          })
        : undefined,
      ...(workflowSessionModel === undefined ? {} : { workflowSessionModel }),
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowDraftByToolCallId,
      fetchFileChanges: handleFetchFileChanges,
      previewFileRewind: workspaceFileRewindEnabled ? handlePreviewFileRewind : undefined,
      applyFileRewind: workspaceFileRewindEnabled ? handleApplyFileRewind : undefined,
      readAttachment: attachmentRead,
      readAttachmentRange: attachmentReadRange,
    }),
    [
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      remoteSessionId,
      modelSelectionView,
      snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession,
      handleOpenSubagentSession,
      onOpenPlanDetail,
      handleOpenPlanDetail,
      onOpenWorkflowRun,
      handleOpenWorkflowRun,
      onOpenWorkflowActorSession,
      handleOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      handleOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      handleOpenWorkflowArtifact,
      readOnly,
      handleCancelBackgroundWork,
      dynamicWorkflowEnabled,
      handleResumeWorkflowRun,
      handleAmendWorkflowRunSettings,
      workflowSessionModel,
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowDraftByToolCallId,
      workspaceFileRewindEnabled,
      handleFetchFileChanges,
      handlePreviewFileRewind,
      handleApplyFileRewind,
      attachmentRead,
      attachmentReadRange,
    ],
  );

  // Draft-state v4 session prewarm (m5).
  // While the pane has no bound session, create a phase=draft session in the background as the
  // prewarm vehicle: config writes go through CAS, first send reuses it. The external binding
  // semantic is unchanged (shell activeTaskId stays null); the prewarm session is only the
  // pane internal effective subscription target.
  const { binding: prewarmBinding } = useDraftSessionPrewarm({
    enabled: sessionId === null && draftAgentStartupAllowed,
    workspaceKey,
    paneId,
    invalidationVersion: draftRuntimeInvalidationVersion,
    // SessionDataLayer comes from the workspace connection registry: panes/remounts on the
    // same transport generation share identity. A new sendCommand closure from a provider
    // wrapper remount must not be misread as a transport generation change.
    transportIdentity: layer,
    dispatchCommand,
    // The prewarm session consumes only the current Root Composer Draft one-shot initialization result.
    resolveInitialConfig: resolveInitialDraftConfig,
  });
  const prewarmBindingRef = useRef(prewarmBinding);
  prewarmBindingRef.current = prewarmBinding;
  const prewarmSessionId = prewarmBinding?.sessionId ?? null;
  // A runtime generation change (CUA Helper ready, liveness recovery, etc., triggering
  // workspace dispose) wipes a draft prewarm session that never persisted. Block sending while
  // it rebuilds, or attachments hang off a vanished session (sessionNotFound).
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: sessionId === null,
    onRuntimeRestart,
    onRuntimeLifecycle,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
  const ensureDraftPrewarmConfigBeforeSendRef = useRef<(targetSessionId: string) => Promise<void>>(
    async () => undefined,
  );
  const effectiveSessionId = sessionId ?? prewarmSessionId;
  const showModelChangeNotice = useCallback(
    (sourceModel: ModelSelectionSource | null, targetModel: ModelSelectionSource) => {
      // Bug: the draft has no real session yet and the model choice is already visible in
      // the composer; surfacing a switch toast here would misreport initialization or the
      // prewarm fallback as an in-session switch.
      if (sessionId === null) {
        return;
      }

      const fromProviderId = sourceModel?.provider ?? "";
      const fromModelId = sourceModel?.model ?? "";
      const providerChanged = Boolean(
        fromProviderId && targetModel.provider && fromProviderId !== targetModel.provider,
      );
      if (
        !fromModelId ||
        !targetModel.model ||
        (fromModelId === targetModel.model && !providerChanged)
      ) {
        return;
      }

      const fromProvider = resolveProviderLabel(fromProviderId, modelSelectionView);
      const toProvider = resolveProviderLabel(targetModel.provider, modelSelectionView);
      const fromModel = formatModelChangeLabel(fromProviderId, fromProvider, fromModelId, intl);
      const toModel = formatModelChangeLabel(
        targetModel.provider,
        toProvider,
        targetModel.model,
        intl,
      );
      toast(intl.formatMessage({ id: "chat.modelChangeNotice.changed" }, { fromModel, toModel }));
    },
    [intl, modelSelectionView, sessionId],
  );

  const handleOnlineModelTransition = useCallback(
    (
      subscribedSessionId: string,
      _store: SessionLease["store"],
      transition: SessionModelTransition,
    ) => {
      if (!focused || subscribedSessionId !== effectiveSessionId) return;
      // Bug: the auto-fallback notice and preference promotion were driven by online events
      // and arbitrary snapshot diffs respectively, letting recovery/historical projections
      // silently rewrite the next draft. Both now consume the same realtime online event after
      // the store deliveryKind dedup.
      showModelChangeNotice(transition.from, transition.to);
    },
    [
      effectiveSessionId,
      focused,
      provider,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  const onlineModelTransitionHandlerRef = useRef(handleOnlineModelTransition);
  useLayoutEffect(() => {
    onlineModelTransitionHandlerRef.current = handleOnlineModelTransition;
  }, [handleOnlineModelTransition]);

  const recoverableCommands = usePendingCommandRecovery({
    layer,
    sessionId: effectiveSessionId,
    snapshot,
    status: state.status,
    subscriptionId: state.subscriptionId,
    workspacePath,
    workspaceIdentity,
  });

  useEffect(() => {
    if (!effectiveSessionId) {
      setLease(null);
      return;
    }
    const nextLease = layer.acquire(effectiveSessionId);
    // Bug: acquire starts connect immediately and the activation may release the one-shot
    // online frame before the next effect runs; listen synchronously right after acquire
    // returns - snapshot replay cannot compensate.
    const offOnlineModelTransition = nextLease.store.onOnlineModelTransition((transition) => {
      onlineModelTransitionHandlerRef.current(effectiveSessionId, nextLease.store, transition);
    });
    setLease(nextLease);
    return () => {
      offOnlineModelTransition();
      nextLease.release();
    };
  }, [layer, effectiveSessionId]);

  useEffect(() => {
    if (!sessionId || !lease || snapshot?.sessionId !== sessionId) return;
    void lease.store.refreshPlans();
  }, [lease, sessionId, snapshot?.sessionId, state.planDirectoryRevision]);

  // Prewarm subscription failure (e.g. the in-memory session died with a CLI restart): drop the fallback-to-prewarm path, no error UI.
  useEffect(() => {
    if (sessionId === null && prewarmBinding && state.status === "error") {
      logger.warn("[v4-draft-prewarm] prewarm session subscription failed; dropping fallback", {
        prewarmSessionId: prewarmBinding.sessionId,
        lastError: state.lastError ?? null,
      });
      prewarmBinding.discard();
    }
  }, [prewarmBinding, sessionId, state.lastError, state.status]);

  useEffect(() => {
    if (
      !selectionSideChat ||
      state.status !== "error" ||
      !state.lastError?.includes("sessionNotFound")
    ) {
      return;
    }
    // Side panes are transient UI bindings; clear the tab when the persisted child is gone and rebuild from the parent on the next selection.
    onSelectionSideChatUnavailable?.();
  }, [onSelectionSideChatUnavailable, selectionSideChat, state.lastError, state.status]);

  const settleCurrentQueueInputs = useCallback((targetSessionId: string) => {
    const current = snapshotRef.current;
    if (!current || current.sessionId !== targetSessionId) return;
    for (const item of current.queue.items) {
      pendingCommandRegistry.settle(targetSessionId, item.sourceCommandId);
    }
  }, []);

  const dispatchSlashCommand = useCallback(
    async (
      command: V4VisibleSlashCommand,
      targetSessionId: string,
      baseRevision: number | undefined,
      heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
      expectedHeldQueueItemIds?: readonly string[],
      submission?: ComposerSubmissionConfig,
      onAccepted?: (messageId: string) => void,
    ): Promise<boolean | "confirmationRequired"> => {
      let type: CommandType | null = null;
      let payload: Record<string, unknown> = {};
      // compact is a queueable input command, no CAS; resumeGoal stays CAS.
      let withBaseRevision = false;
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      const compactExpectedToQueue =
        command.kind === "compact" &&
        currentRoutingMode !== undefined &&
        currentRoutingMode !== "startNow";
      switch (command.kind) {
        case "compact":
          type = "compact";
          break;
        case "sendGoalCommand":
          type = "sendGoalCommand";
          // A manual merge made /goal re-read the Composer after preparation, clobbering the
          // tier frozen at click time. Like sendText, keep this Submission; later menu edits
          // affect only the next send.
          if (!submission) return false;
          payload = {
            text: command.objective,
            displayText: command.displayText,
            ...submission,
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          };
          break;
        case "resumeGoal":
          type = "resumeGoal";
          withBaseRevision = true;
          break;
        case "sendMissionCommand":
          type = "sendMissionCommand";
          payload = { enabled: command.enabled };
          break;
        case "emptyGoal":
          logger.warn("[v4-pane] /goal needs target text");
          return true;
        case "unsupportedGoal":
          logger.warn(`[v4-pane] unsupported /goal ${command.action}`);
          return true;
        default:
          return false;
      }
      if (withBaseRevision && baseRevision === undefined) {
        logger.warn(`[v4-pane] slash ${command.kind} missing baseRevision`);
        return true;
      }
      const ack = await dispatchCommand(
        type,
        payload,
        targetSessionId,
        withBaseRevision ? baseRevision : undefined,
      );
      if (ack.status === "accepted") onAccepted?.(ack.commandId);
      if (command.kind === "sendMissionCommand" && ack.status === "accepted") {
        toast(
          intl.formatMessage({
            id: command.enabled ? "chat.mission.continuationOn" : "chat.mission.continuationOff",
          }),
        );
      }
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired";
      }
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(
          `[v4-pane] slash ${command.kind} rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
        );
        if (command.kind === "compact" && ack.reasonCode === "compactOperationLock") {
          toast(intl.formatMessage({ id: "chat.compact.duplicateBlocked" }));
        } else if (command.kind === "compact" && ack.reasonCode === "activeTurn") {
          // Compatibility with not-yet-upgraded CLIs: old ends still return activeTurn; never silently clear the command twice.
          toast(intl.formatMessage({ id: "chat.compact.runningBlocked" }));
        }
      } else if (command.kind === "compact" && compactExpectedToQueue) {
        toast(intl.formatMessage({ id: "chat.compact.queued" }));
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
      return true;
    },
    [dispatchCommand, intl, settleCurrentQueueInputs],
  );

  const dispatchSendTextAfterConfig = useCallback(
    async (
      text: string,
      options: ConversationComposerSendOptions | undefined,
      createSourceAtSend: SessionCreateSource,
    ) => {
      let onAcceptedSelection: (() => void) | undefined;
      const dispatchSubmissionCommand = async (...args: Parameters<typeof dispatchCommand>) => {
        const ack = await dispatchCommand(...args);
        // Write back the recommended choice at the original accepted boundary, before the new session draft handoff; failures never change user intent.
        if (ack.status === "accepted" && submissionConfigFromCommand(args[0], args[1]))
          onAcceptedSelection?.();
        return ack;
      };
      // Frozen before the barrier; while waiting for config/attachments, never re-read the Composer or Session.
      let submission = options?.submission ?? null;
      const heldQueueDisposition = options?.heldQueueDisposition;
      const expectedHeldQueueItemIds = options?.expectedHeldQueueItemIds;
      const readyAttachments = options?.attachments ?? [];
      const sharedContextRefs = options?.sharedContextRefs;
      const contextAttachmentCount = options?.contextAttachmentCount ?? 0;
      let slashCommand = parseV4VisibleSlashCommand(text, readyAttachments, {
        contextAttachmentCount,
      });

      // The first `/plan` cut consumes plain text only. Reject attachments/context before
      // provider readiness and any command admission, or a raw `/plan ...` degrades into a
      // plain prompt, bypassing the product boundary and wiping the draft.
      if (slashCommand?.kind === "unsupportedPlanShortcut") {
        toast(intl.formatMessage({ id: "chat.plan.attachmentsBlocked" }));
        return "blocked" as const;
      }

      // A bare /plan behaves like the mode menu: edits the current Composer only, never rewrites Agent execution state early.
      if (slashCommand?.kind === "planShortcut") {
        handleDraftSwitchMode("plan");
        if (submission) submission = { ...submission, planEnabled: true };
        if (!slashCommand.task) return "sent" as const;
      }

      if (!(await ensureDraftModelReadyForSend())) {
        return "blocked" as const;
      }

      let effectiveText = text;
      if (slashCommand?.kind === "planShortcut") {
        // The command pins this Submission mode explicitly; ordering against another CAS must not be relied on.
        effectiveText = slashCommand.task;
        // The command only sets the shortcut; the follow-up must be a plain sendText, never the goal/compact command branch.
        slashCommand = null;
      }
      // The user may switch tasks or start another draft while create/send ACKs are in
      // flight. placement must bind to the stable identity captured at send start; never read
      // the current workspace draft inside the completion callback.
      const groupedDraftTaskAtSend =
        sessionId === null
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .groupedDraftTask
          : null;
      const selectionSideSlashCommand =
        sessionId && (appSlashCommands?.length ?? 0) > 0
          ? parseSelectionSideSlashCommand(text, readyAttachments, {
              contextAttachmentCount,
              enabledCommandNames: availableSelectionSideSlashCommandNames,
            })
          : null;
      if (sessionId && selectionSideSlashCommand) {
        const created = await handleOpenSelectionSideConversationWithPrompt(
          selectionSideSlashCommand.text,
          options?.telemetrySeed,
        );
        return created ? ("sent" as const) : ("blocked" as const);
      }
      if (
        submission?.planEnabled &&
        slashCommand !== null &&
        (slashCommand.kind === "sendGoalCommand" ||
          slashCommand.kind === "resumeGoal" ||
          slashCommand.kind === "emptyGoal" ||
          slashCommand.kind === "unsupportedGoal")
      ) {
        // Plan mode cannot create, update, or resume goals. Reject before draft promotion /
        // command dispatch, otherwise the composer clears user input believing the send
        // succeeded even when the CLI later rejects.
        toast(intl.formatMessage({ id: "chat.goal.planModeBlocked" }));
        return "blocked" as const;
      }
      if (!submission) {
        logger.warn("[v4-pane] Submission missing model or mode config");
        return "blocked" as const;
      }
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      if (
        currentRoutingMode === "choice" &&
        !heldQueueDisposition &&
        (slashCommand === null || slashCommand.kind === "sendGoalCommand")
      ) {
        // The UI choice applies only to plain input and /goal <new goal>; /compact appends to
        // the paused queue directly, and control commands such as resumeGoal must not be
        // intercepted by the send-confirm dialog.
        return "confirmationRequired" as const;
      }
      if (slashCommand === null || slashCommand.kind === "sendGoalCommand") {
        const original = submission.modelSelection;
        const chosen = await recommendStartPlan(original);
        if (!chosen) return "blocked" as const;
        if (chosen !== original) {
          onAcceptedSelection = captureAcceptedModelSelection(chosen, original);
          submission = { ...submission, modelSelection: chosen };
        }
      }
      const prewarmTargetBeforeSend =
        sessionId === null ? prewarmBindingRef.current?.sessionId : null;
      if (prewarmTargetBeforeSend) {
        // The barrier only covers already-queued commands; if the prewarm session/snapshot is
        // not ready at click time, the command may have had no target. Re-sync the draft
        // authoritative config once more before the first send binds the concrete prewarm
        // session, so UI values and runtime values never diverge.
        await ensureDraftPrewarmConfigBeforeSendRef.current(prewarmTargetBeforeSend);
      }
      // Slash commands win: an existing session consumes them directly; a draft first-send
      // /goal creates the empty session first, then sends. With attachments or web-element
      // context, do not consume as native v4 commands (compact/goal have no attachment
      // semantics) - pass through via sendText.
      if (sessionId && slashCommand) {
        const consumed = await dispatchSlashCommand(
          slashCommand,
          sessionId,
          snapshotRef.current?.revision,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          onAcceptedSelection?.();
          return;
        }
      }
      const draftSlashCommand =
        slashCommand?.kind === "sendGoalCommand" ||
        slashCommand?.kind === "resumeGoal" ||
        slashCommand?.kind === "emptyGoal" ||
        slashCommand?.kind === "unsupportedGoal"
          ? slashCommand
          : null;
      if (!sessionId && draftSlashCommand) {
        if (
          draftSlashCommand.kind === "emptyGoal" ||
          draftSlashCommand.kind === "unsupportedGoal"
        ) {
          await dispatchSlashCommand(
            draftSlashCommand,
            prewarmBindingRef.current?.sessionId ?? "__draft__",
            undefined,
            heldQueueDisposition,
            expectedHeldQueueItemIds,
            submission,
          );
          return;
        }
        const prewarm = prewarmBindingRef.current;
        if (prewarm?.beginPromotion()) {
          try {
            const consumed = await dispatchSlashCommand(
              draftSlashCommand,
              prewarm.sessionId,
              0,
              heldQueueDisposition,
              expectedHeldQueueItemIds,
              submission,
              (messageId) => reportDraftCreated(prewarm.sessionId, createSourceAtSend, messageId),
            );
            if (consumed === "confirmationRequired") return consumed;
            if (consumed) {
              onAcceptedSelection?.();
              prewarm.promote();
              handleDraftSessionCreated(
                prewarm.sessionId,
                groupedDraftTaskAtSend,
                createSourceAtSend,
              );
              return;
            }
          } catch (error) {
            if (isProviderNotReadyError(error)) throw error;
            // Same as a plain first send: a transport error after the slash command is
            // written leaves the admission result unknown; never discard and re-run on another
            // session/command.
            logger.warn(
              `[v4-draft-prewarm] prewarm slash result unknown; keeping original command, no auto-resend: ${String(error)}`,
            );
            throw error;
          }
        }
        const draftConfigPayload = buildDraftCreateConfigPayload(
          { ...draftConfigRef.current, modelSelection: submission.modelSelection },
          appFollowupMode,
        );
        const createAck = await dispatchSubmissionCommand(
          "createSession",
          { workspaceId: workspaceKey, ...draftConfigPayload },
          null,
        );
        if (createAck.status !== "accepted") {
          throw new Error(createAck.reasonCode ?? "createSession rejected");
        }
        const createResult = createAck.result;
        if (!createResult || createResult.type !== "createSession") {
          throw new Error("createSession returned no sessionId");
        }
        const newSessionId = createResult.sessionId;
        handleDraftSessionCreated(newSessionId, groupedDraftTaskAtSend, createSourceAtSend);
        await dispatchSlashCommand(
          draftSlashCommand,
          newSessionId,
          0,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
          (messageId) => reportDraftCreated(newSessionId, createSourceAtSend, messageId),
        );
        return;
      }
      if (!sessionId) {
        // Draft attachments already pre-uploaded in the composer bound to the prewarm
        // session. Commit the ready refs only; never start an upload inside the send click.
        const prewarm = prewarmBindingRef.current;
        if (prewarm?.beginPromotion()) {
          try {
            const ack = await dispatchSubmissionCommand(
              "sendText",
              {
                text: effectiveText,
                ...submission,
                ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
                ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
              },
              prewarm.sessionId,
              undefined,
              undefined,
              options?.telemetrySeed,
            );
            if (ack.status === "accepted") {
              prewarm.promote();
              handleDraftSessionCreated(
                prewarm.sessionId,
                groupedDraftTaskAtSend,
                createSourceAtSend,
                ack.commandId,
              );
              return;
            }
            // A failed ACK can also land after the runtime started but the TurnStarted
            // projection commit timed out; model/tool side effects cannot be rolled back via
            // the failed ACK, so never auto-rerun under a new command.
            logger.warn(
              `[v4-draft-prewarm] prewarm first send not accepted (${ack.reasonCode ?? ack.status}); no auto-resend`,
            );
            throw new Error(ack.reasonCode ?? "prewarm first send not accepted");
          } catch (error) {
            if (isProviderNotReadyError(error)) throw error;
            if (readyAttachments.length > 0) throw error;
            // Bug: a transport error does not prove the Agent never admitted the input, and
            // a failed ACK may also land after runtime start and tool side effects. The old
            // behavior discarded the prewarm session and auto-ran createSession(firstInput),
            // running the same submission twice. Keep the pending lifecycle and command
            // reconciliation clues; the composer keeps the draft on error. No automatic resend
            // under a new command.
            logger.warn(
              `[v4-draft-prewarm] prewarm first send unconfirmed; keeping original command, no auto-resend: ${String(error)}`,
            );
            throw error;
          }
        }
        // Fallback: with no prewarm (create failed/dropped), create the session inline. The
        // draft-chosen config rides along in createSession (the CLI merges the request with
        // runtime defaults, so the first send already uses the draft choice).
        // With a prewarm projection the fallback must take the Agent current config as base;
        // only with no projection ever received may the frozen initialization tuple be used,
        // else a provider fallback writes the stale localStorage model back.
        const draftConfigPayload = buildDraftCreateConfigPayload(
          { ...draftConfigRef.current, modelSelection: submission.modelSelection },
          appFollowupMode,
        );
        if (readyAttachments.length === 0 && !sharedContextRefs?.length) {
          const ack = await dispatchSubmissionCommand(
            "createSession",
            {
              workspaceId: workspaceKey,
              firstInput: { text: effectiveText, ...submission },
              ...draftConfigPayload,
            },
            null,
            undefined,
            undefined,
            options?.telemetrySeed,
            undefined,
            createSourceAtSend,
          );
          if (ack.status !== "accepted") {
            throw new Error(ack.reasonCode ?? "createSession rejected");
          }
          const result = ack.result;
          if (!result || result.type !== "createSession") {
            throw new Error("createSession returned no sessionId");
          }
          handleDraftSessionCreated(
            result.sessionId,
            groupedDraftTaskAtSend,
            createSourceAtSend,
            ack.commandId,
          );
          return;
        }
        // A local desktop localPath is zero-copy ready, no attachment transaction needed; the
        // prewarm session may still not have returned within that tiny window. Create the empty
        // session first, then commit the ready refs: no upload inside the send click, and
        // non-ready attachments still cannot bypass the composer gate.
        const createAck = await dispatchSubmissionCommand(
          "createSession",
          { workspaceId: workspaceKey, ...draftConfigPayload },
          null,
        );
        if (createAck.status !== "accepted") {
          throw new Error(createAck.reasonCode ?? "createSession rejected");
        }
        const createResult = createAck.result;
        if (!createResult || createResult.type !== "createSession") {
          throw new Error("createSession returned no sessionId");
        }
        const newSessionId = createResult.sessionId;
        const sendAck = await dispatchSubmissionCommand(
          "sendText",
          {
            text: effectiveText,
            attachments: readyAttachments,
            ...submission,
            ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
          },
          newSessionId,
          undefined,
          undefined,
          options?.telemetrySeed,
        );
        if (sendAck.status !== "accepted") {
          throw new Error(sendAck.reasonCode ?? "sendText rejected");
        }
        handleDraftSessionCreated(
          newSessionId,
          groupedDraftTaskAtSend,
          createSourceAtSend,
          sendAck.commandId,
        );
        return;
      }
      // Attachment refs already settled in the composer pre-upload state machine.
      const ack = await dispatchSubmissionCommand(
        "sendText",
        {
          text: effectiveText,
          ...submission,
          ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
          ...(options?.requestedDelivery
            ? {
                // Send-now used to project the QueueItem first and then wait for a second
                // sendQueuedNow, leaking the queue intermediate state and delaying the input
                // clear. The CLI now does an atomic stop+start; the accepted ACK is the
                // composer-clear boundary.
                requestedDelivery: options.requestedDelivery,
              }
            : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
        },
        sessionId,
        undefined,
        undefined,
        options?.telemetrySeed,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired" as const;
      }
      if (ack.status !== "accepted") {
        throw new Error(ack.reasonCode ?? "sendText rejected");
      }
      if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(sessionId);
      }
    },
    [
      dispatchCommand,
      recommendStartPlan,
      captureAcceptedModelSelection,
      dispatchSlashCommand,
      ensureDraftModelReadyForSend,
      availableSelectionSideSlashCommandNames,
      appSlashCommands,
      appFollowupMode,
      handleDraftSessionCreated,
      reportDraftCreated,
      handleDraftSwitchMode,
      handleOpenSelectionSideConversationWithPrompt,
      intl,
      lease,
      resolveInitialDraftConfig,
      createSubmissionFromComposer,
      sessionId,
      settleCurrentQueueInputs,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  const dispatchSendText = useCallback(
    (text: string, options?: ConversationComposerSendOptions) => {
      const createSource = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource;
      const submissionOptions = {
        ...options,
        submission:
          options?.submission === undefined ? createSubmissionFromComposer() : options.submission,
      };
      // followupMode still syncs via Session CAS; model and mode are encapsulated in the
      // Submission, no longer relying on cross-command ordering (config first, sendText after).
      return configCommandBarrier.enqueue(async () => {
        try {
          return await dispatchSendTextAfterConfig(text, submissionOptions, createSource);
        } catch (error) {
          if (sessionId === null && isProviderNotReadyError(error)) {
            // The registry can still be invalidated between the UI precheck and Host
            // getClient. On a lost race, converge to the same normal waiting state - no
            // exceptional send path, no composer clear.
            markDraftProviderNotReady();
            return "blocked" as const;
          }
          throw error;
        }
      });
    },
    [
      configCommandBarrier,
      createSubmissionFromComposer,
      dispatchSendTextAfterConfig,
      markDraftProviderNotReady,
      sessionId,
      workspacePath,
      workspaceIdentity,
    ],
  );

  const focusTimelineToLatest = useCallback(() => {
    timelineScrollToBottomRef.current?.();
  }, []);

  const handleSendText = useCallback(
    async (
      text: string,
      options?: ConversationComposerSendOptions,
    ): Promise<ConversationComposerSendResult> => {
      // Freeze this submission admission expectation before sending: by the time the command
      // ACK returns, the projection may already be running, and the updated enqueue mode must
      // not be used to infer whether the just-sent prompt was meant to send immediately.
      const shouldFocusLatest = shouldFocusTimelineAfterComposerSend({
        draftMode: sessionId === null,
        inputRoutingMode: snapshotRef.current?.inputRouting.mode ?? null,
        heldQueueDisposition: options?.heldQueueDisposition,
      });
      try {
        const sendResult = await dispatchSendText(text, options);
        if (sendResult === "blocked" || sendResult === "confirmationRequired") {
          return sendResult;
        }
        setSendSubmissionError(null);
        if (shouldFocusLatest) {
          focusTimelineToLatest();
        }
        return "sent";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const runtimeModelUnavailable = detail.includes("provider.notInRegistry");
        // A pre-send switchModelConfig failure only throws back into the Composer, which
        // keeps the draft and just logs - no snapshot.control.lastError, so to the user the
        // click did nothing. Funnel pre-admission failures into a pane-local error banner; the
        // desktop-continuous / web-remote-replayable send/resume semantics are untouched and
        // the Composer keeps the draft via its usual path.
        setSendSubmissionError({
          code: runtimeModelUnavailable ? "ZCODE_RUNTIME_MODEL_UNAVAILABLE" : "SEND_FAILED",
          message: runtimeModelUnavailable
            ? detail
            : intl.formatMessage({ id: "chat.error.sendFailed" }),
          detail,
          ...(sessionId ? { taskId: sessionId } : {}),
        });
        throw error;
      }
    },
    [dispatchSendText, focusTimelineToLatest, intl, sessionId],
  );

  const handleComposerDraftStateChange = useCallback(
    (state: { hasContent: boolean; busy: boolean }) => {
      composerDraftStateRef.current = state;
    },
    [],
  );
  const clearQueueEditOperation = useCallback(() => {
    queueEditOperationRef.current = null;
    setQueueEditOperation(null);
  }, []);
  const handleComposerRestoreApplied = useCallback(
    (requestId: number) => {
      setComposerRestoreRequest((current) => (current?.requestId === requestId ? null : current));
      clearQueueEditOperation();
    },
    [clearQueueEditOperation],
  );

  const handleFork = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // forkAssistant is a CAS command: baseRevision comes from the current projection revision.
      void dispatchCommand(
        "forkAssistant",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          logger.warn(`[v4-pane] fork rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          return;
        }
        if (ack.result?.type === "forkAssistant") {
          // Switch in place to the child session (same selection path as creating a session).
          onSessionCreated?.(ack.result.sessionId);
        }
      });
    },
    [dispatchCommand, onSessionCreated, sessionId],
  );

  const handleEdit = useCallback(
    async (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
      workspaceMode: "preserve" | "rewind" = "preserve",
    ) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      if (!newText.trim() && (!attachments || attachments.length === 0)) {
        logger.warn("[v4-pane] edit skipped: inline edit empty and no attachments");
        return false;
      }
      const ack = await dispatchCommand(
        "editUserQuery",
        {
          target,
          newText,
          workspaceMode,
          // Omitting editUserQuery attachments keeps the canonical originals; only an
          // explicit [] lets the CLI tell user-deleted-all from caller-left-attachments-alone.
          ...(attachments ? { attachments: [...attachments] } : {}),
        },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] edit rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
        return false;
      }
      // The fork ACK exists only for legacy protocol decode; the new edit never navigates to the child. blocked is handled by the inline conflict dialog.
      return ack;
    },
    [dispatchCommand, sessionId],
  );

  const dispatchRetryTurn = useCallback(
    async (target: ConversationRowTarget): Promise<CommandAck> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) {
        throw new Error("retryTurn missing the current session projection");
      }
      // retryTurn is a CAS command: baseRevision comes from the current projection revision.
      return dispatchCommand(
        "retryTurn",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleRetry = useCallback(
    (target: ConversationRowTarget) => {
      void dispatchRetryTurn(target)
        .then((ack) => {
          if (ack.status !== "accepted") {
            logger.warn(`[v4-pane] retry rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        })
        .catch((error: unknown) => {
          logger.warn("[v4-pane] retry submit failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [dispatchRetryTurn],
  );

  const handleAssistantFeedback = useCallback(
    async (
      target: ConversationRowTarget,
      feedback: "like" | "dislike" | null,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      const ack = await dispatchCommand(
        "setAssistantFeedback",
        { target, feedback },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      const accepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!accepted) {
        logger.warn(`[v4-pane] assistant feedback rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
      return accepted;
    },
    [dispatchCommand, sessionId],
  );

  const handleDeleteQueueItem = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      const sourceCommandId = current.queue.items.find(
        (item) => item.queueItemId === queueItemId,
      )?.sourceCommandId;
      void dispatchCommand("deleteQueueItem", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(
              `[v4-pane] deleteQueueItem rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
            );
            return;
          }
          if (sourceCommandId) pendingCommandRegistry.settle(sessionId, sourceCommandId);
        },
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleEditQueueItem = useCallback(
    async (queueItemId: string): Promise<void> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null || queueEditOperationRef.current) return;
      if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
        toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
        return;
      }
      const restoreTarget = resolveQueuedComposerRestore(current, queueItemId);
      if (!restoreTarget) {
        logger.warn(
          `[v4-pane] queue edit-withdraw skipped: queue item missing or not editable ${queueItemId}`,
        );
        return;
      }
      const operation = { queueItemId, sessionId, workspaceKey };
      queueEditOperationRef.current = operation;
      setQueueEditOperation(operation);
      try {
        const ack = await dispatchCommand(
          "deleteQueueItem",
          { queueItemId },
          sessionId,
          restoreTarget.baseRevision,
        );
        if (!shouldRestoreQueuedComposerFromAck(ack.status)) {
          logger.warn(
            `[v4-pane] queue edit-withdraw rejected: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
          toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
          clearQueueEditOperation();
          return;
        }
        pendingCommandRegistry.settle(sessionId, restoreTarget.sourceCommandId);
        const currentBinding = composerBindingRef.current;
        if (
          currentBinding.sessionId !== sessionId ||
          currentBinding.workspaceKey !== workspaceKey
        ) {
          // The pane may have switched tasks by the time the delete ACK returns; the old
          // direct setText wrote the old session queue payload into the new task. The
          // authoritative delete stands, but the local restore is abandoned.
          logger.warn("[v4-pane] queue edit-withdraw not restored: composer switched before ACK", {
            queueItemId,
            sessionId,
            workspaceKey,
          });
          clearQueueEditOperation();
          return;
        }
        setComposerRestoreRequest({
          requestId: nextComposerRestoreRequestIdRef.current++,
          sessionId,
          workspaceKey,
          inputKind: restoreTarget.inputKind,
          text: restoreTarget.text,
          attachments: restoreTarget.attachments,
          config: restoreTarget.config,
        });
      } catch (error) {
        logger.warn("[v4-pane] queue edit-withdraw command failed", error);
        toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
        clearQueueEditOperation();
      }
    },
    [clearQueueEditOperation, dispatchCommand, intl, sessionId, workspaceKey],
  );

  const handleSendQueuedNow = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // An explicit send-now click is visually equivalent to scroll-to-bottom; the command
      // reserve/stop/promote lifecycle stays with the CLI - keep scroll state out of the
      // protocol.
      focusTimelineToLatest();
      void dispatchCommand("sendQueuedNow", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] sendQueuedNow rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        },
      );
    },
    [dispatchCommand, focusTimelineToLatest, sessionId],
  );

  const handleReorderQueueItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      void dispatchCommand(
        "reorderQueueItem",
        { queueItemId, beforeQueueItemId },
        sessionId,
        current.revision,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] reorderQueueItem rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  const handleResumeQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!sessionId || !current || current.queue.autoDrain || current.queue.items.length === 0) {
      return;
    }
    const ack = await dispatchCommand(
      "setAutoDrain",
      { autoDrain: true },
      sessionId,
      current.revision,
    );
    if (ack.status !== "accepted" && ack.status !== "noop") {
      logger.warn(`[v4-pane] resume paused queue rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
    }
  }, [dispatchCommand, sessionId]);

  // Stale-retry for config-plane CAS commands. Across model -> reasoning depth -> mode, the
  // previous command revision bump may not have echoed into the local projection yet, and the
  // local revision would be judged stale. The stale ack carries revisionAtDecision (the CLI
  // current revision); retrying with it converges (bounded to 3 attempts).
  // m5: target = the effective session (bound session or draft prewarm session); the projection
  // must be same-origin with the target (snapshot.sessionId check) so the revision is never
  // taken from the wrong side of a prewarm switch.
  const dispatchConfigCas = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      options?: { initialBaseRevision?: number; targetSessionId?: string },
    ): Promise<CommandAck | null> => {
      const targetSessionId =
        options?.targetSessionId ?? sessionId ?? prewarmBindingRef.current?.sessionId ?? null;
      const current = snapshotRef.current;
      if (!targetSessionId) {
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "skipped",
          reasonCode: "no-session",
          at: Date.now(),
        });
        return null;
      }
      // When the draft prewarm session exists but its snapshot is not yet projected, the old
      // code skipped the config CAS and the first send inherited the runtime build default.
      // CAS already retries on stale-revision replies, so starting from 0 without a snapshot
      // still converges deterministically - not-yet-projected is not success.
      let baseRevision =
        options?.initialBaseRevision ??
        (current?.sessionId === targetSessionId ? current.revision : 0);
      let lastAck: CommandAck | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const ack = await dispatchCommand(type, payload, targetSessionId, baseRevision);
          lastAck = ack;
          if (ack.status === "stale") {
            baseRevision = ack.revisionAtDecision;
            continue;
          }
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] ${type} rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
          return ack;
        }
        logger.warn(`[v4-pane] ${type} stale too many times; giving up retry`);
        return lastAck;
      } catch (error) {
        if (isProviderNotReadyError(error)) {
          // Once the config CAS swallows a provider-readiness race as null, the first send is
          // rewritten to missing-ack and the draft page can no longer recover into the model
          // setup flow. Deterministic startup gates must propagate verbatim.
          throw error;
        }
        // Production renderer logs are off; errors also go into the ack debug buffer so nothing vanishes silently.
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "dispatch-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        logger.warn(`[v4-pane] ${type} failed: ${String(error)}`);
        return null;
      }
    },
    [dispatchCommand, sessionId],
  );
  const telemetryDraftConfig = draftConfig;
  const ensureDraftPrewarmConfigBeforeSend = useCallback(
    async (targetSessionId: string) => {
      // followupMode remains a Session behavior setting; model and mode belong to this
      // Submission and are committed atomically with sendText - never rewrite the shared
      // Session via CAS before sending.
      const desiredConfig = buildDraftCreateConfigPayload(
        draftConfigRef.current,
        appFollowupMode,
      ).config;
      if (!desiredConfig) return;
      const projectedConfig =
        snapshotRef.current?.sessionId === targetSessionId ? snapshotRef.current.config : null;

      const requireAcceptedConfigAck = (type: CommandType, ack: CommandAck | null) => {
        if (
          ack &&
          (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate")
        ) {
          return;
        }
        throw new Error(
          `${type} did not converge before first send: ${ack?.status ?? "missing-ack"} ${ack?.reasonCode ?? ""}`,
        );
      };

      if (
        desiredConfig.followupMode &&
        desiredConfig.followupMode !== projectedConfig?.followupMode
      ) {
        const ack = await dispatchConfigCas(
          "setFollowupMode",
          { mode: desiredConfig.followupMode },
          { targetSessionId },
        );
        requireAcceptedConfigAck("setFollowupMode", ack);
      }
    },
    [appFollowupMode, dispatchConfigCas, draftConfigRef],
  );
  ensureDraftPrewarmConfigBeforeSendRef.current = ensureDraftPrewarmConfigBeforeSend;

  const followupModeSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const targetSessionId = sessionId ?? prewarmSessionId;
    if (!targetSessionId || !appFollowupMode || snapshotRevision === null) return;
    if (snapshotSessionId !== targetSessionId) return;
    if (snapshotFollowupMode === appFollowupMode) {
      followupModeSyncKeyRef.current = `${targetSessionId}:${appFollowupMode}:synced`;
      return;
    }
    const syncKey = `${targetSessionId}:${appFollowupMode}:${snapshotRevision}`;
    if (followupModeSyncKeyRef.current === syncKey) return;
    followupModeSyncKeyRef.current = syncKey;
    // The user source of truth for interaction behavior is the app settings page; the v4
    // projection followupMode is just the CLI/runtime sync result. Re-emit changes as the
    // existing setFollowupMode command so the composer does not grow a second synonymous
    // follow-up-mode entry and fork upstream/downstream state.
    void configCommandBarrier.enqueue(() =>
      dispatchConfigCas("setFollowupMode", { mode: appFollowupMode }),
    );
  }, [
    appFollowupMode,
    configCommandBarrier,
    dispatchConfigCas,
    prewarmSessionId,
    sessionId,
    snapshotFollowupMode,
    snapshotRevision,
    snapshotSessionId,
  ]);

  // A Composer choice means the next submission. Clicking updates renderer intent only; the
  // Session Selection is updated by CLI/Core once the Submission actually starts (Guide on the
  // next model-step).
  const handleSelectModel = useCallback(
    (modelProvider: string, model: string, sourceModel: ModelSelectionSource | null) => {
      const resolvedProvider =
        modelProvider || draftConfigRef.current.provider || sourceModel?.provider || "";
      logger.debug("[v4-pane] onSelectModel", {
        modelProvider: resolvedProvider,
        model,
        branch: "composer-submission-intent",
      });
      handleDraftSelectModel(resolvedProvider, model);
    },
    [draftConfigRef, handleDraftSelectModel],
  );

  const handleSelectThought = useCallback(
    (thought: string, _modelContext: { provider: string; model: string }) => {
      handleDraftSelectThought(thought);
    },
    [handleDraftSelectThought],
  );

  const handleRecoverCustomModelSelection = useCallback(
    async (value: string, sourceModel: ModelSelectionSource | null) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.providerId) {
        return;
      }
      const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
      let modelValue = value;
      if (!decoded.modelName) {
        const fallbackModel =
          modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )?.models[0]?.modelId ?? (modelSelectionView ? null : undefined);
        if (!fallbackModel) {
          logger.warn("[v4-pane] custom provider restore skipped: provider has no models", {
            customProviderId: decoded.providerId,
            workspacePath,
          });
          return;
        }
        modelValue = encodeCustomModelValue(decoded.providerId, fallbackModel);
      }
      const modelSelection = parseModelPickerValue(modelValue);
      // Bug: a custom-provider choice carrying a configOptions error bypasses plain
      // onSelectModel; bound tasks reuse the same prompt entry, and draft state is silenced
      // centrally by that entry.
      showModelChangeNotice(sourceModel, {
        provider: modelSelection.providerId,
        model: modelSelection.modelId,
      });
      const store = useZCodeSessionStore.getState();
      store.setModelSelectionResolution(
        workspacePath,
        {
          selectedSupplierKey: buildCustomSupplierKey(decoded.providerId),
          isGhostSupplier: false,
          supplierMismatchReason: null,
        },
        workspaceIdentity,
      );
      store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
      logger.info("[v4-pane] configOptions error custom provider recovery start", {
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });

      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          bumpRuntimeEpoch: true,
        });

        const prepareResult = await prepareWorkspaceWithZCodeSessionService({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          zcodeSessionService,
        });
        handleDraftSelectModel(modelSelection.providerId, modelSelection.modelId);
        store.setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        store.setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
        logger.info("[v4-pane] configOptions error custom provider recovery done", {
          configOptionsCount: prepareResult.configOptions?.length ?? 0,
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
      } catch (error) {
        store.setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn("[v4-pane] configOptions error custom provider recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
        throw error;
      }
    },
    [
      provider,
      handleDraftSelectModel,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspacePath,
      zcodeSessionService,
      zcodeTaskService,
    ],
  );

  // Like the model, the mode belongs to the next Submission; selecting only updates the Composer.
  const handleSwitchMode = useCallback(
    (mode: string) => {
      handleDraftSwitchMode(mode);
    },
    [handleDraftSwitchMode],
  );

  // Compact entry of the context-usage panel (command text "/compact", reusing the slash parse path).
  const handleSendCompressionCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      const parsed = parseV4VisibleSlashCommand(command);
      if (!parsed) return;
      void dispatchSlashCommand(parsed, sessionId, snapshotRef.current?.revision, undefined);
    },
    [dispatchSlashCommand, sessionId],
  );

  // Debugging accidental stops requires telling button from Esc; plain info is off in production, so use the lifecycle logger.
  const handleStop = useCallback(
    (source: "button" | "escape") => {
      const current = snapshotRef.current;
      if (!sessionId || !current?.control.canStop) {
        logger.lifecycle.info("[v4-pane] stop skipped (nothing running to stop)", {
          source,
          sessionId: sessionId ?? "",
        });
        return;
      }
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      logger.lifecycle.info("[v4-pane] stop command sent", {
        source,
        sessionId,
        foregroundExecutionId: foregroundExecutionId ?? "",
      });
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        sessionId,
      ).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] stop failed: ${String(error)}`);
      });
    },
    [dispatchCommand, sessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    void dispatchCommand("pauseGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] pauseGoal rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchCommand("resumeGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] resumeGoal rejected: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // Composer parity: Esc -> stop (preserves the old useChatViewEffects escape-stops-
  // generation semantics: skip when the event path includes a dialog / defaultPrevented; with
  // a mention/slash popover open, Lexical already preventDefaults and this handler yields).
  // Focused pane only: dangerous actions such as stop always target a concrete pane, and
  // shortcuts follow the focused pane.
  useEffect(() => {
    if (!focused || readOnly) return;
    if (!sessionId || !snapshot?.control.canStop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (shouldIgnoreEscapeForStopGeneration(event)) return;
      event.preventDefault();
      handleStop("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focused, handleStop, readOnly, sessionId, snapshot?.control.canStop]);

  // handleStop takes a source (two call sites: button / escape), but ConversationComposer is
  // memoized: inlining onStop={() => handleStop("button")} changes the prop every render,
  // defeating the memo - and the composer is exactly the component that re-renders per
  // keystroke. Pin the button-bound reference; keep the two-entry handleStop design.
  const handleStopFromButton = useCallback(() => handleStop("button"), [handleStop]);

  const handleRetrySubscribe = useCallback(() => {
    void lease?.store.retry();
  }, [lease]);

  // loadOlder trigger (auto-prefetch near the top). Single-flight inside the store.
  const handleLoadOlder = useCallback(() => {
    return lease?.store.loadOlder();
  }, [lease]);

  const handleLoadAllOlder = useCallback(() => {
    return lease
      ? lease.store.loadAllOlder()
      : Promise.resolve({
          status: "stale" as const,
          logEpoch: snapshot?.logEpoch ?? "unknown",
        });
  }, [lease, snapshot?.logEpoch]);

  useEffect(() => {
    if (!shareActive || !sessionId || !hasOlderRows(snapshot)) return;
    const key = `${sessionId}:${snapshot?.logEpoch ?? "unknown"}`;
    if (shareHydratedSessionRef.current === key) return;
    shareHydratedSessionRef.current = key;
    void handleLoadAllOlder().catch((error) => {
      shareHydratedSessionRef.current = null;
      logger.warn("[conversation-share] failed to backfill the share directory", { error });
    });
  }, [handleLoadAllOlder, sessionId, shareActive, snapshot]);

  useEffect(() => {
    if (
      !sessionId ||
      !lease?.store ||
      !shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)
    ) {
      return;
    }
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    const cursorKey = `${sessionId}:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (autoLoadIncompleteTurnCursorRef.current === cursorKey) return;
    autoLoadIncompleteTurnCursorRef.current = cursorKey;

    // snapshotTailWindowRows truncates by row and can leave a long turn header/user rows
    // outside the window. The old UI loaded older only on a scroll event reaching the top;
    // with less than a screen of content or scrollTop already 0, no event ever fires, so only
    // the assistant renders until the user scrolls down and back up. Once the first turn lacks
    // a header, backfill window by window immediately; cursor dedup keeps the effect from
    // spinning on empty ranges or failures.
    logger.debug("[v4-pane] cold snapshot first turn incomplete; backfilling older rows", {
      firstRowId,
      sessionId,
      turnId: snapshot?.rows.window[0]?.turnId,
    });
    void lease.store.loadOlder();
  }, [lease, sessionId, snapshot, state.loadingOlder, state.subscriptionId]);

  // The subscribe ACK marks the store live before the initial snapshot arrives; keying on
  // status alone would enable the editor during the projection-less window. A real session must
  // wait for its first snapshot before accepting input.
  const connecting = sessionId !== null && (state.status === "connecting" || snapshot === null);
  const queueEditActiveForCurrentComposer =
    queueEditOperation?.sessionId === sessionId && queueEditOperation.workspaceKey === workspaceKey;
  const errored = sessionId !== null && state.status === "error";
  useSessionSubscriptionErrorTelemetry({
    supervisor: conversationTelemetry,
    sessionId,
    lastError: state.lastError,
    visible: errored && telemetryVisible && conversationTelemetryForegroundEnabled,
  });
  // The retry product verdict belongs to the row-level authoritative projection. This only
  // provides the command; visibility reads row.actions.canRetry exclusively - never a second
  // guard from the pane phase.
  const retryActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  // Fork availability is decided solely by row.actions.canFork (CLI stable-resolver projection); the pane only provides the command callback.
  const forkActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  // editUserQuery is already guarded at the command layer against the latest real user
  // query and runs a stop barrier before rewind/rerun on running submissions; the UI must not
  // hide the entry for a whole turn via a completed gate.
  const editActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  const isDraft = sessionId === null;
  // Scroll restore must use the lease projection matching the sessionId. The switch render
  // and its passive effect are not simultaneous; feeding the old lease rows to the timeline
  // early clamps the new scroll memory to the old content height, and the temporary offset
  // becomes indistinguishable once the target rows arrive.
  const timelineSnapshot =
    !isDraft && (lease === null || sessionLeaseReady) && snapshot?.sessionId === sessionId
      ? snapshot
      : null;
  const shareHandoverContext =
    snapshot?.sharedContextImport && "contextId" in snapshot.sharedContextImport
      ? snapshot.sharedContextImport
      : null;
  // Imported share conversation: read the persisted public rows for the read-only block at
  // the top of the thread. The share page may be expired or not yet published, so only the
  // local copy is read - never re-fetched from origin.
  const [importedShare, setImportedShare] = useState<ImportedConversationShare | null>(null);
  const importedShareContextId =
    shareHandoverContext && shareHandoverContext.status !== "discarded"
      ? shareHandoverContext.contextId
      : null;
  useEffect(() => {
    if (!importedShareContextId) {
      setImportedShare(null);
      return;
    }
    let disposed = false;
    void conversationShareService
      .getImportedConversation({
        workspacePath,
        contextId: importedShareContextId,
      })
      .then((imported) => {
        if (disposed) return;
        setImportedShare(imported);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // The read-only block is an enhancement: no data, no render, never breaks the session.
        logger.warn("[conversation-share] failed to read the imported share conversation", {
          error,
        });
        setImportedShare(null);
      });
    return () => {
      disposed = true;
    };
  }, [conversationShareService, importedShareContextId, workspacePath]);
  // When normalizeConversationShareMarkdown finds no match in artifactNames it replaces file
  // references in the body with empty strings (drops them). Without this mapping, file
  // references in the read-only block would vanish silently.
  const importedShareArtifactNames = useMemo(
    () =>
      new Map(
        (importedShare?.artifacts ?? []).map((artifact) => [
          artifact.artifactId,
          artifact.displayName,
        ]),
      ),
    [importedShare],
  );
  const importedShareArtifactWorkspaceRelativePaths = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const artifact of importedShare?.artifacts ?? []) {
      if (artifact.workspaceRelativePath) {
        entries.push([artifact.artifactId, artifact.workspaceRelativePath]);
      }
    }
    return new Map(entries);
  }, [importedShare]);
  useLayoutEffect(() => {
    if (
      !timelineBottomRequest ||
      timelineBottomRequest.taskId !== sessionId ||
      !importedShare ||
      importedShare.contextId !== importedShareContextId
    ) {
      return;
    }
    // The share block mounts async; keep the request until target task and local copy are both ready, then consume it once layout settles.
    const scrollToBottom = () => {
      const action = timelineScrollToBottomRef.current;
      if (!action) return false;
      action();
      return true;
    };
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom();
      secondFrame = window.requestAnimationFrame(() => {
        if (!scrollToBottom()) return;
        useZCodeSessionStore
          .getState()
          .clearTimelineBottomRequest(
            workspacePath,
            timelineBottomRequest.requestId,
            workspaceIdentity,
          );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    importedShare,
    importedShareContextId,
    sessionId,
    timelineBottomRequest,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleOpenImportedShareUrl = useCallback(() => {
    if (!shareHandoverContext || !onOpenBrowserUrl) return;
    // The canonical /cn/share/ path is what gets persisted; localization to the UI language happens at display/open time.
    onOpenBrowserUrl(localizeConversationShareUrl(shareHandoverContext.shareUrl, locale));
  }, [locale, onOpenBrowserUrl, shareHandoverContext]);
  const initialDraftConfigForDiagnostics = isDraft ? resolveInitialDraftConfig() : undefined;
  // The CLI V4 projection is the sole authority for running/count/manifest; the renderer no
  // longer fires its own query after spawn to stitch a second state, which lost updates from
  // concurrent children in-flight refreshes.
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENT_PROJECTION;
  useEffect(() => {
    if (!sessionId || subagents.revision === 0 || !onSyncSubagentSessionTabs) return;
    onSyncSubagentSessionTabs({
      rootSessionId: rootSessionId ?? sessionId,
      parentSessionId: sessionId,
      validChildSessionIds: subagents.childSessionIds,
    });
  }, [
    onSyncSubagentSessionTabs,
    rootSessionId,
    sessionId,
    subagents.childSessionIds,
    subagents.revision,
  ]);
  useEffect(() => {
    if (!selectionSideChat || !sessionId) return;
    setSelectionSideChatBlocked(sessionId, Boolean(blockingInteractionId));
    return () => setSelectionSideChatBlocked(sessionId, false);
  }, [blockingInteractionId, selectionSideChat, sessionId]);
  const isOfficeMode = useIsOfficeMode();
  const statusPanelModel = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        workspacePath,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal: selectionSideChat ? null : (snapshot?.goal ?? null),
        sessionPlans: state.sessionPlans,
        plan: snapshot?.plan ?? null,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
        runningSubagents: subagents.running,
        workflowRuns: snapshot?.workflowRuns?.runs ?? [],
      }),
    [
      isOfficeMode,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      snapshot?.backgroundWorks,
      snapshot?.goal,
      snapshot?.plan,
      snapshot?.workflowRuns,
      state.sessionPlans,
      selectionSideChat,
      subagents.running,
      workspacePath,
    ],
  );
  const runningBackgroundWorkCount =
    statusPanelModel.runningBashWorks.length +
    statusPanelModel.runningSubagentWorks.length +
    statusPanelModel.runningWorkflowRuns.length;
  const runningTerminalCount = statusPanelModel.runningBashWorks.length;
  const runningAgentCount = statusPanelModel.runningSubagentWorks.length;
  const runningWorkflowCount = statusPanelModel.runningWorkflowRuns.length;
  useEffect(() => {
    setTerminalSectionOpen(false);
    setAgentSectionOpen(false);
    setWorkflowSectionOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (runningTerminalCount === 0) {
      setTerminalSectionOpen(false);
    }
  }, [runningTerminalCount]);
  useEffect(() => {
    if (runningWorkflowCount === 0) {
      setWorkflowSectionOpen(false);
    }
  }, [runningWorkflowCount]);
  useEffect(() => {
    if (runningAgentCount === 0) {
      setAgentSectionOpen(false);
    }
  }, [runningAgentCount]);
  // Composer badge direct-open: when the only running work is a single workflow run with a
  // detail page, clicking the badge opens its side tab directly and the pill stays put. Uses
  // the same model that drives the pill; without a host onOpenWorkflowRun (panel rows are
  // likewise non-clickable) there is no direct open.
  const soleRunningWorkflowRunTarget = useMemo(
    () => (onOpenWorkflowRun ? resolveSoleRunningWorkflowRunTarget(statusPanelModel) : null),
    [onOpenWorkflowRun, statusPanelModel],
  );
  const handleOpenRunningBackgroundWorks = useCallback(() => {
    if (runningBackgroundWorkCount === 0) return;
    if (soleRunningWorkflowRunTarget) {
      // Same handler as the panel rows: there is no second open path.
      handleOpenWorkflowRunFromPanel(soleRunningWorkflowRunTarget);
      return;
    }
    // Product rule: the Composer is the entry for all live activity. After the section split
    // one click still expands every non-empty kind, but the three sections keep independent
    // collapsed state; they must not share a single open boolean.
    setTerminalSectionOpen(runningTerminalCount > 0);
    setAgentSectionOpen(runningAgentCount > 0);
    setWorkflowSectionOpen(runningWorkflowCount > 0);
    handleSummaryPanelVariantChange("panel");
  }, [
    handleOpenWorkflowRunFromPanel,
    handleSummaryPanelVariantChange,
    runningAgentCount,
    runningBackgroundWorkCount,
    runningTerminalCount,
    runningWorkflowCount,
    soleRunningWorkflowRunTarget,
  ]);
  const statusPanelVariant = resolveConversationStatusPanelVariant({
    variantOverride: effectiveSummaryPanelVariantOverride,
  });
  // If only the status panel knows about the auto-expanded state while timeline/composer
  // keep the old layout, the panel overlaps content on wide screens. The outer layout must
  // consume the same expanded state.
  const shouldUseStatusPanelInlineLayout =
    !isDraft &&
    shouldUseConversationStatusPanelInlineLayout({
      hasContent: statusPanelModel.hasContent,
      variant: statusPanelVariant,
    });
  const statusPanelLayout = !shouldUseStatusPanelInlineLayout
    ? "none"
    : statusPanelVariant === "auto"
      ? "auto"
      : "inline";
  const controlLastError = snapshot?.control.lastError ?? null;
  const controlLastErrorKey = controlLastError
    ? createSessionErrorKey(snapshot?.sessionId ?? sessionId, controlLastError)
    : null;
  const projectedComposerError =
    controlLastError && controlLastErrorKey && !dismissedErrorKeys.includes(controlLastErrorKey)
      ? toComposerUiError(snapshot?.sessionId ?? sessionId, controlLastError)
      : null;
  // Official Server MCP unavailable (quota exhausted / no Coding Plan): the fact comes from
  // the structured marker on the tool row. Model quota is a separate channel; projection only.
  const mcpUnavailableNotice = useMemo(
    () => resolveMcpUnavailableNotice(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  const quotaBanner = useV4SessionQuotaBanner({
    sessionId: snapshot?.sessionId ?? sessionId,
    error: controlLastError,
    errorKey: controlLastErrorKey,
    phase: snapshot?.control.phase ?? null,
    providerId: snapshot?.config.provider ?? null,
    modelId: snapshot?.config.model ?? null,
    usageStatsService: baseWorkspaceServices.usageStatsService,
    mcpUnavailableNotice,
  });
  const composerError =
    draftModelReadinessError ??
    sendSubmissionError ??
    (quotaBanner.takesOverError ? null : projectedComposerError);
  useEffect(() => {
    setSendSubmissionError(null);
  }, [sessionId]);
  const handleDismissComposerError = useCallback(() => {
    if (draftModelReadinessError) {
      dismissDraftModelReadinessError();
      return;
    }
    if (sendSubmissionError) {
      setSendSubmissionError(null);
      return;
    }
    if (!controlLastErrorKey) return;
    // v4 control.lastError is projection fact; dismissing the banner does not change it.
    // Record the current error fingerprint so the next render does not immediately re-raise
    // the same error; a new one (changed at/message) still shows.
    setDismissedErrorKeys((keys) =>
      keys.includes(controlLastErrorKey) ? keys : [...keys.slice(-19), controlLastErrorKey],
    );
  }, [
    controlLastErrorKey,
    dismissDraftModelReadinessError,
    draftModelReadinessError,
    sendSubmissionError,
  ]);
  const handleOpenModelSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const handleOpenModelUpgrade = useCallback(() => {
    if (!codingPlanUpgradeDialog) return;
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    codingPlanUpgradeDialog.openCodingPlanUpgrade({ providerId });
  }, [codingPlanUpgradeDialog, sharedSettings?.providerFamilyDomain]);
  const handleOpenQuotaUpgrade = useCallback(() => {
    const providerId = quotaBanner.upgradeProviderId;
    if (!providerId || !codingPlanUpgradeDialog) return;
    const eventText = intl.formatMessage({
      id: quotaBanner.upgradeActionLabelId,
    });
    // The banner only establishes funnel context; coding_plan_upgrade_ck is still reported once the real purchase panel opens.
    codingPlanUpgradeDialog.openCodingPlanUpgrade({
      providerId,
      funnelContext: createCodingPlanFunnelContext({
        providerId,
        upgradeSource: "session_quota_alert",
        eventRegion: "app.session",
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanState({
          providerId,
          displayStatus: "purchased",
          planLevel: "start",
        }),
      }),
    });
  }, [
    codingPlanUpgradeDialog,
    intl,
    quotaBanner.upgradeActionLabelId,
    quotaBanner.upgradeProviderId,
  ]);

  const handleConfirmShareDisclosure = useCallback(async () => {
    if (!sessionId || !shareDraft || sharePublishing) return;
    const productTurnIds = getConversationShareSelectedProductTurnIds(
      useConversationShareSelectionStore.getState(),
      sessionId,
    );
    if (productTurnIds.length === 0 || !shareTitle.trim()) return;
    const attemptKey = JSON.stringify({
      title: shareTitle.trim(),
      accessMode: shareDraft.accessMode,
      productTurnIds,
      revision: snapshot?.revision ?? null,
      logEpoch: snapshot?.logEpoch ?? null,
    });
    const shareAttempt = ensureConversationShareAttempt(
      getConversationShareDockState(useConversationShareSelectionStore.getState(), sessionId)
        .attempt,
      attemptKey,
      sessionId,
      { randomUUID: () => globalThis.crypto?.randomUUID?.() },
    );
    const operationId = `share-operation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    let activePhase = "collecting";
    let collectedWarnings: ConversationShareDisplayWarnings | null = null;
    const progressSubscription = conversationShareService.onDynamicPublishProgress(operationId)((
      progress,
    ) => {
      activePhase = progress.phase;
      updateShareDockState(sessionId, {
        progress: progress.phase === "complete" ? "checking" : progress.phase,
        completedArtifacts: progress.completedArtifacts,
        totalArtifacts: progress.totalArtifacts,
      });
      const warnings = sanitizeConversationShareWarnings(progress.warnings);
      if (warnings.length > 0) {
        collectedWarnings = {
          issues: warnings,
          issueCount: warnings.length,
          ...(progress.omittedWarningCount
            ? { omittedIssueCount: progress.omittedWarningCount }
            : {}),
        };
      }
    });
    updateShareDockState(sessionId, {
      attempt: shareAttempt,
      publishing: true,
      progress: "collecting",
      completedArtifacts: 0,
      totalArtifacts: 0,
      publishedShareUrl: null,
      error: null,
      warnings: null,
    });
    try {
      const share = await conversationShareService.publish(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          title: shareTitle.trim(),
          accessMode: shareDraft.accessMode,
          selection: { kind: "productTurns", productTurnIds },
          clientRequestId: shareAttempt.clientRequestId,
          disclosureAcceptedAt: shareAttempt.disclosureAcceptedAt,
          locale,
        },
        operationId,
      );
      const warnings = collectedWarnings as ConversationShareDisplayWarnings | null;
      updateShareDockState(sessionId, {
        publishedShareUrl: share.share_url,
        warnings,
      });
      // collectedWarnings is only assigned inside the progress callback; TS control-flow
      // analysis cannot see across the closure and narrows it to null, so restore the real
      // type here.
      if (warnings) {
        toast(
          intl.formatMessage(
            { id: "conversationShare.publishSucceededWithSkips" },
            { count: warnings.issueCount },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "conversationShare.publishSucceeded" }));
      }
    } catch (error) {
      const details = getConversationShareErrorDetails(error);
      // Transport errors such as 401 usually carry no server issues; do not degrade them to the generic collecting-stage copy.
      const resolvedMessageId = resolveConversationSharePublishErrorMessageId(error);
      const messageId =
        resolvedMessageId === "conversationShare.publishFailed" ? undefined : resolvedMessageId;
      updateShareDockState(sessionId, {
        error:
          details.issues && details.issues.length > 0
            ? {
                issues: details.issues,
                issueCount: details.issueCount ?? details.issues.length,
                omittedIssueCount: details.omittedIssueCount,
                requestId: details.requestId,
              }
            : {
                issues: [
                  {
                    code: resolveConversationShareFallbackIssueCode(details),
                    scope: "transport",
                    phase: activePhase as "collecting" | "uploading" | "checking" | "complete",
                  },
                ],
                issueCount: 1,
                requestId: details.requestId,
                messageId,
              },
      });
      logger.warn("[conversation-share] session publish failed", {
        sessionId,
        operationId,
        phase: activePhase,
        accessMode: shareDraft.accessMode,
        selectedProductTurnCount: productTurnIds.length,
        remoteWorkspace: Boolean(workspaceIdentity || remoteSessionId),
        errorName: details.name,
        kind: details.kind,
        ...(details.reasonCode === undefined ? {} : { reasonCode: details.reasonCode }),
        ...(details.diagnostics === undefined ? {} : { diagnostics: details.diagnostics }),
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(details.requestId === undefined ? {} : { requestId: details.requestId }),
      });
    } finally {
      progressSubscription.dispose();
      updateShareDockState(sessionId, { publishing: false });
    }
  }, [
    conversationShareService,
    intl,
    remoteSessionId,
    sessionId,
    shareDraft,
    sharePublishing,
    shareTitle,
    snapshot?.logEpoch,
    snapshot?.revision,
    updateShareDockState,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleCopyPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(publishedShareUrl).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, publishedShareUrl]);

  const handleOpenPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !onOpenBrowserUrl) return;
    // The server persists the canonical /cn/share/ path; the landing-page path is switched per UI language at open time.
    onOpenBrowserUrl(localizeConversationShareUrl(publishedShareUrl, locale));
  }, [locale, onOpenBrowserUrl, publishedShareUrl]);

  const handleCopyShareRequestId = useCallback(() => {
    const requestId = shareError?.requestId;
    if (!requestId || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return;
    }
    void navigator.clipboard.writeText(requestId).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, shareError?.requestId]);

  const handleShareCancel = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    finishShare(sessionId);
  }, [finishShare, sessionId, sharePublishing]);

  const handleShareNext = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    if (
      sharePreflight.status === "idle" ||
      sharePreflight.status === "checking" ||
      sharePreflight.status === "stale" ||
      ("blockingIssues" in sharePreflight && sharePreflight.blockingIssues.length > 0)
    ) {
      return;
    }
    // Preflight warnings are already surfaced by the selection dock status entry;
    // shareWarnings takes only the final publish result, keeping the share-completed copy out
    // of the not-yet-published confirm stage.
    updateShareDockState(sessionId, { error: null });
    goToShareConfiguration(sessionId);
  }, [goToShareConfiguration, sessionId, sharePreflight, sharePublishing, updateShareDockState]);

  const handleShareSelectAll = useCallback(() => {
    if (!sessionId) return;
    setAllShareRowsSelected(sessionId, true);
    updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
  }, [sessionId, setAllShareRowsSelected, updateShareDockState]);

  const handleShareDeselectAll = useCallback(() => {
    if (!sessionId) return;
    setAllShareRowsSelected(sessionId, false);
    updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
  }, [sessionId, setAllShareRowsSelected, updateShareDockState]);

  const handleDismissShareError = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { error: null });
  }, [sessionId, updateShareDockState]);
  const handleDismissShareWarnings = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { warnings: null });
  }, [sessionId, updateShareDockState]);

  const handleDeselectShareTurn = useCallback(
    (productTurnId: string) => {
      if (!sessionId || !productTurnId) return;
      // Remove by product-turn identity for the whole turn: the service issue already
      // carries productTurnId; indexing the UI per-query lists by turnOrdinal would misalign
      // the two numbering schemes.
      deselectShareProductTurn(sessionId, productTurnId);
      updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
    },
    [deselectShareProductTurn, sessionId, updateShareDockState],
  );

  const handleShareTitleChange = useCallback(
    (value: string) => {
      if (!sessionId) return;
      updateShareDockState(sessionId, {
        title: value,
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, updateShareDockState],
  );

  const handleShareAccessModeChange = useCallback(
    (accessMode: ConversationShareAccessMode) => {
      if (!sessionId) return;
      setShareAccessMode(sessionId, accessMode);
      updateShareDockState(sessionId, {
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, setShareAccessMode, updateShareDockState],
  );

  // Inline callbacks would re-render the memoized confirm dock on every render; depend on the current session so a switch never writes back to the old one.
  const handleShareDisclosureAcceptedChange = useCallback(
    (accepted: boolean) => {
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: accepted });
      }
    },
    [sessionId, updateShareDockState],
  );

  const handleShareBack = useCallback(() => {
    if (sharePublishing || publishedShareUrl || !sessionId) return;
    updateShareDockState(sessionId, { error: null });
    goToShareSelection(sessionId);
  }, [goToShareSelection, publishedShareUrl, sessionId, sharePublishing, updateShareDockState]);

  const handleShareConfirm = useCallback(() => {
    if (!shareDisclosureAccepted) return;
    void handleConfirmShareDisclosure();
  }, [handleConfirmShareDisclosure, shareDisclosureAccepted]);

  const handleShareSelectionToggle = useCallback(
    (rowId: number) => {
      if (sessionId) toggleShareRow(sessionId, rowId);
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
      }
    },
    [sessionId, toggleShareRow, updateShareDockState],
  );

  const handleShareSelectionInspect = useCallback(
    (target: { unitIndex: number; rowId: number }) => {
      timelineScrollToQueryRef.current?.(target);
    },
    [],
  );

  const recoverableCommand = recoverableCommands[0] ?? null;
  const handleDismissPendingRecovery = useCallback(() => {
    if (!recoverableCommand) return;
    pendingCommandRegistry.dismissRecovery(
      recoverableCommand.sessionId,
      recoverableCommand.commandId,
    );
  }, [recoverableCommand]);
  const handleResendPendingCommand = useCallback(() => {
    if (!recoverableCommand) return;
    const replay = pendingCommandRegistry.consumeReplay({
      sessionId: recoverableCommand.sessionId,
      commandId: recoverableCommand.commandId,
    });
    if (!replay) return;
    void dispatchCommand(replay.type, replay.payload, replay.sessionId, replay.baseRevision)
      .then((ack) => {
        if (
          replay.type === "createSession" &&
          (ack.status === "accepted" || ack.status === "duplicate") &&
          ack.result?.type === "createSession"
        ) {
          const originWorkspace = replay.clientContext?.workspace;
          const originWorkspaceKey =
            originWorkspace?.workspaceIdentity?.trim() || originWorkspace?.workspacePath;
          if (originWorkspaceKey && originWorkspaceKey !== workspaceKey) {
            // Guard against stale UI/stale closures triggering a cross-workspace replay; the
            // normal entry is already filtered in the hook.
            logger.error(
              "[v4-pending-command] rejecting cross-workspace createSession replay result",
              {
                originWorkspaceKey,
                workspaceKey,
              },
            );
            return;
          }
          handleDraftSessionCreated(
            ack.result.sessionId,
            replay.clientContext?.groupedDraftTask,
            replay.clientContext?.sessionCreateSource,
            replay.payload.firstInput ? ack.commandId : undefined,
          );
        }
      })
      .catch((error) => {
        // The new command is already in the registry; this transport failure can still be
        // reconciled on the next connection.
        logger.warn("[v4-pending-command] user-confirmed resend failed", error);
      });
  }, [dispatchCommand, handleDraftSessionCreated, recoverableCommand, workspaceKey]);

  // The subagent side child tab is an observer view; reusing the plain SessionPane while
  // still creating the composer would suggest users can keep typing into the child session.
  const composerNode = readOnly ? null : (
    <ConversationComposer
      key="conversation-composer"
      // The snapshot still serves usage, routing, and run state; the toolbar mode/model merely reflect the Composer Draft below.
      snapshot={snapshot}
      sessionId={sessionId}
      // The draft taskId is still null, but the prewarm already owns a dedicated
      // AgentRuntime. Pass only the effective id to the Skill catalog so the UI does not scan
      // Skills the prewarm runtime has not loaded yet.
      skillCatalogSessionId={effectiveSessionId}
      draftMode={isDraft}
      draftConfig={draftConfig}
      composerDraft={composerDraft}
      replaceComposerDraft={replaceComposerDraft}
      submissionReady={composerSubmissionReady}
      updateComposerContent={updateComposerContent}
      createSubmissionFromComposer={createSubmissionFromComposer}
      contextHeader={isDraft ? draftComposerHeader : undefined}
      centered={isDraft}
      blockingRequestId={blockingInteractionId}
      listenAddToChatEvents={focused}
      externalTextInsertRequest={focused && sessionId === null ? composerTextInsertRequest : null}
      onExternalTextInsertApplied={handleExternalTextInsertApplied}
      autoFocusEnabled={focused}
      disabled={
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer ||
        quotaBanner.state.blocksSubmit
      }
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId ?? undefined}
      modelSelectionView={modelSelectionView}
      modelSelectionState={modelSelectionRead.state}
      modelSelectionReload={modelSelectionRead.reload}
      attachmentSessionId={effectiveSessionId}
      attachmentPut={attachmentPut}
      onRuntimeRestart={onRuntimeRestart}
      onRuntimeLifecycle={onRuntimeLifecycle}
      provider={provider}
      telemetryDraftConfig={telemetryDraftConfig}
      telemetryVisible={telemetryVisible && conversationTelemetryForegroundEnabled}
      readPlanIdentitySnapshot={readPlanIdentitySnapshot}
      onSendText={handleSendText}
      onDraftStateChange={handleComposerDraftStateChange}
      composerRestoreRequest={composerRestoreRequest}
      onComposerRestoreApplied={handleComposerRestoreApplied}
      onStop={handleStopFromButton}
      onSelectModel={handleSelectModel}
      onSelectThought={handleSelectThought}
      onSwitchMode={handleSwitchMode}
      onOpenRunningBackgroundWorks={
        sessionId && runningBackgroundWorkCount > 0 ? handleOpenRunningBackgroundWorks : undefined
      }
      backgroundWorkOpenTarget={soleRunningWorkflowRunTarget ? "workflow-run" : "panel"}
      // After the parent turn ends, the subagents.running directory projection can lag the
      // still-running backgroundWorks briefly; reading the directory directly would hide the
      // Agent entry early. Reuse the status panel count after its per-childSessionId fallback
      // so both entries share one run-state truth.
      runningSubagentCount={runningAgentCount}
      onRecoverCustomModelSelection={handleRecoverCustomModelSelection}
      onSendCompressionCommand={handleSendCompressionCommand}
      error={composerError}
      onDismissError={handleDismissComposerError}
      onOpenModelSettings={handleOpenModelSettings}
      onOpenModelUpgrade={handleOpenModelUpgrade}
      onOpenCodeViewer={onOpenCodeViewer}
      suppressGoalCommands={selectionSideChat}
      appSlashCommands={appSlashCommands}
      onDropTargetControllerChange={handleDropTargetControllerChange}
    />
  );
  const pendingGuideProjection = snapshot ? projectPendingGuideQueue(snapshot.queue) : null;
  const conversationBottomDockContent = readOnly ? null : shareActive && sessionId ? (
    shareInSelectionStage ? (
      <ConversationShareSelectionDock
        selectedCount={selectedShareRowIds.size}
        totalCount={eligibleShareItems.length}
        pending={sharePublishing}
        preflight={sharePreflight}
        onCancel={handleShareCancel}
        onNext={handleShareNext}
        onSelectAll={handleShareSelectAll}
        onDeselectAll={handleShareDeselectAll}
        onDeselectTurn={handleDeselectShareTurn}
        onRetryPreflight={retrySharePreflight}
      />
    ) : publishedShareUrl ? (
      <ConversationShareSuccessDock
        title={shareTitle}
        warnings={shareWarnings}
        onOpen={handleOpenPublishedShare}
        onCopy={handleCopyPublishedShare}
        onDismiss={handleShareCancel}
      />
    ) : (
      <ConversationShareConfirmationDock
        selectedCount={selectedShareProductTurnIds.length}
        totalCount={eligibleShareProductTurnIds.length}
        title={shareTitle}
        accessMode={shareDraft?.accessMode ?? DEFAULT_CONVERSATION_SHARE_ACCESS_MODE}
        progressLabel={intl.formatMessage({
          id:
            shareProgress === "uploading"
              ? "conversationShare.progress.uploading"
              : shareProgress === "checking"
                ? "conversationShare.progress.checking"
                : "conversationShare.progress.collecting",
        })}
        progressPhase={shareProgress}
        completedArtifacts={shareCompletedArtifacts}
        totalArtifacts={shareTotalArtifacts}
        pending={sharePublishing}
        error={shareError}
        warnings={shareWarnings}
        onDismissError={handleDismissShareError}
        onDismissWarnings={handleDismissShareWarnings}
        onCopyRequestId={handleCopyShareRequestId}
        onDeselectTurn={handleDeselectShareTurn}
        onTitleChange={handleShareTitleChange}
        onAccessModeChange={handleShareAccessModeChange}
        disclosureAccepted={shareDisclosureAccepted}
        onDisclosureAcceptedChange={handleShareDisclosureAcceptedChange}
        onCancel={handleShareCancel}
        onBack={handleShareBack}
        onConfirm={handleShareConfirm}
      />
    )
  ) : (
    <>
      {quotaBanner.state.visible &&
      !quotaBanner.dismissed &&
      (!projectedComposerError || quotaBanner.takesOverError || quotaBanner.state.blocksSubmit) ? (
        <ConversationQuotaBanner
          state={quotaBanner.state}
          onShown={quotaBanner.markShown}
          upgradeActionLabelId={quotaBanner.upgradeActionLabelId}
          onUpgrade={
            quotaBanner.upgradeProviderId && codingPlanUpgradeDialog
              ? handleOpenQuotaUpgrade
              : undefined
          }
          onDismiss={quotaBanner.dismiss}
        />
      ) : null}
      {recoverableCommand ? (
        <PendingCommandRecoveryBanner
          entry={recoverableCommand}
          onResend={
            recoverableCommand.replay.kind === "input" ? handleResendPendingCommand : undefined
          }
          onDismiss={handleDismissPendingRecovery}
        />
      ) : null}
      {sessionId && snapshot?.workspaceHookAdmission ? (
        <WorkspaceHookPendingBanner
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          admission={snapshot.workspaceHookAdmission}
        />
      ) : null}
      {sessionId && snapshot ? (
        <ConversationQueuePanel
          key="conversation-queue"
          queue={pendingGuideProjection?.visibleQueue ?? snapshot.queue}
          onDeleteItem={handleDeleteQueueItem}
          onEditItem={handleEditQueueItem}
          pendingEditQueueItemId={
            queueEditActiveForCurrentComposer ? queueEditOperation.queueItemId : null
          }
          onSendNow={handleSendQueuedNow}
          onMoveItem={handleReorderQueueItem}
          onResume={handleResumeQueue}
        />
      ) : null}
      {/* v4 permission/question waiting states are runtime-blocking interactions and must
          share the timeline bottom dock with the composer; rendering outside SessionPane
          escapes the main column width and squeezes the lower half. */}
      {sessionId && snapshot ? (
        <V4InteractionDialogs
          key="conversation-interactions"
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          provider={provider}
          snapshot={snapshot}
        />
      ) : null}
      {composerNode}
      {/* Office mode shows proactive task suggestions; coding mode keeps the original compact scenario entry. */}
      {isDraft && (!isOfficeMode || sharedSettings?.proactiveSuggestionsEnabled === true) ? (
        <ConversationDraftSuggestedPromptsContainer
          className={isOfficeMode ? "mt-4" : "mt-6"}
          proactive={isOfficeMode}
          onOpenAutomations={
            onOpenAutomationsMain
              ? (automationTab) => onOpenAutomationsMain(undefined, automationTab)
              : undefined
          }
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isDesktop={isDesktop}
        />
      ) : null}
    </>
  );
  // The chat dock and share dock differ in height across share enter/exit; share one grid
  // cell with a vertical slide+fade so the parent height never hard-jumps.
  // prefers-reduced-motion degrades to an instant switch inside the transition component.
  const conversationBottomDock = conversationBottomDockContent ? (
    <ConversationBottomDockTransition mode={shareActive && sessionId ? "confirmation" : "chat"}>
      {conversationBottomDockContent}
    </ConversationBottomDockTransition>
  ) : null;

  return (
    <div
      data-testid={testId(TID_V4_SESSION_PANE, paneId)}
      data-session-id={sessionId ?? "draft"}
      data-initial-draft-provider={initialDraftConfigForDiagnostics?.provider ?? ""}
      data-initial-draft-model={initialDraftConfigForDiagnostics?.model ?? ""}
      data-projection-seq={snapshot?.seq ?? ""}
      data-running-subagent-ids={subagents.running.map((item) => item.childSessionId).join(",")}
      data-running-subagent-work-ids={(snapshot?.backgroundWorks ?? [])
        .filter((work) => work.kind === "subagent" && work.status === "running")
        .map((work) => work.childSessionId ?? work.workId)
        .join(",")}
      data-v4-conversation-drop-target="true"
      onDragOver={effectiveDropTargetController?.onDragOver}
      onDragLeave={effectiveDropTargetController?.onDragLeave}
      onDrop={effectiveDropTargetController?.onDrop}
      className="relative flex h-full min-h-0 flex-col"
    >
      {effectiveDropTargetController?.active ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/55 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
            <Hand className="size-4 text-foreground" />
            <span>
              {intl.formatMessage({
                id:
                  effectiveDropTargetController.kind === "workspace"
                    ? "chat.composer.workspaceFileDragHint"
                    : "chat.attachments.dragHint",
              })}
            </span>
          </div>
        </div>
      ) : null}
      <ConversationHeader
        title={snapshot?.meta.title ?? ""}
        onSplitRight={onSplitRight}
        onSplitDown={onSplitDown}
        onClosePane={onClosePane}
        workspaceBadge={workspaceBadge}
      />

      <div
        ref={conversationLayoutContainerRef}
        className="@container/conversation relative flex min-h-0 flex-1 flex-col"
      >
        <ConversationShareSelectionScrim
          visible={shareSelectionPanelVisible}
          interactive
          onBackdropClick={dismissShareSelectionPanel}
        />
        <ConversationShareSelectionPanel
          visible={shareSelectionPanelVisible}
          items={shareItems}
          selectedRowIds={selectedShareRowIds}
          onToggle={handleShareSelectionToggle}
          onInspect={handleShareSelectionInspect}
        />
        {shareActive && shareInSelectionStage && shareDraft?.view === "timeline" && sessionId ? (
          <ConversationShareSelectionReopenTab onOpen={() => showShareSelectionPanel(sessionId)} />
        ) : null}
        {!isDraft ? (
          <ConversationStatusPanel
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            gitSummary={gitSummary}
            gitDirtyFileCount={gitDirtyFileCount}
            gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
            gitWorktreeChangeSummary={gitWorktreeChangeSummary}
            activeTaskChangeSummary={activeTaskChangeSummary}
            goal={selectionSideChat ? null : (snapshot?.goal ?? null)}
            sessionPlans={state.sessionPlans}
            plan={snapshot?.plan ?? null}
            backgroundWorks={snapshot?.backgroundWorks ?? []}
            runningSubagents={subagents.running}
            workflowRuns={snapshot?.workflowRuns?.runs ?? []}
            endedSubagentCount={subagents.endedTotal}
            rootSessionId={rootSessionId ?? sessionId ?? undefined}
            parentSessionId={sessionId ?? undefined}
            layoutMode={statusPanelLayout}
            summaryPanelVariantOverride={effectiveSummaryPanelVariantOverride}
            onVariantChange={handleSummaryPanelVariantChange}
            terminalSectionOpen={terminalSectionOpen}
            onTerminalSectionOpenChange={setTerminalSectionOpen}
            agentSectionOpen={agentSectionOpen}
            onAgentSectionOpenChange={setAgentSectionOpen}
            workflowSectionOpen={workflowSectionOpen}
            onWorkflowSectionOpenChange={setWorkflowSectionOpen}
            onRefreshGit={onRefreshGit}
            onOpenGitReview={onOpenGitReview}
            onPauseGoal={
              !readOnly && !selectionSideChat && snapshot?.availability.pauseGoal.allowed
                ? handlePauseGoal
                : undefined
            }
            onResumeGoal={
              !readOnly && !selectionSideChat && snapshot?.availability.resumeGoal.allowed
                ? handleResumeGoal
                : undefined
            }
            onOpenPlanDetail={onOpenPlanDetail ? handleOpenPlanDetail : undefined}
            onOpenBackgroundBash={
              onOpenBackgroundBash && sessionId
                ? (work) =>
                    onOpenBackgroundBash({
                      workspacePath,
                      workspaceIdentity: workspaceIdentity ?? undefined,
                      remoteSessionId: remoteSessionId ?? undefined,
                      rootSessionId: rootSessionId ?? sessionId,
                      sessionId,
                      workId: work.workId,
                      title: work.title,
                    })
                : undefined
            }
            onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}
            onOpenSubagentSession={onOpenSubagentSession ? handleOpenSubagentSession : undefined}
            onOpenSubagentDirectory={
              onOpenSubagentDirectory ? handleOpenSubagentDirectory : undefined
            }
            onOpenWorkflowRun={
              onOpenWorkflowRun && sessionId ? handleOpenWorkflowRunFromPanel : undefined
            }
            endedWorkflowRunCount={endedWorkflowRunCount}
            onOpenWorkflowRunDirectory={
              onOpenWorkflowRunDirectory ? handleOpenWorkflowRunDirectoryFromPanel : undefined
            }
          />
        ) : null}

        {readOnly && controlLastError ? (
          <div
            role="alert"
            data-testid="v4-subagent-readonly-error"
            className="mx-4 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base text-[var(--color-danger)]"
          >
            {controlLastError.message}
          </div>
        ) : null}

        {errored ? (
          <SessionSubscriptionErrorPanel
            error={state.lastError ?? intl.formatMessage({ id: "chat.error.connectionLost" })}
            sessionId={sessionId}
            workspacePath={workspacePath}
            onReconnect={handleRetrySubscribe}
          />
        ) : (
          <SessionPluginReferenceIconBoundary
            enabled={pluginReferenceIconsEnabled}
            remoteSessionId={remoteSessionId}
            sessionId={sessionId}
            workspaceIdentity={workspaceIdentity}
            workspacePath={workspacePath}
          >
            <ConversationTimeline
              scrollToBottomActionRef={timelineScrollToBottomRef}
              scrollToQueryActionRef={timelineScrollToQueryRef}
              selectionPanelLayoutContainerRef={conversationLayoutContainerRef}
              rows={timelineSnapshot?.rows.window ?? []}
              pendingGuides={timelineSnapshot ? pendingGuideProjection?.pendingGuides : []}
              apiRetry={timelineSnapshot?.control.apiRetry ?? null}
              totalCount={timelineSnapshot?.rows.totalCount ?? 0}
              sessionKey={sessionId ?? "draft"}
              scrollMemoryKey={timelineScrollMemoryKey}
              rowContext={rowContext}
              onFork={forkActionsEnabled ? handleFork : undefined}
              onRetry={retryActionsEnabled ? handleRetry : undefined}
              onFeedbackChange={
                !readOnly && !selectionSideChat && sessionId ? handleAssistantFeedback : undefined
              }
              onEdit={editActionsEnabled ? handleEdit : undefined}
              canLoadOlder={timelineSnapshot ? hasOlderRows(timelineSnapshot) : false}
              loadingOlder={timelineSnapshot ? state.loadingOlder : false}
              onLoadOlder={handleLoadOlder}
              onLoadAllOlder={handleLoadAllOlder}
              turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
              bottomDock={conversationBottomDock}
              hideTurnNavigator={shareActive && shareInSelectionStage}
              backgroundScrollLocked={resolveConversationShareBackgroundScrollLocked({
                partialShareActive: shareActive,
                stage: shareDraft?.stage ?? "selection",
                view: shareDraft?.view,
              })}
              headerSlot={
                // unsupportedRowCount opens this gate too: when this build skips every row,
                // rows is empty, but the read-only block must remain to show the update-ZCode
                // note instead of vanishing.
                importedShare &&
                (importedShare.rows.length > 0 || importedShare.unsupportedRowCount > 0) ? (
                  <ConversationShareImportNotice
                    rows={importedShare.rows}
                    unsupportedRowCount={importedShare.unsupportedRowCount}
                    artifactNames={importedShareArtifactNames}
                    artifactWorkspaceRelativePaths={importedShareArtifactWorkspaceRelativePaths}
                    workspacePath={workspacePath}
                    {...(workspaceIdentity ? { workspaceIdentity } : {})}
                    {...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {})}
                    locale={locale}
                    theme={theme}
                    codePreviewSettings={codePreviewSettings}
                    onOpenShareUrl={onOpenBrowserUrl ? handleOpenImportedShareUrl : undefined}
                    onOpenFileLink={onOpenFileLink}
                    onOpenCodeViewer={onOpenCodeViewer}
                  />
                ) : null
              }
              emptyState={
                isDraft ? (
                  <div data-testid={TID_CHAT_EMPTY} className="w-full">
                    <ConversationDraftEmptyState />
                  </div>
                ) : null
              }
              centerEmptyStateWithDock={isDraft}
              summaryPanelLayout={statusPanelLayout}
              conversationFindQuery={!isDraft && focused ? conversationFindQuery : ""}
              conversationFindActiveIndex={!isDraft && focused ? conversationFindActiveIndex : -1}
              conversationFindNavigationRequestId={
                !isDraft && focused ? conversationFindNavigationRequestId : 0
              }
              onConversationFindMatchStateChange={
                !isDraft && focused ? onConversationFindMatchStateChange : undefined
              }
              searchResultHighlightRequest={isDraft ? null : searchResultHighlightRequest}
              onSearchResultHighlightDone={onSearchResultHighlightDone}
              sessionPhase={isDraft ? undefined : snapshot?.control.phase}
              shareSelection={
                shareActive && shareInSelectionStage && shareDraft?.view === "timeline" && sessionId
                  ? {
                      eligibleRowIds: eligibleShareRowIds,
                      selectedRowIds: selectedShareRowIds,
                      onToggle: handleShareSelectionToggle,
                    }
                  : undefined
              }
              selectionActions={
                !isDraft && sessionId && !readOnly && !selectionSideChat
                  ? {
                      enabled: resolveConversationSelectionTooltipEnabled({
                        selectionActionsEnabled: focused && !blockingInteractionId,
                        partialShareActive: shareActive,
                      }),
                      sideActionDisabled: selectionSideActionBlocked,
                      onAddToCurrentTask: handleAddSelectionToCurrentTask,
                      onAskInSideChat: handleOpenSelectionSideConversation,
                    }
                  : undefined
              }
            />
          </SessionPluginReferenceIconBoundary>
        )}
      </div>
    </div>
  );
}
