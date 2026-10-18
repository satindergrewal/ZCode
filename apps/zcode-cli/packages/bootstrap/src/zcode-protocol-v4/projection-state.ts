// ProductProjection state factory and derivation rules.
// Pure functions only: initial snapshot, availability/inputRouting derivations, revision-advance decisions.
import type {
  ActionAvailability,
  ConversationDelta,
  ConversationSnapshot,
  GoalState,
  InputRouting,
  SessionActionAvailability,
  SessionControl,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * The traceId sentinel for cold-restored synthesized events.
 * Synthesized events are view rebuilds, not authoritative user actions: config-class synths such as ModelSelected
 * update the projected config but must not claim seed authority (configModelTouchedByEvent) --
 * else the last historical round's model would override the runtime truth rewritten at resume (draft-stage choices included).
 */
export const HYDRATION_TRACE_ID = "hydrate-trace";

export function createInitialConversationSnapshot(
  sessionId: string,
  logEpoch: string,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch,
    seq: 0,
    revision: 0,
    control: {
      // draft verdict: the session entity exists but has no input yet.
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: computeAvailability({
      phase: "draft",
      goalStatus: null,
      compacting: false,
      goalVerifying: false,
      queueLength: 0,
      autoDrain: true,
    }),
    inputRouting: computeInputRouting(
      {
        phase: "draft",
        goalStatus: null,
        compacting: false,
        goalVerifying: false,
        queueLength: 0,
        autoDrain: true,
      },
      "queue",
    ),
    meta: { title: "", titleSource: "default" },
    // mode initial value = core's default collaboration mode (session-mode-port getMode's "build" fallback).
    // SessionCreated carries a mode, but draft semantics demand no visible delta (no revision bump);
    // non-build persisted preferences wait for the first SessionModeChanged (TODO: a revision-free seed channel during draft).
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    // Soft gate: no pending review initially; written by the projection once activate() reports.
    workspaceHookAdmission: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

const ALLOWED: ActionAvailability = { allowed: true };

function denied(reasonCode: string): ActionAvailability {
  return { allowed: false, reasonCode };
}

// Guard-derived input face (same source as the projection, P5-3). compacting/goalVerifying are not separate phases
// (10 4.2.1 closed phase enum); derived from activeWorks / goal.status and passed in.
// queueLength/autoDrain feed the held derivation (heldQueueInputRequiresChoice, ruling 2026-07-05).
export interface AvailabilityContext {
  phase: SessionControl["phase"];
  goalStatus: GoalState["status"] | null;
  compacting: boolean;
  goalVerifying: boolean;
  queueLength: number;
  autoDrain: boolean;
}

// The verdict table aligns row-by-row with packages/formal-proof/src/model.ts's evaluate
// (backed by the formal-proof-consistency golden test); reasonCode = the product-protocol guard id.
export function computeAvailability(context: AvailabilityContext): SessionActionAvailability {
  const { phase, goalStatus, compacting } = context;
  const running = phase === "running" || phase === "prewarming";
  const compact = compacting
    ? // formal-proof: duplicateCompactRejected -- dedup via the running/queued compact operation lock.
      denied("compactOperationLock")
    : phase === "draft"
      ? // formal-proof: idleCannotCompact -- no compactable context.
        denied("idleCannotCompact")
      : // during running/goal-verifier the command enters the typed FIFO; on completed it executes at once or enters held.
        ALLOWED;
  return {
    fork: compacting
      ? denied("compactOperationLock")
      : phase === "draft"
        ? denied("forkTargetNotStable")
        : ALLOWED,
    compact,
    switchModelConfig: ALLOWED,
    setFollowupMode: ALLOWED,
    queueEdit: ALLOWED,
    sendQueuedNow: compacting
      ? denied("compactOperationLock")
      : running
        ? ALLOWED
        : denied("sendQueuedNowRequiresRunning"),
    // A standalone pauseGoal changes the target's product state; during verifier/notSatisfied the underlying target is still active,
    // so pausing is allowed -- never require a live provider abort controller.
    pauseGoal:
      goalStatus === "active" || goalStatus === "verifying" || goalStatus === "notSatisfied"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToPause" : "goalNotActive"),
    // resumeGoal is the inverse of stopPausesActiveGoalTarget: only paused resumes.
    resumeGoal:
      goalStatus === "paused"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToResume" : "goalNotPaused"),
  };
}

export function computeInputRouting(
  context: AvailabilityContext,
  followupMode: "queue" | "guide",
): InputRouting {
  // formal-proof: compactingAcceptsFutureInput
  // -- compact is maintenance; the input is future intent -> queue, never interrupt the compact.
  if (context.compacting) {
    return { mode: "enqueue", reasonCode: "compactingAcceptsFutureInput" };
  }
  // The goal verifier is completion-blocking active work, but not a normal
  // assistant active turn; keying on phase=running would steer in guide mode while
  // core has no steerable activeTurn, so the input lands in neither queue nor history.
  if (context.goalVerifying) {
    return { mode: "enqueue", reasonCode: "goalVerifierAcceptsFutureInput" };
  }
  if (context.phase === "running" || context.phase === "prewarming") {
    return { mode: followupMode === "guide" ? "guide" : "enqueue" };
  }
  // completed + queue>0 + autoDrain=false: input does not silently enqueue;
  // the client presents clear/keep, and the disposition travels up with the command.
  const completed =
    context.phase === "completedSuccess" || context.phase === "completedInterrupted";
  if (completed && context.queueLength > 0 && !context.autoDrain) {
    return { mode: "choice", reasonCode: "heldQueueInputRequiresChoice" };
  }
  return { mode: "startNow" };
}

// Revision-advance rule (closed definition): row-structure changes and group-A changes (except usage/pendingCommands) each +1.
// `workflowRuns` is **deliberately excluded**, in the usage/pendingCommands exemption class: high-frequency derived data
// (about 5 migrations per node), with its own monotonic revision field, and no command's
// baseRevision CAS reads it -- listing it would jitter conversation revision on every node migration of a live run,
// buying CAS false failures.
const REVISION_BEARING_PATCH_KEYS: ReadonlyArray<keyof StatePatch> = [
  "control",
  "availability",
  "inputRouting",
  "meta",
  "config",
  "queue",
  "pendingInteractions",
  "backgroundWorks",
  "subagents",
  "goal",
  "plan",
];

export function deltaBumpsRevision(delta: ConversationDelta): boolean {
  switch (delta.op) {
    case "row.appended":
    case "row.upserted":
    case "row.removed":
      return true;
    case "row.delta":
      return false;
    case "state.updated":
      return REVISION_BEARING_PATCH_KEYS.some((key) => delta.patch[key] !== undefined);
    case "pluginUi.resourceUpdated":
    case "pluginUi.resourceListChanged":
    case "pluginUi.instanceClosed":
    case "pluginUi.appToolCall":
    // Live-only notices touch neither snapshot nor ledger.
    // Key-level deltas share the whole-key `workflowRuns` exemption (see above): they express that key's change,
    // and a different encoding must not change the accounting -- listing them would jitter conversation revision per node migration of a live run.
    case "workflowRun.updated":
    case "workflowRun.removed":
      return false;
  }
}
