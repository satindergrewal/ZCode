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
 * CreateWorkflow approval bypass under headless (`-p`).
 *
 * Why it exists: headless never builds a permissionBroker, so core falls back to
 * `createDenyPermissionBroker()`（`core/src/runtime/agent-runtime.ts`、
 * (core/src/tool/executor/impl.ts), and CreateWorkflow's `alwaysAsk` gate
 * must pass the broker in every mode (`yolo` cannot skip it either; the alwaysAsk branch in core/src/permission/service.ts
 * runs before the mode switch). Net result: dwf is always rejected immediately under `-p`,
 * with the message "No permission client configured for CreateWorkflow" -- a hang, not a timeout.
 *
 * The bypass admits CreateWorkflow by tool name only and delegates all other tools to the same deny broker:
 * it reuses rather than restates the denial semantics, making unchanged behavior for other tools structural instead of coincidental
 * (copy drift is impossible -- there is only one).
 *
 * This is not a permission bypass, only a gate bypass:
 * core is untouched; the PermissionRequest hook still answers before the broker (the `??`
 * short-circuit in permission-flow.ts), permission events still fire, and in-run actors inherit the session's permission profile as before.
 */
export const createHeadlessPermissionBroker = (): NonNullable<
  ZCodeAppOptions["permissionBroker"]
> => {
  const denyBroker = createDenyPermissionBroker();
  return {
    requestPermission: async (request, options) => {
      // AmendWorkflow passes the same gate with the same exception.
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
 * The `type` of dwf progress lines in stream-json.
 *
 * Deliberately not a member of zcodeSessionEventTypeSchema (shared/src/zcode-protocol/index.ts):
 * that is a closed `z.enum` feeding a discriminated union in `zcodeSessionEventSchema`; adding a value would make the
 * v3 app-server declare, at the type level, an event it never emits. stream-json is a CLI-private output format,
 * not bound by the protocol's strict schema.
 */
export const WORKFLOW_RUN_PROGRESS_STREAM_TYPE = "workflow.run.progress";

/**
 * One typed dwf progress NDJSON line. Envelope fields align verbatim with `mapSessionEvent` (same keys, same
 * `String()`/`getTime()` normalization), so line readers need no second envelope interpretation for this one shape;
 * `payload` is the bounded contracts payload verbatim, with no field renaming.
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

/** Is this session event dwf progress? stream-json and stderr progress share this verdict. */
export const isDynamicWorkflowRunProgressEvent = (event: SessionEvent): boolean =>
  event.type === SessionEventType.DynamicWorkflowRunProgress;

const progressPayloadOf = (event: SessionEvent): DynamicWorkflowRunProgressPayload =>
  event.payload as DynamicWorkflowRunProgressPayload;

/**
 * dwf progress event -> typed NDJSON line.
 *
 * Replaces today's bare leak: mapSessionEventType's default folds this type into the catch-all
 * `session.updated` (session-mapper.ts), so stream-json consumers get a line
 * named like a generic something-changed but carrying run-internal payload -- indistinguishable and unsubscribable.
 *
 * Note dwf events are out-of-turn (`turnId` always empty), so the envelope carries no
 * `turnId`: a always-undefined key would suggest it sometimes has a value.
 */
export const mapWorkflowRunProgressStreamLine = (
  event: SessionEvent,
): WorkflowRunProgressStreamLine => ({
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
 * The state-transition subset of engine events (what `text`-mode stderr prints, plus `log`).
 *
 * Vocabulary from the toProtocolEvent contract comments (bootstrap/src/app/dynamic-workflow-run-launch.ts):
 * run-started / actor-created / node-queued / node-dispatched / node-repairing /
 * node-nudged / node-settled / usage-updated / log / run-settled。
 * `usage-updated` and `actor-created` are deliberately not printed: the former is pure counting, the latter is no transition.
 */
const describeProgress = (payload: DynamicWorkflowRunProgressPayload): string | undefined => {
  const inner = asRecord(payload.payload);
  switch (payload.eventType) {
    case "run-started":
      return "started";
    case "run-settled": {
      // Terminal vocabulary: completed / errored / stopped;
      // stopped carries a reason: `stopped/provider: ...`.
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
 * Whether a transition is must-print. Run start and settlement are the two endpoints of this progress stream; no throttle may eat them,
 * or `text` mode could print nothing for the whole wait and then dump the final answer.
 * `log` is emitted explicitly by the script author (the `log()` facade) and is also unthrottled: its frequency is the script's choice,
 * and it was written to be seen.
 */
const isUnthrottledProgress = (eventType: string): boolean =>
  eventType === "run-started" || eventType === "run-settled" || eventType === "log";

interface WorkflowProgressReporterInput {
  /** Progress goes to stderr only -- stdout belongs to the result (`text` mode prints brief progress on stderr). */
  write: (line: string) => void;
  /** Injected clock so throttling is exhaustively testable without sleeps. */
  now?: () => number;
  /** Minimum interval for node phase transitions; `log` and run endpoints are exempt. */
  throttleMs?: number;
}

/** Default throttle interval for node phase transitions. A 100-node run emits roughly 5x100 events. */
const DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS = 400;

/**
 * stderr progress printer for `--output-format text`.
 * Recognizes only dwf progress events; all other session events are ignored (no side effects after return).
 */
export const createWorkflowProgressReporter = (
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
  /** Only needed for `--output-format stream-json`; absent means no NDJSON is written. */
  mapSessionEvent?: (event: SessionEvent) => unknown;
}

interface HeadlessSessionObserver {
  /** The only session-event consumer. Mounted on exactly one sink -- two sinks mean duplicated lines. */
  observe: (event: SessionEvent) => void;
  /**
   * Has dwf activity been observed? This is the narrow trigger for the settlement wait: runs with no dwf activity
   * never enter the wait, keeping behavior byte-identical to before.
   */
  hasWorkflowActivity: () => boolean;
  /**
   * Start recording turn text. Must be called synchronously after `submitPrompt` returns: between that moment and the first
   * await, no event can cut in, so the notification-driven turn's first event cannot be missed.
   * `excludeTurnId` is the first turn's id -- its text already arrived via `submitPrompt`'s return value,
   * and if its `turn_complete` lands late, this id prevents double counting.
   */
  beginWaitPhase: (excludeTurnId?: string) => void;
  /** Text of each turn completed during the wait, in arrival order. */
  waitPhaseTurnResponses: () => readonly string[];
}

/**
 * The headless session-event observer: one place for what each output format does and what the wait needs to know.
 *
 * Division of labor across the three formats:
 *   stream-json -> one NDJSON line per event on stdout, dwf progress as typed lines; nothing duplicated on stderr.
 *   text        -> dwf progress only, and only on stderr (stdout belongs to the result).
 *   json        -> no events at all (the contract is exactly one object).
 *
 * All three formats observe events -- even though json prints nothing, the wait still relies on the dwf trigger
 * and turn-text recording. So this always returns an observer, never undefined.
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
        // dwf progress takes the typed line: mapSessionEvent's default would fold it into the catch-all
        // `session.updated` (session-mapper.ts), leaving readers unable to distinguish it or
        // subscribe to it alone.
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
 * Two signals, not one: the progress event is the most direct proof, but its append is async and could in theory land after
 * the turn ends. `BackgroundTaskStarted` fires synchronously when the tool executor registers the background task,
 * necessarily inside the turn that started it -- earlier, harder evidence. Accept both; either triggers.
 */
const isWorkflowActivityEvent = (event: SessionEvent): boolean => {
  if (isDynamicWorkflowRunProgressEvent(event)) return true;
  return (
    event.type === SessionEventType.BackgroundTaskStarted &&
    (event.payload as { taskKind?: unknown }).taskKind === "workflow"
  );
};

/** The runtime's two busy facts. A narrow interface instead of the whole AgentRuntime -- the wait reads only these booleans. */
interface HeadlessWorkflowRuntimeFacts {
  hasActiveOrQueuedTurnWork: () => boolean;
  hasRunningBackgroundTasks: () => boolean;
}

/** Poll interval. Waits are minutes-scale, so this granularity is free -- and it sets exit responsiveness. */
const HEADLESS_WORKFLOW_POLL_INTERVAL_MS = 100;

/**
 * Wait for the in-flight workflow run to settle plus notification-driven turns to finish.
 *
 * Why polling these two booleans suffices (no race window -- the key argument): the background task's terminal transition
 * (updateRuntimeBackgroundTask in background-tasks.ts) and the notification command enqueue
 * (runtime-command-queue.ts, via maybeEnqueueBackgroundTaskNotification ->
 * enqueueBackgroundTaskNotification -> enqueueRuntimeCommand) happen with no await in between,
 * and drainRuntimeCommandQueue sets `runtimeCommandDrainActive` before its first await.
 * So task-no-longer-running and turn-work-pending flip in one synchronous block; a poller cannot land in between.
 *
 * The predicate is deliberately wider than dwf: concurrent background Bash/subagent tasks are awaited too. Their notification turns interleave
 * with the workflow's on the same queue; waiting separately is meaningless. The narrow half is the trigger (hasWorkflowActivity),
 * so runs with no dwf activity are entirely unaffected.
 *
 * No timeout, no env escape hatch: the controls are Cancel and Ctrl-C, the latter recording the run as
 * `stopped(interrupted)` via the existing orphan convergence (failure code `Interrupted`, resumable). Return immediately on abort; never swallow the signal.
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
 * Why it is read dynamically: see readRuntimeFunction in runtime-event-subscriber.ts (the same
 * RunDependencies.createZCodeApp injection-point boundary).
 *
 * No silent degradation: without the busy facts, do not enter the wait -- the honest answer is this host lacks the capability,
 * not pretending the wait happened.
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
 * Only `text` has such a channel: `json`'s contract is exactly one object, and `stream-json` already types each progress
 * event as a stdout line. The default (no --output-format, no --json) is text, so it prints too.
 */
const wantsWorkflowProgress = (options: Pick<GlobalOptions, "json" | "outputFormat">): boolean =>
  options.outputFormat === undefined ? !options.json : options.outputFormat === "text";
