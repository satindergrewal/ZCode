// ============================================================
// The workflowRuns reduction's hole branch: `hole-reached` / `hole-filled`, plus hole indexes on the phase table
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate; same precedent as phases / started).
// Contract: docs/dynamic-workflow/presentation.md, Holes on the timeline, the The-model section, and
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunHole,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { boundedPhaseName, nonEmptyString } from "./workflow-runs-entries.js";

/**
 * Hole stop id: `hole#` plus 8 hex chars, keyed by the hole's **name**, nesting-independent (minted by
 * the CLI's analysis/hole-id.ts; apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md, Sites).
 * The id encodes no nesting: which hole contains a hole shows in its own phase/stop `fill`.
 */
export const WORKFLOW_HOLE_SITE_ID_PATTERN = /^hole#[0-9a-f]{8}$/u;

function readEpoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Carry of `run-launched.holes` / `hole-filled.holes`: indexes point at the **accepted** `phaseNames`, so
 * out-of-range, non-integer, and duplicate entries drop -- a bad index draws a dashed light on a nonexistent stop.
 * Nothing left returns `undefined`: no key created.
 */
export function readPhaseHoles(raw: unknown, count: number): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 0 || value >= count || out.includes(value)) continue;
    out.push(value);
    if (out.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  return out.length === 0 ? undefined : out;
}

/**
 * The declared phase table on the payload (`run-launched` and `hole-filled` alike): declaration order, trimmed to `phases`' bounds.
 * Empty returns `undefined`; callers keep their existing table.
 */
export function readPhaseNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = value.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    names.push(name);
    if (names.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  return names.length === 0 ? undefined : names;
}

/**
 * `hole-reached`: the run reaches an open hole; that branch parks. Upsert by **stop id** -- a loop parks
 * a second ordinal at the same stop; the table keeps the newest. Replay is byte-neutral (the top-level structural compare at once returns null).
 * `name` is this record's whole reason to exist (every surface labels by name); absent only bumps the watermark. Bounds match nodes / actors:
 * reject new entries, update existing, set truncated.
 */
/** Prompt trimmed to the cap: over-long keeps 499 chars plus an ellipsis, total still 500. */
function boundedHolePrompt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const max = WORKFLOW_RUNS_LIMITS.maxHolePromptLength;
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

export function reduceHoleReached(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const instance = payload.instance;
  if (typeof instance !== "object" || instance === null) return run;
  const siteId = nonEmptyString((instance as Record<string, unknown>).siteId);
  const ordinalRaw = (instance as Record<string, unknown>).ordinal;
  const ordinal = typeof ordinalRaw === "number" && Number.isInteger(ordinalRaw) ? ordinalRaw : 0;
  const name = boundedPhaseName(nonEmptyString(payload.name));
  if (siteId === undefined || name === undefined) return run;
  const type = nonEmptyString(payload.type)?.slice(0, WORKFLOW_RUNS_LIMITS.maxHoleTypeLength);
  const prompt = boundedHolePrompt(nonEmptyString(payload.prompt));
  // Reached-at time can only ride the event (clockless module); both key names accepted: `reachedAt` the notice's word, `since` the projection's.
  const since = readEpoch(payload.reachedAt) ?? readEpoch(payload.since);
  const entry: WorkflowRunHole = {
    siteId,
    ordinal,
    name,
    ...(type === undefined ? {} : { type }),
    ...(prompt === undefined ? {} : { prompt }),
    state: "waiting",
    ...(since === undefined ? {} : { since }),
  };
  const existing = run.holes ?? [];
  const index = existing.findIndex((hole) => hole.siteId === siteId);
  if (index >= 0) {
    // Existing record (including filled-then-re-reached -- resume replaying onto a not-yet-filled stop): switch to waiting,
    // keeping the recorded type when absent.
    const previous = existing[index]!;
    const merged: WorkflowRunHole = {
      ...entry,
      ...(entry.type === undefined && previous.type !== undefined ? { type: previous.type } : {}),
      ...(entry.prompt === undefined && previous.prompt !== undefined
        ? { prompt: previous.prompt }
        : {}),
    };
    return { ...run, holes: existing.map((hole, i) => (i === index ? merged : hole)) };
  }
  if (existing.length >= WORKFLOW_RUNS_LIMITS.maxHoles) return { ...run, truncated: true };
  return { ...run, holes: [...existing, entry] };
}

/**
 * `hole-filled`: the main agent's fill joins the run. Three things in one step -- the record flips to filled, the phase table
 * becomes the post-fill declaration table (superset: the hole's body expands in place), the hole-index table replaces whole. The running-now
 * table shifts by insertion: a fill inserts k stops after the hole's stop, so old indexes > h all +k; any shape mismatch drops
 * the table -- a missing double-line segment beats one attached to the wrong stop.
 */
export function reduceHoleFilled(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const siteId = nonEmptyString(payload.siteId);
  if (siteId === undefined) return run;
  const filledAt = readEpoch(payload.filledAt);
  const filledBy = nonEmptyString(payload.filledBy)?.slice(0, 128);
  let next: WorkflowRunState = run;

  const existing = run.holes ?? [];
  const index = existing.findIndex((hole) => hole.siteId === siteId);
  if (index >= 0) {
    // The prompt exists only for the waiting body: dropped on fill; a settled run state does not carry it.
    const { prompt: _prompt, ...reached } = existing[index]!;
    void _prompt;
    const filled: WorkflowRunHole = {
      ...reached,
      state: "filled",
      ...(filledAt === undefined ? {} : { filledAt }),
      ...(filledBy === undefined ? {} : { filledBy }),
    };
    next = { ...next, holes: existing.map((hole, i) => (i === index ? filled : hole)) };
  }

  const phaseNames = readPhaseNames(payload.phaseNames);
  if (phaseNames === undefined) return next;
  const phaseHoles = readPhaseHoles(payload.holes, phaseNames.length);
  const phaseAlongside = shiftPhaseAlongside(run, phaseNames);
  const { phaseAlongside: _stale, phaseHoles: _staleHoles, ...rest } = next;
  void [_stale, _staleHoles];
  return {
    ...rest,
    phaseNames,
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
    ...(phaseHoles === undefined ? {} : { phaseHoles }),
  };
}

/** Old table + insert-k-after-the-hole => running-now indexes on the new table; undefined on shape mismatch. */
function shiftPhaseAlongside(
  run: WorkflowRunState,
  names: readonly string[],
): number[][] | undefined {
  const old = run.phaseNames;
  const alongside = run.phaseAlongside;
  if (old === undefined || alongside === undefined) return undefined;
  const inserted = names.length - old.length;
  if (inserted < 0) return undefined;
  // Find insertion h: prefix old[0..h] and suffix old[h+1..] must be identical.
  let h = -1;
  for (let i = 0; i < old.length; i += 1) {
    if (old[i] !== names[i]) break;
    h = i;
  }
  if (h < 0) return undefined;
  for (let i = h + 1; i < old.length; i += 1) {
    if (old[i] !== names[i + inserted]) return undefined;
  }
  const shift = (i: number): number => (i <= h ? i : i + inserted);
  const out: number[][] = [];
  for (let i = 0; i < names.length; i += 1) {
    const source = i <= h ? i : i - inserted;
    const entry = i > h && i <= h + inserted ? [] : (alongside[source] ?? []);
    out.push(entry.map(shift));
  }
  return out.some((entry) => entry.length > 0) ? out : undefined;
}

/**
 * Strip waiting records (new life / terminal): the truth is the in-process parked deferred, same reason as pendingQuestions --
 * nobody awaits a stopped run's fill; a resume re-run of that stop emits a fresh `hole-reached`. filled records survive across lives:
 * they are code joined into the run, not residue. None left removes the whole key.
 */
export function withoutWaitingHoles(run: WorkflowRunState): WorkflowRunState {
  if (run.holes === undefined) return run;
  const kept = run.holes.filter((hole) => hole.state === "filled");
  if (kept.length === run.holes.length) return run;
  const { holes: _dropped, ...rest } = run;
  void _dropped;
  return kept.length === 0 ? rest : { ...rest, holes: kept };
}
