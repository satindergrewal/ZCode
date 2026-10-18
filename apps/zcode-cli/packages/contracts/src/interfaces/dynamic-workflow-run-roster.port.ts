// ============================================================
// The **situation section** of a Dynamic Workflow Run: phases / subagents / health
// ============================================================
// Split out of dynamic-workflow-run.port.ts for the same reason as dwf-journal-introspection.ts: that contract
// hit oxlint's max-lines ceiling. Public surface unchanged - the main port file re-exports every name here in place,
// and `@zcode/contracts` import paths stay verbatim.
//
// The three field groups hang off `DynamicWorkflowRunDetail`, derived at read time in `getRunDetail`;
// contracts and invariants live in each type's comments below.

// One discipline across all three: **time has one source**, `dwf_event.time_created` (when the event
// entered the journal). A read-time `Date.now()` fallback is wrong - it would label week-old cold-read history "just now",
// and the entire point of these fields is a trustworthy "how long ago". Old journals without the column keep time fields
// **absent**: no 0, no NaN.

/**
 * A phase's situation in the situation section.
 *
 * - `ahead`: declared by the script, control flow not there yet - the **only** state with `rounds: 0`;
 * - `current`: run alive and this is the most recently entered phase;
 * - `unfinished`: run terminal yet the phase has unsettled asks (the process died under it);
 * - `done`: otherwise.
 */
export type DynamicWorkflowRunPhaseState = "done" | "current" | "ahead" | "unfinished";

/** A phase in the situation section (a `phase("...")` marker). */
export interface DynamicWorkflowRunPhaseView {
  /** Author's verbatim word; same vocabulary as `run-launched.phaseNames` / `phase-entered.name`. */
  name: string;
  state: DynamicWorkflowRunPhaseState;
  /** Times entered (same-name re-entry +1). Always 0 for `ahead`, >= 1 otherwise. */
  rounds: number;
  /** Settled / unsettled counts among nodes born in this phase. */
  nodesSettled: number;
  nodesRunning: number;
  /**
   * The **most recent** entry time, and that visit's exit time (the next differently-named `phase-entered`).
   * Most recent, not first: for a phase looped three times, the reader asks "how long in this visit".
   * The current phase has no exit time; both absent when events lack timestamps.
   */
  enteredAt?: number;
  exitedAt?: number;
}

/**
 * A subagent's current state. **Read order = precedence**, first hit settles:
 *
 * run not terminal: `parked` (its own question parked, awaiting an answer) -> `waiting` (the last lifecycle
 * event of the current ask is `node-waiting`: awaiting a slot or backing off) -> `executing` (an ask row still running) -> `failed`
 * (the last settled ask failed) -> `idle`.
 *
 * run terminal: all three live words retire - `unfinished` (ask rows still marked running, i.e. the process
 * died under them) -> `failed` -> `done`.
 */
export type DynamicWorkflowRunSubagentState =
  | "idle"
  | "executing"
  | "waiting"
  | "parked"
  | "done"
  | "failed"
  | "unfinished";

/**
 * The most recently observed tool call within the ask. `target` is a human **hint** (file path, command head),
 * not the args - every hop from engine to here cuts at the same bound; full args never come through.
 */
export interface DynamicWorkflowRunSubagentLastTool {
  name: string;
  target?: string;
  /** Persistence time of the `node-progress` that observed it; absent when the event has no timestamp. */
  at?: number;
}

/** The ask the subagent is running right now (present while its ask row is `running`). */
export interface DynamicWorkflowRunSubagentAsk {
  siteId: string;
  ordinal: number;
  /** Which ask this is for the subagent (journal `actorSeq`); absent on old rows without the column. */
  actorSeq?: number;
  /**
   * First 240 chars of the instructions written for this ask. Read surfaces answer "what was this subagent sent to do" with it - the phase
   * only says "running". Absent on old journals without `instructionsHead`; **never fetch full instructions to backfill**.
   */
  instructionsHead?: string;
  /** The ask's `node-dispatched` time; absent when the event has no timestamp. */
  startedAt?: number;
  /**
   * Round reached and cumulative tool calls (as `node-progress` arrives).
   * Always absent on journals without `node-progress` - absent reads "unknown", `0` reads
   * "not a single tool call", two different facts.
   */
  turn?: number;
  toolCalls?: number;
  lastTool?: DynamicWorkflowRunSubagentLastTool;
}

/** What the current ask waits on (the last `node-waiting` observation). */
export interface DynamicWorkflowRunSubagentWait {
  /** `slot` = awaiting the process-level admission gate; `backoff` = runner in backoff retry. */
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  /**
   * When **this wait began** (the first `node-waiting` after the last non-waiting
   * lifecycle event), not the last event's time: backoff ladders emit several; the reader asks "how long stuck".
   * Absent when events lack timestamps.
   */
  since?: number;
}

/** A subagent in the situation section (= one actor instance). */
export interface DynamicWorkflowRunSubagentView {
  siteId: string;
  ordinal: number;
  /** Effective name of `agent("poet")`; absent for anonymous actors, no fallback synthesized (as in pendingQuestions). */
  name?: string;
  state: DynamicWorkflowRunSubagentState;
  /** The phase its current (or last) ask was born in; falls back to its own birth phase when unreadable. */
  phaseName?: string;
  currentAsk?: DynamicWorkflowRunSubagentAsk;
  wait?: DynamicWorkflowRunSubagentWait;
  /**
   * Which question it is parked on (`pendingQuestions[].qid`). **Present only when the park table is truly queryable**:
   * a read with `health.pendingQuestionsKnown` false cannot know whether anyone waits; see that field.
   */
  parkedOn?: string;
  /** Settled / failed ask counts, plus the token sum over those asks (the node row's `stats`). */
  stepsSettled: number;
  stepsFailed: number;
  tokens: number;
  /** Last observed activity (latest progress-class event under any of its nodes). */
  lastProgressAt?: number;
}

/**
 * Run-level concurrency state: how far it is squeezed now, what it should be, and why, since when.
 *
 * **The whole object appears only when `effective < cap`** (same absence rule as the detail's `maxConcurrency`):
 * a run at its own bound has nothing to say; presence here means "currently throttled".
 */
export interface DynamicWorkflowRunConcurrencyHealth {
  /** What the governor actually admits now = min(shared gate, {@link cap}). */
  effective: number;
  /**
   * **This run's own** cap: the user-set number if set, else the machine ceiling.
   *
   * Deliberately not the ceiling: a run started with `max_concurrency: 3` would forever show "3/6" on a six-core machine,
   * reading as throttled while it runs exactly at the user's hand-set bound - a setting, not a fault.
   */
  cap: number;
  /** Reason of the last `concurrency-changed` (`rate_limited` / `recovered` ...). */
  reason?: string;
  /** That event's journal time; absent without timestamp. */
  since?: number;
}

/** Whether the run as a whole still moves. */
export interface DynamicWorkflowRunHealth {
  /** Time of the run's latest progress-class event. */
  lastProgressAt?: number;
  /**
   * Time of the last `run-stalled`, with **no** progress-class event after it.
   * "Waiting for a slot" is not progress - that wait is the stall; counting it hides stalls forever.
   */
  stalledSince?: number;
  concurrency?: DynamicWorkflowRunConcurrencyHealth;
  /** Trailing consecutive failed asks in settle order: 3 in a row vs 3 scattered are different situations. */
  consecutiveFailures: number;
  /** Settlements that hit the completion cache (`node-settled { cached: true }`). */
  cachedSteps: number;
  /** **Terminal runs only**: node rows still marked `running`, i.e. the process died under them. Absent at 0. */
  leftoverRunning?: number;
  /**
   * Whether this read **can** answer "is a question awaiting an answer".
   *
   * Parked questions live only in the asking process's memory (see {@link DynamicWorkflowRunDetail.pendingQuestions});
   * reading another process's in-flight run, "no pending questions" and "unknown" look identical - yet for the model
   * they are two different next steps. True when: this session holds the run's registry entry, or the run is
   * terminal (a terminal run has no listener by definition). When false, `pendingQuestions` is wholly absent and no
   * subagent is ever reported `parked`.
   */
  pendingQuestionsKnown: boolean;
}
