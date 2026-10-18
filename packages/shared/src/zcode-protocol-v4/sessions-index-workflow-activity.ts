// ============================================================
// The sessions-index workflow-run summary
// ============================================================
// The sidebar wants one row under the session title--"Workflow icon + mini track lights + current phase name"--without subscribing to the whole
// workflowRuns (the conversation authoritative projection, high-frequency per run progress). This derives, from the same snapshot's
// `workflowRuns` + `backgroundWorks`, a **bounded summary carrying only the fields the sidebar reads**:
// pure, clockless--when finished rows collapse is the renderer's acknowledged-set decision, no time recorded here.

import { z } from "zod";
import { timestampSchema } from "./core.js";
import type { BackgroundWorkSummary } from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunSchema,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/** Max runs sent per session: running first by launch order, then most recently finished. */
export const SESSION_WORKFLOW_ACTIVITY_MAX_RUNS = 4;

/**
 * The station light's four states, same vocabulary as the card timeline (`STATUS_DOT`). Control flow gives the skeleton: while running, the
 * current phase is running, entered ones done, rest pending; on completed the entered become done; errored marks current failed; stopped leaves current pending.
 *
 * Member nodes add one rule: while the run is running,
 * a node **born at this station** and truly running now lights it. Parallel phases therefore burn simultaneously--control flow remembers only the last marker,
 * while A's subagent still works after B's marker. Nodes only ever say "still running", never flip done / failed / pending
 * to anything: failure words belong to control flow.
 */
export const sessionWorkflowPhaseStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type SessionWorkflowPhaseStatus = z.infer<typeof sessionWorkflowPhaseStatusSchema>;

export const sessionWorkflowPhaseSummarySchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  status: sessionWorkflowPhaseStatusSchema,
  /**
   * Indices (into this `phases` array) of other stations still running when this one was entered, from
   * `run.phaseAlongside`. The sidebar draws a double-strand segment between the two parallel stations. Only the declared-table path has this--
   * the degraded path (entered phases) is assembled by entry order, nothing parallel about it, so the whole key is absent then.
   */
  alongside: z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
  /**
   * This stop is an **open hole** (docs/dynamic-workflow/presentation.md, 'Holes on the timeline'):
   * `open` = not reached yet, `waiting` = the run is parked here for the main agent to fill. The sidebar draws these lights dashed (warning color while waiting).
   * Once filled it is a plain stop and the key is absent. Only the declaration-table path knows this (`run.phaseHoles`).
   */
  hole: z.enum(["open", "waiting"]).optional(),
});
export type SessionWorkflowPhaseSummary = z.infer<typeof sessionWorkflowPhaseSummarySchema>;

export const sessionWorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /// Tool-call id of the initiating row: the key that opens the run pane from the run row; direct launches have it too (`launch-` prefix).
  toolCallId: z.string().min(1).optional(),
  /// Title of the workflow's background work (= the run's display name); absent when the projection has no such background work.
  name: z.string().min(1).optional(),
  status: workflowRunSchema.shape.status,
  stopReason: workflowRunSchema.shape.stopReason,
  /// Background work start time, for the tooltip's elapsed; absent without background work.
  startedAt: timestampSchema.optional(),
  /**
   * Station table, declaration order: `run.phaseNames` (the declared table via run-launched) when present, else degraded to entered
   * phases + current phase (entry order). Empty array with neither; the UI draws one implicit "Workflow" station.
   */
  phases: z.array(sessionWorkflowPhaseSummarySchema).max(WORKFLOW_RUNS_LIMITS.maxPhases),
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /// Subagent count with status === "running" (the tooltip's "{n} agents working").
  agentsWorking: z.number().int().nonnegative(),
  /**
   * Name of the hole waiting for the main agent (the first waiting entry's `name` in `run.holes`); the sidebar run row shows
   * '{name} - awaiting fill' (docs/dynamic-workflow/presentation.md, 'Holes on the timeline', 'The sidebar').
   * Absent when no hole is parked.
   */
  waitingHole: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
});
export type SessionWorkflowRunSummary = z.infer<typeof sessionWorkflowRunSummarySchema>;

export const sessionWorkflowActivitySchema = z.object({
  runs: z.array(sessionWorkflowRunSummarySchema).max(SESSION_WORKFLOW_ACTIVITY_MAX_RUNS),
});
export type SessionWorkflowActivity = z.infer<typeof sessionWorkflowActivitySchema>;

export function isSessionWorkflowRunLive(status: SessionWorkflowRunSummary["status"]): boolean {
  return status === "pending" || status === "running";
}

/**
 * "This node is truly running now": entry-for-entry identical to packages/ui's `statusOfRunNode` running arm, and to the set the reducer
 * uses for the actor tri-state (workflow-runs-reducer.ts), so the station light and
 * "{n} agents working" always say running about the same thing.
 *
 * `dispatched` / `waiting` do not count: the former is the brief "session ready, first request not admitted" phase, the latter waits for a slot
 * or backs off--actually sent is `node-executing`' word.
 */
function isRunNodeRunning(node: WorkflowRunNode): boolean {
  return node.phase === "executing" || node.phase === "repairing" || node.phase === "nudged";
}

/**
 * The station-name <-> instance birth-stamp matching rule. Entry-for-entry the same as packages/ui's `phaseNameMatches`
 (workflow-graph/phase-name.ts): exact match, prefix fallback only when the name sits exactly at the cap--the prefix opens only when
 * truncation really happened, else "plan" would misdetect "plan repair". That helper lives in ui and shared cannot depend backward, so the rule is inlined here.
 */
function phaseNameMatches(stationName: string, stamp: string): boolean {
  return (
    stationName === stamp ||
    (stationName.length >= WORKFLOW_RUNS_LIMITS.maxPhaseNameLength && stamp.startsWith(stationName))
  );
}

/**
 * Sole derivation of the stop table. Both the sidebar run row (via `summarizeRun`) and the task-island run row read it, so both lights
 * always say the same thing about the same fact; the task island never writes a second version.
 */
export function deriveSessionWorkflowPhases(run: WorkflowRunState): SessionWorkflowPhaseSummary[] {
  const entered = new Set((run.phases ?? []).map((phase) => phase.name));
  const current = run.currentPhase;
  let names: string[];
  // The alongside indices address the **declared table**, so they mean something only on that path; the degraded path
  // (entered + current phase) is another index space, and the whole table is omitted then.
  let alongside: readonly (readonly number[])[] | undefined;
  // Open holes (indexes into the declaration table); waiting ones are recognized by name from `run.holes` -- hole names are unique per rule 9012.
  let holeIndexes: ReadonlySet<number> = new Set();
  const waitingNames = new Set(
    (run.holes ?? []).filter((hole) => hole.state === "waiting").map((hole) => hole.name),
  );
  if (run.phaseNames !== undefined && run.phaseNames.length > 0) {
    names = run.phaseNames;
    alongside = run.phaseAlongside;
    holeIndexes = new Set(run.phaseHoles ?? []);
  } else {
    names = (run.phases ?? []).map((phase) => phase.name);
    if (current !== undefined && !entered.has(current)) names = [...names, current];
  }
  const live = isSessionWorkflowRunLive(run.status);
  // Birth stamps of running nodes. Empty table whenever the run is not running: nobody in a terminal run is still working,
  // even if a settled event has not landed (the same posture as the actor tri-state's terminality-overrides-all).
  const burning = live
    ? run.nodes.filter(isRunNodeRunning).flatMap((node) => node.phaseName ?? [])
    : [];
  const emitted = Math.min(names.length, WORKFLOW_RUNS_LIMITS.maxPhases);
  return names.slice(0, WORKFLOW_RUNS_LIMITS.maxPhases).map((name, index) => {
    const isCurrent = name === current;
    const wasEntered = entered.has(name) || isCurrent;
    // A node born at this station still running -> the station burns on, even after control flow moved to the next marker.
    const burningHere = burning.some((stamp) => phaseNameMatches(name, stamp));
    let status: SessionWorkflowPhaseStatus;
    if (live) {
      status = isCurrent || burningHere ? "running" : wasEntered ? "done" : "pending";
    } else if (run.status === "completed") {
      status = wasEntered ? "done" : "pending";
    } else if (run.status === "errored") {
      status = isCurrent ? "failed" : wasEntered ? "done" : "pending";
    } else {
      // stopped: control flow rests on the current phase, neither done nor failed--leave the light hollow.
      status = isCurrent ? "pending" : wasEntered ? "done" : "pending";
    }
    // After clipping, the index space narrows with it: references to clipped stations drop together; empty results create no key.
    const beside = (alongside?.[index] ?? []).filter(
      (other) => Number.isInteger(other) && other >= 0 && other < emitted && other !== index,
    );
    // Hole stops: waiting ones match via `run.holes` (names unique); the index table names the not-yet-reached holes.
    const hole = waitingNames.has(name) ? "waiting" : holeIndexes.has(index) ? "open" : undefined;
    return {
      name,
      status,
      ...(beside.length === 0 ? {} : { alongside: beside }),
      ...(hole === undefined ? {} : { hole }),
    };
  });
}

function summarizeRun(
  run: WorkflowRunState,
  work: BackgroundWorkSummary | undefined,
): SessionWorkflowRunSummary {
  const name = work?.title.trim();
  // Only a live run can be 'awaiting fill': the reducer strips waiting records from terminal runs, so guard again here.
  const waitingHole = isSessionWorkflowRunLive(run.status)
    ? (run.holes ?? []).find((hole) => hole.state === "waiting")?.name
    : undefined;
  return {
    runId: run.runId,
    ...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
    ...(name === undefined || name.length === 0 ? {} : { name }),
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(work === undefined ? {} : { startedAt: work.startedAt }),
    phases: deriveSessionWorkflowPhases(run),
    ...(run.currentPhase === undefined ? {} : { currentPhase: run.currentPhase }),
    agentsWorking: run.actors.filter((actor) => actor.status === "running").length,
    ...(waitingHole === undefined ? {} : { waitingHole }),
  };
}

/**
 * Derive the session's workflow-run summary from the same snapshot's `workflowRuns` + `backgroundWorks`.
 * Running runs (pending / running) first in `runs[]` order (= launch order); then finished ones by background-work
 * `endedAt` descending, or `runs[]` descending without it (later-created = newer). Total clipped to 4.
 * A session with no run -> `undefined` (whole key absent, so legacy CLIs change nothing).
 */
export function deriveSessionWorkflowActivity(input: {
  workflowRuns: WorkflowRunsState | undefined;
  backgroundWorks: readonly BackgroundWorkSummary[];
}): SessionWorkflowActivity | undefined {
  const runs = input.workflowRuns?.runs;
  if (runs === undefined || runs.length === 0) return undefined;
  const workByRunId = new Map<string, BackgroundWorkSummary>();
  for (const work of input.backgroundWorks) {
    if (work.kind === "workflow") workByRunId.set(work.workId, work);
  }
  const live: SessionWorkflowRunSummary[] = [];
  const settled: { summary: SessionWorkflowRunSummary; endedAt: number; index: number }[] = [];
  runs.forEach((run, index) => {
    const work = workByRunId.get(run.runId);
    const summary = summarizeRun(run, work);
    if (isSessionWorkflowRunLive(run.status)) live.push(summary);
    else settled.push({ summary, endedAt: work?.endedAt ?? 0, index });
  });
  settled.sort((a, b) => b.endedAt - a.endedAt || b.index - a.index);
  return {
    runs: [...live, ...settled.map((entry) => entry.summary)].slice(
      0,
      SESSION_WORKFLOW_ACTIVITY_MAX_RUNS,
    ),
  };
}
