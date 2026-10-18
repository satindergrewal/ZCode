// ============================================================
// Dynamic Workflow run observation helpers (the read-only half of the run service)
// ============================================================
// Synthesis rules for snapshot/list/detail. Split from dynamic-workflow-run-service.ts: the
// service file keeps entries and gates; this file keeps the pure registry+journal -> read-side
// synthesis (no I/O, no state).

import type { DwfRunListItem, DwfRunSessionListItem } from "@zcode/adapters/storage";
import {
  boundDynamicWorkflowRunEventPayload,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunLogEntry,
  type DynamicWorkflowRunPendingQuestion,
  type DynamicWorkflowRunSessionSummary,
  type DynamicWorkflowRunSnapshot,
  type DynamicWorkflowRunStopReason,
  type DynamicWorkflowRunSummary,
} from "@zcode/contracts";
import type {
  JournalStorePort,
  NodeRecord,
  RunRecord,
  RunSettlement,
  RunStatus,
  RunStopReason,
  StoredEvent,
  WorkflowErrorCode,
  WorkflowErrorJson,
} from "@zcode/dynamic-workflow";
import { artifactsOf } from "./dynamic-workflow-run-artifact-projection.js";
import { runLineageActiveMs } from "./dynamic-workflow-run-elapsed.js";
import { readRunScriptPath, readRunSubagentModel } from "./dynamic-workflow-run-launch-anchor.js";
import { resolveDynamicWorkflowRunLabel } from "./dynamic-workflow-run-label.js";
import { lineageFields, supersededByOf } from "./dynamic-workflow-run-lineage.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";

/**
 * Artifact merging lives in dynamic-workflow-run-artifact-projection.ts (this file sits at the
 * oxlint 400-line cap). Re-exported verbatim rather than making four call sites rewrite imports:
 * they want the observation surface, and this split is a line-count constraint, not a boundary
 * change - turning it into a cross-module rename would only aim git blame at an
 * intent-unrelated commit. */
export { artifactsOf };

/** Registry entry: an in-flight or recently settled run. */
export interface RunRegistryEntry {
  controller: AbortController;
  startedAt: Date;
  toolCallId?: string;
  parentSessionId?: string;
  /**
   * In-memory copies of three submit-time metadata fields, serving only the **submit ->
   * createRun microtask gap**: no journal row yet, while the enumeration side must still
   * project-filter the run (cwd) and label it (name / script first line). Once the row lands the
   * journal is authoritative for all three and the copies stop being read.   */
  cwd: string;
  name?: string;
  scriptText: string;
  /**
   * The cap actually in effect for this run (in-memory copy of `dwf_run.caps_max_concurrency`,
   * same gap argument). Set by submit / amend, **not by resume** - that path keeps the journal
   * row's caps, and the row long exists.   */
  maxConcurrency?: number;
  /**
   * The run's live control surface. Kept beside {@link controller}, not merged: that one is the
   * only channel for stopping this run, this one the only channel for changing one setting of it,
   * and the recipients differ (harness signal vs engine and seat gate).   *
   * All three entry-creating paths build one (submit / amend / resume); launch wires its two
   * ends. Entry present but the handle's `setMaxConcurrency` returns false means the run settled
   * between the two steps - `retuneConcurrency` answers `not_live` from that.   */
  control?: WorkflowRunControl;
  /**
   * This run's subagent model (in-memory copy of the canonical picker string
   * `providerId/modelId[$reasoningLevel]` from the `run-launched` event).   * Same gap argument: AmendWorkflow's resolveInput reads the snapshot to decide what to keep,
   * and amending a just-started run lands exactly in the submit -> engine-records-event
   * microtasks.   *
   * **All three entry-creating paths set it**: submit / amend use the just-normalized string,
   * resume copies it from one event-header read. The value is frozen for the run's lifetime, so
   * copy and event cannot diverge - the read side keeps a single rule: entry if present, event
   // scan only for cold rows (no entry in this process). Absent means the subagent runs on the
   // session model.   */
  subagentModel?: string;
  /**
   * This run's script file (in-memory copy of the absolute path on the `run-launched` event).
   * Clause-for-clause the same rules as {@link subagentModel}: all three entry-creating paths set
   * it (submit / amend use the given one, resume copies from one event-header read), the value is
   * frozen for the run's lifetime, copy and event cannot diverge. Absent means this run has no
   * file.   */
  scriptPath?: string;
  /** The amendment's predecessor (in-memory copy of `dwf_run.resumed_from`; before the journal row lands, the only place enumeration can read it). */
  resumedFrom?: string;
  /**
   * This run's usage baseline (predecessor `spentTokens` after settlement). Same gap argument:
   * before the row lands, both read sides can get usage only from the entry, and amending a
   * just-started run lands in exactly those microtasks. **Only the amend path sets it**: a fresh
   * submit starts from zero and resume's row long exists.   */
  inheritedTokens?: number;
  /**
   * The **session quiescence probe** handed over by this run's driver
   * (workflow-driver-quiescence.ts). Backfilled at driver construction, so a fresh entry has none
   * yet - in that gap the run has not built a single actor session, nothing to ask.   *
   // Sole reader is amend: after superseding an in-flight predecessor it must first confirm those
   // sessions finished writing before continuation is even negotiable.   * The unfinished ask (`inFlight`). The probe is owned by this very entry - one per run, living
   * and dying with the driver; no separate process-level registry.   */
  quiescence?: ActorSessionQuiescence;
  /** Settlement promise; waitForTask awaits it. The fire-and-forget chain hangs here. */
  settlement: Promise<RunSettlement>;
  /** Terminal state once settled (artifact/error live only here; the journal stores no script return value). */
  terminal?: RunSettlement;
  completedAt?: Date;
  /**
   * Whether the journal-row-is-foreign-terminal warn was already logged for this entry (see the
   * {@link synthesizeRunStatus} precedence note). The tracker polls every second; without the
   * flag, the same warn would fire every second.   */
  foreignTerminalLogged?: true;
}

/**
 * The terminal-status set for runs (pending / running excluded). * This is the **single authority** on what counts as terminal: the journal-side SQL only
 * pre-filters index-friendly; re-check against this set before reaping, so adding a non-terminal
 * status later touches exactly one place. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "errored",
  "stopped",
]);

/**
 * Synthesize a snapshot from the journal record plus the live registry. Neither present returns
 * undefined (the layer above normalizes to lost). *
 * `pendingQuestions` is projected by the caller from the **in-memory** escalation parking table
 * and passed in (this file's discipline: no I/O, no state). An empty array means no question
 * pending right now and the whole field is absent - never an empty array. *
 * `concurrencyCeiling` likewise comes from the caller (reading it probes CPU count = I/O):
 * absent means this read judges no ceiling and `maxConcurrency` is omitted wholesale - see
 * {@link runConcurrencyField}. */
export function snapshotOf(
  taskId: string,
  runs: Map<string, RunRegistryEntry>,
  journal: JournalStorePort,
  pendingQuestions: readonly DynamicWorkflowRunPendingQuestion[] = [],
  concurrencyCeiling?: number,
): DynamicWorkflowRunSnapshot | undefined {
  const entry = runs.get(taskId);
  const record = journal.getRun(taskId);
  if (entry === undefined && record === undefined) return undefined;

  // The single status-synthesis implementation (see {@link synthesizeRunStatus}). The snapshot
  // vocabulary has no pending, so it folds at the last step: runStatusToTaskStatus reports
  // pending as running, together with running itself - exactly the established registered-means-
  // running behavior (without it, a just-submitted run would be judged lost on its first poll).
  const status: DynamicWorkflowRunSnapshot["status"] = runStatusToTaskStatus(
    synthesizeRunStatus(entry, record?.status),
  );

  // Node rows are scanned **once**, shared by reports and artifacts (both read terminal-state
  // only, see their notes). Two listNodes calls would decode a 256-node run's table twice.
  const nodes = status === "running" ? undefined : journal.listNodes(taskId);

  // Lineage active duration: same terminal gate and same argument as nodes - its only consumer is
  // the terminal notification, while the snapshot is polled repeatedly by the background tracker.
  const activeDurationMs = status === "running" ? undefined : runLineageActiveMs(journal, taskId);

  // True terminal word + stop reason + structured failure: the snapshot base's `status` is the
  // background tracker's common vocabulary (stopped folds to cancelled, errored to failed), so
  // telling the truth means reading these three fields. Absent before terminal (no ending to tell
  // yet).
  const runStatus = synthesizeRunStatus(entry, record?.status);
  const terminal = TERMINAL_RUN_STATUSES.has(runStatus);
  const stopReason = terminal ? stopReasonOf(entry, record) : undefined;
  const failure = terminal ? terminalErrorField(runStatus, entry, record).error : undefined;
  const error = failure?.message;
  // Ownership: AmendWorkflow's resolveInput reads the snapshot to decide is-this-session's-run;
  // lineage endpoint pointers in lineageFields.
  const parentSessionId = entry?.parentSessionId ?? record?.parentSessionId;

  return {
    runId: taskId,
    taskId,
    startedAt: entry?.startedAt ?? new Date(0),
    status,
    ...(terminal ? { runStatus } : {}),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...lineageFields(entry?.resumedFrom ?? record?.resumedFrom, supersededByOf(entry, record)),
    // In-memory copy before journal, same rule as every gap field above: in the submit ->
    // createRun microtasks no row exists, and AmendWorkflow's resolveInput reads the snapshot
    // exactly then.
    ...runConcurrencyField(
      entry?.maxConcurrency ?? record?.caps.maxConcurrency,
      concurrencyCeiling,
    ),
    // Subagent model: **entry if present** (all three entry-creating paths set it, see
    // RunRegistryEntry.subagentModel); only a cold row - no entry in this process - triggers one
    // bounded event-header scan (eight events, not the whole journal). It has no
    // not-worth-mentioning test like the cap: it exists only when the user set it explicitly, and
    // presence is the entire information. Absent means running on the session model.
    ...runSubagentModelField(
      entry === undefined ? readRunSubagentModel(journal, taskId) : entry.subagentModel,
    ),
    // Script file: clause-for-clause the subagent-model rules (entry if present, event-header scan
    // for cold rows), likewise recorded-means-present. The terminal notification uses it to phrase
    // the next step as edit-that-file, so the snapshot must carry it.
    ...runScriptPathField(
      entry === undefined ? readRunScriptPath(journal, taskId) : entry.scriptPath,
    ),
    ...(failure === undefined ? {} : { failure }),
    ...(activeDurationMs === undefined ? {} : { activeDurationMs }),
    ...(entry?.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(error === undefined ? {} : { error }),
    // Whole field absent at zero (same rule as reports): the read side drops the entire pending
    // section instead of rendering an empty one.
    ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
    ...reportsOf(nodes),
    // User-facing artifacts. Note: distinct from the adjacent `output`
    // (`entry.terminal.artifact` = the script's top-level return value, also called artifact
    // inside the engine): this is what the script published to the user via `artifact.*`, that is
    // the return value shown to the model.
    ...(nodes === undefined ? {} : artifactsOf(taskId, journal, nodes)),
    ...(entry?.terminal?.status === "completed"
      ? { output: entry.terminal.artifact }
      : // After a restart this process's registry is empty, so artifacts come from the journal
        // record (the row's result_json). In-memory terminal wins in the branch above - it is the
        // pristine value this process just took from the engine.
        record?.status === "completed" && record.result !== undefined
        ? { output: record.result }
        : {}),
  };
}

/**
 * `maxConcurrency` on both read sides (the `getTask` snapshot and the `getRunDetail` detail): *
 * **present only below the current ceiling**: a run at the ceiling has nothing to say - that is
 * the default behavior, and every row carrying a number equal to the default just makes the model
 * read no-cap as capped. With no ceiling known (caller gave none) the field is omitted entirely:
 // without the test, quoting a number is guessing. *
 * One implementation for both read sides: judging twice would eventually diverge on
 * does-equal-the-ceiling-count, at some tuning touch. */
export function runConcurrencyField(
  applied: number | undefined,
  ceiling: number | undefined,
): { maxConcurrency?: number } {
  if (applied === undefined || ceiling === undefined || applied >= ceiling) return {};
  return { maxConcurrency: applied };
}

/**
 * `subagentModel` on both read sides (the `getTask` snapshot and the `getRunDetail` detail): *
 * One rule: **present only when set**. Unlike {@link runConcurrencyField} there is no comparable
 * default - runs-on-the-session-model is not a string this field can hold, and filling the
 * current session model in would make the read side parse not-set as set-equal-to-session-model,
 * different meanings in amend's three-state logic. *
 * One implementation for both read sides, same argument as the concurrency cap. */
export function runSubagentModelField(subagentModel: string | undefined): {
  subagentModel?: string;
} {
  return subagentModel === undefined ? {} : { subagentModel };
}

/**
 * `scriptPath` on both read sides. Rules verbatim as {@link runSubagentModelField}:
 * **recorded-means-present**, no comparable default - this-run-has-no-script is not a path this
 * field can hold, and a guessed path would have the model edit a file unrelated to the run. One
 * implementation for both read sides. */
export function runScriptPathField(scriptPath: string | undefined): { scriptPath?: string } {
  return scriptPath === undefined ? {} : { scriptPath };
}

/**
 * `reports` on the terminal snapshot: journal node rows with `kind = "report"` (written once,
 * always `completed`, the reported item on `result`), insertion order = report order. *
 * Why read from the journal, not the projection: `workflowRuns.reports` is a bounded memory-only
 * display surface (empty after cold resume), while these rows are that data's **persistent home**.
 * The completion notification must carry reports on failed / cancelled too - a run that died on
 * ask 12 still did the work of 11, and recovering it is the very reason `report` exists - so it
 * must read the durable copy. *
 * Read only when **terminal**: `getTask` is polled repeatedly by the background tracker while
 * `listNodes` is a full scan (a 256-node run decodes 256 rows per poll). The only consumers are
 * the terminal notification and terminal TaskOutput; in flight it has readers none, only cost.
 * The gate is enforced by the caller - absent `nodes` means in-flight-dont-read, letting one scan
 * also feed {@link artifactsOf}. */
function reportsOf(nodes: readonly NodeRecord[] | undefined): { reports?: readonly unknown[] } {
  if (nodes === undefined) return {};
  const items = nodes.filter((node) => node.kind === "report").map((node) => node.result);
  // Whole field absent at zero: the notification side drops the whole reports section, no empty
  // sections.
  return items.length === 0 ? {} : { reports: items };
}

/**
 * **The single implementation of status-truth synthesis**, four precedence tiers: *   in-memory terminal > live entry (journal status trusted only while non-terminal) > journal
 *   status > in-registry-but-no-row-yet. *
 * While this process's engine lives, a terminal journal row may come from another instance's
 * orphan reap and must not end local tracking. * With a local settlement, in-memory terminal wins; the second tier covers not-yet-settled live
 * entries, ignoring foreign terminal rows and waiting for the engine, so the model is not
 * notified early and the real completion result dropped after the task is marked done. *
 * Shared by the three read sides (snapshot, list, detail). Returns the journal {@link RunStatus}
 * vocabulary rather than the snapshot's because it is the finest: `pending` (submitted, engine
 * row not yet created) is a model-legible distinction on the introspection side, and the snapshot
 * folding it into `running` is just that vocabulary's own limitation ({@link
 * runStatusToTaskStatus} does the folding). The other direction - fold then try to recover -
 * would leave downstream guessing which running it is. */
function synthesizeRunStatus(
  entry: RunRegistryEntry | undefined,
  journalStatus: RunStatus | undefined,
): RunStatus {
  // In-memory terminal first: a settlement this process just took from the engine is fresher than
  // the journal row (possibly not yet written).
  if (entry?.terminal !== undefined) return terminalRunStatus(entry.terminal);
  // Reaching here with `entry !== undefined` means a live run owned by this service: a terminal
  // value on the row can only be a foreign write - ignore it, report running as fact. Non-terminal
  // rows (pending / running) are trusted as usual - the engine wrote them itself. Deliberately
  // gating terminal only: a gap with no `journalStatus` still falls to `pending` below (finer
  // tier, and model-legible on the introspection side).
  if (
    entry !== undefined &&
    journalStatus !== undefined &&
    TERMINAL_RUN_STATUSES.has(journalStatus)
  ) {
    return "running";
  }
  if (journalStatus !== undefined) return journalStatus;
  // Registry yes, journal no: the submit -> createRun microtask gap. `pending` is the only honest
  // status here - accepted, but the engine has landed no row yet.
  return "pending";
}

function terminalRunStatus(settlement: RunSettlement): RunStatus {
  switch (settlement.status) {
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return "errored";
  }
}

/**
 * Logical terminal -> the background task tracker's common vocabulary. The tracker (shared with
 * bash / subagent tasks) knows no stopped / errored: stopped folds to `cancelled`, errored to
 * `failed`; the real words surface via the snapshot's `runStatus` / `stopReason`. */
function runStatusToTaskStatus(status: RunStatus): DynamicWorkflowRunSnapshot["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "stopped":
      return "cancelled";
    // pending / running are both still running.
    default:
      return "running";
  }
}

/**
 * Stop reason: in-memory terminal first (the settlement this process just took from the engine),
 * else the journal row. Meaningful only for stopped; other states return undefined. *
 * Same precedence as {@link synthesizeRunStatus}: **no stop reason while the entry is live**. A
 * value on the row could only be a foreign write, and the three read sides must agree - status
 * running while reason says interrupted is harder to debug than both being wrong. */
function stopReasonOf(
  entry: RunRegistryEntry | undefined,
  record: { status?: RunStatus; stopReason?: RunStopReason } | undefined,
): DynamicWorkflowRunStopReason | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.reason : undefined;
  }
  if (entry !== undefined) return undefined;
  if (record?.status === "stopped") return record.stopReason ?? "user";
  return undefined;
}

/**
 * Journal row (plus optional in-memory entry) -> the shape shared by list and detail. *
 * Timestamps **straight from the journal row**, deliberately bypassing {@link snapshotOf}'s
 * `new Date(0)` fallback: once the entry is evoked that baseline is fake, and introspection
 * timestamps are how the model judges how-long-ago. */
export function journalRunSummary(
  row: DwfRunListItem,
  entry: RunRegistryEntry | undefined,
  ownerSessionId: string,
): DynamicWorkflowRunSummary {
  const ownedByThisSession = entry !== undefined || row.parentSessionId === ownerSessionId;
  // Reads the **journal** status, not the synthesized one: the semantics are journal-says-unfinished
  // and this-session-cannot-verify. (On this branch the two necessarily agree - not-ours and
  // not-in-registry means no in-memory terminal can override the journal; written literally so the
  // invariant survives future truth sources.)
  const possiblyInterrupted = !TERMINAL_RUN_STATUSES.has(row.status) && !ownedByThisSession;
  const stopReason = stopReasonOf(entry, row);
  return {
    runId: row.runId,
    ...resolveDynamicWorkflowRunLabel({
      runId: row.runId,
      ...(row.name === undefined ? {} : { name: row.name }),
      ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
    }),
    status: synthesizeRunStatus(entry, row.status),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(entry?.resumedFrom ?? row.resumedFrom, supersededByOf(entry, row)),
    ownedByThisSession,
    // Present only when true: absence reads as no-such-doubt; `false` would be per-row noise.
    ...(possiblyInterrupted ? { possiblyInterrupted: true } : {}),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/**
 * Run with only an in-memory entry (the submit -> createRun microtask gap) -> shared shape. *
 * Ownership always true (it sits in this session's registry), hence never any
 * `possiblyInterrupted`. The timestamp is the registration moment - not a fallback guess but the
 * run's true submit time (the journal row writes the same millisecond `Date.now()` when it
 * lands). */
export function registryRunSummary(
  runId: string,
  entry: RunRegistryEntry,
): DynamicWorkflowRunSummary {
  return {
    runId,
    ...resolveDynamicWorkflowRunLabel({
      runId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      scriptText: entry.scriptText,
    }),
    status: synthesizeRunStatus(entry, undefined),
    ...(entry.terminal?.status === "stopped" ? { stopReason: entry.terminal.reason } : {}),
    ...lineageFields(entry.resumedFrom, supersededByOf(entry, undefined)),
    ownedByThisSession: true,
    createdAt: entry.startedAt.getTime(),
    updatedAt: (entry.completedAt ?? entry.startedAt).getTime(),
  };
}

/**
 * Only completed runs carry artifacts, and a `undefined` artifact means **the whole field is
 * absent** (same rule as the completion notification). *
 * Precedence as {@link snapshotOf}: the in-memory terminal artifact is the **pristine value**
 * this process just took from the engine; the journal result_json is it after one JSON round
 * trip. Only an evicted entry falls back to the latter. * The value is **handed over as-is, not serialized** - the model-facing text projection has a
 * single implementation in core; doing it again at the port would end with the same artifact
 * looking different in the notification and the tool. */
export function terminalResultField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { result?: unknown },
): { result?: unknown } {
  if (status !== "completed") return {};
  if (entry?.terminal?.status === "completed" && entry.terminal.artifact !== undefined) {
    return { result: entry.terminal.artifact };
  }
  // `result: null` is a legal artifact (`ask<T | null>` returns it), so the test is
  // `!== undefined`, not truthiness - the decoder likewise writes the key only for non-NULL
  // columns.
  return row?.result === undefined ? {} : { result: row.result };
}

/**
 * errored always carries a failure; stopped carries one only for provider / interrupted (a
 * user / model stop has no failure to speak of). * The journal `failure_json` is **authoritative**: it carries the structured code, so
 * `Interrupted` (process died), `ProviderStop` (model-side deterministic error) and `DriverError`
 * (real script failure) stay distinguishable to the model - the code passes through verbatim,
 * never folded into a generic failure; `ProviderStop` structured details pass through too. */
export function terminalErrorField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { failure?: WorkflowErrorJson },
): { error?: DynamicWorkflowRunError } {
  if (status !== "errored" && status !== "stopped") return {};
  // In-memory terminal first: the settlement this process just took carries pristine values
  // (ProviderStop details intact); the journal row is it after one JSON round trip. Only an
  // evicted entry falls back to the latter.
  const memoryError =
    entry?.terminal?.status === "errored"
      ? entry.terminal.error
      : entry?.terminal?.status === "stopped"
        ? entry.terminal.error
        : undefined;
  if (memoryError !== undefined) {
    // Paths failing before the engine is constructed (child process spawn failure, constructor
    // throw) store a wrapped plain Error in the registry - possibly codeless. Classified
    // DriverError rather than inventing a code: that failure truly comes from the driver layer
    // outside the engine.
    const code = typeof memoryError.code === "string" ? memoryError.code : "DriverError";
    const providerStop = (memoryError as { providerStop?: WorkflowErrorJson["providerStop"] })
      .providerStop;
    return {
      error: {
        code,
        message: memoryError.message,
        ...(providerStop === undefined ? {} : { providerStop }),
      },
    };
  }
  if (row?.failure !== undefined) {
    return {
      error: {
        code: row.failure.code,
        message: row.failure.message,
        ...(row.failure.providerStop === undefined
          ? {}
          : { providerStop: row.failure.providerStop }),
      },
    };
  }
  return {};
}

/**
 * One journal `log` event -> a port logTail item. *
 * The message is bounded via {@link boundDynamicWorkflowRunEventPayload} instead of a local
 * slice: the string cap (2048) and proxy-safe truncation rules already exist once on the port
 * side; a second copy would diverge at some tuning touch. The query pushdown filters
 * `type='log'`, so a non-log event means implementation drift - return an empty message rather
 * than crashing the whole detail side. */
export function toLogTailEntry(stored: StoredEvent): DynamicWorkflowRunLogEntry {
  const message = stored.event.type === "log" ? stored.event.message : "";
  const { payload } = boundDynamicWorkflowRunEventPayload({ message });
  return {
    sequence: stored.sequence,
    message: typeof payload.message === "string" ? payload.message : "",
    // Persisted-at passes through verbatim; absent on old journals without the column (read side
    // then omits age).
    ...(stored.timeCreated === undefined ? {} : { at: stored.timeCreated }),
  };
}

/** Await settlement, honoring the caller signal (an interrupted wait is not a cancelled run). */
export async function settleOrAbort(
  settlement: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await settlement;
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void settlement.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
}

/**
 * Failure code written by orphan reaping (host-level member; the engine never emits it).
 * Persisted with `stopped(interrupted)`: status + stopReason already say process-death
 * interruption; this code is the second witness of the same fact (old rows have only it). */
export const INTERRUPTED_FAILURE_CODE: WorkflowErrorCode = "Interrupted";

/**
 * The resume gate's single predicate: **stopped means resumable**. * Except `superseded` - its unfinished work now belongs to the successor, and replaying would do
 * the same work twice against a workspace the successor is editing; errored / completed are not.
 * {@link DynamicWorkflowRunSessionSummary.resumable} uses this same predicate - a UI deriving it
 * from status will eventually disagree: button lit, command refused. */
export function isResumableRecord(record: Pick<RunRecord, "status" | "stopReason">): boolean {
  return isResumableSettlement(record.status, record.stopReason);
}

/**
 * The settlement-fact shape of the same predicate: the `resumable` bit on the `run-settled`
 * payload is computed here (live paths compute from engine events in toProgressPayload, cold
 * replay from journal rows in backfill); the reducer only carries it. */
export function isResumableSettlement(status: RunStatus, stopReason?: RunStopReason): boolean {
  return status === "stopped" && stopReason !== "superseded";
}

/**
 * Enumerated row -> session enumeration summary. All three deliberately share sources elsewhere: *   - `resumable` uses the resume gate's very predicate ({@link isResumableRecord}); *   - `label` uses the derivation chain shared by both read sides
 *   ({@link resolveDynamicWorkflowRunLabel}) - a private fallback here would show the same run
 *   under different names in `/dwf list` and the tool card; *   - `updatedAt` reads the journal row's `timeUpdated` directly (`RunRecord` carries no
 *   timestamps, hence the row-typed input). */
export function toSessionSummary(
  row: DwfRunSessionListItem,
  entry?: RunRegistryEntry,
): DynamicWorkflowRunSessionSummary {
  const { label } = resolveDynamicWorkflowRunLabel({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
  });
  // The fourth read side follows the same precedence ({@link synthesizeRunStatus}): with a live
  // entry, a terminal value on the row is a foreign write - report running and omit stop reason
  // and failure. Without this branch the session list would alone show a run as stopped while
  // snapshot / list / detail all say running.
  const status = synthesizeRunStatus(entry, row.status);
  const stopReason = stopReasonOf(entry, row);
  const live = entry !== undefined && entry.terminal === undefined;
  return {
    runId: row.runId,
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    label,
    updatedAt: row.timeUpdated,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(row.resumedFrom, supersededByOf(entry, row)),
    ...(live || row.failure?.code === undefined ? {} : { failureCode: row.failure.code }),
    ...(live || row.failure?.message === undefined ? {} : { failureMessage: row.failure.message }),
    resumable: isResumableSettlement(status, stopReason),
  };
}
