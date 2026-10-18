import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type SessionEvent,
} from "@zcode/contracts";
import { createDenyPermissionBroker } from "@zcode/core";
import type { GlobalOptions } from "@zcode/shared-types";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { readRuntimeFunction } from "./runtime-event-subscriber.js";

/**
  * The CreateWorkflow approval bypass under headless (-p).
 *
  * Why it exists: headless never constructs a permissionBroker, so core falls back to the deny broker (see
 * `createDenyPermissionBroker()`（`core/src/runtime/agent-runtime.ts`、
  * core/src/tool/executor/impl.ts), while CreateWorkflow's alwaysAsk gate
  * must pass the broker in every mode -- yolo included, since the alwaysAsk branch in core/src/permission/service.ts
  * precedes the mode branches. Together: under -p, dwf is **necessarily rejected immediately**,
  * with the message "No permission client configured for CreateWorkflow" -- a hard error, not a hang or timeout.
 *
  * The bypass admits CreateWorkflow only, by tool name; every other tool is **delegated to the same deny broker**:
  * reusing rather than restating its denial semantics makes other-tools-keep-today's-behavior a structural fact, not a coincidence
  * (wording drift is impossible -- there is only one copy).
 *
  * This is a gate bypass, not a permission bypass:
  * core is untouched, the PermissionRequest hook still answers before the broker (the ?? short-circuit in permission-flow.ts),
  * permission events still fire, and in-run actors still inherit the session's permission profile.
 */
export const createHeadlessPermissionBroker = (): NonNullable<
  ZCodeAppOptions["permissionBroker"]
> => {
  const denyBroker = createDenyPermissionBroker();
  return {
    requestPermission: async (request, options) => {
            // AmendWorkflow passes the same gate, under the same exception.
      if (
        request.toolName !== CREATE_WORKFLOW_TOOL_NAME &&
        request.toolName !== AMEND_WORKFLOW_TOOL_NAME
      ) {
        return await denyBroker.requestPermission(request, options);
      }
      return {
        decision: "allow",
        reason: `Headless CLI auto-approves ${request.toolName}: no interactive gate exists in -p mode.`,
        resolvedAt: new Date(),
      };
    },
  };
};

/**
  * The type of dwf progress lines in stream-json.
 *
  * Deliberately **not** added to zcodeSessionEventTypeSchema (shared/src/zcode-protocol/index.ts):
  * that is a closed zod enum feeding zcodeSessionEventSchema's discriminated union -- adding a value would have the
  * v3 app-server declare, at the type level, an event it never emits. stream-json is a CLI-private output format,
  * not bound by the protocol's strict schema.
 */
const WORKFLOW_RUN_PROGRESS_STREAM_TYPE = "workflow.run.progress";

/**
  * One settled dwf-progress NDJSON line. Envelope fields align verbatim with mapSessionEvent (same keys, same
  * String()/getTime() normalization), so line readers need no second envelope rule for this one line kind;
  * payload is the contracts bounded payload **as-is**, with no field renaming.
 */
interface WorkflowRunProgressStreamLine {
  type: typeof WORKFLOW_RUN_PROGRESS_STREAM_TYPE;
  eventId: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  traceId: string;
  payload: DynamicWorkflowRunProgressPayload;
}

/** Is this session event dwf progress? The shared gate for stream-json and stderr progress. */
const isDynamicWorkflowRunProgressEvent = (event: SessionEvent): boolean =>
  event.type === SessionEventType.DynamicWorkflowRunProgress;

const progressPayloadOf = (event: SessionEvent): DynamicWorkflowRunProgressPayload =>
  event.payload as DynamicWorkflowRunProgressPayload;

/**
  * dwf progress event -> settled NDJSON line.
 *
  * Replaces today's bare leak: mapSessionEvent's default lands this type in the catch-all
  * session.updated (session-mapper.ts), so stream-json consumers get a line
  * named like any-other-change yet carrying run-internal payload -- indistinguishable and unsubscribable.
 *
  * Note dwf events are out-of-turn (turnId always empty), so the envelope omits
  * turnId: an always-undefined key would only suggest it sometimes has a value.
 */
const mapWorkflowRunProgressStreamLine = (event: SessionEvent): WorkflowRunProgressStreamLine => ({
  type: WORKFLOW_RUN_PROGRESS_STREAM_TYPE,
  eventId: String(event.id),
  sessionId: String(event.sessionId),
  seq: event.sequenceNumber,
  timestamp: event.timestamp.getTime(),
  traceId: String(event.traceId),
  payload: progressPayloadOf(event),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const instanceLabel = (payload: Record<string, unknown>): string | undefined => {
  const instance = asRecord(payload.instance);
  const siteId = instance.siteId;
  if (typeof siteId !== "string") return undefined;
  const ordinal = instance.ordinal;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
};

/**
  * The **state-transition** face of the engine event kinds (text-mode stderr prints these plus log).
 *
  * Vocabulary from toProtocolEvent's contract comment (bootstrap/src/app/dynamic-workflow-run-launch.ts):
 * run-started / actor-created / node-queued / node-dispatched / node-repairing /
 * node-nudged / node-settled / usage-updated / log / run-settled。
  * usage-updated and actor-created are deliberately not printed: the former is pure counting, the latter no transition.
 */
const describeProgress = (payload: DynamicWorkflowRunProgressPayload): string | undefined => {
  const inner = asRecord(payload.payload);
  switch (payload.eventType) {
    case "run-started":
      return "started";
    case "run-settled": {
            // Terminal vocabulary: completed / errored / stopped;
            // stopped carries a reason: stopped/provider: ...
      const rawStatus = typeof inner.status === "string" ? inner.status : "settled";
      const status =
        typeof inner.stopReason === "string" ? `${rawStatus}/${inner.stopReason}` : rawStatus;
      const error = asRecord(inner.error).message;
      return typeof error === "string" ? `${status}: ${error}` : status;
    }
    case "log":
      return typeof inner.message === "string" ? `log: ${inner.message}` : undefined;
    case "node-queued":
    case "node-dispatched":
    case "node-repairing":
    case "node-nudged": {
      const label = instanceLabel(inner);
      return label ? `${payload.eventType.slice("node-".length)} ${label}` : undefined;
    }
    case "node-settled": {
      const label = instanceLabel(inner);
      const outcome = typeof inner.outcome === "string" ? inner.outcome : "settled";
      return label ? `settled ${label} (${outcome})` : undefined;
    }
    default:
      return undefined;
  }
};

/**
  * Whether a transition belongs to the must-print face. Run start and settlement are the two endpoints of this progress stream; no throttling may eat them
  * -- else text mode could print nothing for the whole wait, then suddenly print the final answer.
  * log is emitted explicitly by the script author (the log() facade), likewise unthrottled: its frequency is the script's choice,
  * and the author wrote it to be seen.
 */
const isUnthrottledProgress = (eventType: string): boolean =>
  eventType === "run-started" || eventType === "run-settled" || eventType === "log";

interface WorkflowProgressReporterInput {
    /** Progress goes to stderr only -- stdout belongs to the result (text mode prints brief progress on stderr). */
  write: (line: string) => void;
    /** Injected clock, so throttling is exhaustible in sleep-free unit tests. */
  now?: () => number;
    /** Minimum interval between node phase transitions; log and run endpoints are exempt. */
  throttleMs?: number;
}

/** Default throttle interval for node phase transitions. A 100-node run emits roughly 5x100 events. */
const DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS = 400;

/**
  * The stderr progress printer for --output-format text.
  * Knows only dwf progress events; every other session event is ignored (no side effects after return).
 */
const createWorkflowProgressReporter = (
  input: WorkflowProgressReporterInput,
): ((event: SessionEvent) => void) => {
  const now = input.now ?? Date.now;
  const throttleMs = input.throttleMs ?? DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS;
  let lastThrottledAt: number | undefined;
  return (event) => {
    if (!isDynamicWorkflowRunProgressEvent(event)) return;
    const payload = progressPayloadOf(event);
    const description = describeProgress(payload);
    if (description === undefined) return;
    if (!isUnthrottledProgress(payload.eventType)) {
      const at = now();
      if (lastThrottledAt !== undefined && at - lastThrottledAt < throttleMs) return;
      lastThrottledAt = at;
    }
    input.write(`workflow ${payload.runId}: ${description}\n`);
  };
};

interface HeadlessWriteStream {
  write: (chunk: string) => unknown;
}

interface HeadlessSessionObserverInput {
  options: Pick<GlobalOptions, "json" | "outputFormat">;
  stderr: HeadlessWriteStream;
  stdout: HeadlessWriteStream;
    /** Needed only by --output-format stream-json; absent means no NDJSON is written. */
  mapSessionEvent?: (event: SessionEvent) => unknown;
}

interface HeadlessSessionObserver {
    /** The single session-event consumer. Mounted on **one** sink -- two sinks would write every line twice. */
  observe: (event: SessionEvent) => void;
  /**
      * Has dwf activity been observed? The **narrow trigger** for wait-for-settlement: a run with no dwf activity
      * never enters the wait, not even once -- byte-for-byte the pre-change behavior.
   */
  hasWorkflowActivity: () => boolean;
  /**
      * Start recording turn text. Must be called **synchronously** after submitPrompt returns: nothing can cut in
      * between that point and the first await, so the notice-driven turn's first event cannot be missed.
      * excludeTurnId is the first turn's id -- its text already came back in submitPrompt's return value;
      * should its turn_complete be late, this id blocks a double count.
   */
  beginWaitPhase: (excludeTurnId?: string) => void;
    /** Text of every turn completed during the wait, in arrival order. */
  waitPhaseTurnResponses: () => readonly string[];
}

/**
  * The headless session-event observer: one place for both what-the-format-prints and what-the-wait-needs.
 *
  * Division of labor across the three formats:
  *   stream-json -> one NDJSON line per event on stdout, dwf progress as settled lines; nothing on stderr.
  *   text        -> dwf progress only, and only to stderr (stdout belongs to the result).
  *   json        -> no events written (the contract is exactly one object).
 *
  * All three formats **observe** events -- even when json prints nothing, the wait still relies on the dwf trigger
  * and turn-text recording. So the function always returns an observer; it no longer returns undefined.
 */
export const createHeadlessSessionObserver = (
  input: HeadlessSessionObserverInput,
): HeadlessSessionObserver => {
  const { mapSessionEvent, options, stderr, stdout } = input;
  const writeStreamEvent = mapSessionEvent
    ? (event: SessionEvent) => {
        // One event per line, written as it happens. Deliberately not formatJson:
        // that pretty-prints with an indent, which would spread a single event
        // over several lines and break every line-oriented reader downstream.
        //
                // dwf progress travels as a settled line: mapSessionEvent's default would land it in the catch-all
                // session.updated (session-mapper.ts); readers could neither tell them apart
                // nor subscribe to that kind alone.
        const line = isDynamicWorkflowRunProgressEvent(event)
          ? mapWorkflowRunProgressStreamLine(event)
          : mapSessionEvent(event);
        stdout.write(`${JSON.stringify(line)}\n`);
      }
    : undefined;
  const reportProgress =
    mapSessionEvent === undefined && wantsWorkflowProgress(options)
      ? createWorkflowProgressReporter({ write: (line) => void stderr.write(line) })
      : undefined;

  let workflowActivity = false;
  let waiting = false;
  let excludedTurnId: string | undefined;
  const turnResponses: string[] = [];

  return {
    hasWorkflowActivity: () => workflowActivity,
    beginWaitPhase: (excludeTurnId) => {
      waiting = true;
      excludedTurnId = excludeTurnId;
    },
    waitPhaseTurnResponses: () => turnResponses,
    observe: (event) => {
      writeStreamEvent?.(event);
      reportProgress?.(event);
      if (isWorkflowActivityEvent(event)) workflowActivity = true;
      if (!waiting || event.type !== SessionEventType.TurnComplete) return;
            // The first turn's text comes from submitPrompt's return; a late turn_complete would double-count.
      if (event.turnId !== undefined && String(event.turnId) === excludedTurnId) return;
      const response = (event.payload as { response?: unknown }).response;
      if (typeof response === "string" && response.trim().length > 0) turnResponses.push(response);
    },
  };
};

/**
  * Does this event prove dwf activity in this process?
 *
  * Two predicates, not one: progress events are the most direct evidence, but their append is async and could in theory
  * reach the sink after the turn ends. BackgroundTaskStarted, though, is emitted synchronously when the tool executor registers the background task,
  * so it **necessarily** lands within the spawning turn -- earlier and harder evidence. Accept both; either triggers.
 */
const isWorkflowActivityEvent = (event: SessionEvent): boolean => {
  if (isDynamicWorkflowRunProgressEvent(event)) return true;
  return (
    event.type === SessionEventType.BackgroundTaskStarted &&
    (event.payload as { taskKind?: unknown }).taskKind === "workflow"
  );
};

/** The runtime's two authoritative busy facts. A narrow interface, not the whole AgentRuntime -- the wait reads two booleans. */
interface HeadlessWorkflowRuntimeFacts {
  hasActiveOrQueuedTurnWork: () => boolean;
  hasRunningBackgroundTasks: () => boolean;
}

/** Poll interval. The wait is minutes-scale: this granularity is negligible and it sets exit responsiveness. */
const HEADLESS_WORKFLOW_POLL_INTERVAL_MS = 100;

/**
  * Wait for the in-flight workflow run to settle **and** the completion-notice-driven turn to finish.
 *
  * Why polling two booleans suffices (no race window -- the key argument of this mechanism): the background task going terminal
  * (updateRuntimeBackgroundTask in background-tasks.ts) and the notice command being enqueued
  * (runtime-command-queue.ts, via maybeEnqueueBackgroundTaskNotification ->
  * enqueueBackgroundTaskNotification -> enqueueRuntimeCommand) share **no await in between**,
  * and drainRuntimeCommandQueue sets runtimeCommandDrainActive before its first await too.
  * So task-no-longer-running and turn-work-pending flip within one synchronous block; a poller cannot land in between.
 *
  * The predicate is deliberately **wider than dwf**: coexisting background Bash/subagent tasks are awaited too. Their notice
  * turns interleave with the workflow's on the same queue; waiting separately is meaningless. The narrow half is the **trigger** (hasWorkflowActivity),
  * so runs with no dwf activity are untouched entirely.
 *
  * No timeout, no env escape hatch: the controls are Cancel and Ctrl-C, the latter recording the run as
  * stopped(interrupted) (failure code Interrupted, resumable) via the existing orphan convergence. Return as soon as signal aborts; never swallow it.
 */
export const waitForHeadlessWorkflowSettle = async (input: {
  intervalMs?: number;
  runtime: HeadlessWorkflowRuntimeFacts;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> => {
  const intervalMs = input.intervalMs ?? HEADLESS_WORKFLOW_POLL_INTERVAL_MS;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (!input.signal.aborted) {
    if (!input.runtime.hasRunningBackgroundTasks() && !input.runtime.hasActiveOrQueuedTurnWork()) {
      return;
    }
    await sleep(intervalMs);
  }
};

/**
  * Can this app's runtime provide the busy facts?
 *
  * For the dynamic read, see readRuntimeFunction in runtime-event-subscriber.ts (the same
  * RunDependencies.createZCodeApp injection-point boundary).
 *
  * **No silent downgrade**: without the busy facts, do not enter the wait -- the honest this-host-lacks-the-capability answer,
  * not a pretended wait.
 */
export const readHeadlessRuntimeFacts = (
  runtime: unknown,
): HeadlessWorkflowRuntimeFacts | undefined => {
  const turnWork = readRuntimeFunction(runtime, "hasActiveOrQueuedTurnWork");
  const backgroundTasks = readRuntimeFunction(runtime, "hasRunningBackgroundTasks");
  if (!turnWork || !backgroundTasks) return undefined;
  return {
    hasActiveOrQueuedTurnWork: () => turnWork.call(runtime) === true,
    hasRunningBackgroundTasks: () => backgroundTasks.call(runtime) === true,
  };
};

/**
  * Should this run print workflow progress on stderr?
 *
  * Only text has that slot: json's contract is exactly one object, and stream-json already settles every progress
  * line onto stdout. The default (no --output-format, no --json) is text, so it prints too.
 */
const wantsWorkflowProgress = (options: Pick<GlobalOptions, "json" | "outputFormat">): boolean =>
  options.outputFormat === undefined ? !options.json : options.outputFormat === "text";
