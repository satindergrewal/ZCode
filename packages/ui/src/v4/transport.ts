// Transport seam of the V4 session data layer (dependency injection).
// desktop goes through preload/MessagePort, web through the ws relay - the data layer knows neither;
// this is where dependency-injection-solves-desktop/web-compat lands in the v4 data layer.
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationRowTarget,
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
  SubscribeParams,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansParams,
  V4ConversationPlansResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  ConversationResyncParams,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

/**
 * The v4 conversation transport surface over one host connection.
 * Cross-workspace splits = the UI shell holds Map<workspaceKey, ConversationTransport>,
 * each connection with its own SessionDataLayer.
 */
export interface ConversationTransport {
  /** v4/conversation/subscribe. connectionId is filled in by the transport impl, never by the UI layer. */
  subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult>;
  /** Activate once the store ACKs the subscriptionId, releasing pre-ACK notifications in order. */
  activate(subscriptionId: string): void;
  /** Live-subscription same-sub recovery; topic/connection/profile resolved via the host-owned registry. */
  resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  /** v4/conversation/unsubscribe。 */
  unsubscribe(subscriptionId: string): Promise<void>;
  /** v4/command。 */
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  /** v4/commands/query: reconcile against CLI-authoritative facts by commandId after reconnect. */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult>;
  /** v4/conversation/rowsRange (loadOlder): fetch one window of history upward by cursor. */
  rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>;
  /** v4/conversation/plans: every terminal plan in the current live branch. */
  plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult>;
  /** v4/conversation/workflowRunEvents: workflow run event-log pagination (cursor = journal sequence). */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** v4/conversation/workflowRuns: workflow run enumeration (journal-backed rediscovery after restart). */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * v4/conversation/workflowRunArtifacts: the user-facing artifact list of a workflow run (durable read for cold recovery).
   *
   * Terminology: an artifact is output published to the user by the script via `artifact.*` (file / markdown / preset dashboard),
   * not the run top-level return value.
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** v4/conversation/workflowRunArtifactData: preset dashboard entry pagination (cursor = journal sequence). */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** v4/conversation/workflowRunArtifactRead: content artifact bytes, one chunk at a time (<= 512 KiB). */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /**
   * v4/conversation/workflowRunWorkspace: the script transcript listing of a workflow run
   * (files.* / git.* / world.run journal lines, no bodies).
   */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** v4/conversation/workflowRunNodeResult: bounded body of one workspace node (fetched on expand). */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /** v4/conversation/fileChanges: per-turn-row file summary details and read-only diffs. */
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  /** v4/conversation/fileRewindPreview: per-turn-row preview of workspace-only file reverts. */
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** High-level UI attachment upload; the production wire is begin/chunk/commit/abort. */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  /** High-level read for sent image/video; Desktop-local video may return an authorized URL, the rest loops small chunks. */
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
  /** Authorized range reads for sent PDFs; never loads the whole file into the renderer. */
  attachmentReadRange(
    params: ConversationAttachmentReadParams & { offset: number; limit: number },
  ): Promise<{
    bytes: Uint8Array;
    mediaType: string;
    totalBytes: number;
    nextOffset: number | null;
  }>;
  /** Registers the downstream frame listener (v4/conversation/frame); returns the unsubscribe function. */
  onFrame(
    listener: (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void;
  /** Atomic failure of physical assembly; projection untouched, the store starts a single-flight resync. */
  onAssemblyFault(
    listener: (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void,
  ): () => void;
  /** CLI runtime or carrying-proxy generation change; the transport has already cleared ownership/barrier/assembler. */
  onRuntimeRestart(listener: (reason?: "runtimeRestart" | "transportReplaced") => void): () => void;
  /**
   * CLI runtime liveness. unavailable arrives during workspace dispose (no new runtime exists yet,
   * cannot re-subscribe); available arrives when the new process spawns, same instant and meaning as onRuntimeRestart.
   *
   * onRuntimeRestart fires only on new-process spawn, and the agent starts lazily - once CUA Helper readiness
   * triggers dispose nobody starts the agent, so the generation notice never arrives: the draft-prewarm session is not
   * rebuilt and attachments stick in waitingSession until the user sends once manually. This event is the only dispose-time signal.
   *
   * Consumers subscribe to one of the two per the established sessionsIndexStore pattern (with this method, skip onRuntimeRestart),
   * so one generation change is handled once, not twice per channel. Absent when the carrier exposes no runtime lifecycle.
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

export interface ConversationAttachmentReadParams {
  sessionId: string;
  ref: string;
  /** Only decides whether to query the Desktop local video source; final MIME stays CLI-authoritative. */
  mediaType?: string;
  /** New rows carry a stable identity; keep ref-only compat when old snapshots lack it. */
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  /** Stops further chunked requests on dialog close, switch, or unmount. */
  signal?: AbortSignal;
}

/** Conversation topic key (dual of the CLI parseConversationTopic), re-exported from the protocol package. */
export { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
