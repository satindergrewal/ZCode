// ============================================================
// Dynamic Workflow run observation helpers (the read-only half of the run service)
// ============================================================
// Synthesis rules for snapshot/list/detail. Split out of dynamic-workflow-run-service.ts: the service file carries entries and gates,
// this file carries the pure synthesis rules of "registry + journal -> outward read surface" (no IO, no state).

import type { DwfRunListItem, DwfRunSessionListItem } from "@zcode/adapters/storage";
import {
  boundDynamicWorkflowRunEventPayload,
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES,
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunHole,
  type DynamicWorkflowRunLogEntry,
  type DynamicWorkflowRunPendingQuestion,
  type DynamicWorkflowRunSessionSummary,
  type DynamicWorkflowRunSnapshot,
  type DynamicWorkflowRunStopReason,
  type DynamicWorkflowRunSummary,
} from "@zcode/contracts";
import type {
  JournalStorePort,
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
import {
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveDynamicWorkflowRunLabel } from "./dynamic-workflow-run-label.js";
import { lineageFields, supersededByOf } from "./dynamic-workflow-run-lineage.js";
import type { CompiledHole } from "./dynamic-workflow-run-holes.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";

/**
 * Artifact merging lives in dynamic-workflow-run-artifact-projection.ts (this file sits at oxlint's 400-line cap).
 * Re-export as-is instead of fixing imports at four call sites: they want "the observation surface", and this split was a line-count
 * constraint, not a boundary change; turning it into a cross-module rename would point git blame at an intent-free commit.
 */
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
   */
  cwd: string;
  name?: string;
  scriptText: string;
  /**
   * The cap actually in effect for this run (in-memory copy of `dwf_run.caps_max_concurrency`,
   * same gap argument). Set by submit / amend, **not by resume** - that path keeps the journal
   */
  maxConcurrency?: number;
  /**
   * This run's live control surface (docs/dynamic-workflow/concurrency.md, "The control path"). Parallel to
   * {@link controller}, not merged: that one is the only channel for "stop this run", this one for "change one
   * setting of this run"; their recipients (harness signal vs engine and seat gates) differ too.
   *
   * All three entry-creation paths build one (submit / amend / resume); launch wires its two ends. Entry present but handle's
   * setMaxConcurrency returning false means "the settled between those two steps" -- retuneConcurrency
   * returns not_live on that.
   */
  control?: WorkflowRunControl;
  /**
   * This run's subagent model (in-memory copy of the canonical picker string
   * `providerId/modelId[$reasoningLevel]` from the `run-launched` event).   * Same gap argument: AmendWorkflow's resolveInput reads the snapshot to decide what to keep,
   * and amending a just-started run lands exactly in the submit -> engine-records-event
   * microtasks.   *
   *
   * resume copies it from one event-header read. The value is frozen for the run's lifetime, so
   * copy and event cannot diverge - the read side keeps a single rule: entry if present, event
   // scan only for cold rows (no entry in this process). Absent means the subagent runs on the
   */
  subagentModel?: string;
  /**
   * The model binding table the run's script names (in-memory copy of modelBindings on the run-launched
   * event; docs/dynamic-workflow/launch.md, "Models the script names"). Same rule per-entry as {@link subagentModel}:
   * all three creation paths set it, immutable afterwards, entry present -> read the entry. Absent = the script named no model.
   */
  modelBindings?: Record<string, string>;
  /**
   * This run's script file (in-memory copy of the absolute path on the run-launched event). Same per-entry rule as {@link subagentModel}:
   * all three creation paths set it (submit/amend use the given one, resume copies it once from the event header),
   * fixed for the entry's lifetime, so the copy and the event cannot diverge. Absent = this run has no file.
   */
  scriptPath?: string;
  /** The amendment's predecessor (in-memory copy of `dwf_run.resumed_from`; before the journal row lands, the only place enumeration can read it). */
  resumedFrom?: string;
  /**
   * The blank-facts table of the CURRENTLY effective script (docs/execution-engine.md, "Holes"): the snapshot's type/line and
   * the progress payload's type read it. All three creation paths set it from compile artifacts; one fill swaps in the effective script's table,
   * through which nested in-function holes appear. Swapped together with scriptText; both must describe the same script.
   */
  holes?: readonly CompiledHole[];
  /**
   * The currently effective phase table (holes placeholder by name): submit/amend copy the declarer's table, resume reads it back,
   * and after fill it becomes the effective script table (the same one the engine records on hole-filled). The snapshot before/after reads it.
   */
  phaseNames?: readonly string[];
  /**
   * This run's usage baseline (predecessor `spentTokens` after settlement). Same gap argument:
   * before the row lands, both read sides can get usage only from the entry, and amending a
   * just-started run lands in exactly those microtasks. **Only the amend path sets it**: a fresh
   */
  inheritedTokens?: number;
  /**
    * The session-quiet probe handed over by this run's driver (workflow-driver-quiescence.ts). The driver
   * backfills it at construction, so a fresh entry lacks it -- in that gap the run has built no actor session and there is nothing to ask.
   *
   //   The only reader is amend: after superseding an in-flight predecessor it must confirm those sessions finished writing
   //   before continuing the unfinished ask (inFlight). The probe's owner is this entry -- one per run, born and dying with the driver,
   //   never a process-level registry.
   */
  quiescence?: ActorSessionQuiescence;
  /** Settlement promise; waitForTask awaits it. The fire-and-forget chain hangs here. */
  settlement: Promise<RunSettlement>;
  /** Terminal state once settled (artifact/error live only here; the journal stores no script return value). */
  terminal?: RunSettlement;
  completedAt?: Date;
  /**
   * Whether the journal-row-is-foreign-terminal warn was already logged for this entry (see the
   * {@link synthesizeRunStatus} precedence note). The tracker polls every second; without the
   */
  foreignTerminalLogged?: true;
}

/**
 // A run's terminal states (pending/running excluded).
 // This is the SINGLE authority on "what counts terminal": journal-side SQL only pre-filters for index friendliness; before converging, check
 // against this set again, so a future non-terminal state means one edit here.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "errored",
  "stopped",
]);

/**
 * Synthesize a snapshot from the journal record plus the live registry. Neither present returns
 *
 * `pendingQuestions` is projected by the caller from the **in-memory** escalation parking table
 * and passed in (this file's discipline: no I/O, no state). An empty array means no question
 *
 // defaultConcurrency likewise comes from the caller (reading it probes core count = IO): absent = "no default verdict this read".
 * absent means this read judges no ceiling and `maxConcurrency` is omitted wholesale - see
 */
export function snapshotOf(
  taskId: string,
  runs: Map<string, RunRegistryEntry>,
  journal: JournalStorePort,
  pendingQuestions: readonly DynamicWorkflowRunPendingQuestion[] = [],
  defaultConcurrency?: number,
  /**
   * holes (docs/execution-engine.md, "The run snapshot"), projected by the caller under the same rule as pendingQuestions
   * (waiting must read the engine's stall table, live state beyond IO); empty = whole field absent.
   */
  holes: readonly DynamicWorkflowRunHole[] = [],
): DynamicWorkflowRunSnapshot | undefined {
  const entry = runs.get(taskId);
  const record = journal.getRun(taskId);
  if (entry === undefined && record === undefined) return undefined;

  // The single implementation of status synthesis (see {@link synthesizeRunStatus}). The snapshot vocabulary has no pending,
  // so it folds at the last step: runStatusToTaskStatus reports pending and running both as running --
  // exactly the existing "in the registry == running" behavior (without it, a just-submitted run's first poll reads lost).
  const status: DynamicWorkflowRunSnapshot["status"] = runStatusToTaskStatus(
    synthesizeRunStatus(entry, record?.status),
  );

  // reports / artifacts / elapsed are read only on terminal: their only consumers are the terminal notification and terminal TaskOutput,
  // while snapshots get polled repeatedly by the background tracker; reading them in flight has no reader, only cost.
  const settled = status !== "running";

  // Elapsed for the lineage (docs/dynamic-workflow/transcript-and-notifications.md, "How long it took").
  const activeDurationMs = settled ? runLineageActiveMs(journal, taskId) : undefined;

  // Real terminal word + stop reason + structured failure (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md): the snapshot base's
  // status is the background task tracker's generic vocabulary (stopped -> cancelled, errored -> failed); the notification
  // can only tell the truth through these three fields. Absent before terminal (no ending to tell yet).
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
    // In-memory copy wins over journal, same rule as every gap field above: in the few microtasks between submit -> createRun
    // the row does not exist yet, and AmendWorkflow's resolveInput reads this snapshot exactly then.
    ...runConcurrencyField(
      entry?.maxConcurrency ?? record?.caps.maxConcurrency,
      defaultConcurrency,
    ),
    // Subagent model: entry present -> read the entry (all three creation paths set it, see RunRegistryEntry.subagentModel);
    // only a cold row -- no entry in this process -- scans event headers once (a bounded scan of eight, not the whole journal).
    // It lacks the concurrency bound's "value not worth mentioning" criterion: it exists only when explicitly set; presence is the whole information.
    // Absent = running on the session model.
    ...runSubagentModelField(
      entry === undefined ? readRunSubagentModel(journal, taskId) : entry.subagentModel,
    ),
    // Script file: same per-entry rule as the subagent model (entry present -> read it; only cold rows scan event headers once), likewise
    // "present only if recorded". The terminal notification uses it to phrase the next step as "edit that file in place", so the snapshot must carry it.
    ...runScriptPathField(
      entry === undefined ? readRunScriptPath(journal, taskId) : entry.scriptPath,
    ),
    // Script-named models: same per-entry rule as the subagent model. AmendWorkflow and the GUI "configure" use it to carry same-name bindings forward.
    ...runModelBindingsField(
      entry === undefined ? readRunModelBindings(journal, taskId) : entry.modelBindings,
    ),
    ...(failure === undefined ? {} : { failure }),
    ...(activeDurationMs === undefined ? {} : { activeDurationMs }),
    ...(entry?.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(error === undefined ? {} : { error }),
    // With zero rows the whole field is absent (same rule as reports): the read side hides the whole pending block, rendering no empty node.
    ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
    ...(holes.length === 0 ? {} : { holes }),
    ...(settled ? reportsOf(taskId, journal) : {}),
    // User-facing artifacts. Note: distinct from the adjacent output
    // (entry.terminal.artifact = the script's top-level return value, also called artifact inside the engine): two different things.
    // This is the output the script published to the user via artifact.*; that is the return value for the model.
    ...(settled ? artifactsOf(taskId, journal) : {}),
    ...(entry?.terminal?.status === "completed"
      ? { output: entry.terminal.artifact }
      : // After a restart this process's registry is empty; artifacts come from the journal record only (migration 0020's
        // result_json). The in-memory terminal in the other branch wins -- it is the fresh value just handed over by the engine.
        record?.status === "completed" && record.result !== undefined
        ? { output: record.result }
        : {}),
  };
}

/**
 * On both read surfaces (getTask snapshot and getRunDetail), maxConcurrency
 *
 * appears ONLY when != default concurrency (higher or lower): a run on the default has nothing to say -- it IS the
 * default behavior, and every row carrying a default-equal number makes the model read "no limit" as "a limit". With the default
 * absent (caller gave none) the whole field stays out: no criterion, a number would be a guess.
 *
 * One implementation for both read surfaces: judging twice, "does default-equal count as present" would eventually fork at some tuning.
 */
export function runConcurrencyField(
  applied: number | undefined,
  defaultConcurrency: number | undefined,
): { maxConcurrency?: number } {
  if (applied === undefined || defaultConcurrency === undefined || applied === defaultConcurrency) {
    return {};
  }
  return { maxConcurrency: applied };
}

/**
 * On both read surfaces, subagentModel.
 *
 * One rule: present only if set. Unlike {@link runConcurrencyField} there is no default to compare -- "running on the
 * session model" is not a string this field could hold, and filling the current session model in would make the read side
 * read "unset" as "set, equal to the session model" -- different meanings in amend's three states.
 *
 * One implementation for both read surfaces, same argument as the concurrency bound.
 */
export function runSubagentModelField(subagentModel: string | undefined): {
  subagentModel?: string;
} {
  return subagentModel === undefined ? {} : { subagentModel };
}

/** modelBindings on both read surfaces: the same rule as {@link runSubagentModelField}; present only if recorded (and non-empty). */
export function runModelBindingsField(modelBindings: Record<string, string> | undefined): {
  modelBindings?: Record<string, string>;
} {
  return modelBindings === undefined || Object.keys(modelBindings).length === 0
    ? {}
    : { modelBindings };
}

/**
 * scriptPath on both read surfaces. Rule verbatim as
 * {@link runSubagentModelField}: present only if recorded, no default to compare -- "this run has no
 * script file" is not a path this field could hold, and a guessed path would make the model edit a file
 * unrelated to this run. One implementation for both read surfaces.
 */
export function runScriptPathField(scriptPath: string | undefined): { scriptPath?: string } {
  return scriptPath === undefined ? {} : { scriptPath };
}

/**
 * reports and reportCount on the terminal snapshot: journal nodes with kind="report" (written once, always
 * completed, the reported item on result), insertion order = report order.
 *
 * Why from the journal, not the projection: workflowRuns.reports is a bounded memory-only display surface
 * (empty after cold recovery), while these rows are the durable home of those items. The completion notification must carry artifacts on
 * failed/cancelled too -- a run that died on ask 12 still did 11 asks' work, and recovering it is the very
 * point of report -- so it must read the durable copy.
 *
 * Reads only the first {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} items, at most
 * {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES} bytes; the total is one count(*)
 * (docs/execution-engine.md, "Reading the journal"). Fix rationale: this used to read the whole node table plus every
 * report item into memory -- a report-sated run would decode GiB-scale items at settlement, while the notification's
 * character budget fits only dozens. A count bound alone is not enough: at 1 MiB per item, 256 items are 256 MiB. With zero rows both
 * fields are absent: the notification side hides the whole reports section instead of rendering an empty one.
 */
function reportsOf(
  taskId: string,
  journal: JournalStorePort,
): { reports?: readonly unknown[]; reportCount?: number } {
  const reportCount = journal.countNodes(taskId, "report");
  if (reportCount === 0) return {};
  const reports = journal
    .listNodes(taskId, {
      kinds: ["report"],
      withResult: true,
      limit: DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS,
      maxResultBytes: DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES,
    })
    .map((node) => node.result);
  return { reports, reportCount };
}

/**
 * **The single implementation of status-truth synthesis**, four precedence tiers: *   in-memory terminal > live entry (journal status trusted only while non-terminal) > journal
 *   status > in-registry-but-no-row-yet. *
 *
 * orphan reap and must not end local tracking. * With a local settlement, in-memory terminal wins; the second tier covers not-yet-settled live
 * entries, ignoring foreign terminal rows and waiting for the engine, so the model is not
 * notified early and the real completion result dropped after the task is marked done. *
 *
 * vocabulary rather than the snapshot's because it is the finest: `pending` (submitted, engine
 * row not yet created) is a model-legible distinction on the introspection side, and the snapshot
 * folding it into `running` is just that vocabulary's own limitation ({@link
 * runStatusToTaskStatus} does the folding). The other direction - fold then try to recover -
 */
function synthesizeRunStatus(
  entry: RunRegistryEntry | undefined,
  journalStatus: RunStatus | undefined,
): RunStatus {
  // In-memory terminal wins: the settlement just handed over by this process is fresher than the journal row (possibly not yet written).
  if (entry?.terminal !== undefined) return terminalRunStatus(entry.terminal);
  // Reaching here, entry !== undefined means "a live run held by this service": a terminal state on the row can only be a foreign write;
  // ignore it and report running truthfully. Non-terminal rows (pending/running) are trusted as always -- the engine wrote them itself.
  // Deliberately intercepting terminal only: rows with journalStatus absent still fall to pending below (finer tier,
  // and the introspection surface treats it as a model-visible distinction).
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
 * Logical terminal -> the background task tracker's generic vocabulary. The tracker (shared with bash/subagent tasks) knows neither
 * stopped nor errored: stopped folds to cancelled, errored to failed; the real words surface via the snapshot's
 * runStatus / stopReason.
 */
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
 * Stop reason: in-memory terminal first (the settlement just handed over here), then the journal row. Meaningful for stopped only;
 * other states return undefined.
 *
 * Same priority as {@link synthesizeRunStatus}: NO stop reason while the live entry exists. One written on the row can only be
 * a foreign write, and the three read surfaces must agree -- status "running" with
 * reason "interrupted" is harder to debug than either being wrong.
 */
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
 * journal row (+ optional in-memory entry) -> the common cross-section of list and detail.
 *
 * Timestamps read the JOURNAL row, deliberately bypassing {@link snapshotOf}'s new Date(0) fallback: after the entry
 * is evicted that start time is fake, while the introspection surface's time is what the model judges "how long ago" by.
 */
export function journalRunSummary(
  row: DwfRunListItem,
  entry: RunRegistryEntry | undefined,
  ownerSessionId: string,
): DynamicWorkflowRunSummary {
  const ownedByThisSession = entry !== undefined || row.parentSessionId === ownerSessionId;
  // Reads the JOURNAL's status, not the synthesized one: the semantics are "the journal says unfinished and this
  // session cannot prove otherwise". (On this branch both are necessarily equal -- not this session, not in the registry, no in-memory
  // terminal to cover the journal -- written literally so the assertion survives future truth sources.)
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
 * A run with only an in-memory entry (the submit -> createRun microtask gap) -> common cross-section.
 *
 * Attribution always true (it sits in this session's registry), so possiblyInterrupted never appears. Timestamp from
 * registration -- not a fallback guess but the run's real commit time (the journal row writes the same millisecond
 * Date.now()).
 */
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
 *
 * Precedence as {@link snapshotOf}: the in-memory terminal artifact is the **pristine value**
 * this process just took from the engine; the journal result_json is it after one JSON round
 * trip. Only an evicted entry falls back to the latter. * The value is **handed over as-is, not serialized** - the model-facing text projection has a
 * single implementation in core; doing it again at the port would end with the same artifact
 */
export function terminalResultField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { result?: unknown },
): { result?: unknown } {
  if (status !== "completed") return {};
  if (entry?.terminal?.status === "completed" && entry.terminal.artifact !== undefined) {
    return { result: entry.terminal.artifact };
  }
  // result: null is a legal artifact (ask<T | null> returns it), hence the !== undefined test, not truthiness --
  // the decoder likewise writes the key only for non-NULL columns.
  return row?.result === undefined ? {} : { result: row.result };
}

/**
 * errored always carries a failure; stopped carries one only for provider / interrupted (a
 * user / model stop has no failure to speak of). * The journal `failure_json` is **authoritative**: it carries the structured code, so
 * `Interrupted` (process died), `ProviderStop` (model-side deterministic error) and `DriverError`
 * (real script failure) stay distinguishable to the model - the code passes through verbatim,
 */
export function terminalErrorField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { failure?: WorkflowErrorJson },
): { error?: DynamicWorkflowRunError } {
  if (status !== "errored" && status !== "stopped") return {};
  // In-memory terminal wins: the settlement just handed over here carries the original (full ProviderStop detail); the journal row is
  // its shape after one JSON round trip; only an evicted entry falls back to the latter.
  const memoryError =
    entry?.terminal?.status === "errored"
      ? entry.terminal.error
      : entry?.terminal?.status === "stopped"
        ? entry.terminal.error
        : undefined;
  if (memoryError !== undefined) {
    // Failures before the engine was constructed (spawn impossible, constructor threw) put a wrapped plain Error in the
    // registry -- code may be absent at runtime. Classify as DriverError instead of inventing a code: that failure
    // truly comes from the driver layer outside the engine.
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
 * A journal log event -> the port's logTail item.
 *
 * Bound via {@link boundDynamicWorkflowRunEventPayload} instead of slicing here: the string cap
 * (2048) and the agent-item-safe truncation rule are already written port-side; a second copy would fork at some tuning.
 * The query pushes down type='log', so non-log events mean implementation drift -- return an empty message rather than
 * crashing the whole detail surface.
 */
export function toLogTailEntry(stored: StoredEvent): DynamicWorkflowRunLogEntry {
  const message = stored.event.type === "log" ? stored.event.message : "";
  const { payload } = boundDynamicWorkflowRunEventPayload({ message });
  return {
    sequence: stored.sequence,
    message: typeof payload.message === "string" ? payload.message : "",
    // Persisted-at passes through as-is; absent on legacy journals without the column (the read side then omits age).
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
 */
export const INTERRUPTED_FAILURE_CODE: WorkflowErrorCode = "Interrupted";

/**
 * The resume gate's single predicate: stopped is resumable,
 * except superseded -- its unfinished work belongs to the successor; replaying means doing the same thing twice over a workspace the successor is editing.
 * errored/completed are not. {@link DynamicWorkflowRunSessionSummary.resumable} uses the same one:
 * if the UI re-derived from status, the two predicates would diverge one day: button lit, command rejected.
 */
export function isResumableRecord(record: Pick<RunRecord, "status" | "stopReason">): boolean {
  return isResumableSettlement(record.status, record.stopReason);
}

/**
 * The settlement-fact shape of the same predicate: the `resumable` bit on the `run-settled`
 * payload is computed here (live paths compute from engine events in toProgressPayload, cold
 */
export function isResumableSettlement(status: RunStatus, stopReason?: RunStopReason): boolean {
  return status === "stopped" && stopReason !== "superseded";
}

/**
 * Enumerated row -> session enumeration summary. All three choices deliberately share sources elsewhere:
 *   - resumable uses the resume gate's own predicate ({@link isResumableRecord});
 *   - label uses the derivation chain shared by both read surfaces ({@link resolveDynamicWorkflowRunLabel}); a fallback
 *     coined here would show one run under different names in /dwf list and on the tool card;
 *   - updatedAt reads the journal row's timeUpdated directly (RunRecord carries no time, hence the enumeration row input).
 */
export function toSessionSummary(
  row: DwfRunSessionListItem,
  entry?: RunRegistryEntry,
): DynamicWorkflowRunSessionSummary {
  const { label } = resolveDynamicWorkflowRunLabel({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
  });
  // The fourth read surface follows the same priority ({@link synthesizeRunStatus}): with a live entry, a terminal on the row is a foreign write;
  // report running and withhold stop reason and failure both. Without this branch, the session list alone would show a run as
  // stopped while snapshot/list/detail all say running.
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
