// v4 row-render context (the host-injection surface re-bridging ai-elements / ToolCallBlocks).
// Injection mirrors PermissionDialog (store decoupling): presentational components never fetch stores;
// theme / codePreviewSettings are taken at the host (SessionPane) and passed down as stable props.
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunSettingsChange } from "@/components/workflow-timeline/workflowRunSettings.js";
import type { WorkflowDraftPosition, WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import type { WorkflowFillGraph } from "@/v4/workflowRunCardJoin.js";
import type { Theme } from "@/useTheme.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ZCodeWorkflowsForRunCandidate } from "@zcode/shared";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";

export type ConversationFileChangesState = Exclude<
  NonNullable<TurnHeaderRow["fileChanges"]>["state"],
  undefined
>;

export interface ConversationRowRenderContext {
  logEpoch?: string;
  workspacePath: string;
  /** User home of the current workspace Host; resolves ~/ paths in Assistant output. */
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /** The same Model Selection view SessionPane read from the target Host. */
  modelSelectionView?: ModelSelectionView | null;
  theme: Theme;
  /** Must stay reference-stable (MessageResponse/ToolCallBlock memo deps). */
  codePreviewSettings: CodePreviewSettings;
  /** Parent session bound to this pane; the subagent side tab groups by it. */
  sessionId?: string | null;
  /** Top session of the current drill-down tree; detail tabs group across nesting by this id. */
  rootSessionId?: string | null;
  /** @deprecated Legacy inline drill-down marker; child sessions now open the side details. */
  inSubagentDrilldown?: boolean;
  /** Phone /remote compact mode: hide the open-in-external-app dropdown, keep in-app preview only. */
  compactForRemoteControl?: boolean;
  /** The session is compacting or verifying a goal; dedicated status UI owns progress feedback. */
  chatLoadingBlockedByActiveWork?: boolean;
  /** The session awaits a permission decision or AskUserQuestion answer; hides the bottom ChatLoading. */
  chatLoadingBlockedByInteraction?: boolean;
  /** Setting: render reasoning/thought rows in the message flow. */
  messageStreamShowReasoning?: boolean;
  /** First reasoning row of the current assistant turn; still shown when full thinking is off. */
  messageStreamFirstReasoningRowId?: number;
  /** Setting: render Todo tool cards in the message flow. */
  messageStreamShowTodos?: boolean;
  /** Setting: aggregate consecutive Explore-compatible tools. */
  toolGroupingExploreEnabled?: boolean;
  /** Setting: aggregate consecutive non-readonly Shell tools. */
  toolGroupingTerminalEnabled?: boolean;
  /** Setting: aggregate consecutive file-write tools. */
  toolGroupingChangesEnabled?: boolean;
  /**
   * Tier 1 fork jump: switch this pane to the target session (forkNotice -> parent, reusing the onSessionCreated
   * in-place switch). rowId is reserved for Tier 2 exact scroll - forkNotice.parentRowId is a 0 placeholder for now.
   * Must stay reference-stable (rowContext memo deps).
   */
  onNavigateToRow?: (sessionId: string, rowId: number) => void;
  /** Assistant Preview Cards: website card preview entry; the app shell injects side-pane behavior. */
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  /** Assistant Preview Cards: markdown/file card preview entry; the app shell injects code-viewer behavior. */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop completed PPTX: the shell atomically opens several side preview tabs. */
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  /** Once the renderer sees running -> completedSuccess, lock to that turn. */
  assistantPreviewPptxAutoOpenTarget?: { turnId: string; key: string } | null;
  /** Assistant markdown local-file link entry: the shell stats and routes to preview or file tree. */
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  /** Plugin UI: an inline card asks to open in the side pane; RowView fills parentSessionId and workspace. */
  onOpenWorkflowRun?: (request: OpenWorkflowRunSideTabRequest) => void;
  /**
   * Full-size viewer tab entry for artifacts.
   *
   * Terminology: an artifact here is output published to the user via `artifact.*`, not a synonym of the
   * engine-internal script top-level return.
   *
   * Mirrors `onOpenWorkflowRun`: the row emits intent only (which artifact of which run); session and workspace
   * identity are host-filled. No version pin - the chip means show me this artifact, always the latest version.
   */
  onOpenWorkflowArtifact?: (request: OpenWorkflowArtifactSideTabRequest) => void;
  /**
   * Cancel one background work (`cancelBackgroundWork{workId}`); the host binds dispatchCommand + sessionId.
   *
   * The turn-tail run card uses it for Stop run: the run
   * id equals the workId, the same cancel path as the details pane/task list. Notification rows are terminal and need
   * no cancel, so the capability is absent from context; the run card is the first transcript row rendering a stop
   * button in running state, hence this optional field. Read-only sessions get no host injection, thus no cancel.
   */
  onCancelBackgroundWork?: (workId: string) => void;
  /**
   * The tool-card-footer Resume: the same
   * v4 `resumeWorkflowRun {workId === runId}` as the details page. Not injected for read-only sessions.
   */
  onResumeWorkflowRun?: (workId: string, name?: string) => void;
  /**
   * The run-card Configure: v4
   * `amendWorkflowRunSettings {workId === runId, ...changed}`; the ACK feeds the popover rejection copy. The same two gates as Resume
   * (read-only, rollout): absent means no Configure on the card.
   */
  onAmendWorkflowRunSettings?: (
    workId: string,
    change: WorkflowRunSettingsChange,
  ) => Promise<CommandAck>;
  /**
   * The completed card's Save / Run-again (docs/dynamic-workflow/transcript-and-notifications.md,
   * Saving the run, and running it again): send the GUI-authored user message into this session for ZCode
   * to summarize and save. Same two gates as Resume (read-only, rollout) and the **same single supplier** --
   * file writes and engine starts go wherever Resume goes. Absent, the card keeps only the saved chip fact.
   */
  onSendWorkflowSaveRequest?: (text: string) => Promise<void>;
  /**
   * runId -> SaveWorkflow candidates claiming this run in the transcript (`workflowRunCardJoin.buildWorkflowSaveCandidatesByRunId`),
   * built by the host in one pass over the row window. It is the only link between the definition saved under a fresh name and this run
   * (the model never names the workflow after the run) -- hence transcript-derived.
   */
  workflowSaveCandidatesByRunId?: ReadonlyMap<string, readonly ZCodeWorkflowsForRunCandidate[]>;
  /** The session current model (the Session model first item in the Configure popover); absent if unreadable, the item then stays generic. */
  workflowSessionModel?: { providerId: string; modelId: string };
  /**
   * Subagent pill on the tool card -> that subagent transcript tab: the same open path as the details subagent row; the host fills workspace identity.
   */
  onOpenWorkflowActor?: (request: OpenWorkflowActorSessionSideTabRequest) => void;
  /**
   * Script pill on the tool card -> the run script transcript tab:
   * the same open path as the details-spine script row; the host fills workspace identity.
   */
  onOpenWorkflowWorkspace?: (request: OpenWorkflowWorkspaceSideTabRequest) => void;
  /**
   * CreateWorkflow tool call -> run summary resolution table, built by the host from the `workflowRuns` projection.
   *
   * Run identity must come from the projection, not tool output: `workflowRunSchema.toolCallId` exists for exactly this join
   * (the card-to-details key), while the v4 tool-row output is one prose line -
   * structured fields like `status` / `backgroundTaskId` are dropped by formatModelContent.
   *
   * Values carry state and step counts, not just runId: a hit promotes the card into run state (compact, clickable), which then renders
   * live status words and progress - computed once at join (`workflowRunCardJoin.ts`).
   */
  workflowRunByToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /**
   * The runId-keyed sibling join (`workflowRunCardJoin.buildWorkflowRunByRunId`). For
   * ResumeWorkflowRun tool rows: in the projection run.toolCallId keeps the original
   * CreateWorkflow row across resumes (deliberate unbroken-join semantics), so resume rows never resolve by toolCallId;
   * their display payload carries runId - join the same projection by runId.
   */
  workflowRunByRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /**
   * runId -> the qids this run rests on, built by the host from the live projection (no journal fallback)
   * (`workflowRunCardJoin.buildWorkflowRunPendingQuestionsByRunId`). The notification-manifest
   * upgrade entry flips Waiting->Answered with it: key present iff the run is live, qid in value = Waiting,
   * missing from value = Answered, whole key absent = run not present (neutral Question).
   */
  workflowRunPendingQuestionsByRunId?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * initiating toolCallId -> the static run graph (`workflowRunCardJoin.buildWorkflowGraphByToolCallId`), built by the
   * host from the row window. The graph belongs to the run: turn-tail cards take it here by the initiating
   * toolCallId, whether hosted on a CreateWorkflow row, a ResumeWorkflowRun row, or a direct-launch turn.
   */
  workflowGraphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
  /**
   * runId -> the latest successful fill's valid script graph (`workflowRunCardJoin.buildWorkflowFillGraphByRunId`): after the fill,
   * the run card and side pane take it, not the origin's graph (docs/dynamic-workflow/presentation.md, Holes on the timeline).
   */
  workflowFillGraphByRunId?: ReadonlyMap<string, WorkflowFillGraph>;
  /**
   * CreateWorkflow / AmendWorkflow rows -> draft standing (number, superseded), built by the host in one pass
   * (`workflowDraftJoin.buildWorkflowDraftByToolCallId`). Compile-feedback rows write draft n and pick the empty-lane
   * color; absent, the card shows no number.
   */
  workflowDraftByToolCallId?: ReadonlyMap<string, WorkflowDraftPosition>;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
  previewFileRewind?: (
    target: ConversationRowTarget,
  ) => Promise<V4ConversationFileRewindPreviewResult>;
  applyFileRewind?: (target: ConversationRowTarget) => Promise<CommandAck>;
  /** Sent image/video preview; injected by the pane-bound workspace transport. */
  readAttachment?: (
    params: ConversationAttachmentReadParams,
  ) => ReturnType<ConversationTransport["attachmentRead"]>;
  readAttachmentRange?: (
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ) => ReturnType<ConversationTransport["attachmentReadRange"]>;
}

export interface ConversationFileChangesRequestOptions {
  /**
   * A running-turn result keeps growing with projection revisions; only the in-flight request is reusable;
   * terminal turns may reuse the successful result across virtual remounts.
   */
  cachePolicy: "in-flight" | "terminal";
  /** Rewind flips active/reverted inside one logEpoch; terminal caches must be isolated by that state. */
  fileChangesState?: ConversationFileChangesState;
}

export type ConversationReasoningVisibility = Pick<
  ConversationRowRenderContext,
  "messageStreamShowReasoning" | "messageStreamFirstReasoningRowId"
>;

export function isConversationReasoningRowVisible(
  rowId: number,
  visibility: ConversationReasoningVisibility,
): boolean {
  return (
    visibility.messageStreamShowReasoning === true ||
    visibility.messageStreamFirstReasoningRowId === rowId
  );
}
