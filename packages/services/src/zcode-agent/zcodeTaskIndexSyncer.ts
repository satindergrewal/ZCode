/* eslint-disable max-lines -- task index v4 frame ingest, snapshot upsert, and workspace broadcast must share one closure state. */
import { repairSubagentTaskIndex } from "#src/zcode-agent/repairSubagentTaskIndex.js";
import {
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  getZCodeUserVisibleMessages,
  isZCodeGoalContinuationReminderText,
  isZCodeModelOnlySyntheticUserMessage,
  resolveWorkspaceKey,
  resolveZCodeVisibleSessionTitle,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER,
  type ZCodeTaskGoal,
  type ZCodeTaskMode,
  type ZCodeTaskMeta,
  type ZCodeMessagePart,
  type ZCodeSessionMode,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionPhase,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type V4SessionsIndexSubscribeResult,
  type V4WorkspaceConfigSubscribeResult,
  type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeWorkspaceEventSubscriptionParams } from "#src/session/zcodeTaskListTypes.js";
import type {
  IZCodeAgentService,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
import { formatTaskMetaModelSelectionFromSnapshot } from "./zcodeConfigOptions.js";

const logger = createServiceLogger("zcode-task-index-syncer");

/** v4 subscription connectionId scope: a separate generation from the renderer sidebar's shared topic (replaced on resubscribe). */
const TASK_INDEX_SUBSCRIBER_SCOPE = "task-index";
const MAX_PENDING_TOPIC_FRAMES = 1_024;
const MAX_PENDING_TOPIC_BYTES = 32 * 1024 * 1024;
const INITIAL_BASELINE_SEED_BATCH_SIZE = 64;
const PROVIDER_NOT_READY_RETRY_MS = 5_000;
const TOPIC_SUBSCRIBE_WARN_INTERVAL_MS = 60_000;

type TopicSubscribeReason =
  | "initial"
  | "runtime-restart"
  | "snapshot-recovery-gap"
  | "recovery-frame-timeout"
  | "resync-ack-mismatch"
  | "resync-failed"
  | "force-recovery-gap"
  | "pre-ack-overflow"
  | "provider-not-ready-wait"
  | "retry";
type TopicRetryKind = "provider-not-ready" | "transient";
type TaskIndexTopicKind = "sessions-index" | "workspace-config";

type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;

interface WorkspaceBroadcastTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
}

export interface ZCodeTaskIndexTerminalEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase terminal mapping: completedSuccess/completedInterrupted -> turn.completed; error -> turn.failed. */
  kind: "turn.completed" | "turn.failed";
}

export interface ZCodeTaskIndexReadyEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase terminal mapping: the ready boundary for accepting the next input once the agent settles. */
  reason: "prompt_completed" | "prompt_failed";
}

export interface ZCodeTaskIndexSyncer {
  /**
   * Idempotently establishes the v4 background ingest subscriptions (sessions-index +
   * workspace-config) for a workspace, landing the CLI-authoritative terminal state/title/
   * config catalog into the task index sqlite and workspace broadcasts.
   * Repeated calls for the same workspace subscribe only once.
   */
  ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void;
  /**
   * Compat entry (legacy shadow-subscription API shape): session-level activation signals
   * converge on the workspace-level v4 subscription. options.includeSnapshot has no meaning
   * under v4 ingest (the initial sessions-index snapshot only silently backfills missing rows,
   * never replays terminals/broadcasts); the parameter survives only to keep callsites stable.
   */
  ensureSessionSubscription(
    target: ZCodeAgentSessionTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void;
  /**
   * Synces a session snapshot into sqlite and broadcasts workspace_task_list_changed.
   * On the desktop-continuous path zcodeSessionService calls this after
   * createSession/resumeSession/setModel (the legacy send/steer/fork/compact/rewind write
   * paths are gone; writes go through v4 commands + sessions-index/workspace events) so sqlite
   * gets fresh title/updatedAt and the UI list refreshes.
   */
  syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      /**
       * Design correction: required. Model switches (task_model_changed) and snapshot settles
       * (task_status_changed) must not fall through to task_meta_changed, which the UI treats
       * as an ownership change and answers with a global membership refetch and full refresh.
       */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta>;
  /**
   * Updates only the model record in the task index; no historical snapshot broadcast.
   * Pre-send resume suppresses snapshot broadcasts so a stale terminal cannot overwrite the
   * local streaming UI, yet sqlite's model must move from a deleted historical model to the
   * one in actual use.
   */
  syncTaskModel(target: ZCodeAgentSessionTarget, model: string): Promise<ZCodeTaskMeta | null>;
  /**
   * Emits one workspace_task_list_changed broadcast on demand.
   * For the adapter: archive/rename/pin/delete and other task metadata changes still broadcast.
   * Design correction: reason is required. The old default (task_meta_changed) silently gave
   * every noncommittal emit site the UI's heaviest refresh semantics (global membership
   * refetch), the root cause of input-box/task-settle actions refreshing the whole sidebar;
   * emit sites must declare the change kind.
   */
  emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    meta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void;
  /**
   * Returns the shared workspace emitter for the adapter to fire non-task-list events
   * (workspace_config_options_update etc.). Adapter and syncer share one emitter, so a single
   * subscription receives everything.
   */
  getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent>;
  /** Subscribes to the workspace-level event stream. adapter.onDynamicWorkspaceEvent forwards here. */
  onDynamicWorkspaceEvent(workspace: WorkspaceEventInput): Event<ZCodeWorkspaceEvent>;
  /**
   * Subscribes to session phase terminal transitions observed on the v4 sessions-index.
   * Not a UI stream: internal services state settlement only (host runtime command queue etc.).
   */
  onSessionTerminalEvent: Event<ZCodeTaskIndexTerminalEvent>;
  /**
   * Subscribes to the post-settle prompt ready state (phase entering
   * completedSuccess/completedInterrupted/error). The phone host command queue may send the
   * next command only on this event.
   */
  onSessionReadyEvent: Event<ZCodeTaskIndexReadyEvent>;
  /** Disposes every v4 subscription and workspace emitter; does not close the injected taskIndexRepo. */
  disposeAll(): void;
}

interface CreateZCodeTaskIndexSyncerOptions {
  agentService: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
}

/** Terminal phase set (detects transitions within the sessions-index conflated latest state). */
function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

function resolveTerminalUnreadSignal(
  summary: Pick<SessionSummary, "phase" | "goalStatus">,
): ZCodeWorkspaceTaskListChanged["unreadSignal"] {
  if (summary.phase === "error") {
    return "background_terminal";
  }
  if (
    (summary.phase === "completedSuccess" || summary.phase === "completedInterrupted") &&
    (summary.goalStatus === undefined || summary.goalStatus === "verified")
  ) {
    return "background_terminal";
  }
  return undefined;
}

function taskStatusFromSummaryPhase(phase: SessionPhase): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function buildBaselineMetaFromSummary(
  target: ZCodeAgentWorkspaceTarget,
  summary: SessionSummary,
): ZCodeTaskMeta {
  const status = taskStatusFromSummaryPhase(summary.phase);
  return {
    taskId: summary.sessionId,
    traceId: generateTraceId(summary.sessionId),
    title: summary.title,
    ...(summary.titleSource === "custom" ? { titleOverridden: true } : {}),
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    createdAt: summary.createdAt,
    updatedAt: summary.lastActivityAt,
    mode: "default",
    provider: ZCODE_AGENT_PROVIDER,
    ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
    ...(status ? { status } : {}),
  };
}

interface WorkspaceIngestState {
  target: ZCodeAgentWorkspaceTarget;
  /** Agent runtime generation currently attached; null = dormant. */
  runtimeGeneration: number | null;
  /** sessions-index subscription generation (frame filter gate; null = subscribing). */
  indexSubscriptionId: string | null;
  /** workspace-config subscription generation. */
  configSubscriptionId: string | null;
  /** Each generation is per-topic; one topic's recovery must not invalidate a sibling's late ACK. */
  indexSubscriptionGeneration: number;
  configSubscriptionGeneration: number;
  indexPending: PendingTopicFrames<SessionsIndexTopicWireCandidate> | null;
  configPending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate> | null;
  /** Per-topic acknowledged watermarks; a single seq/epoch must not be shared. */
  indexLogEpoch: string | null;
  indexSeq: number;
  configLogEpoch: string | null;
  configSeq: number;
  /** An ACK proves admission only; epoch/seq become the resume base once the first logical frame applies atomically. */
  indexHasAppliedBase: boolean;
  configHasAppliedBase: boolean;
  indexRecovery: TopicRecoveryState | null;
  configRecovery: TopicRecoveryState | null;
  indexRecoveryGeneration: number;
  configRecoveryGeneration: number;
  /** Topic-local backoff after transient runtime-restart/recovery-RPC failures; the sibling stays alive. */
  indexRetryTimer: ReturnType<typeof setTimeout> | null;
  configRetryTimer: ReturnType<typeof setTimeout> | null;
  indexRetryAttempt: number;
  configRetryAttempt: number;
  /** Rate limit for persistent-failure production warns; cleared on success so the next new failure is visible at once. */
  indexLastWarnAt: number | null;
  configLastWarnAt: number | null;
  /** Session summary baseline (diff basis for terminal transitions/title changes). */
  summaries: Map<string, SessionSummary>;
  /** The first frame (snapshot) silently backfills missing rows, never replaying terminals or list broadcasts. */
  seeded: boolean;
  /** Workspace-level frame emitters survive runtime generations; install one listener set only. */
  frameListenersInstalled: boolean;
  disposables: IDisposable[];
  indexAssembler: TopicWireFrameAssembler<SessionsIndexTopicFrame>;
  configAssembler: TopicWireFrameAssembler<WorkspaceConfigTopicFrame>;
  assemblyTimer: ReturnType<typeof setTimeout> | null;
}

type TopicDeliveryKind = "initial" | "online" | "recovery";

interface TopicRecoveryState {
  generation: number;
  subscriptionId: string;
  forceSnapshot: boolean;
  ackReceived: boolean;
  frameApplied: boolean;
  upgradeToSnapshot: boolean;
  postRecoveryGapPending: boolean;
  frameDeadline: ReturnType<typeof setTimeout> | null;
}

interface PendingTopicFrames<TFrame> {
  generation: number;
  frames: TFrame[];
  stagedBytes: number;
  recoveryNeeded: boolean;
}

export function createZCodeTaskIndexSyncer(
  options: CreateZCodeTaskIndexSyncerOptions,
): ZCodeTaskIndexSyncer {
  const { agentService, taskIndexRepo } = options;
  // Task index event ingest moved wholesale from the legacy shadow subscription
  // (session/subscribe + session/event + state.updated) to v4 frames: the sessions-index topic
  // carries the workspace-level conflated latest status(phase)/title/lastActivity and
  // workspace-config hot-reloads the config catalog; the body-search index re-fetches a full
  // snapshot on phase terminal transitions (the v4 command path has no op-driven snapshot
  // sync fallback anymore).
  const workspaceIngests = new Map<string, WorkspaceIngestState>();
  // workspaceEmitters used to be private in the adapter, leaving the syncer no broadcast
  // channel after writing sqlite, so the UI never saw workspace_task_list_changed. The emitter
  // moved up into the syncer with the adapter forwarding, so both paths share one subscription
  // and events no longer split.
  const workspaceEmitters = new Map<string, Emitter<ZCodeWorkspaceEvent>>();
  const terminalEventEmitter = new Emitter<ZCodeTaskIndexTerminalEvent>();
  const readyEventEmitter = new Emitter<ZCodeTaskIndexReadyEvent>();
  let disposed = false;

  const indexTopicFor = (state: WorkspaceIngestState) =>
    sessionsIndexTopic(resolveWorkspaceKey(state.target));
  const configTopicFor = (state: WorkspaceIngestState) =>
    workspaceConfigTopic(resolveWorkspaceKey(state.target));
  const isProviderNotReadyError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
  const isRuntimeUnavailableError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  const logTopicSubscribeFailure = (
    state: WorkspaceIngestState,
    topic: TaskIndexTopicKind,
    reason: TopicSubscribeReason,
    error: unknown,
    retryKind: TopicRetryKind,
  ): void => {
    const message = `task index ${topic} subscribe failed reason=${reason} workspace=${state.target.workspacePath}`;
    if (retryKind === "provider-not-ready") {
      // A new user with no model yet is a normal waiting state; persistent warns from two
      // topics per workspace would create a log storm before any user action. debug is not
      // persisted in production builds.
      logger.debug(undefined, message, error);
      return;
    }

    const lastWarnAt = topic === "sessions-index" ? state.indexLastWarnAt : state.configLastWarnAt;
    const now = Date.now();
    if (lastWarnAt === null || now - lastWarnAt >= TOPIC_SUBSCRIBE_WARN_INTERVAL_MS) {
      if (topic === "sessions-index") state.indexLastWarnAt = now;
      else state.configLastWarnAt = now;
      logger.warn(undefined, message, error);
      return;
    }
    // High-frequency retry detail is local-debug only; never at message-stream volume in production logs.
    logger.debug(undefined, message, error);
  };
  const createPendingFrames = <TFrame>(generation: number): PendingTopicFrames<TFrame> => ({
    generation,
    frames: [],
    stagedBytes: 0,
    recoveryNeeded: false,
  });
  const discardPendingFrames = <TFrame>(pending: PendingTopicFrames<TFrame> | null): void => {
    if (!pending) return;
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };
  const frameBytes = (
    frame: SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  ): number => new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  const stagePendingFrame = <
    TFrame extends SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  >(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    pending: PendingTopicFrames<TFrame>,
    frame: TFrame,
  ): void => {
    if (pending.recoveryNeeded) return;
    const bytes = frameBytes(frame);
    if (
      bytes > MAX_PENDING_TOPIC_BYTES ||
      pending.frames.length + 1 > MAX_PENDING_TOPIC_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_TOPIC_BYTES
    ) {
      // ACK-only initial notifications arrive before the Promise continuation. If the
      // pre-subscription staging buffer overflows, neither unbounded backlog nor dropped frames
      // will do; with no provable base yet, mark recovery-needed and start a fresh-generation
      // snapshot subscription for that topic once the ACK lands.
      discardPendingFrames(pending);
      pending.recoveryNeeded = true;
      logger.warn(
        undefined,
        `task index ${kind} ACK staging overflow; recovery-needed workspace=${resolveWorkspaceKey(state.target)}`,
      );
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const clearIndexPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.indexPending);
    state.indexPending = null;
    state.indexAssembler.clear();
  };
  const clearConfigPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.configPending);
    state.configPending = null;
    state.configAssembler.clear();
  };
  const clearPendingState = (state: WorkspaceIngestState): void => {
    clearIndexPendingState(state);
    clearConfigPendingState(state);
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    state.assemblyTimer = null;
  };
  const unsubscribeIndex = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeSessionsIndexV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `task index sessions-index unsubscribe failed workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const unsubscribeConfig = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `task index workspace-config unsubscribe failed workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const clearActiveSubscriptions = (state: WorkspaceIngestState): void => {
    const indexSubscriptionId = state.indexSubscriptionId;
    const configSubscriptionId = state.configSubscriptionId;
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
    if (indexSubscriptionId) void unsubscribeIndex(state, indexSubscriptionId);
    if (configSubscriptionId) void unsubscribeConfig(state, configSubscriptionId);
  };

  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    const key =
      typeof workspace === "string"
        ? workspace
        : resolveWorkspaceKey({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          });
    let emitter = workspaceEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeWorkspaceEvent>();
      workspaceEmitters.set(key, emitter);
    }
    return emitter;
  }

  function emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void {
    // Trace log (sidebar refreshing on input-box actions): confirms which actions emit task list broadcasts, and with which reason.
    logger.debug(
      undefined,
      `[list-refresh-trace] emitWorkspaceTaskListChanged reason=${reason} taskId=${target.taskId ?? "-"} workspace=${target.workspacePath} hasMeta=${Boolean(taskMeta)}`,
    );
    getWorkspaceEmitter({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    }).fire({
      type: "workspace_task_list_changed",
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      reason,
      ...(taskMeta ? { taskMeta } : {}),
      ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
    });
  }

  async function resyncTaskIndexRowFromAgent(
    target: ZCodeAgentSessionTarget,
    reason: string,
    options?: {
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
    },
  ): Promise<void> {
    try {
      // The task index is a passive observer reading the existing runtime only. resumeSession
      // would re-materialize/resume the same session after the user's next prompt is accepted
      // by Core, creating a second lifecycle writer; readSession(existing-only) keeps full
      // snapshot indexing without starting or touching the runtime.
      // Perf root cause: every turn completion/rename/visibility lands here and a full-history
      // row can reach ~15MB, saturating host stdio framing and JSON.parse; the index needs only
      // title/body/visibility/status, so request contentProfile "index" (strips
      // tool/reasoning/data-URL payloads, structure intact).
      // messageLimit is not an option: searchableText and title fallback need the history head.
      const snapshot = await agentService.readSession({
        ...target,
        runtimePolicy: "existing-only",
        contentProfile: "index",
      });
      // The backfill settle is a state/body sync, not pin/archive/unread ownership (task_status_changed).
      await syncSnapshotAndBroadcast(snapshot, {
        ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
        broadcastReason: "task_status_changed",
        moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
      });
    } catch (error) {
      logger.warn(
        undefined,
        `Backfill sync failed reason=${reason} taskId=${target.sessionId}`,
        error,
      );
    }
  }

  function sessionTargetFrom(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): ZCodeAgentSessionTarget {
    return {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId,
    };
  }

  function broadcastTargetFrom(target: ZCodeAgentSessionTarget): WorkspaceBroadcastTarget {
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.sessionId,
    };
  }

  function emitTerminalAndReady(target: ZCodeAgentSessionTarget, summary: SessionSummary): void {
    const phase = summary.phase;
    const failed = phase === "error";
    // Order preserves legacy semantics: turn terminal first (settles this input), then prompt ready (admits the next).
    terminalEventEmitter.fire({
      target,
      kind: failed ? "turn.failed" : "turn.completed",
    });
    readyEventEmitter.fire({
      target,
      reason: failed ? "prompt_failed" : "prompt_completed",
    });
  }

  /** Phase terminal transition -> sqlite status settle + broadcast + body reindex. */
  function applyTerminalTransition(
    target: ZCodeAgentSessionTarget,
    summary: SessionSummary,
    options?: { moveGroupedTaskToTop?: boolean },
  ): void {
    emitTerminalAndReady(target, summary);
    const failed = summary.phase === "error";
    const unreadSignal = resolveTerminalUnreadSignal(summary);
    logger.debug(undefined, "task terminal unread adjudication", {
      goalStatus: summary.goalStatus ?? null,
      phase: summary.phase,
      taskId: target.sessionId,
      unreadSignal: unreadSignal ?? null,
    });
    const updatedAt = Date.now();
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        // error's lastError detail is absent from the sessions-index summary; the following
        // backfill snapshot writes the authoritative value (a patch without the lastError key
        // keeps the current value). completed clears it, per legacy semantics.
        patch: failed
          ? { status: "error", updatedAt }
          : { status: "completed", lastError: undefined, updatedAt },
      })
      .then((meta) => {
        if (meta) {
          // sqlite-only updates never reached the UI's workspace_task_list_changed listener,
          // leaving spinners stuck and updatedAt ordering stale; this broadcast converges the
          // list. A terminal settle is a status change and must use task_status_changed. The old
          // default task_meta_changed bumped membership globally on every turn completion,
          // refetching ownership in every list instance: the sidebar flash on task finish.
          emitWorkspaceTaskListChanged(
            broadcastTargetFrom(target),
            meta,
            "task_status_changed",
            unreadSignal ? { unreadSignal } : undefined,
          );
        }
        // Terminal states read a full snapshot: the v4 command path (createSession/sendText via
        // v4/command) bypasses zcodeSessionService's op-driven snapshot sync, so missing rows,
        // body search, and lastError all converge here; readSession(existing-only) reads the
        // live runtime without resuming the session.
        void resyncTaskIndexRowFromAgent(target, failed ? "phase.error" : "phase.completed", {
          moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
          // Once the patch has broadcast, the later snapshot backfill must not raise the
          // completion notice again; with no row yet, hand the same signal to the backfill
          // result so the notice is neither lost nor duplicated.
          ...(meta || !unreadSignal ? {} : { unreadSignal }),
        });
      })
      .catch((error) => {
        logger.warn(undefined, `v4 phase terminal sync failed taskId=${target.sessionId}`, error);
      });
  }

  /** Title change -> sqlite title patch; missing rows backfill a full snapshot (legacy first_input semantics). */
  function applyTitleChange(target: ZCodeAgentSessionTarget, title: string): void {
    const updatedAt = Date.now();
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { title, updatedAt },
      })
      .then((meta) => {
        if (meta) {
          // Title changes (first message/auto-generated) are ownership-neutral and fire per
          // task; the dedicated reason keeps every first-send/settle title write from
          // triggering a global membership refetch.
          emitWorkspaceTaskListChanged(broadcastTargetFrom(target), meta, "task_title_changed");
        } else {
          // Draft sessions never pre-write a placeholder row; if the first title (legacy
          // first_input) lands before any snapshot upsert, backfill from the full snapshot
          // instead of relying on an empty-session placeholder.
          // v4 createSession bypasses zcodeSessionService.createSession, so a first title with
          // no task index row means first persistence of a new session. The backfill must also
          // write the grouped-top minimal sort_order, or the client appends the unordered node
          // to the end of the list.
          void resyncTaskIndexRowFromAgent(target, "meta.titleUpdated", {
            moveGroupedTaskToTop: true,
          });
        }
      })
      .catch((error) => {
        logger.warn(undefined, `v4 title sync failed taskId=${target.sessionId}`, error);
      });
  }

  /** Diffs one summary against the baseline: drafts skip; terminal transitions/title changes settle separately. */
  function processSummary(
    state: WorkspaceIngestState,
    previous: SessionSummary | undefined,
    next: SessionSummary,
    _deliveryKind: TopicDeliveryKind,
  ): void {
    state.summaries.set(next.sessionId, next);
    // Draft ruling: memory-only, never persisted, never enters the task index sqlite.
    if (next.phase === "draft") {
      return;
    }
    const target = sessionTargetFrom(state.target, next.sessionId);
    const becameVisibleTask = previous === undefined || previous.phase === "draft";
    // Terminal transition = non-terminal observed in the baseline, then terminal. Sessions
    // without a baseline (cold-resume hydration, history appearing after a gap downgrade) never
    // replay terminals; live sessions always enter the baseline as running/prewarming first
    // (the gateway fans out every event), so no real settle is missed.
    const becameTerminal =
      previous !== undefined && !isTerminalPhase(previous.phase) && isTerminalPhase(next.phase);
    if (becameTerminal) {
      applyTerminalTransition(target, next, {
        moveGroupedTaskToTop: becameVisibleTask,
      });
      return;
    }
    if (becameVisibleTask) {
      // A v4 prewarm session promoted from draft, or a new session in its first online delta,
      // skips zcodeSessionService.createSession. This is the earliest
      // title-order-independent new-task boundary; backfill the task row and grouped-root
      // minimal sort_order now so the unordered node never lands at the bottom.
      void resyncTaskIndexRowFromAgent(target, "session.became-visible", {
        moveGroupedTaskToTop: true,
      });
      return;
    }
    const title = next.title.trim();
    if (title && (previous === undefined || previous.title !== next.title)) {
      applyTitleChange(target, title);
    }
  }

  async function seedMissingRowsFromInitialSnapshot(
    state: WorkspaceIngestState,
    summaries: Iterable<SessionSummary>,
  ): Promise<void> {
    const candidates = [...summaries].filter((summary) => summary.phase !== "draft");
    if (candidates.length === 0) return;
    // Pure-V4 UIs skip zcodeSessionService.initializeWorkspace; treating the first frame as a
    // silent already-in-sqlite baseline would leave fresh remote databases at zero rows
    // forever. This is atomic insert-if-missing only: no broadcast, no terminal replay, no
    // overwrite of existing product-shell state; later open/settle backfills model, body
    // search, and the other authoritative fields from a full snapshot.
    // Burst protection: history can be huge, so never spawn that many Promises at once and
    // starve the host event loop. Fixed small batches; failures aggregate into one production
    // log instead of per-session errors reigniting a log storm.
    let failedCount = 0;
    let firstError: unknown;
    for (let offset = 0; offset < candidates.length; offset += INITIAL_BASELINE_SEED_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + INITIAL_BASELINE_SEED_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((summary) =>
          taskIndexRepo.seedTaskMetaIfMissing(buildBaselineMetaFromSummary(state.target, summary)),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failedCount += 1;
          firstError ??= result.reason;
        }
      }
    }
    if (failedCount > 0) {
      logger.warn(
        undefined,
        `First sessions-index baseline failed workspace=${resolveWorkspaceKey(state.target)} failed=${failedCount} total=${candidates.length}`,
        firstError,
      );
    }
  }

  function deliveryKindOf(event: unknown): TopicDeliveryKind {
    const deliveryKind = (event as { deliveryKind?: unknown }).deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "recovery" ? deliveryKind : "online";
  }

  function faultDeliveryKindOf(event: unknown): TopicDeliveryKind | undefined {
    const deliveryKind = (event as { fault?: { deliveryKind?: unknown } }).fault?.deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "online" || deliveryKind === "recovery"
      ? deliveryKind
      : undefined;
  }

  function isLiveState(state: WorkspaceIngestState): boolean {
    return !disposed && workspaceIngests.get(resolveWorkspaceKey(state.target)) === state;
  }

  function clearRecoveryDeadline(recovery: TopicRecoveryState | null): void {
    if (!recovery?.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  function discardIndexRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.indexRecovery);
    state.indexRecovery = null;
  }

  function discardConfigRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.configRecovery);
    state.configRecovery = null;
  }

  function settleIndexRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.indexRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardIndexRecovery(state);
      if (recovery.forceSnapshot) void subscribeIndexTopic(state, "snapshot-recovery-gap", true);
      else requestIndexRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardIndexRecovery(state);
      if (followup) requestIndexRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.indexRecovery !== recovery || recovery.frameApplied) return;
      discardIndexRecovery(state);
      if (!recovery.forceSnapshot) requestIndexRecovery(state, true);
      else void subscribeIndexTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function settleConfigRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.configRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardConfigRecovery(state);
      if (recovery.forceSnapshot) void subscribeConfigTopic(state, "snapshot-recovery-gap", true);
      else requestConfigRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardConfigRecovery(state);
      if (followup) requestConfigRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.configRecovery !== recovery || recovery.frameApplied) return;
      discardConfigRecovery(state);
      if (!recovery.forceSnapshot) requestConfigRecovery(state, true);
      else void subscribeConfigTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function completeIndexRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.indexRecovery) return;
    state.indexRecovery.frameApplied = true;
    settleIndexRecovery(state, state.indexRecovery);
  }

  function completeConfigRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.configRecovery) return;
    state.configRecovery.frameApplied = true;
    settleConfigRecovery(state, state.configRecovery);
  }

  function requestIndexRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.indexSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.indexRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleIndexRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.indexHasAppliedBase || state.indexLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.indexRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.indexRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.indexLogEpoch!, seq: state.indexSeq };
    void agentService
      .resyncSessionsIndexV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        if (
          state.indexSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardIndexRecovery(state);
          void subscribeIndexTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleIndexRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        discardIndexRecovery(state);
        logger.warn(
          undefined,
          `sessions-index resync failed; fresh subscription workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeIndexTopic(state, "resync-failed", true);
      });
  }

  function requestConfigRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.configSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.configRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleConfigRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.configHasAppliedBase || state.configLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.configRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.configRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.configLogEpoch!, seq: state.configSeq };
    void agentService
      .resyncWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        if (
          state.configSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardConfigRecovery(state);
          void subscribeConfigTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleConfigRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        discardConfigRecovery(state);
        logger.warn(
          undefined,
          `workspace-config resync failed; fresh subscription workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeConfigTopic(state, "resync-failed", true);
      });
  }

  function handleIndexGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.indexRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        // A forced snapshot still gapping means this same-subscription stream is no longer
        // provable; stop guessing at splices and start a new-generation snapshot subscription
        // for the topic.
        discardIndexRecovery(state);
        void subscribeIndexTopic(state, "force-recovery-gap", true);
      } else {
        requestIndexRecovery(state, true);
      }
      return;
    }
    requestIndexRecovery(state);
  }

  function handleConfigGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.configRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        discardConfigRecovery(state);
        void subscribeConfigTopic(state, "force-recovery-gap", true);
      } else {
        requestConfigRecovery(state, true);
      }
      return;
    }
    requestConfigRecovery(state);
  }

  function applySessionsIndexFrame(
    state: WorkspaceIngestState,
    frame: SessionsIndexTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.indexRecovery && frame.payload.kind === "deltas") {
      if (state.indexRecovery.frameApplied && frame.toSeq > state.indexSeq) {
        state.indexRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (deliveryKind === "online" && state.indexHasAppliedBase && frame.toSeq <= state.indexSeq) {
        return;
      }
      state.indexLogEpoch = frame.payload.snapshot.logEpoch;
      state.indexSeq = frame.toSeq;
      state.indexHasAppliedBase = true;
      const nextSummaries = new Map<string, SessionSummary>();
      for (const summary of frame.payload.snapshot.sessions) {
        nextSummaries.set(summary.sessionId, summary);
      }
      if (!state.seeded) {
        // First frame = silent baseline: no terminal replay, no list broadcast; atomically
        // backfill missing rows so a fresh/empty remote sqlite is not stranded at zero by the
        // pure-V4 path.
        state.summaries = nextSummaries;
        state.seeded = true;
        void seedMissingRowsFromInitialSnapshot(state, nextSummaries.values());
        const generation = state.indexSubscriptionGeneration;
        void repairSubagentTaskIndex({
          target: state.target,
          visibleSessionIds: new Set(nextSummaries.keys()),
          agentService,
          taskIndexRepo,
          isCurrent: () => isLiveState(state) && state.indexSubscriptionGeneration === generation,
          onRemoved: () =>
            emitWorkspaceTaskListChanged(state.target, undefined, "task_meta_changed"),
        }).catch((error) => {
          logger.warn(
            undefined,
            `Subagent history index repair failed workspace=${resolveWorkspaceKey(state.target)}`,
            error,
          );
        });
        completeIndexRecoveryFrame(state, deliveryKind);
        return;
      }
      // Gap-downgrade snapshot: diff against the baseline and process, equivalent to replaying the lost deltas (conflated semantics).
      const previousSummaries = state.summaries;
      state.summaries = new Map();
      for (const summary of nextSummaries.values()) {
        processSummary(state, previousSummaries.get(summary.sessionId), summary, deliveryKind);
      }
      completeIndexRecoveryFrame(state, deliveryKind);
      return;
    }
    if (!state.indexHasAppliedBase) {
      // A fresh task-index subscribe never carries a base; once the initial batch is lost, no
      // delta can build a cold baseline. Only an owned snapshot proves complete state.
      handleIndexGap(state, deliveryKind === "recovery" ? "recovery" : "online");
      return;
    }
    if (frame.toSeq <= state.indexSeq) {
      // A fully validated recovery already superseded by a later authoritative snapshot/online
      // frame still counts as delivered; plain duplicates stay silently dropped.
      if (deliveryKind === "recovery" && state.indexHasAppliedBase) {
        completeIndexRecoveryFrame(state, deliveryKind);
      }
      return;
    }
    if (frame.fromSeq !== state.indexSeq) {
      handleIndexGap(state, deliveryKind);
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") {
        processSummary(
          state,
          state.summaries.get(delta.session.sessionId),
          delta.session,
          deliveryKind,
        );
        continue;
      }
      // session.removed: sqlite settle for deletions happens in the task deletion flows
      // (adapter deleteTask / the v4 deleteSession command's host-side finish); only the
      // baseline is maintained here.
      state.summaries.delete(delta.sessionId);
    }
    state.indexSeq = frame.toSeq;
    state.indexHasAppliedBase = true;
    completeIndexRecoveryFrame(state, deliveryKind);
  }

  function applyWorkspaceConfigFrame(
    state: WorkspaceIngestState,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.configRecovery && frame.payload.kind === "deltas") {
      if (state.configRecovery.frameApplied && frame.toSeq > state.configSeq) {
        state.configRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (
        deliveryKind === "online" &&
        state.configHasAppliedBase &&
        frame.toSeq <= state.configSeq
      ) {
        return;
      }
      state.configLogEpoch = frame.payload.snapshot.logEpoch;
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    } else {
      if (!state.configHasAppliedBase) {
        handleConfigGap(state, deliveryKind === "recovery" ? "recovery" : "online");
        return;
      }
      if (frame.toSeq <= state.configSeq) {
        if (deliveryKind === "recovery" && state.configHasAppliedBase) {
          completeConfigRecoveryFrame(state, deliveryKind);
        }
        return;
      }
      if (frame.fromSeq !== state.configSeq) {
        handleConfigGap(state, deliveryKind);
        return;
      }
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    }
    const config =
      frame.payload.kind === "snapshot"
        ? frame.payload.snapshot.config
        : frame.payload.deltas.at(-1)?.config;
    if (!config || config.configOptions.length === 0) {
      // Never emit an empty catalog (the subscription seed with no live session): an empty
      // configOptions wipes the chat toolbar's model catalog downstream in useZCodeConfig.
      completeConfigRecoveryFrame(state, deliveryKind);
      return;
    }
    // The v4 payload matches the ZCodeConfigOption shape (backed by shared golden tests), so
    // this is a zero-mapping pass-through and downstream workspace_config_options_update
    // consumers (useZCodeConfig etc.) stay untouched.
    getWorkspaceEmitter({
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
    }).fire({
      type: "workspace_config_options_update",
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
      configOptions: config.configOptions,
    });
    completeConfigRecoveryFrame(state, deliveryKind);
  }

  function markAssemblyFault(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    reasonCode: string,
    deliveryKind: TopicDeliveryKind | undefined,
  ): void {
    logger.warn(
      undefined,
      `task index ${kind} physical assembly failed reason=${reasonCode} workspace=${resolveWorkspaceKey(state.target)}`,
    );
    if (kind === "sessions-index") {
      if (deliveryKind === "online" && state.indexRecovery) {
        state.indexRecovery.postRecoveryGapPending ||= state.indexRecovery.frameApplied;
        return;
      }
      // An owned fault with malformed deliveryKind must not be downgraded to online, stranding
      // an in-flight recovery; during recovery escalate as a recovery fault, else start a plain
      // same-sub resync.
      handleIndexGap(state, deliveryKind ?? (state.indexRecovery ? "recovery" : "online"));
    } else {
      if (deliveryKind === "online" && state.configRecovery) {
        state.configRecovery.postRecoveryGapPending ||= state.configRecovery.frameApplied;
        return;
      }
      handleConfigGap(state, deliveryKind ?? (state.configRecovery ? "recovery" : "online"));
    }
  }

  function scheduleAssemblyExpiry(state: WorkspaceIngestState): void {
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    const expiries = [state.indexAssembler.nextExpiryAt, state.configAssembler.nextExpiryAt].filter(
      (value): value is number => value !== null,
    );
    if (expiries.length === 0) {
      state.assemblyTimer = null;
      return;
    }
    const nextExpiryAt = Math.min(...expiries);
    const timer = setTimeout(
      () => {
        state.assemblyTimer = null;
        const now = Date.now();
        for (const event of state.indexAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "sessions-index",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        for (const event of state.configAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "workspace-config",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        scheduleAssemblyExpiry(state);
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    timer.unref?.();
    state.assemblyTimer = timer;
  }

  function handleSessionsIndexWire(
    state: WorkspaceIngestState,
    wire: SessionsIndexTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== indexTopicFor(state)) return;
    // Ownership before assembly; a foreign subscription must not occupy the decoded staging.
    if (state.indexSubscriptionId === null) {
      if (state.indexPending) {
        stagePendingFrame(state, "sessions-index", state.indexPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.indexSubscriptionId) return;
    const events = state.indexAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.indexAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "sessions-index",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applySessionsIndexFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  function handleWorkspaceConfigWire(
    state: WorkspaceIngestState,
    wire: WorkspaceConfigTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== configTopicFor(state)) return;
    if (state.configSubscriptionId === null) {
      if (state.configPending) {
        stagePendingFrame(state, "workspace-config", state.configPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.configSubscriptionId) return;
    const events = state.configAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.configAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "workspace-config",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applyWorkspaceConfigFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  async function activateIndexSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<SessionsIndexTopicWireCandidate>,
    result: V4SessionsIndexSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.indexSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      // A new runtime generation may reuse subscriptionIds; a late stale ACK must not
      // unsubscribe a same-id route the new generation already owns.
      if (state.indexSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeIndex(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.indexPending === pending) state.indexPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeIndex(state, result.ack.subscriptionId);
      if (generation === state.indexSubscriptionGeneration && isLiveState(state)) {
        void subscribeIndexTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.indexSubscriptionId = result.ack.subscriptionId;
    state.indexLogEpoch = result.ack.logEpoch;
    state.indexSeq = 0;
    // The subscribe ACK's epoch/seq0 is admission metadata only; initial physical frames may
    // still be incomplete or fail validation. A base exists only after a logical
    // snapshot/delta applies atomically.
    state.indexHasAppliedBase = false;
    discardIndexRecovery(state);
    state.indexRetryAttempt = 0;
    state.indexLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleSessionsIndexWire(state, frame);
      }
    }
  }

  async function activateConfigSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate>,
    result: V4WorkspaceConfigSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.configSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      if (state.configSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeConfig(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.configPending === pending) state.configPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeConfig(state, result.ack.subscriptionId);
      if (generation === state.configSubscriptionGeneration && isLiveState(state)) {
        void subscribeConfigTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.configSubscriptionId = result.ack.subscriptionId;
    state.configLogEpoch = result.ack.logEpoch;
    state.configSeq = 0;
    state.configHasAppliedBase = false;
    discardConfigRecovery(state);
    state.configRetryAttempt = 0;
    state.configLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleWorkspaceConfigWire(state, frame);
      }
    }
  }

  function scheduleIndexRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.indexRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.indexRetryAttempt, 5));
    state.indexRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.indexRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeIndexTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.indexRetryTimer = timer;
  }

  function scheduleConfigRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.configRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.configRetryAttempt, 5));
    state.configRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.configRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeConfigTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.configRetryTimer = timer;
  }

  async function subscribeIndexTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    state.indexRetryTimer = null;
    const generation = ++state.indexSubscriptionGeneration;
    const previousSubscriptionId = state.indexSubscriptionId;
    state.indexSubscriptionId = null;
    discardIndexRecovery(state);
    clearIndexPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeIndex(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.indexSubscriptionGeneration) return;
    }
    const indexPending = createPendingFrames<SessionsIndexTopicWireCandidate>(generation);
    state.indexPending = indexPending;
    try {
      const result = await agentService.subscribeSessionsIndexV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateIndexSubscribe(state, generation, indexPending, result);
    } catch (error) {
      if (isLiveState(state) && state.indexSubscriptionGeneration === generation) {
        clearIndexPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "sessions-index", reason, error, retryKind);
        scheduleIndexRetry(state, retryKind);
      }
    }
  }

  async function subscribeConfigTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.configRetryTimer = null;
    const generation = ++state.configSubscriptionGeneration;
    const previousSubscriptionId = state.configSubscriptionId;
    state.configSubscriptionId = null;
    discardConfigRecovery(state);
    clearConfigPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeConfig(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.configSubscriptionGeneration) return;
    }
    const configPending = createPendingFrames<WorkspaceConfigTopicWireCandidate>(generation);
    state.configPending = configPending;
    try {
      const result = await agentService.subscribeWorkspaceConfigV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateConfigSubscribe(state, generation, configPending, result);
    } catch (error) {
      if (isLiveState(state) && state.configSubscriptionGeneration === generation) {
        clearConfigPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "workspace-config", reason, error, retryKind);
        scheduleConfigRetry(state, retryKind);
      }
    }
  }

  function ensureWorkspaceFrameListeners(state: WorkspaceIngestState): void {
    if (!isLiveState(state) || state.frameListenersInstalled) return;
    const workspace = state.target;
    // A dormant state skips the first establish yet goes straight to resubscribe once the
    // runtime is available; with no default listener installed, the initial frame following the
    // response within the same read has no consumer. Listeners must be installed synchronously
    // before any subscribe and reused across runtime generations.
    state.disposables.push(
      agentService.onDynamicSessionsIndexFrame(workspace)((frame) =>
        handleSessionsIndexWire(state, frame),
      ),
      agentService.onDynamicWorkspaceConfigFrame(workspace)((frame) =>
        handleWorkspaceConfigWire(state, frame),
      ),
    );
    state.frameListenersInstalled = true;
  }

  async function establishWorkspaceSubscriptions(state: WorkspaceIngestState): Promise<void> {
    // Attach frame listeners before subscribing: a single stdio read resolves the response
    // promise and synchronously fires the initial notification before the await continuation
    // runs, so the handler must stage frames and must not read bytes-before-response as
    // subscription-active-in-JS-state.
    ensureWorkspaceFrameListeners(state);
    await Promise.all([
      subscribeIndexTopic(state, "initial", false),
      subscribeConfigTopic(state, "initial", false),
    ]);
  }

  /**
   * (CLI reconnect resubscribe): after an agent process generation change the CLI's
   * in-memory subscriptions are gone, no gap frames arrive (silent subscription death), and
   * ensureWorkspaceSubscription's placeholder early-return will not resubscribe. Re-issue
   * subscribe by workspaceKey: frame listeners hang off the workspace-level persistent emitter
   * (the agentService wireClient reconnects across generations), so only the subscriptionId
   * gate refreshes; new snapshot frames over a seeded baseline converge via the existing
   * gap-downgrade-snapshot diff path.
   */
  function resubscribeWorkspaceAfterRuntimeRestart(workspaceKey: string): void {
    if (disposed) return;
    const state = workspaceIngests.get(workspaceKey);
    if (!state) return;
    ensureWorkspaceFrameListeners(state);
    // The two topics used to share one Promise.all generation, so a transient failure on one
    // side reverted the other's successful new subscription. Each now subscribes fresh with its
    // own backoff.
    void subscribeIndexTopic(state, "runtime-restart", false);
    void subscribeConfigTopic(state, "runtime-restart", false);
  }

  const availableRuntimeGenerationByWorkspaceKey = new Map<string, number>();
  const hasRuntimeLifecycle = Boolean(agentService.onAgentRuntimeLifecycle);

  function suspendWorkspaceAfterRuntimeUnavailable(workspaceKey: string, generation: number): void {
    const state = workspaceIngests.get(workspaceKey);
    if (!state || state.runtimeGeneration !== generation) return;
    state.runtimeGeneration = null;
    state.indexSubscriptionGeneration += 1;
    state.configSubscriptionGeneration += 1;
    state.indexRecoveryGeneration += 1;
    state.configRecoveryGeneration += 1;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.indexRetryTimer = null;
    state.configRetryTimer = null;
    discardIndexRecovery(state);
    discardConfigRecovery(state);
    clearPendingState(state);
    // unsubscribe/retry after the runtime exited would re-enter getClient. unavailable clears
    // local ownership only; the CLI-side subscriptions died with the process, so no cleanup RPC.
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
  }

  const runtimeLifecycleDisposable = agentService.onAgentRuntimeLifecycle?.((event) => {
    if (disposed) return;
    if (event.state === "unavailable") {
      if (
        availableRuntimeGenerationByWorkspaceKey.get(event.workspaceKey) ===
        event.runtimeIdentity.generation
      ) {
        availableRuntimeGenerationByWorkspaceKey.delete(event.workspaceKey);
      }
      suspendWorkspaceAfterRuntimeUnavailable(event.workspaceKey, event.runtimeIdentity.generation);
      return;
    }

    availableRuntimeGenerationByWorkspaceKey.set(
      event.workspaceKey,
      event.runtimeIdentity.generation,
    );
    const existing = workspaceIngests.get(event.workspaceKey);
    if (!existing) {
      ensureWorkspaceSubscription({
        workspacePath: event.workspacePath,
        workspaceIdentity: event.workspaceIdentity,
      });
      return;
    }
    if (existing.runtimeGeneration === event.runtimeIdentity.generation) return;
    existing.runtimeGeneration = event.runtimeIdentity.generation;
    resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey);
  });

  // Legacy fixtures/hosts without lifecycle keep the restart compat; production uses available/unavailable only.
  const runtimeRestartedDisposable = hasRuntimeLifecycle
    ? undefined
    : agentService.onAgentRuntimeRestarted?.((event) =>
        resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey),
      );

  function ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void {
    if (disposed) {
      return;
    }
    if (!target.workspacePath) {
      return;
    }
    const key = resolveWorkspaceKey(target);
    if (workspaceIngests.has(key)) {
      return;
    }
    const state: WorkspaceIngestState = {
      target: {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      },
      runtimeGeneration: availableRuntimeGenerationByWorkspaceKey.get(key) ?? null,
      indexSubscriptionId: null,
      configSubscriptionId: null,
      indexSubscriptionGeneration: 0,
      configSubscriptionGeneration: 0,
      indexPending: null,
      configPending: null,
      indexLogEpoch: null,
      indexSeq: 0,
      configLogEpoch: null,
      configSeq: 0,
      indexHasAppliedBase: false,
      configHasAppliedBase: false,
      indexRecovery: null,
      configRecovery: null,
      indexRecoveryGeneration: 0,
      configRecoveryGeneration: 0,
      indexRetryTimer: null,
      configRetryTimer: null,
      indexRetryAttempt: 0,
      configRetryAttempt: 0,
      indexLastWarnAt: null,
      configLastWarnAt: null,
      summaries: new Map(),
      seeded: false,
      frameListenersInstalled: false,
      disposables: [],
      indexAssembler: new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
      configAssembler: new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
      assemblyTimer: null,
    };
    // Reserve the Map entry first so concurrent calls during establishment cannot double-subscribe.
    workspaceIngests.set(key, state);
    // With lifecycle available, a workspace without a runtime stays a dormant placeholder; a
    // passive observer must not start the CLI. Legacy hosts without lifecycle keep the explicit
    // ensure behavior.
    if (!hasRuntimeLifecycle || state.runtimeGeneration !== null) {
      void establishWorkspaceSubscriptions(state);
    }
  }

  async function syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta> {
    const meta = buildMetaFromSnapshot(snapshot, options);
    // Explicit resume of a legacy child tab still syncs the snapshot; read-only details must not be rewritten as main tasks.
    if (snapshot.session.sessionKind === "subagent_child") return meta;
    // Also index the visible chat body from snapshot.messages so TaskSearchDialog body search
    // hits; legacy sqlite rows backfill naturally the next time they pass through here.
    const searchableText = buildSearchableTextFromSnapshot(snapshot);
    // On desktop-continuous first send, committing the task row before the grouped sort_order
    // lets sessions-index expose the unordered task to the Renderer between the two writes:
    // a bottom-then-back-to-top jump.
    const { meta: persisted, initializedGroupedOrder } = options?.moveGroupedTaskToTop
      ? await taskIndexRepo.syncTaskMetaAtGroupedTop({ meta, searchableText })
      : {
          meta: await taskIndexRepo.syncTaskMeta({ meta, searchableText }),
          initializedGroupedOrder: false,
        };
    // Right after createSession the snapshot has neither title nor user message, so the
    // default title lands as the "New session" placeholder. A snapshot with no user content yet
    // must not broadcast, or the sidebar flashes "New session" until sendPrompt finishes and
    // the real prompt text appears. Still write the sqlite row so the later title update finds
    // it via applyAgentPatch; that title-triggered broadcast is the user's first sight of the
    // session, already titled with the prompt text, no flash.
    if (!hasUserVisibleContent(snapshot)) {
      if (initializedGroupedOrder) {
        // When a prewarmed session promotes from draft, grouped order persists before the
        // first title. Even without broadcastable task meta yet, the renderer must be told to
        // refetch structure, or sessions-index shows the task while structure stays unordered
        // and this process appends it to the end.
        emitWorkspaceTaskListChanged(
          {
            workspacePath: persisted.workspacePath,
            workspaceIdentity: persisted.workspaceIdentity,
            taskId: persisted.taskId,
          },
          undefined,
          "task_created",
        );
      }
      return persisted;
    }
    emitWorkspaceTaskListChanged(
      {
        workspacePath: persisted.workspacePath,
        workspaceIdentity: persisted.workspaceIdentity,
        taskId: persisted.taskId,
      },
      persisted,
      // A sessions-index visible frame can land before the first grouped sort_order persists.
      // First initialization must use task_created to invalidate live grouped-structure caches;
      // repeated snapshots add no ordering and keep the caller's status/title semantics.
      initializedGroupedOrder ? "task_created" : options.broadcastReason,
      options.unreadSignal ? { unreadSignal: options.unreadSignal } : undefined,
    );
    return persisted;
  }

  async function syncTaskModel(
    target: ZCodeAgentSessionTarget,
    model: string,
  ): Promise<ZCodeTaskMeta | null> {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return null;
    }
    try {
      return await taskIndexRepo.updateTaskState({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { model: normalizedModel },
      });
    } catch (error) {
      logger.warn(undefined, `Task model sync failed taskId=${target.sessionId}`, error);
      return null;
    }
  }

  return {
    ensureWorkspaceSubscription,

    ensureSessionSubscription(
      target: ZCodeAgentSessionTarget,
      _options?: {
        includeSnapshot?: boolean;
      },
    ): void {
      if (!target.sessionId || !target.workspacePath) {
        return;
      }
      ensureWorkspaceSubscription({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
    },

    syncSnapshotAndBroadcast,

    syncTaskModel,

    emitWorkspaceTaskListChanged,

    getWorkspaceEmitter,

    onDynamicWorkspaceEvent(workspace: WorkspaceEventInput) {
      // Task list mount calls this for every restored workspace. Listening is not usage; never
      // activate sessions-index or start an agent here.
      return getWorkspaceEmitter(workspace).event;
    },

    onSessionTerminalEvent: terminalEventEmitter.event,

    onSessionReadyEvent: readyEventEmitter.event,

    disposeAll(): void {
      disposed = true;
      for (const state of workspaceIngests.values()) {
        state.indexSubscriptionGeneration += 1;
        state.configSubscriptionGeneration += 1;
        state.indexRecoveryGeneration += 1;
        state.configRecoveryGeneration += 1;
        if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
        if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
        state.indexRetryTimer = null;
        state.configRetryTimer = null;
        discardIndexRecovery(state);
        discardConfigRecovery(state);
        clearPendingState(state);
        clearActiveSubscriptions(state);
        for (const disposable of state.disposables) {
          try {
            disposable.dispose();
          } catch {
            // Ignore dispose failures; every subscription still gets its disposal attempt.
          }
        }
      }
      workspaceIngests.clear();
      for (const emitter of workspaceEmitters.values()) {
        emitter.dispose();
      }
      workspaceEmitters.clear();
      terminalEventEmitter.dispose();
      readyEventEmitter.dispose();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartedDisposable?.dispose();
      availableRuntimeGenerationByWorkspaceKey.clear();
    },
  };
}

function buildMetaFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
  options?: {
    modelOverride?: string;
    thoughtLevelOverride?: string;
  },
): ZCodeTaskMeta {
  const modelOverride = options?.modelOverride?.trim();
  const thoughtLevelOverride = options?.thoughtLevelOverride?.trim();
  const meta: ZCodeTaskMeta = {
    taskId: snapshot.session.sessionId,
    traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    mode: fromZCodeMode(snapshot.session.mode),
    // Explicit model switches and unavailable historical models already carry a fresh usable
    // model on the session op; overlay sqlite's task model in those cases or the next resume
    // starts from a deleted model. Plain history snapshots keep latest-message-model-wins so a
    // polluted settings.current cannot backfire into the index.
    model: modelOverride || formatTaskMetaModelSelectionFromSnapshot(snapshot),
    // On history restore, snapshot.settings.thoughtLevel may still hold the workspace draft's
    // latest value. When the restore entry carries a task-local thoughtLevel, sqlite must
    // record the entry value or the next open is polluted again.
    thoughtLevel: thoughtLevelOverride || snapshot.settings.thoughtLevel.current,
    provider: ZCODE_AGENT_PROVIDER,
    status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          // sessions-index terminal resync and the task service snapshot must share one
          // lastError attribution, or the cold and hot read paths drift.
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
  };
  if (Object.prototype.hasOwnProperty.call(snapshot.projection, "target")) {
    // A missing target key means this snapshot carried no goal info; keep the old index. Only
    // null means the DB has no goal and the task-index target must be cleared.
    meta.target = snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target;
  }
  return meta;
}

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

// Right after createSession the snapshot has neither real title nor user message; broadcasting
// such a blank session flashes a "New session" placeholder in the sidebar. This checks for any
// user-visible content: with none, write sqlite only and broadcast once the real title lands.
function hasUserVisibleContent(snapshot: ZCodeSessionStateSnapshot): boolean {
  const title = snapshot.session.title?.trim() ?? "";
  if (title && !isZCodeGoalContinuationReminderText(title)) {
    return true;
  }
  if (snapshot.projection.target?.objective.trim()) {
    return true;
  }
  return snapshot.messages.some((message) => {
    if (message.info.role !== "user") return false;
    if (isZCodeModelOnlySyntheticUserMessage(message)) return false;
    return message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  });
}

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

// Global session search indexes only the default-visible chat body: no reasoning, no tool
// calls, no collapsed compaction. An assistant message's parts may mix historical and latest
// body; take the last text part only, matching the UI's default collapsed view.
function buildSearchableTextFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  const parts: string[] = [];
  let total = 0;
  // /goal auto-continuation persists internal system-reminders as runtime user turns; that
  // content is model-only input, not a user-visible query, and stays out of sidebar search text.
  for (const message of getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  })) {
    const textParts = message.parts.filter(
      (part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text",
    );
    if (textParts.length === 0) {
      continue;
    }
    const chosen = message.info.role === "assistant" ? textParts.slice(-1) : textParts;
    for (const part of chosen) {
      const content = part.text.trim();
      if (!content) {
        continue;
      }
      parts.push(content);
      total += content.length;
      if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
        break;
      }
    }
    if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
      break;
    }
  }
  // Load-bearing cap: truncate at the limit so long tasks cannot bloat tasks-index.sqlite into startup/list-query pain.
  return parts.join("\n").slice(0, TASK_SEARCH_TEXT_MAX_CHARS);
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function fromZCodeGoal(
  goal: NonNullable<ZCodeSessionStateSnapshot["projection"]["target"]>,
): ZCodeTaskGoal {
  return {
    sessionID: goal.sessionId,
    targetID: goal.targetId,
    objective: goal.objective,
    summaryTitle: goal.summaryTitle,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    time: {
      created: goal.createdAt,
      updated: goal.updatedAt,
    },
  };
}
