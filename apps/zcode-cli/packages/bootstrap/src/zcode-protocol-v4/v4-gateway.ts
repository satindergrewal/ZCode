import { LocalTtftRecorder } from "./local-ttft.js";
import { localTtftNow, localTtftFactsSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  type BackgroundBashOutputResult,
} from "@zcode/shared/zcode-protocol-v4";
// V4 conversation gateway (host-channel layer, CLI side).
// Responsibilities: per-session ConversationTopicPublisher registry + flushWindowMs scheduling
// + closing the loop v4/command -> CommandInbox -> host executor.
//
// Layering discipline:
// - this class does no network IO: physical frames go to the host via host.emitWireFrame (stdio notification / test collector).
// - command side effects are not implemented here: once the inbox rules, they go through host.executeCommand
//   and unimplemented commands return a structured error.
// - the flush timer is the only source of time; the publisher itself stays pure advancement (boundary unchanged).
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItemsResult,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowRunSessionSummary,
  MessageWithParts,
  SessionEvent,
  TargetChangedPayload,
  TurnId,
  FileSystemErrorCode,
} from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType, isFileSystemPortError } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import type {
  CommandAck,
  AttachmentRef,
  CommandEnvelope,
  CommandKey,
  CommandResult,
  ConversationRowTarget,
  CommandsQueryResult,
  ConversationInputIntent,
  ConversationTopicFrame,
  QueueItem,
  RoutedTopicFrame,
  RoutedTopicWireFrame,
  SessionSummary,
  SessionsIndexTopicFrame,
  SubscribeAck,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationOpenTiming,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  readZCodeAttachmentFaultCode,
  encodeTopicWireFrames,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  parseCommandEnvelope,
  measureTopicNotificationEnvelopeBytes,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowParamsSchema,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationPlansParamsSchema,
  WORKFLOW_ARTIFACT_LIMITS,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  WORKFLOW_WORKSPACE_LIMITS,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import {
  ColdSessionResumeCoordinator,
  type ColdSessionResumeOutcome,
} from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import type {
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
} from "./product-projection.js";
import type { ConversationRowTargetAction } from "./product-projection.js";
import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";

function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // The conversation projection keeps product turnIds as strings for row-indexing;
  // calls leaving the gateway for runtime file summary/fallback need the contracts branded type restored.
  return turnId as TurnId | null;
}

function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
    case "setHighspeedMetrics":
      return type;
    default:
      return null;
  }
}

interface PersistedEventsLoadResult {
  events: SessionEvent[];
  synthesized: boolean;
  /** Store-verified child manifest injected after durable replay, before live-buffer backfill. */
  subagentsSeed?: SessionSubagentsSeed;
  /** shared_context creates no visible row; only sanitized handover metadata is published. */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** Raw-sequence level already included when the memory eventStore snapshotted. */
  sourceEventSeq?: number;
  /** Seed sharing the capacity of this historical event; null = queried but no historical level. */
  usageSeed?: SessionUsageSeed | null;
}

export type V4GatewayErrorContext = Record<string, unknown>;

/**
 * One read-back whole-byte payload, for reuse by chunked reads.
 *
 * Two families share this table: previews of sent attachments (attachmentRead) and the bytes of dwf user-facing artifacts
 * (workflowRunArtifactRead). Sharing is deliberate: their invalidation rules are identical word for word (TTL, byte budget,
 * oldest evicted first, cleared by sessionId on session destroy), while two tables would mean two independent byte budgets
 * and the "how many bytes may be cached" constraint would become unstatable.
 *
 * Key spaces are distinguished by a leading tag segment (att / dwfart), not by field count or content: both families key
 * on NUL-separated four-or-five segments where the count matches and contents can collide (an artifact id named "1" and an
 * attachmentIndex 1 look alike); only an impossible-to-equal leading segment is provable isolation.
 *
 * bytes=null means the read is in flight: the entry does not count against the budget and is not evicted by it (evicting an
 * awaited entry just re-reads the whole file for the next chunk, which is exactly what this table exists to prevent).
 */
interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export interface V4GatewayHost {
  cliVersion?: string;
  /** Whether the session is live in the host registry (basis for the inbox sessionNotFound verdict). */
  sessionExists(sessionId: string): boolean;
  /**
   * V4 cold-restore hook. The gateway wraps runtime activation and projection hydration in one
   * READY promise; the host only restores the record.
   */
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  /**
   * Downstream physical-frame sink (the host delivers: stdio notification / MessagePort / ws).
   *
   * The logical-frame fallback bypasses the 1MiB cap, chunking, and the receiver's atomic-assembly boundary; both the production
   * host and test hosts must therefore accept physical wire explicitly; the type layer no longer allows falling back to logical frames.
   */
  emitWireFrame(frame: RoutedTopicWireFrame): void;
  /** Body-less facts of live ingest in this process; not cached, never in topic replay. */
  emitConversationTelemetryFact?(fact: ConversationTelemetryFact): void;
  emitLocalTtftFacts?(facts: import("@zcode/shared").LocalTtftFacts): void;
  /** live request_access permission facts of this process; not cached, never in topic replay. */
  emitCuaPermissionObservation?(observation: CuaPermissionObservation): void;
  /**
   * sessions-index: session -> owning workspaceId (the bucket key for list topics).
   * Unimplemented (legacy host): the whole sessions-index path stays inactive (no-op) and does not affect conversation.
   */
  getSessionWorkspaceId?(sessionId: string): string | null;
  /** sessions-index: list-facing metadata for a session (createdAt/parent/last activity). */
  getSessionIndexMeta?(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    parentSessionId?: string;
  } | null;
  /**
   * config seed: the session runtime's current truth (model selection, reasoning depth, collaboration mode).
   * Projection initial values must not hardcode empties. The runtime's startup default model, the project-persisted mode preference, and the
   * previous selection restored on resume live only in the runtime (ModelSelected is emitted only after
   * switchModelConfig and may be absent from the log); the seed is their only path into the projection.
   * Unknown session returns null (gateway skips, initial value stays empty); unimplemented (legacy host/test stub) likewise.
   */
  getSessionConfigSeed?(sessionId: string): SessionConfigSeed | null;
  /** Read-only session-creation App switches; never reads live settings or infers Memory tool usage. */
  getSessionMemoryEnabled?(sessionId: string): boolean | undefined;
  /**
   * Cold-restore usage seed: transcript synthesis may only produce 0/default-window placeholder
   * ModelCompletes; the host can supply real levels from persisted assistant tokens / the runtime
   * snapshot. Unimplemented -> keep the event-log reduction result.
   */
  getSessionUsageSeed?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<SessionUsageSeed | null> | SessionUsageSeed | null;
  /** sessions-index: session ids currently registered under a workspace (cold-start snapshot). */
  listWorkspaceSessionIds?(workspaceId: string): string[];
  /**
   * sessions-index: draft decision. Sessions persisted as deferred with no first input stay out of the list.
   * The legacy workspace prepare path pre-creates deferred sessions (historically the list read sqlite and
   * deferred rows were not persisted, hence invisible); once sessions-index derives from the live registry those ghost drafts
   * appear as "new tasks" in the sidebar. After the first sendText promotes persistence to immediate,
   * the event flow triggers fanOutToIndex and the session enters the list. Unimplemented (legacy host/test stub): no filtering.
   */
  isDraftSession?(sessionId: string): boolean;
  /**
   * sessions-index: build lightweight summaries for all of a workspace's sessions straight from the persisted store (cold-start seed).
   * Sessions without a live publisher enter the list through it; loaded sessions are overridden by the gateway's live projection.
   * The store read is async, so returning a Promise is allowed (the gateway awaits on subscribe; a sync stub returns the array directly).
   */
  getStoredSessionSummaries?(workspaceId: string): Promise<SessionSummary[]> | SessionSummary[];
  /**
   * 3.3.6 remote-history compatibility: claim idempotently with the exact task allowlist, then return the strict identity summary.
   * Non-remote workspaces return null; on failure degrade to an empty array, later subscriptions carrying the allowlist retry.
   */
  refreshLegacySessionSummaries?(
    workspaceId: string,
    legacyTaskIds: readonly string[],
  ): Promise<SessionSummary[] | null> | SessionSummary[] | null;
  /**
   * workspace-config: a workspace's config directory (config options + slash commands).
   * Both the subscribe-time seed and the invalidateWorkspaceConfig re-pull go through here.
   * Unimplemented (legacy host / test stub): the workspace-config path degrades to an empty directory snapshot.
   */
  getWorkspaceConfig?(
    workspaceId: string,
  ): Promise<WorkspaceConfigState | null> | WorkspaceConfigState | null;
  readBackgroundBashOutput?(sessionId: string, workId: string): Promise<BackgroundBashOutputResult>;
  /** Side effects for accepted commands; the return value goes into ACK.result (fork/createSession carry sessionId). */
  executeCommand(
    envelope: CommandEnvelope,
    admission?: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<CommandResult | undefined>;
  /** Persist durable admission before running a command; returns the full intent for the inbox to pin. */
  admitCommandInput?(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelCommandInput?(
    envelope: CommandEnvelope,
    queueItemId: string,
    reason: string,
  ): Promise<void>;
  /** Terminate the current turn when the projection exceeds 16MiB; the gateway guarantees once per fault cycle. */
  terminateTurnForProjectionFault?(
    sessionId: string,
    reasonCode: "proto.payloadTooLarge",
  ): Promise<void> | void;
  /** commands/query persistence fallback; all four sources must match exactly by sourceCommandId. */
  lookupTranscriptCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupTimelineCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupChildCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupDiscardedCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  /** After transcript atomic promotion: invalidate stale lazy seeds, then release the CommandInbox live pin. */
  invalidatePersistentCommandFacts?(sessionId: string): void;
  /** Canonical goal complete entered the projection; host side effects must be detached, never blocking ingest. */
  onTargetCompleted?(sessionId: string, event: SessionEvent): void;
  /** The real Highspeed elapsed time lands in the transcript on CLI terminal state; host side effects must be detached. */
  onHighspeedTurnTerminal?(
    sessionId: string,
    event: SessionEvent,
    snapshot: ConversationSnapshot,
  ): void;
  /** Written once per completed chunk transaction; stores the session artifact. */
  putSessionAttachment?(
    sessionId: string,
    input: { fileName: string; mime: string; bytes: Uint8Array },
  ): Promise<{ ref: string }>;
  /** Read-only query for sent image/video/PDF; the gateway completes row/ref authorization before the host is touched. */
  readSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      maxBytes: number;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Share-selection userInput attachment metadata stat; the gateway completes row/index authorization first. */
  statSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop-local sent-video path; the gateway completes row/index authorization before the host is touched. */
  resolveSessionAttachmentPreviewSource?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<V4AttachmentPreviewSourceResult>;
  getConversationFileChanges?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileChangesResult>;
  previewConversationFileRewind?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /**
   * Paginated event log of a workflow run (the detail page's audit surface). Absent = the session runtime lacks the
   * capability (no dwf journal -> no run service at all); the gateway returns a structured capability-unsupported error.
   */
  listDynamicWorkflowRunEvents?(
    sessionId: string,
    input: { runId: string; afterSequence?: number; limit?: number; maxBytes?: number },
  ): Promise<DynamicWorkflowRunEventsResult>;
  /**
   * Enumeration surface for dwf runs (post-restart discovery).
   * Absence conditions as {@link listDynamicWorkflowRunEvents}.
   */
  listDynamicWorkflowRuns?(
    sessionId: string,
    input: { limit?: number },
  ): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Read facade for a workflow run's user-facing artifacts. All three appear together or not at
   * all (registered under one app-side condition). Absence as {@link listDynamicWorkflowRunEvents}.
   *
   * Terminology: artifact = output the script published to the user via artifact.*, NOT the run's top-level return value.
   */
  listDynamicWorkflowRunArtifacts?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  listDynamicWorkflowRunArtifactItems?(
    sessionId: string,
    input: {
      runId: string;
      artifactId: string;
      afterSequence?: number;
      limit: number;
      maxBytes: number;
      fields?: readonly string[];
    },
  ): Promise<DynamicWorkflowRunArtifactItemsResult>;
  readDynamicWorkflowRunArtifact?(
    sessionId: string,
    input: { runId: string; artifactId: string; version: number },
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * A workflow run's workspace transcript: the two arrive together and are absent together.
   * Authorization is on the host side (the run belongs to this session); denied and unknown both return undefined.
   */
  listDynamicWorkflowRunWorkspaceNodes?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(
    sessionId: string,
    input: { runId: string; siteId: string; ordinal: number; maxBytes: number },
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  /**
   * Hydration: read the session's persisted events to rebuild the projection for cold subscription (fork child / resume /
   * app-restart). synthesized=true means the event log cannot cover the transcript and events were reverse-synthesized from it;
   * then even an existing cold publisher (built by the fork resume's racing ingest) must be REBUILT, or history never enters
   * the projection. synthesized=false (complete event log) keeps the existing live publisher (streaming must not be interrupted by a rebuild).
   * Unimplemented (legacy host): cold subscription degrades to an empty projection.
   */
  loadPersistedEvents?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<PersistedEventsLoadResult>;
  /** For low-frequency lifecycle and recovery verdicts only; never route high-frequency event/stream traces to the production log. */
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: V4GatewayErrorContext): void;
}

export interface ConversationV4GatewayOptions {
  now?: () => number;
  /** logEpoch generator (in-process random by default; tests inject a fixed value for determinism). */
  createLogEpoch?: (sessionId: string) => string;
}

interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

interface RawSequenceState {
  /** Runtime raw cursor already consumed by cold snapshot or live replay. */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset; corrected forward when sequence=0 appears. */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** Events the publisher successfully applied; runtime-sink-seen-but-still-gap-buffered events are not here. */
  appliedEventIds: Set<string>;
  /** Publisher apply-failure facts; also reject late-registered temporary sink waiters immediately. */
  failedEventById: Map<string, Error>;
  /** The notify sink may be out of order; drain into the projection only from sourceEventSeq+1 contiguously. */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** During synthesized-hydration rebuilds, backfill raw facts that arrived after the persisted read boundary. */
  recentRawEventsById: Map<string, SessionEvent>;
}

interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}

const PROJECTION_EVENT_COMMIT_TIMEOUT_MS = 25_000;
const MAX_TELEMETRY_EVENT_IDS = 2_000;
/** Retention for a terminal detached-subagent-child publisher with no subscribers, before the low-frequency tick reclaims it. */
export const DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000;

class ProjectionEventCommitWaitError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.projectionEventCommit.aborted"
      | "fault.projectionEventCommit.applyFailed"
      | "fault.projectionEventCommit.disposed"
      | "fault.projectionEventCommit.gatewayDisposed"
      | "fault.projectionEventCommit.rehydrated"
      | "fault.projectionEventCommit.timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionEventCommitWaitError";
  }
}

/**
 * Server-internal dispatch result: the initial frame is consumed only by the request-scoped
 * post-response outbox; the public JSON-RPC result schema always strictly `{ ack }`.
 */
export interface V4SubscribeDispatchResult<TFrame> {
  ack: SubscribeAck & { openTiming?: ConversationOpenTiming };
  initialFrame: TFrame | null;
  initialWires: RoutedTopicWireFrame[];
  commit(): boolean;
}

export function encodeReservedTopicFrame(
  reservation: TopicFrameReservation<RoutedTopicFrame>,
): RoutedTopicWireFrame[] {
  return encodeTopicWireFrames(reservation.frame, {
    deliveryKind: reservation.deliveryKind,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    logicalFrameId: reservation.logicalFrameId,
    logicalFrameOrdinal: reservation.logicalFrameOrdinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }) as RoutedTopicWireFrame[];
}

/** Commit the publisher watermark only after every downstream accepted the physical wire. */
export function emitReservedTopicFrame<F extends RoutedTopicFrame>(
  reservation: TopicFrameReservation<F>,
  emit: (wire: RoutedTopicWireFrame) => unknown,
): boolean {
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) emit(wire);
  return reservation.commit();
}

function subscriptionRouteKey(topic: string, subscriptionId: string, connectionId: string): string {
  return `${topic}\0${subscriptionId}\0${connectionId}`;
}

function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`zcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/** Error codes for attachments provably absent at the filesystem layer. */
const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * Normalize errors thrown by the host / FileSystemPort into attachment faults with stable codes.
 * A structured fault code from the host passes through untouched; otherwise decide by FileSystemPortError.code;
 * no match keeps the original error for upper layers to treat as "unknown", instead of guessing a definite class.
 */
function toShareStatFault(error: unknown): unknown {
  if (readZCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}

export class ConversationV4Gateway {
  private readonly publishers = new Map<string, ConversationTopicPublisher>();
  /** sessions-index: workspaceId -> list publisher (parallel to conversation; independent seq/logEpoch). */
  private readonly indexPublishers = new SessionsIndexPublisherRegistry();
  /** workspace-config: workspaceId -> config-directory publisher (conflated wholesale-replace state). */
  private readonly configPublishers = new Map<string, WorkspaceConfigPublisher>();
  /** Sessions whose first hydration completed (avoids duplicate rebuilds/double count; see hydratePublisher). */
  private readonly hydratedSessions = new Set<string>();
  /** First hydration is single-flight per session; concurrent panes share one rebuild result. */
  private readonly hydrationInFlight = new Map<string, Promise<ConversationTopicPublisher>>();
  /** READY level from cold activation to hydration; blocks only this recovery's commands/queries. */
  private readonly readyFlights = new Map<string, Promise<ConversationTopicPublisher>>();
  /** Raw accepted events within the load-await window; backfilled by cursor/eventId after rebuild. */
  private readonly hydrationBuffers = new Map<string, HydrationBuffer>();
  /** Per-session monotonic map between transcript-synthesized and runtime raw sequences. */
  private readonly rawSequenceStates = new Map<string, RawSequenceState>();
  /** Connection-independent; command admission decoupled from transport subscription lifetime. */
  private readonly projectionEventCommitWaiters = new Map<
    string,
    Map<string, Set<ProjectionEventCommitWaiter>>
  >();
  /** A live child with no bootstrap record of its own, fed raw events by the parent runtime. */
  private readonly detachedLiveSessions = new Set<string>();
  /**
   * Parent-record attribution and terminal time for a detached subagent child. The child has no record of its own; the publisher can only be
   * released with the parent record, or by a low-frequency tick after turn end with no subscribers past the grace window; otherwise it lingers until process exit.
   */
  private readonly detachedChildParent = new Map<string, string>();
  private readonly detachedChildrenByParent = new Map<string, Set<string>>();
  private readonly detachedTerminalAt = new Map<string, number>();
  /** Cold-restore coordinator (existing activation single-flight + error typing). */
  private readonly coldResume: ColdSessionResumeCoordinator;
  /** Per-subscription flush scheduling (the publisher holds no timers; scheduling belongs to the gateway). */
  private readonly flushStates = new Map<string, FlushState>();
  /** Control reservations awaiting ACK/outbox admission must not be pre-sent by online flush. */
  private readonly controlReservations = new WeakSet<object>();
  /** Transport high-water pauses key on trusted connectionId only; never touches ingest/publisher truth. */
  private readonly pausedConnections = new Set<string>();
  /** One over-budget cycle triggers at most one runtime stop; cleared once the terminal event arrives. */
  private readonly projectionFaultedSessions = new Set<string>();
  private readonly inbox: CommandInbox;
  private readonly attachmentUploads: AttachmentUploadRegistry;
  private readonly binaryReadCache = new Map<string, BinaryReadCacheEntry>();
  private binaryReadCacheBytes = 0;
  private readonly localTtft = new LocalTtftRecorder(
    localTtftNow,
    () => {
      this.host.onError?.(
        "v4.localTtft.completedCapacity",
        new Error("TTFT completed record capacity exceeded"),
      );
    },
    (facts) => {
      const parsed = localTtftFactsSchema.safeParse(facts);
      if (parsed.success) this.host.emitLocalTtftFacts?.(parsed.data);
    },
  );
  /** Index fan-out throttle for high-frequency progress events (14-sessions-index "event fan-out cadence"). */
  private readonly indexFanoutThrottle = new SessionsIndexFanoutThrottle({
    publish: (sessionId) => this.publishCurrentSummaryToIndex(sessionId),
  });
  private readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly createLogEpoch: (sessionId: string) => string;
  private readonly telemetryNormalizer = new ConversationTelemetryFactNormalizer();
  private readonly cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();
  private readonly telemetryEventIds = new Set<string>();
  private disposed = false;

  /** Lightweight metadata refresh after session-entry state changes; no conversation event replay. */
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void {
    const publisher = this.publishers.get(sessionId);
    if (!publisher) return;
    publisher.seedSharedContextImport(source);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
    }
  }

  constructor(
    private readonly host: V4GatewayHost,
    options: ConversationV4GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
    this.coldResume = new ColdSessionResumeCoordinator(host);
    this.inbox = new CommandInbox({
      getRevision: (sessionId) => {
        if (!this.host.sessionExists(sessionId)) return null;
        // Known session, no events yet -> no projection; treat revision as 0 (draft baseline).
        return this.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => this.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = this.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      lookupTranscriptCommand: (key) => this.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => this.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => this.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => this.host.lookupDiscardedCommand?.(key) ?? null,
      now: this.now,
    });
    this.attachmentUploads = new AttachmentUploadRegistry({
      now: this.now,
      putSessionAttachment: async (sessionId, input) => {
        if (!this.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return this.host.putSessionAttachment(sessionId, input);
      },
    });
    this.attachmentPruneTimer = setInterval(
      () => this.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    );
    (
      this.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
  }

  setConnectionFlowState(rawParams: unknown): void {
    const params = v4ConnectionFlowParamsSchema.parse(rawParams);
    if (params.state === "closed") {
      this.pausedConnections.delete(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      this.attachmentUploads.clearConnection(params.connectionId);
      return;
    }
    if (params.state === "saturated") {
      if (this.pausedConnections.has(params.connectionId)) return;
      this.pausedConnections.add(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      return;
    }
    if (!this.pausedConnections.delete(params.connectionId)) return;
    this.flushConnection(params.connectionId);
  }

  private clearConnectionFlushTimers(connectionId: string): void {
    for (const state of this.flushStates.values()) {
      if (state.connectionId !== connectionId || state.timer === null) continue;
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private flushConnection(connectionId: string): void {
    for (const [routeKey, state] of this.flushStates) {
      if (state.connectionId !== connectionId) continue;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      const publisher = this.publishers.get(state.sessionId);
      if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
        this.flushStates.delete(routeKey);
        continue;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }
    for (const workspaceId of this.indexPublishers.keys()) {
      this.flushIndex(workspaceId, connectionId);
    }
    for (const workspaceId of this.configPublishers.keys()) {
      this.flushConfig(workspaceId, connectionId);
    }
  }

  /** Authoritative event ingress: advance the projection and schedule framing per subscriber profile.flushWindowMs. */
  ingest(sessionId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) {
      const eventId = String(event.id);
      if (hydrationBuffer.eventIds.has(eventId)) return;
      // Record the raw fact first; it may wait for predecessors before entering the publisher.
      hydrationBuffer.eventIds.add(eventId);
      hydrationBuffer.rawEvents.push(event);
    }
    this.emitLiveTelemetryFact(sessionId, event);
    for (const normalizedEvent of this.normalizeRuntimeEventSequence(sessionId, event)) {
      try {
        this.localTtft.event(sessionId, normalizedEvent);
      } catch (error) {
        try {
          this.host.onError?.("v4.localTtft.observe", error);
        } catch {
          /* Diagnostic callbacks must not block real content either. */
        }
      }
      this.ingestNormalizedEvent(sessionId, normalizedEvent);
    }
  }

  private emitLiveTelemetryFact(sessionId: string, event: SessionEvent): void {
    const eventId = String(event.id);
    // Main session and detached children keep separate event sequences; eventId is not globally
    // unique across sessions. Deduping by eventId alone misread same-numbered child events as
    // main-session replays, silently dropping the foreground subagent's real turn facts.
    const telemetryEventKey = `${sessionId}\0${eventId}`;
    if (this.telemetryEventIds.has(telemetryEventKey)) return;
    this.telemetryEventIds.add(telemetryEventKey);
    if (this.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
      const oldest = this.telemetryEventIds.values().next().value;
      if (typeof oldest === "string") this.telemetryEventIds.delete(oldest);
    }
    try {
      const config =
        this.publishers.get(sessionId)?.getSnapshot().config ??
        this.host.getSessionConfigSeed?.(sessionId) ??
        undefined;
      const fact = this.telemetryNormalizer.normalize(sessionId, event, {
        memoryEnabled: this.host.getSessionMemoryEnabled?.(sessionId),
        modelName: config?.model,
        modelProvider: config?.provider,
      });
      if (fact) {
        this.host.emitConversationTelemetryFact?.(fact);
      }
    } catch (error) {
      // Turn facts must never block the conversation projection in reverse; strict-schema failures only log a diagnostic.
      this.host.onError?.("v4.telemetry.normalize", error);
    }
    try {
      const observation = this.cuaPermissionNormalizer.normalize(sessionId, event);
      if (observation) this.host.emitCuaPermissionObservation?.(observation);
    } catch (error) {
      // Permission observations are live-UI hints only; schema or projection failures must not block the conversation main line.
      this.host.onError?.("v4.cuaPermissionObservation.normalize", error);
    }
  }

  /** Waits until the given raw event finishes reorder drain and publisher projection apply. */
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway is disposed",
        ),
      );
    }
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.appliedEventIds.has(eventId)) return Promise.resolve();
    const failed = state.failedEventById.get(eventId);
    if (failed) return Promise.reject(failed);
    if (options.signal?.aborted) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal.reason },
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const byEvent = this.projectionEventCommitWaiters.get(sessionId) ?? new Map();
      this.projectionEventCommitWaiters.set(sessionId, byEvent);
      const waiters = byEvent.get(eventId) ?? new Set();
      byEvent.set(eventId, waiters);
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) byEvent.delete(eventId);
        if (byEvent.size === 0) this.projectionEventCommitWaiters.delete(sessionId);
      };
      const waiter: ProjectionEventCommitWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        // Rejecting only the current waiter would leave TurnStarted inside the raw gap alive;
        // after the command is cancelled the gap gets filled and late events still enter the canonical projection.
        // The event failure must be pinned into sequence state; later drains only advance the cursor and never apply again.
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.aborted",
            `projection event commit wait aborted: ${eventId}`,
            { cause: options.signal?.reason },
          ),
        );
      };
      const timeout = setTimeout(() => {
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.timeout",
            `projection event commit wait timed out: ${eventId}`,
          ),
        );
      }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
      timeout.unref?.();
      waiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Authorization already committed to the task transaction: retries must replay the authoritative log, never re-grant or drop the commit. */
  async waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void> {
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.failedEventById.has(eventId)) {
      const event = state.recentRawEventsById.get(eventId);
      if (
        event?.type !== SessionEventType.SessionModeChanged ||
        !(event.payload as { permissionGrant?: unknown }).permissionGrant
      ) {
        throw new Error("Permission grant event unavailable for recovery");
      }
      await this.hydrationInFlight.get(sessionId);
      this.hydratedSessions.delete(sessionId);
      await this.hydratePublisher(sessionId, undefined, true);
    }
    await this.waitForProjectionEventCommit(sessionId, eventId);
  }

  private ingestNormalizedEvent(sessionId: string, event: SessionEvent): void {
    const publisher = this.ensurePublisher(sessionId);
    const promotedQueueRemoval =
      event.type === SessionEventType.TurnSteerDiscarded &&
      (event.payload as { reason?: string }).reason === "promoted";
    const removedQueueItems =
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded
        ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
            (queueItemId) => {
              const item = publisher
                .getSnapshot()
                .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
              return item ? [item] : [];
            },
          )
        : [];
    try {
      publisher.ingest(event);
    } catch (error) {
      const commitError =
        error instanceof ProjectionEventCommitWaitError
          ? error
          : new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply event ${String(event.id)}`,
              { cause: error },
            );
      this.rejectProjectionEventCommit(sessionId, String(event.id), commitError);
      if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
      this.host.onError?.("v4.projection.payloadTooLarge", error);
      if (!this.projectionFaultedSessions.has(sessionId)) {
        this.projectionFaultedSessions.add(sessionId);
        void Promise.resolve(
          this.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
        ).catch((terminateError) => {
          this.host.onError?.("v4.projection.terminate", terminateError);
        });
      }
      return;
    }
    this.resolveProjectionEventCommit(sessionId, String(event.id));
    if (
      !this.hydrationBuffers.has(sessionId) &&
      (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError)
    ) {
      try {
        this.host.onHighspeedTurnTerminal?.(sessionId, event, publisher.getSnapshot());
      } catch (error) {
        this.host.onError?.("v4.projection.highspeedMetrics", error);
      }
    }
    if (
      event.type === SessionEventType.TargetChanged &&
      (event.payload as TargetChangedPayload).target?.status === "complete"
    ) {
      try {
        this.host.onTargetCompleted?.(sessionId, event);
      } catch (error) {
        this.host.onError?.("v4.projection.targetCompleted", error);
      }
    }
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.projectionFaultedSessions.delete(sessionId);
    }
    if (event.type === SessionEventType.TurnSteerQueued) {
      const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
      const item = queueItemId
        ? publisher
            .getSnapshot()
            .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
        : undefined;
      if (item) this.inbox.pinLiveInput(sessionId, item);
    }
    if (!promotedQueueRemoval) {
      if (removedQueueItems.length > 0) {
        // delete/clear already wrote the durable session_input as cancelled, but this session's
        // persistent command index may have cached a stale empty result. Invalidate before releasing the live pin,
        // or after LRU eviction the same commandId still reads unknown and gets re-executed.
        this.host.invalidatePersistentCommandFacts?.(sessionId);
      }
      for (const item of removedQueueItems) {
        this.inbox.releaseLiveInput({
          sessionId,
          commandId: item.sourceCommandId,
        });
      }
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
      if (sourceCommandId) {
        // The persistent index may have been queried before this user message existed; invalidate before unpinning,
        // so a later LRU-eviction re-read hits the just-committed transcript instead of the stale empty seed.
        this.host.invalidatePersistentCommandFacts?.(sessionId);
        this.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
      }
    }
    // Assistant conservation: the projection rejected a body stream (the classic subscribe-mid-turn /
    // missed-TurnStarted shape) -> clear the hydrated flag so the next subscription re-hydrates missing
    // segments from persisted facts; a silent drop keeps content missing until the user manually refreshes.
    if (publisher.getDroppedContentStreamEventCount() > 0 && this.hydratedSessions.has(sessionId)) {
      this.hydratedSessions.delete(sessionId);
      this.host.onError?.(
        "v4.assistantConservation",
        new Error(
          `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
        ),
      );
    }
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      this.scheduleFlush(routeKey, state, publisher);
    }
    // sessions-index fan-out (defensive: no exception may break the conversation main path).
    this.fanOutToIndex(sessionId, event);
  }

  /**
   // A subagent child uses the parent record's external sink but keeps its own session topic. Register such
   // detached live sessions explicitly, so an accidentally present cold publisher is never misread as a running child.
   */
  ingestDetachedLiveSession(
    sessionId: string,
    event: SessionEvent,
    parentSessionId?: string,
  ): void {
    if (!this.detachedLiveSessions.has(sessionId)) {
      this.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
    }
    this.detachedLiveSessions.add(sessionId);
    if (parentSessionId && parentSessionId !== sessionId) {
      this.detachedChildParent.set(sessionId, parentSessionId);
      let children = this.detachedChildrenByParent.get(parentSessionId);
      if (!children) {
        children = new Set();
        this.detachedChildrenByParent.set(parentSessionId, children);
      }
      children.add(sessionId);
    }
    // A child is a one-shot session: no record and no successor turn; its publisher used to linger until process exit.
    // Record the terminal time so pruneDetachedChildPublishers can release after grace; a new child turn revokes it.
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.detachedTerminalAt.set(sessionId, Date.now());
    } else if (event.type === SessionEventType.TurnStarted) {
      this.detachedTerminalAt.delete(sessionId);
    }
    this.ingest(sessionId, event);
  }

  /**
   * Low-frequency tick backstop: release detached child publishers that are terminal, subscriber-less, and record-less.
   * A released child re-subscribes through the normal cold resume (the child is persisted as subagent_child in the session store). Returns the released count.
   */
  pruneDetachedChildPublishers(
    nowMs: number = Date.now(),
    graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
  ): number {
    let released = 0;
    for (const [childId, terminalAt] of [...this.detachedTerminalAt]) {
      if (nowMs - terminalAt < graceMs) continue;
      if (this.host.sessionExists(childId)) continue;
      if (this.publishers.get(childId)?.hasSubscribers()) continue;
      this.releaseDetachedChild(childId);
      released += 1;
    }
    return released;
  }

  private releaseDetachedChild(childId: string): void {
    this.host.onDebug?.(`release detached live child publisher session=${childId}`);
    this.cleanupSessionRuntime(childId, { clearCommandInbox: false, notifyIndexRemoved: false });
  }

  /**
   * Advance a session's latest summary into its workspace's sessions-index publisher and flush to list subscribers.
   * The projection must keep advancing with no list subscribers, so the next snapshot read sees authoritative current state;
   * high-frequency streaming deltas (ModelStreaming) do not recompute the list, avoiding jitter (previews update on turn settle/other events).
   * Legacy host without getSessionWorkspaceId: a whole-path no-op.
   */
  private fanOutToIndex(sessionId: string, event: SessionEvent): void {
    if (event.type === SessionEventType.ModelStreaming) return;
    // Workflow progress is a high-frequency stream too (measured 4000 events in 8s), but the list must keep moving:
    // leading+trailing window throttle; events inside a window merge into one frame at window end, terminals still deliver within one window.
    if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
      this.indexFanoutThrottle.request(sessionId);
      return;
    }
    this.publishCurrentSummaryToIndex(sessionId);
  }

  /**
   * Publish the current complete projection to sessions-index.
   *
   // A fork child's resume first builds a transient draft publisher from a few live events;
   // synthesized hydration fills in the inherited history afterwards. If fan-out happened only on ingest(event),
   // a child with no further runtime event would stay on its draft baseline forever;
   // the task-index syncer would never observe draft->visible and never create the sidebar task row.
   */
  private publishCurrentSummaryToIndex(sessionId: string): void {
    // This publish already carries the merged within-window summary: the pending trailing frame is satisfied here, not sent twice.
    this.indexFanoutThrottle.notePublished(sessionId);
    const getWorkspaceId = this.host.getSessionWorkspaceId;
    if (!getWorkspaceId) return;
    try {
      const workspaceId = getWorkspaceId.call(this.host, sessionId);
      if (!workspaceId) return;
      if (this.host.isDraftSession?.(sessionId)) return;
      const indexPublisher = this.indexPublishers.get(workspaceId);
      if (!indexPublisher) return;
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) return;
      const changed = indexPublisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
      if (changed) this.flushIndex(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.sessionsIndex.ingest", error);
    }
  }

  /** Session list metadata (host-hook fallback: createdAt=0, lastActivityAt=now). */
  private resolveIndexMeta(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    parentSessionId?: string;
  } {
    const meta = this.host.getSessionIndexMeta?.(sessionId);
    return {
      createdAt: meta?.createdAt ?? 0,
      lastActivityAt: meta?.lastActivityAt ?? this.now(),
      ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    };
  }

  /** Push an index publisher's pending delta frames to all list subscribers. */
  private flushIndex(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.indexPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.emit", error);
      }
    }
  }

  /**
   * sessions-index subscription: subscribe to a workspace's session list (parallel to conversation subscribe;
   * the same RPC method dispatches on the topic prefix). Cold start: store summary seed + live-projection override for loaded sessions.
   */
  async subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const dispatch = await this.subscribeSessionsIndexReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a sessions-index topic: ${params.topic}`);
    }
    const publisher = await this.ensureIndexPublisher(workspaceId, params.legacyTaskIds);
    // ensure may cross async store/claim boundaries; if dispose happens before the await returns, the subscription must not be registered.
    this.indexPublishers.ensureActive();
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushIndex(workspaceId),
      );
    } catch (error) {
      // The initial logical frame can already fail physical encode on the 16MiB cap;
      // failure after registering the subscription/in-flight reservation must roll back, or a ghost owner that can never unsubscribe remains.
      result.rollback();
      throw error;
    }
  }

  /** Get-or-create a workspace's index publisher; on create, seed from store summaries overridden by live projections. */
  private async ensureIndexPublisher(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const existing = this.indexPublishers.get(workspaceId);
    const shouldRefreshLegacy =
      Boolean(legacyTaskIds?.length) && Boolean(this.host.refreshLegacySessionSummaries);
    if (existing && !shouldRefreshLegacy) return existing;

    return this.indexPublishers.runExclusive(workspaceId, () =>
      this.ensureIndexPublisherExclusive(workspaceId, legacyTaskIds),
    );
  }

  /** Per-workspace serialization: retryable claims/rereads and publisher construction must observe the same final snapshot. */
  private async ensureIndexPublisherExclusive(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const refreshed =
      legacyTaskIds && legacyTaskIds.length > 0
        ? ((await this.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
        : null;
    const existing = this.indexPublishers.get(workspaceId);
    if (existing) {
      // The claim must not bind to the first construction: once an empty seed enters the Map it blocks retries forever.
      // The re-read only fills missing entries, so cold-store defaults never override a live projection.
      if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
        this.flushIndex(workspaceId);
      }
      return existing;
    }
    const publisher = new SessionsIndexPublisher(
      workspaceId,
      this.createLogEpoch(`sessions-index/${workspaceId}`),
      this.now,
    );
    // Seed 1: lightweight summaries for every session in the store (unloaded ones enter the list).
    const stored = refreshed ?? (await this.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
    for (const summary of stored) publisher.seed(summary);
    // Seed 2: loaded sessions overridden by live projection (more accurate phase/preview/backgroundWork).
    const liveIds = this.host.listWorkspaceSessionIds?.(workspaceId) ?? [...this.publishers.keys()];
    for (const sessionId of liveIds) {
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) continue;
      // Drafts (deferred, no first input) stay out of the cold-start seed, matching fanOutToIndex's filter.
      if (this.host.isDraftSession?.(sessionId)) continue;
      publisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
    }
    this.indexPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /**
   * workspace-config subscription: subscribe to a workspace's config directory (parallel to conversation subscribe;
   * the same RPC method dispatches on the topic prefix). The subscribe-time seed pulls current config through the host hook.
   */
  async subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const dispatch = await this.subscribeWorkspaceConfigReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseWorkspaceConfigTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a workspace-config topic: ${params.topic}`);
    }
    const publisher = await this.ensureConfigPublisher(workspaceId);
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushConfig(workspaceId),
      );
    } catch (error) {
      // Same atomic boundary as sessions-index: encode failure = subscribe not admitted.
      result.rollback();
      throw error;
    }
  }

  /**
   * Config-directory publish entry (called by the host after provider-registry application / workspace default changes,
   * carrying the already-built directory; no host re-pull, avoiding a second throwaway app from buildWorkspaceState).
   * Conflation happens in the publisher (no frame when unchanged); with no publisher, build one synchronously with an empty seed
   * holding the latest state, so later subscribers get a complete snapshot from it.
   */
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void {
    if (this.disposed) return;
    let publisher = this.configPublishers.get(workspaceId);
    if (!publisher) {
      publisher = new WorkspaceConfigPublisher(
        workspaceId,
        this.createLogEpoch(`workspace-config/${workspaceId}`),
        this.now,
      );
      this.configPublishers.set(workspaceId, publisher);
    }
    try {
      if (publisher.publish(state)) this.flushConfig(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.workspaceConfig.publish", error);
    }
  }

  private async pullWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfigState | null> {
    if (!this.host.getWorkspaceConfig) return null;
    return (await this.host.getWorkspaceConfig(workspaceId)) ?? null;
  }

  /** Get-or-create a workspace's config publisher; on create, seed via the host hook. */
  private async ensureConfigPublisher(workspaceId: string): Promise<WorkspaceConfigPublisher> {
    const existing = this.configPublishers.get(workspaceId);
    if (existing) return existing;
    const publisher = new WorkspaceConfigPublisher(
      workspaceId,
      this.createLogEpoch(`workspace-config/${workspaceId}`),
      this.now,
    );
    const seed = await this.pullWorkspaceConfig(workspaceId).catch((error) => {
      this.host.onError?.("v4.workspaceConfig.seed", error);
      return null;
    });
    if (seed) publisher.publish(seed);
    // Concurrent subscribes during the await may have registered a publisher for the same workspace; first registration wins.
    const raced = this.configPublishers.get(workspaceId);
    if (raced) return raced;
    this.configPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /** Push a config publisher's pending delta frames to all subscribers. */
  private flushConfig(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.configPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.workspaceConfig.emit", error);
      }
    }
  }

  /** v4/conversation/subscribe: verdict + server-internal initial frame; the public response takes only the ACK. */
  async subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    const dispatch = await this.subscribeReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      throw new Error(`Unsupported topic: ${params.topic}`);
    }
    const isLiveConversation = this.hasLiveConversation(sessionId);
    this.host.onDebug?.(
      `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
    );
    // Hydration on first subscription rebuilds the projection from authoritative sources:
    // - no publisher (cold) -> build + replay;
    // - publisher present but event log cannot cover the transcript (fork child: resume's ingest raced in
    //   a cold publisher holding only fork events) -> REBUILD synthesized from the transcript;
    // - publisher present with a complete event log (streaming live) -> keep it; a replay would double-count and interrupt the stream.
    const restoreStartedAt = performance.now();
    const existingReady = this.readyFlights.get(sessionId);
    const publisher = existingReady
      ? await existingReady
      : !isLiveConversation
        ? await this.ensureColdReadyPublisher(
            sessionId,
            params.resumeThoughtLevel,
            params.workspace,
          )
        : await this.hydratePublisher(sessionId);
    const cliSessionRestoreMs = !isLiveConversation
      ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
      : undefined;
    // The legacy entry let the UI pick any deliveryProfile, defaulting to replayable when desktop
    // calls omitted it. Now only the trusted clientMode injected by the host attachment counts.
    const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    // subscribeReserved already built the wire projection; starting the clock after it would put large-session
    // row filtering/window truncation outside both the restore and encode spans. The start must cover build and physical encode.
    const initialFrameEncodeStartedAt = performance.now();
    const result = publisher.subscribeReserved({
      connectionId: params.connectionId,
      base: params.base,
      deliveryProfile: profileName,
      // Trusted injection in the same family as clientMode: the capability bit comes from this connection's clientHello and absence
      // always means legacy consumer (whole-key patch + legacy-UI trimming). resync/rehydrate reuse the bit recorded on the subscription, never re-fetch.
      workflowRunDeltas: params.workflowRunDeltas === true,
    });
    const routeKey = subscriptionRouteKey(
      params.topic,
      result.ack.subscriptionId,
      params.connectionId,
    );
    let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
    try {
      dispatch = this.subscribeDispatch(result.ack, result.reservation, () => {
        const state = this.flushStates.get(routeKey);
        if (state) this.scheduleFlush(routeKey, state, publisher);
      });
      dispatch.ack = {
        ...dispatch.ack,
        openTiming: {
          version: 1,
          ...(cliSessionRestoreMs !== undefined ? { cliSessionRestoreMs } : {}),
          initialFrameEncodeMs: Math.max(
            0,
            Math.round(performance.now() - initialFrameEncodeStartedAt),
          ),
          sessionRuntimeState: isLiveConversation ? "warm" : "cold",
          snapshotRowCount: publisher.getSnapshot().rows.window.length,
        },
      };
    } catch (error) {
      // When resubscribe initial encode fails the client still holds the old subId; the
      // replacement must roll back atomically, keeping old publisher subscription and flush timer.
      result.rollback();
      throw error;
    }
    // replacement is admitted only after encode succeeds; clear the old scheduling state then, and keep failure paths off the old owner.
    for (const [staleRouteKey, staleState] of this.flushStates) {
      if (staleState.sessionId !== sessionId) continue;
      if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
        continue;
      }
      if (staleState.timer) clearTimeout(staleState.timer);
      this.flushStates.delete(staleRouteKey);
    }
    this.flushStates.set(routeKey, {
      sessionId,
      topic: params.topic,
      subscriptionId: result.ack.subscriptionId,
      connectionId: params.connectionId,
      deliveryProfile: profileName,
      flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
      timer: null,
    });
    return dispatch;
  }

  /**
   * v4/conversation/resync: hit the existing subscription exactly by owned topic/connection,
   * keeping subId/profile, and re-adjudicate resume/snapshot from the client's base.
   */
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame> {
    const params = v4ConversationResyncParamsSchema.parse(rawParams);
    const request = {
      base: params.base,
      ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
    };
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId !== null) {
      const publisher = this.publishers.get(sessionId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const routeKey = subscriptionRouteKey(
        params.topic,
        params.subscriptionId,
        params.connectionId,
      );
      const flushState = this.flushStates.get(routeKey);
      if (flushState?.timer) {
        clearTimeout(flushState.timer);
        flushState.timer = null;
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(result.ack, result.reservation, () => {
          const state = this.flushStates.get(routeKey);
          if (state) this.scheduleFlush(routeKey, state, publisher);
        });
      } catch (error) {
        // If physical encode fails before ACK admission, same-sub recovery must leave no new
        // inFlight nor cancel the old online flush; restore old state atomically and re-arm the timer.
        result.rollback();
        if (flushState) this.scheduleFlush(routeKey, flushState, publisher);
        throw error;
      }
    }

    const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
    if (indexWorkspaceId !== null) {
      const publisher = this.indexPublishers.get(indexWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushIndex(indexWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }

    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      const publisher = this.configPublishers.get(configWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushConfig(configWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }
    throw new Error(`Unsupported topic: ${params.topic}`);
  }

  /**
   * v4/conversation/rowsRange: fetch one window of history rows upward by the beforeRowId cursor.
   * Read-only query, no subscription; the data source is the session projection's full rows. A cold session (opened straight after
   * restart) reuses the same cold-recovery + hydration pipeline as subscribe to build the projection first.
   */
  async rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult> {
    const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    return publisher.getRowsRange(
      {
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      },
      // clientMode picks the row-visibility filter tier: desktop continuous (default) / disconnected-recovery replayable.
      params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
    );
  }

  /** Terminal plan directory of the fully valid projection; cold sessions reuse subscribe hydration. */
  async plans(rawParams: unknown): Promise<V4ConversationPlansResult> {
    const params = v4ConversationPlansParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    return publisher.getPlans();
  }

  /**
   * Paginated read of a workflow run's event log (cursor = journal sequence).
   *
   * Kin to rows/range and plans: read-only, stateless, safe to re-send on timeout. Deliberately NOT a v4 command:
   * a command ACKs with that closed "mutation result" discriminated union; a read-only page does not belong to that vocabulary.
   *
   * Both the row-count and byte bounds are set here (docs/execution-engine.md, "Reading the journal"): the count is the
   * caller's limit, defaulting to the protocol cap; the byte bound is always the protocol cap, the renderer cannot loosen it. hasMore is
   * decided by the store: a page may end early on bytes, so "filled the limit" is no longer the criterion.
   */
  async workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult> {
    const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunEvents) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const page = await this.host.listDynamicWorkflowRunEvents(params.sessionId, {
      runId: params.runId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      limit: params.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
      maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
    });
    return v4ConversationWorkflowRunEventsResultSchema.parse(page);
  }

  /**
   * Enumerated query for dwf runs. Kin to
   * workflowRunEvents: read-only, stateless, safe to re-send on timeout. limit defaulting/clamping lives on the CLI side
   * (run service); this only passes through, and resumable is computed by the CLI with the same predicate as the resume gate.
   */
  async workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult> {
    const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRuns) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const runs = await this.host.listDynamicWorkflowRuns(params.sessionId, {
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return v4ConversationWorkflowRunsResultSchema.parse({ runs });
  }

  /**
   * A workflow run's user-facing artifact listing.
   * Same family as workflowRunEvents: read-only, stateless, safe to re-send on timeout.
   *
   * Terminology: artifact here means output published to the user by a script via `artifact.*`,
   * not the run's top-level return value (the engine's same-named notion).
   *
   * An unknown runId returns an empty list, not an error: an evicted/never-existing run simply has no artifacts. That is a
   * fact, not a failure; see the event log's handling of out-of-range cursors for the same posture.
   */
  async workflowRunArtifacts(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactsResult> {
    const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifacts) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const artifacts = await this.host.listDynamicWorkflowRunArtifacts(params.sessionId, {
      runId: params.runId,
    });
    return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
  }

  /**
   * Preset-dashboard fetch facade: paginate the `report` entries of one artifact.
   *
   * Count defaulting/clamping and the byte bound are set here (the store implements them exactly, never inventing page sizes nor re-clamping). fields passes through: the board wants only the spec-named fields, fetched by SQLite; hasMore is the store's call, since a page may end early on bytes, so the criterion is never
   * "this page happens to be full", nor the gateway fetching one extra row.
   */
  async workflowRunArtifactData(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
    const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifactItems) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunArtifactItems",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const limit = Math.max(
      1,
      Math.min(
        params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
        WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
      ),
    );
    const page = await this.host.listDynamicWorkflowRunArtifactItems(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      limit,
      maxBytes: WORKFLOW_ARTIFACT_LIMITS.maxPageBytes,
      ...(params.fields === undefined ? {} : { fields: params.fields }),
    });
    return v4ConversationWorkflowRunArtifactDataResultSchema.parse(page);
  }

  /**
   * Artifact content bytes, verbatim like attachmentRead: one chunk at a time, <= 512 KiB (the
   * schema pins the limit bound), `nextOffset` null means the end.
   *
   * Authorization lives entirely host-side (the port implementation): the run must belong to session `sessionId` and the journal must
   * have a completed (artifactId, version) row; only then is the row's uri used to read from the store. The gateway does
   * parameter validation and chunking only: it has no journal and must not grow a second authorization criterion (two layers judging the same id
   * will eventually disagree). A host undefined = no such version / not your run /
   * it is a board block (no bytes): all three are the same business fact to the caller, normalized here into a structured not-found.
   *
   * An out-of-range `offset` is not an error: empty chunk + `nextOffset: null`, same shape as EOF.
   */
  async workflowRunArtifactRead(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
    const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunArtifact) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const artifact = await this.readWorkflowArtifactPayload(params);
    const totalBytes = artifact.bytes.byteLength;
    const start = Math.min(params.offset, totalBytes);
    const end = Math.min(start + params.limit, totalBytes);
    const chunk = artifact.bytes.subarray(start, end);
    return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: artifact.mediaType,
      totalBytes,
      nextOffset: end < totalBytes ? end : null,
    });
  }

  /**
   * A workspace transcript listing: a run's
   * `files.*` / `git.*` / `world.run` rows, without bodies.
   *
   * A host undefined (unknown run / not your run) yields an empty list, not an error: same posture as the artifact list,
   * also required by the authorization rule "do not tell an unauthorized caller which half they guessed". Lists over maxNodes are truncated with `truncated`:
   * a run that looped world.run three thousand times must not blow up the side panel.
   */
  async workflowRunWorkspace(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
    const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunWorkspaceNodes) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunWorkspaceNodes",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const nodes =
      (await this.host.listDynamicWorkflowRunWorkspaceNodes(params.sessionId, {
        runId: params.runId,
      })) ?? [];
    const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
    return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
      nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  /**
   * The body of a workspace node, size-bounded by maxBytes (default and cap both resultMaxBytes, clamped here).
   * Authorization is entirely host-side; a host undefined = no such node / not your run / not a world row, normalized into a
   * structured not-found.
   */
  async workflowRunNodeResult(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunNodeResultResult> {
    const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunNodeResult) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId);
    const maxBytes = Math.max(
      1,
      Math.min(
        params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
        WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
      ),
    );
    const result = await this.host.readDynamicWorkflowRunNodeResult(params.sessionId, {
      runId: params.runId,
      siteId: params.siteId,
      ordinal: params.ordinal,
      maxBytes,
    });
    if (result === undefined) {
      throw new Error(
        `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
      );
    }
    return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
  }

  /**
   * One artifact version's entire bytes, cached.
   *
   * The port's `readArtifact` returns whole bytes while
   * `workflowRunArtifactRead` is chunked — uncached, a 20 MiB PDF taken in 512 KiB chunks would
   * read the whole file from the store 40 times (800 MiB of IO), each chunk also redoing the
   * journal authorization chain. `attachmentRead` already has this table; reuse it (see
   * {@link BinaryReadCacheEntry} for why both families share one table).
   *
   * What's cached is the promise, not the result, and it's written before the read starts: concurrent
   * chunk fetches share one read instead of each issuing one and each writing the cache.
   *
   * Authorization cannot be bypassed by the cache: the key carries sessionId, the very object of the port's authorization check
   * (the run's parentSessionId must equal it); a different session is a different key and necessarily re-enters the port. On session destroy the
   * whole key space clears by sessionId, the same rule as attachments.
   *
   * Host `undefined` (not your run / no such version / dashboard block) throws here instead of
   * being cached: the existing catch branch deletes the entry, so a "just-published, read slightly
   * too early" race isn't pinned by a negative cache for 30s.
   */
  private readWorkflowArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // First-segment tag `dwfart`: shares the attachment table, isolated by the first segment (see BinaryReadCacheEntry).
    const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    const payload = this.host.readDynamicWorkflowRunArtifact!(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      version: params.version,
    })
      .then((artifact) => {
        if (artifact === undefined) {
          throw new Error(
            `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
          );
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = artifact.bytes.byteLength;
          this.binaryReadCacheBytes += artifact.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        // contentType normalizes into the table's mediaType vocabulary; the value is still the one recorded in the journal
        // (the UI dispatcher's exact-match contract), not the one the store guesses from the filename.
        return { bytes: artifact.bytes, mediaType: artifact.contentType };
      })
      .catch((error: unknown) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, {
      sessionId: params.sessionId,
      accessedAt: now,
      bytes: null,
      payload,
    });
    return payload;
  }

  /**
   * Host-record precondition for the two dwf journal read facades.
   *
   * Both queries read the journal through app capability while the host finds the record by sessionId; a history
   * session's record is activated only by the subscribe path. In the renderer the query-declaring effect is declared before the lease/subscription
   * effect, and the CLI dispatches requests strictly in order (zcode-protocol/transport.ts; only session/stop
   * jump the queue), so on "open a history session after restart" the query necessarily precedes the subscription and gets sessionNotFound:
   * the tool card's join fallback disappears whole, the card falls back to its compiled state, and the interrupted run has no entry at all.
   *
   * Fetch the record only, do NOT build a READY publisher: the journal is unrelated to the conversation log, and reading one page of a run
   * needs no projection (see these queries deliberately carrying no atSeq/atLogEpoch). The idiom matches attachmentBegin
   * word for word; ensureResumably single-flights per session and shares one activation with concurrent subscribes.
   *
   * Liveness must reuse subscribe's very own
   * hasLiveConversation, never a bare sessionExists. A dwf actor transcript is a detached live
   * session: the real runtime lives in the run service and the host deliberately has no record; a nested SessionPane discovery
   * query arriving here with an actor id would, under the old check, materialize a second (ghost) runtime for a RUNNING
   * session: appending SessionResumed to the same event log, dropping pending steers, replaying resume hooks;
   * the double write scrambles the sequence ledger and the transcript freezes (symptom: the live view stuck at "working for xx s").
   */
  private async ensureHostRecordForJournalRead(sessionId: string): Promise<void> {
    if (this.hasLiveConversation(sessionId)) return;
    await this.coldResume.ensureResumed(sessionId);
  }

  async fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult> {
    const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
    if (!this.host.getConversationFileChanges) {
      throw new Error("fault.fileChanges.unsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileChanges");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.getConversationFileChanges(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  async backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult> {
    const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
    // Observation queries must not hydrate/resume cold sessions; existing runtimes authorize the task.
    if (!this.host.readBackgroundBashOutput) return { kind: "unsupported", workId };
    return backgroundBashOutputResultSchema.parse(
      await this.host.readBackgroundBashOutput(sessionId, workId),
    );
  }

  async fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult> {
    const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
    if (!this.host.previewConversationFileRewind) {
      throw new Error("fault.fileRewindPreview.unsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileRewindPreview");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.previewConversationFileRewind(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  private resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
    const snapshot = publisher.getSnapshot();
    if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
    if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
    const resolution = publisher.resolveRowActionTarget(params.target, action);
    if (!resolution.ok) throw new Error(resolution.reasonCode);
    return resolution;
  }

  /** begin admits metadata only; never decodes/stages the full payload. */
  async attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult> {
    const params = v4AttachmentBeginParamsSchema.parse(rawParams);
    if (!this.host.putSessionAttachment) {
      throw new Error("fault.attachment.putUnsupported");
    }
    if (!this.host.sessionExists(params.sessionId)) {
      await this.coldResume.ensureResumed(params.sessionId);
    }
    return this.attachmentUploads.begin(params);
  }

  async attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult> {
    return this.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
  }

  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult> {
    return this.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
  }

  async attachmentAbort(rawParams: unknown): Promise<void> {
    await this.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
  }

  async attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult> {
    const params = v4AttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new Error("fault.attachment.readUnsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      // A renderer-supplied ref is not a path yet; ownership must be proven by the current session's
      // authoritative user row first, avoiding cross-session or arbitrary-path reads.
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }

    const payload = await this.readAttachmentPayload(
      params.sessionId,
      params.ref,
      resolution.attachment.mime,
      resolution.messageId,
      resolution.attachmentIndex,
    );
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return {
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    };
  }

  async conversationAttachmentRead(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentReadResult> {
    const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let payload: { bytes: Uint8Array; mediaType: string };
    try {
      payload = await this.readAttachmentPayload(
        params.sessionId,
        params.ref,
        attachment.mime,
        messageId,
        params.attachmentIndex,
        true,
      );
    } catch (error) {
      throw toShareStatFault(error);
    }
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return v4ConversationAttachmentReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    });
  }

  async conversationAttachmentStat(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentStatResult> {
    const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
    if (!this.host.statSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let result: { totalBytes: number; mediaType: string; mtimeMs?: number };
    try {
      result = await this.host.statSessionAttachment(params.sessionId, {
        ref: params.ref,
        mime: attachment.mime,
        ...(messageId ? { messageId } : {}),
        attachmentIndex: params.attachmentIndex,
      });
    } catch (error) {
      // "Attachment is really gone" is the only share-precheck classification decidable as skip; it
      // must surface as a stable code, else the service can only guess at error text.
      throw toShareStatFault(error);
    }
    // stat results used to be stuck by the 30MiB schema cap: oversized attachments threw ZodError here,
    // so the share precheck degraded a definite "known size over cap" block into deferred and silently dropped content.
    // Even with the cap raised, an explicit exit remains necessary: a stable code when the size truly exceeds what the protocol can express.
    if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
    }
    return v4ConversationAttachmentStatResultSchema.parse(result);
  }

  async attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult> {
    const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }
    if (
      params.clientMode !== "desktop-continuous" ||
      !resolution.attachment.mime.startsWith("video/") ||
      !this.host.resolveSessionAttachmentPreviewSource
    ) {
      return { kind: "chunked" };
    }
    const result = await this.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
      ref: params.ref,
      mime: resolution.attachment.mime,
      ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
      ...(resolution.attachmentIndex !== undefined
        ? { attachmentIndex: resolution.attachmentIndex }
        : {}),
    });
    return v4AttachmentPreviewSourceResultSchema.parse(result);
  }

  private resolveReadableMediaAttachment(
    publisher: ConversationTopicPublisher,
    sessionId: string,
    ref: string,
    target?: { rowId: number; entityId: string },
    attachmentIndex?: number,
  ): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
    const isPreviewable = (attachment: AttachmentRef) => {
      const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      // Root cause: the original preview admitted only images/video/PDF, rejecting text attachments even when owned by the current row.
      // Text is opened only for the existing material marker; ownership still must pass the authoritative row, attachment index, and ref checks.
      return (
        mime.startsWith("image/") ||
        mime.startsWith("video/") ||
        mime === "application/pdf" ||
        (mime === "text/plain" &&
          (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text"))
      );
    };
    const matchesRef = (attachment: AttachmentRef) =>
      attachment.ref === ref || attachment.previewRef === ref;
    if (target && attachmentIndex !== undefined) {
      const row = publisher
        .getSnapshot()
        .rows.window.find(
          (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
        );
      if (row?.kind !== "userInput") return null;
      const attachment = row.attachments?.[attachmentIndex];
      if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
        return null;
      }
      // A hot renderer may still hold the original ref while the hydrated authoritative row already carries
      // previewRef; both belong to the same row/index, so authorization must not misread projection timing as a cross-row read.
      const messageId = publisher.getMessageIdForRow(row.rowId);
      return {
        attachment,
        attachmentIndex,
        ...(messageId ? { messageId } : {}),
      };
    }

    // Legacy renderers have no row target and cannot locate the persisted artifact by message; once
    // previewRef exists only that durable ref may be authorized — never re-admit the mutable raw path.
    for (const row of publisher.getSnapshot().rows.window) {
      if (row.kind === "userInput") {
        for (const attachment of row.attachments ?? []) {
          if (!isPreviewable(attachment)) continue;
          if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
        }
      }
      if (
        row.kind === "assistantText" &&
        artifactRefBelongsToSession(ref, sessionId) &&
        extractMarkdownArtifactImageRefs(row.text).includes(ref)
      ) {
        // Assistant markdown may reference session artifacts produced by tools,
        // but the legacy authorization looked only at userInput.attachments, so legitimate images got blocked by harden in the UI.
        // Authorization still uses the current session's authoritative projection for exact refs, never accepting
        // renderer-reported artifact/path. Markdown is model-controlled text, so the URI authority
        // must also match the requesting session exactly; "appeared in the current projection" does not prove the right
        // to read another session's artifact.
        return {
          attachment: {
            ref,
            fileName: "assistant-image",
            mime: "image/*",
            bytes: 0,
          },
        };
      }
    }
    return null;
  }

  /**
   * Read all attachment bytes (TTL/capacity cached).
   *
   * Semantics note: conversationAttachmentRead's offset/limit is a slice, not streaming — each
   * first request materializes the whole attachment in memory, later chunks hit the same cache.
   * Integrators must not plan huge files around this as on-demand segment fetch; true range reads
   * need host-side readBinaryFile offset support (not yet implemented).
   */
  private readAttachmentPayload(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric = false,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // First-segment tag `att`: this table is shared with dwf artifact bytes (see
    // BinaryReadCacheEntry); the key spaces are isolated only by the provably unequal first segment.
    const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    // Preview reads used to reuse the upload's 20MiB total cap; video keeps the existing global
    // input cap, image and the upload transaction keep their original bounds.
    const maxBytes = allowGeneric
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : mime.startsWith("video/")
        ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
        : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
    const payload = this.host.readSessionAttachment!(sessionId, {
      ref,
      mime,
      maxBytes,
      ...(messageId ? { messageId } : {}),
      ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
    })
      .then((result) => {
        const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          !allowGeneric &&
          !resultMime.startsWith("image/") &&
          !resultMime.startsWith("video/") &&
          resultMime !== "application/pdf" &&
          !(
            resultMime === "text/plain" &&
            mime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
          )
        ) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
        }
        if (result.bytes.byteLength > maxBytes) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = result.bytes.byteLength;
          this.binaryReadCacheBytes += result.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        return result;
      })
      .catch((error) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, { sessionId, accessedAt: now, bytes: null, payload });
    return payload;
  }

  private pruneBinaryReadCache(now = this.now()): void {
    for (const [key, entry] of this.binaryReadCache) {
      if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
        this.deleteBinaryReadCacheEntry(key);
      }
    }
    if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
    const oldest = [...this.binaryReadCache.entries()]
      .filter(([, entry]) => entry.bytes !== null)
      .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    for (const [key] of oldest) {
      this.deleteBinaryReadCacheEntry(key);
      if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
    }
  }

  private deleteBinaryReadCacheEntry(key: string): void {
    const entry = this.binaryReadCache.get(key);
    if (!entry) return;
    this.binaryReadCache.delete(key);
    this.binaryReadCacheBytes = Math.max(0, this.binaryReadCacheBytes - (entry.bytes ?? 0));
  }

  /** v4/conversation/unsubscribe。 */
  unsubscribe(rawParams: unknown): void {
    const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      const workspaceId = parseSessionsIndexTopic(params.topic);
      if (workspaceId !== null) {
        this.indexPublishers
          .get(workspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
        return;
      }
      const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
      if (configWorkspaceId !== null) {
        this.configPublishers
          .get(configWorkspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
      }
      return;
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const state = this.flushStates.get(routeKey);
    if (!state) return;
    if (state?.timer) clearTimeout(state.timer);
    this.flushStates.delete(routeKey);
    // A bare subscriptionId can collide across topics/connections; the old gateway looked up by subId and
    // sprayed all three publisher kinds, deleting other connections. topic + connection must both match.
    this.publishers.get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
  }

  /**
   * v4/command: the inbox's six-way ruling; on accepted, run the side effects and return the terminal state with the response.
   *
   * This used to "ACK immediately, settle in background",
   * so createSession/forkAssistant callers never saw result.sessionId (settle only filled the
   * idempotency table, readable only by retrying with the same commandId), violating
   * "accepted carries result immediately". Command side effects return fast (sendPrompt starts the turn in background),
   * so awaiting does not hold the RPC for the whole turn: wait for the terminal state synchronously.
   * settle still pins the result for duplicate replay.
   */
  async handleCommand(rawParams: unknown): Promise<CommandAck> {
    let ttftCapacityRejected = false;
    const ttftCommand =
      typeof rawParams === "object" && rawParams !== null && "ttft" in rawParams
        ? parseCommandEnvelope(rawParams)
        : undefined;
    if (ttftCommand?.ok && ttftCommand.envelope.ttft) {
      const sessionId = ttftCommand.envelope.sessionId;
      const control = sessionId ? this.publishers.get(sessionId)?.getSnapshot().control : undefined;
      ttftCapacityRejected = !this.localTtft.receive(
        ttftCommand.envelope,
        control?.canStop === true,
      );
    }
    // READY exists only in the cold-recovery window; normal commands go straight into the inbox, avoiding envelope re-parsing.
    if (this.readyFlights.size > 0) {
      const parsed = parseCommandEnvelope(rawParams);
      const sessionId = parsed.ok ? parsed.envelope.sessionId : null;
      const ready = sessionId === null ? undefined : this.readyFlights.get(sessionId);
      if (ready) await ready;
    }

    const outcome = await this.inbox.handle(rawParams);
    if (outcome.kind === "ack")
      return {
        ...outcome.ack,
        ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
      };
    this.localTtft.admitted(outcome.envelope.commandId);
    let durableInputIntent: ConversationInputIntent | null = null;
    let settledAck: CommandAck | null = null;
    type CommandFinal = Parameters<typeof outcome.settle>[0];
    const reportError = (scope: string, error: unknown): void => {
      try {
        this.host.onError?.(scope, error);
      } catch {
        // Error observers must not break command-final or session-FIFO closing in reverse.
      }
    };
    const settleOnce = (final: CommandFinal): CommandAck => {
      if (settledAck) return settledAck;
      const ack = {
        ...outcome.ack,
        ...final,
        ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
      };
      outcome.settle(final);
      settledAck = ack;
      return ack;
    };
    const cancelDurableInput = async (reason: string): Promise<void> => {
      if (!durableInputIntent) return;
      try {
        await this.host.cancelCommandInput?.(outcome.envelope, outcome.queueItemId, reason);
      } catch (cancelError) {
        // The original command ACK must keep the real execution result; a ledger-cancel failure warns separately and never overwrites the original error.
        reportError("v4.command.input.cancel", cancelError);
      }
    };
    const releaseDurableInput = (
      final: Pick<CommandAck, "status" | "reasonCode" | "message" | "result">,
    ) => {
      if (!durableInputIntent || outcome.envelope.sessionId === null) return;
      try {
        this.inbox.releaseLiveInput(
          {
            sessionId: outcome.envelope.sessionId,
            commandId: durableInputIntent.sourceCommandId,
          },
          { ...outcome.ack, ...final },
        );
      } catch (releaseError) {
        reportError("v4.command.input.release", releaseError);
      }
    };
    try {
      const admission = {
        admissionSeq: outcome.admissionSeq,
        admittedAt: outcome.admittedAt,
        queueItemId: outcome.queueItemId,
      };
      const admissionPublisher =
        outcome.envelope.type === "createSession"
          ? new ConversationTopicPublisher(`pending-${outcome.envelope.commandId}`, "admission", {
              now: this.now,
            })
          : outcome.envelope.sessionId === null
            ? null
            : this.ensurePublisher(outcome.envelope.sessionId);
      const admissionProjectionBytes = admissionPublisher?.measureInputAdmissionProjectionBytes(
        outcome.envelope,
        admission,
      );
      if (
        admissionProjectionBytes !== null &&
        admissionProjectionBytes !== undefined &&
        admissionProjectionBytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      ) {
        return settleOnce({
          status: "failed",
          reasonCode: "proto.payloadTooLarge",
          message: `conversation projection would exceed ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
        });
      }
      durableInputIntent =
        (await this.host.admitCommandInput?.(outcome.envelope, admission)) ?? null;
      if (durableInputIntent && outcome.envelope.sessionId !== null) {
        this.inbox.pinLiveInput(outcome.envelope.sessionId, durableInputIntent);
      }
      const result = await this.host.executeCommand(outcome.envelope, admission);
      // New-session/side-chat commands adopt the result session's toggles, so parent-session or global App settings are not misrecorded onto the new session.
      const telemetrySessionId =
        result?.type === "createSession" || result?.type === "createSelectionSideSession"
          ? result.sessionId
          : outcome.envelope.sessionId;
      const memoryEnabled = telemetrySessionId
        ? this.host.getSessionMemoryEnabled?.(telemetrySessionId)
        : undefined;
      const final = {
        status: "accepted" as const,
        ...(result ? { result } : {}),
        ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
      };
      return settleOnce(final);
    } catch (error) {
      // Noop is not failure (same-value switch resolved): skip onError, return the noop ACK.
      if (error instanceof V4CommandNoopError) {
        await cancelDurableInput(error.reasonCode);
        const final = {
          status: "noop" as const,
          reasonCode: error.reasonCode,
        };
        releaseDurableInput(final);
        return settleOnce(final);
      }
      reportError("v4.command.execute", error);
      // Domain errors carrying reasonCode (V4PromptRejectedError / heldQueueDispositionRequired etc.)
      // pass through untouched so the client can branch on guard codes; everything else normalizes to executionFailed.
      const domainReasonCode =
        typeof (error as { reasonCode?: unknown } | null)?.reasonCode === "string"
          ? String((error as { reasonCode: string }).reasonCode)
          : null;
      const final = {
        status: "failed" as const,
        reasonCode:
          error instanceof V4CommandNotImplementedError
            ? "fault.command.notImplemented"
            : (domainReasonCode ?? "fault.command.executionFailed"),
        message: error instanceof Error ? error.message : String(error),
      };
      await cancelDurableInput(final.reasonCode);
      releaseDurableInput(final);
      return settleOnce(final);
    } finally {
      if (!settledAck) {
        // A synchronous exception in publisher/measure/admission used to skip settle, leaving the
        // same command waiting forever and blocking the session's FIFO admission too.
        const final = {
          status: "failed" as const,
          reasonCode: "fault.command.executionFailed",
          message: "command admission terminated before a durable final was recorded",
        };
        releaseDurableInput(final);
        settleOnce(final);
      }
    }
  }

  /** v4/commands/query: shares the CommandInbox gate with handleCommand for the same key. */
  async queryCommands(rawParams: unknown): Promise<CommandsQueryResult> {
    const receivedAt = localTtftNow();
    const params = commandsQueryParamsSchema.parse(rawParams);
    // Calibration is a pure clock probe: it must not trigger command-ledger queries, recovery, or the admission gate.
    if (params.clock)
      return {
        results: params.commands.map((key) => ({ key, result: "unknown" as const })),
        clock: { instanceId: this.localTtft.instanceId, receivedAt, sentAt: localTtftNow() },
      };
    await Promise.all(
      params.commands.map((key) => {
        const ready = key.sessionId === null ? undefined : this.readyFlights.get(key.sessionId);
        return ready;
      }),
    );
    return commandsQueryResultSchema.parse({
      results: await this.inbox.query(params.commands),
    });
  }

  getQueueItem(sessionId: string, queueItemId: string): QueueItem | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
    return item ?? null;
  }

  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.kind === kind),
    );
  }

  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue"): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
    );
  }

  getQueueLength(sessionId: string): number {
    return this.publishers.get(sessionId)?.getSnapshot().queue.items.length ?? 0;
  }

  /** Resident reclamation guard: with a publisher queue or pinned CommandInbox facts present, never close. */
  hasResidencyBlockingCommands(sessionId: string): boolean {
    return this.getQueueLength(sessionId) > 0 || this.inbox.hasPinnedSessionState(sessionId);
  }

  getQueueHead(sessionId: string): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items[0];
    if (!snapshot || !item) return null;
    return {
      autoDrain: snapshot.queue.autoDrain,
      dispatchState: item.dispatch.state,
      kind: item.kind,
      queueItemId: item.queueItemId,
      text: item.text,
    };
  }

  /**
   * Current input-routing mode (v4-native; used by the command layer's host.getInputRoutingMode):
   * held-choice verdicts (heldQueueInputRequiresChoice) read projection inputRouting.mode.
   */
  getInputRoutingMode(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
    return this.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
  }

  getSessionFollowupMode(sessionId: string): "queue" | "guide" | null {
    return this.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
  }

  /**
   * rowId -> authoritative messageId (v4-native; lets forkAssistant/retryTurn address assistant rows).
   * No publisher / missing row / non-assistant row -> null (the command layer rejects; no silent fallback).
   */
  getMessageIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
  }

  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ) {
    return this.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
  }

  /** rowId -> every transcript messageId in the owning product turn (file-summary undo / diff queries). */
  getMessageIdsForTurnRow(sessionId: string, rowId: number): string[] {
    return this.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
  }

  /** Fork targets must be the owning turn's last assistantText segment (no projection -> null, treated as unknown). */
  isLatestAssistantSegmentRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
  }

  resolveStableForkCandidate(sessionId: string, rowId: number) {
    return this.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
  }

  /** latestAssistantRetryOnly: the retry target must be the newest assistantText with a realUser cause. */
  isLatestRetryAssistantRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
  }

  /** latestQueryEditOnly: the edit target must be the current projection's last realUser userInput row. */
  isLatestEditableUserRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
  }

  /** rowId -> product turnId (editUserQuery's user-messageId lookup without an assistant anchor). */
  getTurnIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
  }

  /**
   * rowId -> the owning turn's rewind anchor messageId (for editUserQuery: the user row has no
   * messageId, so a same-turn assistant row's messageId serves as the /rewind target).
   */
  getTurnRewindAnchor(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
  }

  /** Session close: drop the publisher, its subscription scheduling, and hydration flags (reopen
   *  rebuilds cold); also remove it from the workspace index (session.removed to list subscribers). */
  disposeSession(sessionId: string): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: false,
      notifyIndexRemoved: true,
    });
  }

  /**
   * Resident deactivation: the same in-memory cleanup as disposeSession, but the session is NOT
   * removed from sessions-index (no session.removed) — deactivation is a pure memory optimization;
   * the sidebar entry must survive untouched, and a later subscribe transparently cold-restores.
   */
  deactivateSession(sessionId: string): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: true,
      notifyIndexRemoved: false,
    });
  }

  /**
   * Resident reclamation precheck only: callers may reject an unsafe reclaim before tearing down the runtime event subscription.
   * deactivateSession reuses the same check so future callers cannot bypass the execution-side preflight.
   */
  assertSessionRuntimeDeactivatable(sessionId: string): void {
    if (!this.inbox.hasPinnedSessionState(sessionId)) return;
    throw new Error(`Session command inbox is still pinned: ${sessionId}`);
  }

  /** Resident-reclamation verdict: does the session still have conversation subscribers (desktop tab / phone remote)? */
  hasConversationSubscribers(sessionId: string): boolean {
    return this.publishers.get(sessionId)?.hasSubscribers() ?? false;
  }

  /**
   * Memory diagnostics counters. Read sizes only, touch no state.
   * detachedLive observes whether child-session publishers die with their parent session.
   */
  collectMemoryDiagnostics(): Record<string, number> {
    return {
      publishers: this.publishers.size,
      detachedLive: this.detachedLiveSessions.size,
      detachedTerminal: this.detachedTerminalAt.size,
      rawSeqStates: this.rawSequenceStates.size,
    };
  }

  private cleanupSessionRuntime(
    sessionId: string,
    options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
  ): void {
    if (options.clearCommandInbox) {
      // Clearing in-flight/live commands breaks idempotency and FIFO. Resident facts are intercepted before reclamation;
      // if one still appears here, fail before tearing down the publisher; never leave a half-cleared state.
      this.assertSessionRuntimeDeactivatable(sessionId);
    }
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.disposed",
        `conversation session disposed while waiting for projection event commit: ${sessionId}`,
      ),
    );
    this.attachmentUploads.clearSession(sessionId);
    for (const [key, entry] of this.binaryReadCache) {
      if (entry.sessionId === sessionId) this.deleteBinaryReadCacheEntry(key);
    }
    if (options.notifyIndexRemoved) {
      // Take workspaceId first (while the session record lives) and push session.removed to list subscribers.
      try {
        const workspaceId = this.host.getSessionWorkspaceId?.(sessionId) ?? null;
        if (workspaceId !== null) {
          const indexPublisher = this.indexPublishers.get(workspaceId);
          // Even with no subscribers the projection must update first, or an existing publisher would
          // subscribe's snapshot; flushIndex is a natural no-op with no subscribers.
          if (indexPublisher?.removeSession(sessionId)) {
            this.flushIndex(workspaceId);
          }
        }
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.remove", error);
      }
    }
    this.indexFanoutThrottle.clearSession(sessionId);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (state.timer) clearTimeout(state.timer);
      this.flushStates.delete(routeKey);
    }
    this.publishers.delete(sessionId);
    this.hydratedSessions.delete(sessionId);
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) hydrationBuffer.cancelled = true;
    this.hydrationBuffers.delete(sessionId);
    this.hydrationInFlight.delete(sessionId);
    this.readyFlights.delete(sessionId);
    this.rawSequenceStates.delete(sessionId);
    if (options.clearCommandInbox) this.inbox.clearSession(sessionId);
    this.telemetryNormalizer.clearSession(sessionId);
    this.detachedLiveSessions.delete(sessionId);
    this.projectionFaultedSessions.delete(sessionId);
    // Detached-child attribution cleanup: remove self from the parent table as a child; as a parent, also release record-less children.
    this.detachedTerminalAt.delete(sessionId);
    const parentId = this.detachedChildParent.get(sessionId);
    if (parentId !== undefined) {
      this.detachedChildParent.delete(sessionId);
      const siblings = this.detachedChildrenByParent.get(parentId);
      siblings?.delete(sessionId);
      if (siblings && siblings.size === 0) this.detachedChildrenByParent.delete(parentId);
    }
    const children = this.detachedChildrenByParent.get(sessionId);
    if (children) {
      this.detachedChildrenByParent.delete(sessionId);
      for (const childId of children) {
        this.detachedChildParent.delete(childId);
        if (this.host.sessionExists(childId)) continue;
        this.releaseDetachedChild(childId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.localTtft.clear();
    for (const sessionId of this.projectionEventCommitWaiters.keys()) {
      this.rejectProjectionEventWaiters(
        sessionId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway disposed while waiting for projection event commit",
        ),
      );
    }
    clearInterval(this.attachmentPruneTimer);
    this.indexFanoutThrottle.clear();
    this.attachmentUploads.clear();
    this.binaryReadCache.clear();
    this.binaryReadCacheBytes = 0;
    for (const state of this.flushStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.flushStates.clear();
    this.publishers.clear();
    this.hydratedSessions.clear();
    for (const buffer of this.hydrationBuffers.values()) buffer.cancelled = true;
    this.hydrationBuffers.clear();
    this.hydrationInFlight.clear();
    this.readyFlights.clear();
    this.rawSequenceStates.clear();
    this.telemetryEventIds.clear();
    this.detachedLiveSessions.clear();
    this.detachedChildParent.clear();
    this.detachedChildrenByParent.clear();
    this.detachedTerminalAt.clear();
    this.projectionFaultedSessions.clear();
    this.coldResume.clear();
    this.indexPublishers.dispose();
    this.configPublishers.clear();
    this.pausedConnections.clear();
  }

  /** Test probe: drain a subscription immediately, bypassing timers. */
  flushNow(subscriptionId: string): ConversationTopicFrame | null {
    const match = [...this.flushStates.entries()].find(
      ([, state]) => state.subscriptionId === subscriptionId,
    );
    const state = match?.[1];
    if (!state) return null;
    if (this.pausedConnections.has(state.connectionId)) return null;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const publisher = this.publishers.get(state.sessionId);
    if (!publisher) return null;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  private ensurePublisher(sessionId: string): ConversationTopicPublisher {
    let publisher = this.publishers.get(sessionId);
    if (!publisher) {
      publisher = new ConversationTopicPublisher(sessionId, this.createLogEpoch(sessionId), {
        now: this.now,
      });
      this.publishers.set(sessionId, publisher);
      // Config seed: inject runtime truth at creation (no delta / no revision bump).
      this.seedPublisherConfig(sessionId, publisher);
    }
    return publisher;
  }

  /**
   * Config seed injection (defensive: seed failure never breaks the conversation main path).
   * Idempotent and events-first (seedConfig skips event-touched fields), so it runs at both
   * publisher creation and hydration end — creation may precede the record being fully wired
   * (during createSessionRecord event plumbing); the hydration pass covers that window.
   */
  private seedPublisherConfig(sessionId: string, publisher: ConversationTopicPublisher): void {
    const getSeed = this.host.getSessionConfigSeed;
    if (!getSeed) return;
    try {
      const seed = getSeed.call(this.host, sessionId);
      if (seed) publisher.seedConfig(seed);
    } catch (error) {
      this.host.onError?.("v4.configSeed", error);
    }
  }

  /**
   * Cold-recovery READY is created only at entries that explicitly need activation; hydratePublisher stays projection-only.
   * The registration promise precedes activation, so once a record is registered early, concurrent commands/queries cannot jump the recovery watermark.
   */
  private ensureColdReadyPublisher(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ConversationTopicPublisher> {
    const existingFlight = this.readyFlights.get(sessionId);
    if (existingFlight) return existingFlight;
    // Register the same READY before any slow work starts.
    const operation = Promise.resolve().then(async () => {
      const persistedMessages = await this.coldResume.ensureResumed(
        sessionId,
        resumeThoughtLevel,
        workspace,
      );
      return this.hydratePublisher(sessionId, persistedMessages);
    });
    this.readyFlights.set(sessionId, operation);
    // Success and failure release through the same cleanup; no derived promise that could propagate the rejection twice.
    const clear = () => {
      if (this.readyFlights.get(sessionId) === operation) this.readyFlights.delete(sessionId);
    };
    void operation.then(clear, clear);
    return operation;
  }

  /**
   * First-subscribe projection rebuild (hydration). Semantics per the subscribe comment;
   * synthesized events dedupe by sequenceNumber (already-ingested live events are not replayed).
   */
  private hydratePublisher(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existing = this.publishers.get(sessionId);
    // Already-hydrated live publisher: reuse as-is (no duplicate rebuild/double count).
    if (existing && this.hydratedSessions.has(sessionId)) return Promise.resolve(existing);

    const inFlight = this.hydrationInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const buffer: HydrationBuffer = {
      cancelled: false,
      eventIds: new Set<string>(),
      rawEvents: [],
    };
    this.hydrationBuffers.set(sessionId, buffer);
    const hydration = this.performHydration(
      sessionId,
      buffer,
      persistedMessages,
      forceRebuild,
    ).finally(() => {
      if (this.hydrationBuffers.get(sessionId) === buffer) {
        this.hydrationBuffers.delete(sessionId);
      }
      if (this.hydrationInFlight.get(sessionId) === hydration) {
        this.hydrationInFlight.delete(sessionId);
      }
    });
    this.hydrationInFlight.set(sessionId, hydration);
    return hydration;
  }

  private async performHydration(
    sessionId: string,
    buffer: HydrationBuffer,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existingAtStart = this.publishers.get(sessionId);
    const liveSessionAtStart = this.host.sessionExists(sessionId);
    const hydrationStartedAt = performance.now();
    this.host.onDebug?.(
      `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
        `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
        `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
    );
    const loaded: PersistedEventsLoadResult = this.host.loadPersistedEvents
      ? await this.host.loadPersistedEvents(sessionId, persistedMessages).catch((error) => {
          this.host.onError?.("v4.hydrate", error, {
            durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
            existingPublisherAtStart: existingAtStart !== undefined,
            liveSessionAtStart,
            phase: "loadPersistedEvents",
            persistedMessages: persistedMessages?.length ?? 0,
            sessionId,
          });
          return { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
        })
      : { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };

    this.host.onDebug?.(
      `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
        `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
        `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
    );

    if (this.disposed || buffer.cancelled) {
      throw new Error(`v4 hydration cancelled for session ${sessionId}`);
    }

    // Assistant conservation: a publisher that rejected a body stream is not trustworthy. It was built after
    // TurnStarted; missing segments cannot be appended into the middle by append-only replay and must be rebuilt whole.
    const latestPublisher = this.publishers.get(sessionId);
    const existingDroppedContent =
      latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
    // Complete event log (synthesized=false) with a healthy live publisher (streaming) -> keep it, no replay.
    if (
      existingAtStart &&
      latestPublisher === existingAtStart &&
      !loaded.synthesized &&
      !forceRebuild &&
      !existingDroppedContent
    ) {
      // The creation-time seed may have landed empty (record not yet registered); refill on first subscription (idempotent, events win).
      this.hydrationBuffers.delete(sessionId);
      this.seedPublisherConfig(sessionId, latestPublisher);
      if (loaded.sharedContextImport) {
        latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
      }
      await this.seedPublisherUsage(
        sessionId,
        latestPublisher,
        persistedMessages,
        loaded.usageSeed,
      );
      this.hydratedSessions.add(sessionId);
      this.publishCurrentSummaryToIndex(sessionId);
      return latestPublisher;
    }

    // Remembering only the pre-await existing reference is not enough: while load awaits, raw events
    // keep advancing that publisher, yet the synthesized result deletes it whole, and queue/stream vanish with it.
    // The rebuild takes sourceEventSeq as the raw snapshot boundary and replays events from the waiting window back in.
    const publisher = latestPublisher ?? existingAtStart ?? this.ensurePublisher(sessionId);
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.rehydrated",
        `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
      ),
    );
    publisher.rehydrate(loaded.events, {
      // On recovery the transcript/event store may still hold oversized bodies rejected at runtime. The same fact
      // must not re-deadlock subscribe after a CLI restart: skip that untransmittable projection event and keep reducing
      // later persisted TurnError/TurnComplete, so the cold snapshot rests on the last recoverable boundary.
      onPayloadTooLarge: (error) =>
        this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "publisher.rehydrate",
          sessionId,
        }),
    });
    if (loaded.sharedContextImport) {
      publisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
    // In the same recovery, apply the seed first, then the live buffer; newer usage/selection events always win.
    if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
    const sourceEventSeq = Math.max(
      0,
      loaded.sourceEventSeq ??
        (loaded.synthesized
          ? 0
          : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
    );
    const previousSequenceState = this.rawSequenceStates.get(sessionId);
    const sequenceState: RawSequenceState = {
      sourceEventSeq,
      offset: publisher.getSnapshot().seq - sourceEventSeq,
      lastTransportSeq: publisher.getSnapshot().seq,
      seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
      appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
      failedEventById: new Map(previousSequenceState?.failedEventById),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, sequenceState);
    // The persisted read's sourceEventSeq is the watermark when load started; the hydration buffer
    // may only record events from after load started. If seq=N entered the live publisher before the buffer existed
    // while load read only N-1, rehydrate must not replay from N+1: the raw reorder would wait forever for the
    // discarded N, and the running agent's control row would vanish with it. Keep a raw tail the size of the publisher's,
    // merge with the await-window buffer, and replay continuously from the persisted boundary.
    const replayByEventId = new Map<string, SessionEvent>();
    for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    for (const rawEvent of buffer.rawEvents) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    const replayEvents = [...replayByEventId.values()].sort((left, right) => {
      if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
        return left.sequenceNumber - right.sequenceNumber;
      }
      if (left.sequenceNumber > 0) return -1;
      if (right.sequenceNumber > 0) return 1;
      return 0;
    });
    for (const rawEvent of replayEvents) {
      for (const normalized of this.normalizeRuntimeEventSequence(sessionId, rawEvent)) {
        try {
          publisher.ingest(normalized);
          this.resolveProjectionEventCommit(sessionId, String(normalized.id));
        } catch (error) {
          this.rejectProjectionEventCommit(
            sessionId,
            String(normalized.id),
            new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply hydrated event ${String(normalized.id)}`,
              { cause: error },
            ),
          );
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
            phase: "replayBufferedEvents",
            sessionId,
          });
        }
      }
    }
    // Publisher replaced and buffer backfilled; during the usage seed's async wait, new raw events
    // enter the new publisher via the per-session sequence state above — no second replay.
    if (this.hydrationBuffers.get(sessionId) === buffer) {
      this.hydrationBuffers.delete(sessionId);
    }
    // Cold-recovery seed (after replay): resume has written the history session's last selection back into the runtime
    // (reconcileResumedRuntimeSettings), while synthesized/persisted events may contain no ModelSelected;
    // the seed fills only untouched fields; when the log has a value, the log wins (cold-recovery semantics).
    this.seedPublisherConfig(sessionId, publisher);
    if (loaded.usageSeed === undefined) {
      await this.seedPublisherUsage(sessionId, publisher, persistedMessages);
    }
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (this.pausedConnections.has(state.connectionId)) continue;
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.hydrate.subscriptionResync", error, {
          phase: "subscriptionResync",
          sessionId,
        });
        this.scheduleFlush(routeKey, state, publisher);
      }
    }
    this.hydratedSessions.add(sessionId);
    this.publishCurrentSummaryToIndex(sessionId);
    return publisher;
  }

  /**
   * Cold synthesis renumbers events 1..N while the runtime keeps the eventStore raw seq. The source cursor
   * establishes the N-C offset; raw seq=0 (live-only child) continues the sequence, and later offsets are corrected in step.
   * eventId catches the race of snapshot/buffer both seeing one event; the cursor covers events already in the snapshot.
   */
  private normalizeRuntimeEventSequence(sessionId: string, event: SessionEvent): SessionEvent[] {
    const state = this.getOrCreateRawSequenceState(sessionId);
    const eventId = String(event.id);
    if (state.seenEventIds.has(eventId)) return [];

    const rawSeq = event.sequenceNumber;
    state.recentRawEventsById.set(eventId, event);
    while (state.recentRawEventsById.size > PROTOCOL_V4_LIMITS.eventRetentionPerSession) {
      const oldestEventId = state.recentRawEventsById.keys().next().value;
      if (oldestEventId === undefined) break;
      state.recentRawEventsById.delete(oldestEventId);
    }
    if (rawSeq <= 0) {
      state.seenEventIds.add(eventId);
      state.lastTransportSeq += 1;
      return [{ ...event, sequenceNumber: state.lastTransportSeq }];
    }
    if (event.type === SessionEventType.SessionResumed) {
      // A legacy runtime can drop tail raw events across unsubscribe/rebuild. When the new runtime continues the persisted
      // eventStore high-water mark, SessionResumed's raw seq can exceed the old cursor;
      // handling only seq regressions would leave resume and later TurnStarted waiting forever for an uncoverable old gap.
      // SessionResumed is an explicit epoch boundary: drop old pendings before it, keep new-epoch events that arrived early,
      // and drain continuously from the resume itself.
      for (const pendingSeq of state.pendingByRawSeq.keys()) {
        if (pendingSeq <= rawSeq) state.pendingByRawSeq.delete(pendingSeq);
      }
      state.sourceEventSeq = rawSeq - 1;
      state.offset = state.lastTransportSeq - state.sourceEventSeq;
    }
    if (rawSeq <= state.sourceEventSeq) {
      state.seenEventIds.add(eventId);
      this.resolveProjectionEventCommit(sessionId, eventId);
      return [];
    }

    state.seenEventIds.add(eventId);
    if (!state.pendingByRawSeq.has(rawSeq)) state.pendingByRawSeq.set(rawSeq, event);
    const ready: SessionEvent[] = [];
    // The eventStore numbers first; each event awaits persistence before notify, so N+1 can arrive
    // before N. High-water filtering would misjudge late N as duplicate; buffer by raw seq and
    // drain only contiguously to preserve total queue/stream order.
    for (;;) {
      const nextRawSeq = state.sourceEventSeq + 1;
      const next = state.pendingByRawSeq.get(nextRawSeq);
      if (!next) break;
      state.pendingByRawSeq.delete(nextRawSeq);
      let transportSeq = nextRawSeq + state.offset;
      if (transportSeq <= state.lastTransportSeq) {
        transportSeq = state.lastTransportSeq + 1;
        state.offset = transportSeq - nextRawSeq;
      }
      state.sourceEventSeq = nextRawSeq;
      state.lastTransportSeq = transportSeq;
      // A waiter timeout/abort clearing only the listener is not enough; events already inside the raw gap must be
      // terminated too. After the command returns failed, the missing seq's arrival would still project the same TurnStarted.
      // The failed event still consumes its raw seq to unblock later events, but must never become canonical fact again.
      if (state.failedEventById.has(String(next.id))) {
        continue;
      }
      ready.push(
        transportSeq === next.sequenceNumber ? next : { ...next, sequenceNumber: transportSeq },
      );
    }
    return ready;
  }

  private getOrCreateRawSequenceState(sessionId: string): RawSequenceState {
    const existing = this.rawSequenceStates.get(sessionId);
    if (existing) return existing;
    const created: RawSequenceState = {
      sourceEventSeq: 0,
      offset: 0,
      lastTransportSeq: 0,
      seenEventIds: new Set(),
      appliedEventIds: new Set(),
      failedEventById: new Map(),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, created);
    return created;
  }

  private resolveProjectionEventCommit(sessionId: string, eventId: string): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.delete(eventId);
    state.appliedEventIds.add(eventId);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.resolve();
  }

  private rejectProjectionEventCommit(sessionId: string, eventId: string, error: Error): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.set(eventId, error);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.reject(error);
  }

  private rejectProjectionEventWaiters(sessionId: string, error: Error): void {
    const byEvent = this.projectionEventCommitWaiters.get(sessionId);
    if (!byEvent) return;
    for (const waiters of byEvent.values()) {
      for (const waiter of [...waiters]) waiter.reject(error);
    }
    this.projectionEventCommitWaiters.delete(sessionId);
  }

  /**
   * A running subagent has no bootstrap record of its own, but raw child events build a publisher first.
   * An existing publisher means the conversation live side is subscribable; the same child must not be cold-resumed into
   * a second runtime; genuine history sessions remain the host record's / persisted resume's business.
   */
  private hasLiveConversation(sessionId: string): boolean {
    return this.host.sessionExists(sessionId) || this.detachedLiveSessions.has(sessionId);
  }

  private async seedPublisherUsage(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    persistedMessages?: MessageWithParts[],
    loadedSeed?: SessionUsageSeed | null,
  ): Promise<void> {
    if (loadedSeed !== undefined) {
      if (loadedSeed) publisher.seedUsage(loadedSeed);
      return;
    }
    const getSeed = this.host.getSessionUsageSeed;
    if (!getSeed) return;
    try {
      const seed = await getSeed.call(this.host, sessionId, persistedMessages);
      if (seed) publisher.seedUsage(seed);
    } catch (error) {
      this.host.onError?.("v4.usageSeed", error);
    }
  }

  private scheduleFlush(
    routeKey: string,
    state: FlushState,
    publisher: ConversationTopicPublisher,
  ): void {
    if (this.pausedConnections.has(state.connectionId)) return;
    if (state.timer !== null) return;
    const timer = setTimeout(() => {
      state.timer = null;
      // SAT may arrive while the timer is already queued; re-check before reserving, no racy frames.
      if (this.pausedConnections.has(state.connectionId)) return;
      // Lazy cleanup: subscription replaced/unsubscribed -> drop scheduling state, no frame.
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
        this.flushStates.delete(routeKey);
        return;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) return;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }, state.flushWindowMs);
    // CLI process exit must not be held by flush timers.
    timer.unref?.();
    state.timer = timer;
  }

  private emitReservation<F extends RoutedTopicFrame>(
    reservation: TopicFrameReservation<F>,
  ): boolean {
    // Once resync/subscribe recovery enters the request-scoped outbox, an online flush reusing the
    // same inFlight would let physical wire leave before the ACK response.
    if (this.controlReservations.has(reservation)) return false;
    const sessionId = parseConversationTopic(reservation.frame.topic);
    const route = this.flushStates.get(
      subscriptionRouteKey(
        reservation.frame.topic,
        reservation.frame.subscriptionId,
        sessionId
          ? (this.publishers
              .get(sessionId)
              ?.connectionIdForSubscription(reservation.frame.subscriptionId) ?? "")
          : "",
      ),
    );
    if (
      sessionId &&
      route?.deliveryProfile === "continuous" &&
      reservation.deliveryKind === "online" &&
      reservation.frame.payload.kind === "deltas" &&
      this.localTtft.forSession(sessionId)
    ) {
      const rows = this.publishers.get(sessionId)?.getSnapshot().rows.window ?? [];
      const turns = new Set<string>();
      for (const delta of reservation.frame.payload.deltas) {
        if (delta.op === "row.appended" || delta.op === "row.upserted") turns.add(delta.row.turnId);
        else if (delta.op === "row.delta") {
          const row = rows.find((item) => item.rowId === delta.rowId);
          if (row) turns.add(row.turnId);
        }
      }
      const related = rows
        .filter((row) => row.kind === "turnHeader" && turns.has(row.turnId))
        .flatMap((header) =>
          header.kind === "turnHeader" && header.sourceCommandId
            ? [this.localTtft.forSession(sessionId, header.sourceCommandId)]
            : [],
        )
        .filter((facts) => facts !== undefined);
      const candidates = related.length ? related : [this.localTtft.forSession(sessionId)];
      const observations: import("@zcode/shared").LocalTtftFacts[] = [];
      for (const facts of candidates) {
        if (!facts || observations.some((item) => item.observationId === facts.observationId))
          continue;
        const header = rows.find(
          (row) => row.kind === "turnHeader" && row.sourceCommandId === facts.commandId,
        );
        const observation = localTtftFactsSchema.safeParse({
          ...facts,
          ...(this.host.cliVersion ? { cliVersion: this.host.cliVersion } : {}),
          ...(header ? { productTurnId: header.turnId } : {}),
        });
        // Content from before/after promotion may arrive in one batch; carry facts by the original input the row actually belongs to, never the newest queue item.
        if (observation.success) observations.push(observation.data);
      }
      if (observations.length) {
        (reservation.frame as ConversationTopicFrame).ttft = observations[0];
        if (observations.length > 1)
          (reservation.frame as ConversationTopicFrame).ttftRelated = observations.slice(1, 17);
      }
    }
    const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
    for (const wire of wires) this.host.emitWireFrame(wire);
    return reservation.commit();
  }

  private subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F> {
    const initialWires = reservation
      ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
      : [];
    if (reservation) this.controlReservations.add(reservation);
    let afterCommitRan = false;
    return {
      ack,
      initialFrame: reservation?.frame ?? null,
      initialWires,
      commit: () => {
        if (!reservation) return true;
        this.controlReservations.delete(reservation);
        const committed = reservation.commit();
        if (committed && !afterCommitRan) {
          afterCommitRan = true;
          // While a control reservation waits for ACK/outbox admission, an existing flush timer may
          // have fired and been suppressed by the same inFlight. After commit, re-drive the
          // publisher explicitly, or accumulated deltas wait for the next ingest/publish.
          afterCommit?.();
        }
        return committed;
      },
    };
  }
}

/** Thrown by the host executor for unwired commands -> ACK failed fault.notImplemented. */
export class V4CommandNotImplementedError extends Error {
  constructor(type: string) {
    super(`v4 command not implemented in M3: ${type}`);
    this.name = "V4CommandNotImplementedError";
  }
}

/**
 * The no-op exit channel for command handlers ("a same-value switch ACK must be distinguishable"):
 * thrown when a handler decides there is nothing to do (e.g. switchModelConfig/switchCollaborationMode matching
 * the runtime's current value); the gateway maps it to ACK status="noop" + reasonCode.
 * Never swallow it as accepted-without-result; clients must be able to tell "took effect" from "already that value".
 */
export class V4CommandNoopError extends Error {
  constructor(
    readonly reasonCode: string,
    message?: string,
  ) {
    super(message ?? `v4 command is a no-op (${reasonCode})`);
    this.name = "V4CommandNoopError";
  }
}
