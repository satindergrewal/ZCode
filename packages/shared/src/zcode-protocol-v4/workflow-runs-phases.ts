import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunPhase,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { readPhaseHoles } from "./workflow-runs-holes.js";

/**
 * Reduction of `phase-entered`: control flow passed
 * through a `phase("...")` marker. Living outside the main reducer for the same reason as the concurrency observer--the main file's max-lines gate.
 *
 * Never touches nodes / actors--a marker is not a step of work. `rounds` takes **max**, not +1: on resume reruns the engine
 * re-emits the prefix (markers have no journal row to dedupe by), so the monotonic reduction makes replays no-ops per event; a missing ordinal
 (legacy CLI / partial payload) counts as 1. Cap semantics match actors / nodes: reject new, update existing, over-cap facts stay in the
 * journal; `currentPhase` is uncapped--"where control flow is" is a fact that must be said even when the table is full.
 */
/**
 * Reduction of `run-launched`: the anchor (inputId)
 * is event-attribution business, not state; only the script-declared phase table `phaseNames` is carried, in declaration order,
 * clipped to the same pair of bounds as `phases`. Absent or empty -> return as-is (watermark only), key not created: the UI draws an implicit site from its absence.
 * Recorded once per life, so resume's `run-started` does not clear it and replays are no-ops.
 *
 * The "running alongside" table `phaseAlongside` rides along (its indices point into the accepted `phaseNames`), so
 * it is read only after the name table stands, clipped to that table's length--see {@link readPhaseAlongside}.
 */
export function reduceRunLaunched(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  if (!Array.isArray(payload.phaseNames)) return run;
  const phaseNames: string[] = [];
  for (const raw of payload.phaseNames) {
    if (typeof raw !== "string") continue;
    const name = raw.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    phaseNames.push(name);
    if (phaseNames.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  if (phaseNames.length === 0) return run;
  const phaseAlongside = readPhaseAlongside(payload.phaseAlongside, phaseNames.length);
  // 留白下标表（docs/dynamic-workflow/presentation.md「Holes on the timeline」）与「同时在跑」表同一姿态：
  // 搭声明表的车，下标按被接受的那张表裁。
  const phaseHoles = readPhaseHoles(payload.holes, phaseNames.length);
  return {
    ...run,
    phaseNames,
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
    ...(phaseHoles === undefined ? {} : { phaseHoles }),
  };
}

/**
 * Carry-over of the alongside table, only after `phaseNames` is accepted.
 *
 * Indices point into the **accepted** name table, so the whole table is clipped to its length (shorter payloads pad empty arrays), then each
 * entry re-checked: integer, within [0, count), not itself (no phase runs alongside itself), deduped order-stable, count within the same cap. An
 * out-of-range index would tie a sidebar segment to a nonexistent station; better to draw less.
 *
 * Returns `undefined` when nothing remains: key not created, the UI draws a straight line--the same posture as an empty `phaseNames`.
 */
function readPhaseAlongside(raw: unknown, count: number): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[][] = [];
  let any = false;
  for (let index = 0; index < count; index += 1) {
    const entry: unknown = raw[index];
    const indexes: number[] = [];
    if (Array.isArray(entry)) {
      for (const value of entry) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue;
        if (value < 0 || value >= count || value === index) continue;
        if (indexes.includes(value)) continue;
        indexes.push(value);
        if (indexes.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
      }
    }
    if (indexes.length > 0) any = true;
    out.push(indexes);
  }
  return any ? out : undefined;
}

export function reducePhaseEntered(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const raw = typeof payload.name === "string" ? payload.name : undefined;
  const name = raw?.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
  if (name === undefined || name.length === 0) return run;
  const ordinal =
    typeof payload.ordinal === "number" && Number.isInteger(payload.ordinal) && payload.ordinal > 0
      ? payload.ordinal
      : 1;
  const existing = run.phases ?? [];
  const index = existing.findIndex((phase) => phase.name === name);
  let phases: WorkflowRunPhase[];
  let truncated = run.truncated === true;
  if (index >= 0) {
    const current = existing[index]!;
    phases =
      current.rounds >= ordinal
        ? existing
        : existing.map((phase, i) => (i === index ? { ...phase, rounds: ordinal } : phase));
  } else if (existing.length >= WORKFLOW_RUNS_LIMITS.maxPhases) {
    phases = existing;
    truncated = true;
  } else {
    phases = [...existing, { name, rounds: ordinal }];
  }
  return {
    ...run,
    phases,
    currentPhase: name,
    ...(truncated ? { truncated: true } : {}),
  };
}
