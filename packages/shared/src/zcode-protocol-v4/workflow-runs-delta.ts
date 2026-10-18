// ============================================================
// Key-level deltas for workflowRuns: diff (producer side), apply (consumer side), canonical key order
// ============================================================
// Why this exists: `workflowRuns` is a **high-frequency** state key while `state.updated` means whole-key replacement.
// One engine event touches one node yet must re-send the entire table--O(N) bytes per event, O(N^2) per run lifetime.
// Nodes/subagents capped at 256, wide fan-outs silently dropping instances at the cap--the root is here. This module computes
// "what changed", making wire bytes proportional to the **delta**, not the state size.
//
// Three structural facts to know before reading, otherwise spots below look like fallbacks:
//   1. The reducer only **evicts** terminal entries at table-full, never reorders (workflow-runs-eviction.ts). So diff's
//      fast path stays index-aligned comparison, falling back to the keyed path to compute "who left" only on misalignment;
//      a true reorder is unrecognized and falls back to whole-key resend (see RESYNC).
//   2. The reducer allocates a new object only for the **changed run**; other runs and untouched entries keep references. So
//      diff's first gate is reference equality; deep comparison happens only on the truly touched run.
//   3. Correctness never depends on references: equality is only the fast path; any mismatch falls back to structural comparison.
//
// Contract: for any reducer-produced (prior, next) pair,
// `JSON.stringify(applyAll(snapshotWithPrior, diff(prior, next)).workflowRuns) === JSON.stringify(next)`
// --**byte-for-byte**, not just deep-equal. Key order is therefore a first-class citizen here; see {@link canonicalWorkflowRun}.

import type {
  ConversationDelta,
  WorkflowRunEntryRef,
  WorkflowRunHeaderKey,
  WorkflowRunRemovedDelta,
  WorkflowRunUpdatedDelta,
} from "./delta.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunSchema,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * The **canonical key order** of a run object = declaration order of `workflowRunSchema`.
 *
 * The one part of byte-equality not guaranteed by value equality is key order: the reducer advances state via `{...run, newKey: v}`,
 * so newly appearing optional keys (reports / phases / concurrency...) are appended in **arrival order**, and apply
 * has no such history when rebuilding. Each side re-orders by this table once and the orders align--which is also why the reducer's
 * exit must pass through this function too (one place, not two).
 *
 * Key order derives from the schema, so an independently maintained field list cannot give producer and consumer different run shapes.
 */
const WORKFLOW_RUN_KEYS = Object.keys(workflowRunSchema.shape) as (keyof WorkflowRunState)[];
const WORKFLOW_RUN_KEY_SET: ReadonlySet<string> = new Set<string>(WORKFLOW_RUN_KEYS);

/** header = the run minus the two instance tables delta-synced by (siteId, ordinal). Order stays schema declaration order. */
export const WORKFLOW_RUN_HEADER_KEYS: readonly WorkflowRunHeaderKey[] = WORKFLOW_RUN_KEYS.filter(
  (key): key is WorkflowRunHeaderKey => key !== "actors" && key !== "nodes",
);

/**
 * **Required** keys of the header, also schema-derived (`safeParse(undefined)` passing = optional).
 * Used in exactly one place: deciding whether a `workflowRun.updated` header qualifies to **birth** an unknown run.
 */
const runShape = workflowRunSchema.shape as unknown as Record<
  string,
  { safeParse: (value: unknown) => { success: boolean } }
>;
const WORKFLOW_RUN_REQUIRED_HEADER_KEYS: readonly WorkflowRunHeaderKey[] =
  WORKFLOW_RUN_HEADER_KEYS.filter((key) => !runShape[key]!.safeParse(undefined).success);

/** Dedupe keys of the two instance tables. The `\0` separator mirrors the reducer's derived actor state verbatim: ("a",12) and ("a1",2) must not collide. */
export function workflowRunEntryKey(entry: { siteId: string; ordinal: number }): string {
  return `${entry.siteId}\0${entry.ordinal}`;
}

/**
 * Rebuild a run object in canonical key order (shallow: nested values keep their references; they come from the same facts anyway).
 *
 * Keys with `undefined` values count as absent, matching `JSON.stringify` semantics--on the wire there are only
 * "key present" and "key absent", no third state. Keys outside the schema are appended in original order: this module may not drop the caller's data.
 */
export function canonicalWorkflowRun(run: WorkflowRunState): WorkflowRunState {
  const source = run as unknown as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of WORKFLOW_RUN_KEYS) {
    const value = source[key];
    if (value !== undefined) canonical[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (WORKFLOW_RUN_KEY_SET.has(key)) continue;
    const value = source[key];
    if (value !== undefined) canonical[key] = value;
  }
  return canonical as unknown as WorkflowRunState;
}

/**
 * Structural equality of JSON values. Shared by the reducer's idempotence check (formerly a whole-run `JSON.stringify` compare,
 * O(N) bytes per event) and diff's "did this key/entry change", so the two predicates cannot drift apart.
 *
 * Exactly two differences from `JSON.stringify`, both **more** accurate: key order does not participate; keys with `undefined` values
 * equal absent (stringify drops them too).
 */
export function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonValueEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let present = 0;
  for (const key of Object.keys(left)) {
    const value = left[key];
    if (value === undefined) continue;
    present += 1;
    if (!jsonValueEqual(value, right[key])) return false;
  }
  let expected = 0;
  for (const key of Object.keys(right)) if (right[key] !== undefined) expected += 1;
  return present === expected;
}

/** The reducer's idempotence predicate: a replay with unchanged content yields no delta and no revision bump. */
export function workflowRunUnchanged(previous: WorkflowRunState, next: WorkflowRunState): boolean {
  return jsonValueEqual(previous, next);
}

/**
 * Whether a header qualifies to **birth an unknown run**: not one required key missing.
 *
 * Only diff's "birth" branch ever produces a complete header--in deltas of existing runs `runId` never changes and thus never
 * appears in a patch, so merging several deltas (coalesce rule 6) still **cannot assemble** a complete header. That invariant is
 * the pivot of the merge rules: merging never turns two no-ops for an unknown run into a spontaneous birth.
 */
export function isCompleteWorkflowRunHeader(header: unknown): boolean {
  if (typeof header !== "object" || header === null) return false;
  const record = header as Record<string, unknown>;
  return WORKFLOW_RUN_REQUIRED_HEADER_KEYS.every((key) => record[key] !== undefined);
}

/**
 * Key-level delta between two workflowRuns states.
 *
 * Exactly one fallback: on unrecognized structural change (entries deleted or reordered, header fact 1) or "no ops yet
 * revision moved", resend the whole key as `state.updated`. Perfectly legal protocol-wise (whole-key replace)
 * and a barrier in coalesce, costing only a return to pre-refactor byte counts.
 */
export function diffWorkflowRunsState(
  prior: WorkflowRunsState | undefined,
  next: WorkflowRunsState,
): ConversationDelta[] {
  const priorRuns = prior?.runs ?? [];
  const nextIds = new Set(next.runs.map((run) => run.runId));
  const ops: ConversationDelta[] = [];
  // Evictions first, in prior order: the client removes departed runs before the remaining deltas apply to the living table.
  for (const run of priorRuns) {
    if (nextIds.has(run.runId)) continue;
    ops.push({ op: "workflowRun.removed", runId: run.runId, revision: next.revision });
  }
  const priorById = new Map(priorRuns.map((run) => [run.runId, run]));
  for (const run of next.runs) {
    const before = priorById.get(run.runId);
    if (before === run) continue;
    const op = diffWorkflowRun(before, run, next.revision);
    if (op === null) return [{ op: "state.updated", patch: { workflowRuns: next } }];
    if (op !== undefined) ops.push(op);
  }
  // No op at all yet revision moved: the container version has no carrier of its own, so the whole key is resent.
  // The reducer never produces such input (it returns null on no-change), so this is unreachable in production.
  if (ops.length === 0 && (prior?.revision ?? -1) !== next.revision) {
    return [{ op: "state.updated", patch: { workflowRuns: next } }];
  }
  return ops;
}

//** Delta of one run: `undefined` = no change, `null` = unrecognized structural change (whole-key resend). */
function diffWorkflowRun(
  before: WorkflowRunState | undefined,
  run: WorkflowRunState,
  revision: number,
): WorkflowRunUpdatedDelta | undefined | null {
  const source = run as unknown as Record<string, unknown>;
  // key is a union of header keys; per-key writeback narrows TS values to never, so assemble as a record and cast at the exit.
  const patch: Record<string, unknown> = {};
  const cleared: WorkflowRunHeaderKey[] = [];
  if (before === undefined) {
    // Birth: the whole header (runId included--the client judges table-creation eligibility from it) plus every entry.
    for (const key of WORKFLOW_RUN_HEADER_KEYS) {
      const value = source[key];
      if (value !== undefined) patch[key] = value;
    }
    return {
      op: "workflowRun.updated",
      runId: run.runId,
      revision,
      run: patch as WorkflowRunUpdatedDelta["run"],
      ...(run.actors.length > 0 ? { actors: [...run.actors] } : {}),
      ...(run.nodes.length > 0 ? { nodes: [...run.nodes] } : {}),
    };
  }
  const previous = before as unknown as Record<string, unknown>;
  for (const key of WORKFLOW_RUN_HEADER_KEYS) {
    const left = previous[key];
    const right = source[key];
    if (left === right) continue;
    if (right === undefined) {
      cleared.push(key);
      continue;
    }
    if (left !== undefined && jsonValueEqual(left, right)) continue;
    patch[key] = right;
  }
  const actors = diffWorkflowRunEntries(before.actors, run.actors);
  const nodes = diffWorkflowRunEntries(before.nodes, run.nodes);
  if (actors === null || nodes === null) return null;
  const changedHeader = Object.keys(patch).length > 0 || cleared.length > 0;
  if (!changedHeader && actors === undefined && nodes === undefined) return undefined;
  // Key order = application order (header -> removals -> upserts): a key deleted then added lands at the table tail,
  // matching sequential application of the two ops.
  return {
    op: "workflowRun.updated",
    runId: run.runId,
    revision,
    ...(Object.keys(patch).length > 0 ? { run: patch as WorkflowRunUpdatedDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(actors?.removed.length ? { removedActors: actors.removed } : {}),
    ...(nodes?.removed.length ? { removedNodes: nodes.removed } : {}),
    ...(actors?.changed.length ? { actors: actors.changed } : {}),
    ...(nodes?.changed.length ? { nodes: nodes.changed } : {}),
  };
}

/** One instance table's step change: departed entries (identity only) plus changed entries (whole, in next's order). */
interface EntryDiff<T> {
  removed: WorkflowRunEntryRef[];
  changed: T[];
}

/**
 * Change between two instance tables. `undefined` = no change, `null` = unrecognized structural change (whole-key resend).
 *
 * The fast path compares **index-aligned**: the reducer's steady state is append and in-place update, so untouched entries cost one
 // pointer compare. The first misalignment (identity differs at an index, or prior longer than next) means entries left--that is
 // eviction (workflow-runs-eviction.ts)--and the keyed path computes "who left".
 *
 * The keyed path still requires **survivors index-aligned**: order changes beyond deletion are inexpressible (the protocol has
 // no entry-move syntax), falling back to whole-key resend.
 */
function diffWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  before: readonly T[],
  after: readonly T[],
): EntryDiff<T> | undefined | null {
  if (before === after) return undefined;
  if (before.length <= after.length) {
    const changed: T[] = [];
    let aligned = true;
    for (let index = 0; index < after.length && aligned; index += 1) {
      const entry = after[index]!;
      const previous = before[index];
      if (previous === undefined) {
        changed.push(entry);
        continue;
      }
      if (previous === entry) continue;
      if (previous.siteId !== entry.siteId || previous.ordinal !== entry.ordinal) aligned = false;
      else if (!jsonValueEqual(previous, entry)) changed.push(entry);
    }
    if (aligned) return changed.length > 0 ? { removed: [], changed } : undefined;
  }
  return diffWorkflowRunEntriesByKey(before, after);
}

function diffWorkflowRunEntriesByKey<T extends { siteId: string; ordinal: number }>(
  before: readonly T[],
  after: readonly T[],
): EntryDiff<T> | undefined | null {
  const survives = new Set(after.map(workflowRunEntryKey));
  const removed: WorkflowRunEntryRef[] = [];
  const survivors: T[] = [];
  for (const entry of before) {
    if (survives.has(workflowRunEntryKey(entry))) survivors.push(entry);
    else removed.push({ siteId: entry.siteId, ordinal: entry.ordinal });
  }
  if (survivors.length > after.length) return null;
  const changed: T[] = [];
  for (let index = 0; index < after.length; index += 1) {
    const entry = after[index]!;
    const previous = survivors[index];
    if (previous === undefined) {
      changed.push(entry);
      continue;
    }
    // Survivors must still sit, in order, on next's prefix; anything else is a reorder--whole-key resend.
    if (previous.siteId !== entry.siteId || previous.ordinal !== entry.ordinal) return null;
    if (previous === entry || jsonValueEqual(previous, entry)) continue;
    changed.push(entry);
  }
  if (removed.length === 0 && changed.length === 0) return undefined;
  return { removed, changed };
}

/**
 * Application of `workflowRun.updated`.
 *
 * The container revision takes the **max**: coalesce may merge a later op into an earlier position (rule 6), so the last entry of
 // the output sequence need not carry the highest revision. Revision is monotonic by contract; max keeps "pre/post-merge states
 // byte-identical" independent of op position.
 *
 * Identity: unchanged runs and entries keep references; the changed run and container are new objects--the GUI memoizes on
 // exactly these two reference levels.
 */
export function applyWorkflowRunUpdated(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunUpdatedDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const index = runs.findIndex((run) => run.runId === delta.runId);
  if (index < 0) {
    // Unknown run + complete header = birth; unknown run + partial header = this op does not describe the client's facts--
    // treat as no-op (same verdict as row.upserted hitting an unloaded row) and only catch the container revision up.
    if (!isCompleteWorkflowRunHeader(delta.run)) {
      return state !== undefined && state.revision === revision ? state : { revision, runs };
    }
    const born = canonicalWorkflowRun({
      ...(delta.run as Partial<WorkflowRunState>),
      actors: delta.actors === undefined ? [] : [...delta.actors],
      nodes: delta.nodes === undefined ? [] : [...delta.nodes],
    } as WorkflowRunState);
    return { revision, runs: [...runs, born] };
  }
  const existing = runs[index]!;
  const merged: Record<string, unknown> = { ...existing, ...delta.run };
  // "Zero => key absent" is the protocol contract of several keys, so the delta must be able to say "this key is gone".
  for (const key of delta.cleared ?? []) delete merged[key];
  // Application order: header -> removals -> upserts. A key deleted then added by one op lands at the table tail, matching
  // sequential application; the reverse (add then delete) would strip a just-returned entry.
  const actors = removeWorkflowRunEntries(existing.actors, delta.removedActors);
  const nodes = removeWorkflowRunEntries(existing.nodes, delta.removedNodes);
  if (actors !== existing.actors) merged.actors = actors;
  if (nodes !== existing.nodes) merged.nodes = nodes;
  if (delta.actors !== undefined && delta.actors.length > 0) {
    merged.actors = upsertWorkflowRunEntries(actors, delta.actors);
  }
  if (delta.nodes !== undefined && delta.nodes.length > 0) {
    merged.nodes = upsertWorkflowRunEntries(nodes, delta.nodes);
  }
  const next = [...runs];
  next[index] = canonicalWorkflowRun(merged as unknown as WorkflowRunState);
  return { revision, runs: next };
}

/** Application of `workflowRun.removed`: drop this run. An unknown runId only catches the revision up. */
export function applyWorkflowRunRemoved(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunRemovedDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const remaining = runs.filter((run) => run.runId !== delta.runId);
  if (remaining.length === runs.length) {
    return state !== undefined && state.revision === revision ? state : { revision, runs };
  }
  return { revision, runs: remaining };
}

/**
 * Remove entries by (siteId, ordinal); with no hit at all return the **same array** (untouched tables keep their references).
 * Missed keys are a well-defined no-op: the merge unions both ops' removals, some of which never reached this client.
 * never reached this client.
 */
function removeWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  current: readonly T[],
  removed: readonly { siteId: string; ordinal: number }[] | undefined,
): T[] {
  if (removed === undefined || removed.length === 0) return current as T[];
  const dropped = new Set(removed.map(workflowRunEntryKey));
  const next = current.filter((entry) => !dropped.has(workflowRunEntryKey(entry)));
  return next.length === current.length ? (current as T[]) : next;
}

/**
 * Upsert by (siteId, ordinal): existing keys replaced in place, new keys appended.
 *
 * The client **never** applies any cap (maxNodes / maxActors / maxRuns): only the producer may evict, and
 // eviction must be announced (`workflowRun.removed` / `removedActors` / `removedNodes`). Client-side trimming
 // would only let the two sides silently diverge.
 */
function upsertWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const next = [...current];
  const indexByKey = new Map<string, number>();
  next.forEach((entry, index) => indexByKey.set(workflowRunEntryKey(entry), index));
  for (const entry of incoming) {
    const key = workflowRunEntryKey(entry);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, next.length);
      next.push(entry);
      continue;
    }
    next[index] = entry;
  }
  return next;
}

/**
 * Are all four entry tables of a `workflowRun.updated` within the wire caps?
 *
 * What can actually overflow are the **two removal tables**. Merged upsert tables are bounded by construction: per the merge
 // rules, keys upserted by the former and deleted by the latter are already stripped, so every surviving key is still in the
 // table after this op applies, and the table itself is <= cap.
 // Removal tables lack that guard--the merge cannot tell "keys born and evicted within the window" from "keys the client long held",
 // and every eviction frees a seat, so one wide flush window can delete more than 1024 distinct keys.
 *
 // Before eviction this was impossible: tables only grow, so distinct keys touched within one life number at most the table cap.
 // An over-cap payload fails the whole patch parse and drops the frame; the publisher's two limits (500 ops / 1 MiB)
 *
 * Merging is an **optimization**, so refusing to merge is always safe: each op is within caps alone, and per-op delivery is byte-identical in the end.
 */
export function workflowRunUpdateWithinWireBounds(
  delta: WorkflowRunUpdatedDelta,
  limits: WorkflowRunWireBounds = WORKFLOW_RUNS_LIMITS,
): boolean {
  return (
    (delta.actors?.length ?? 0) <= limits.maxActors &&
    (delta.removedActors?.length ?? 0) <= limits.maxActors &&
    (delta.nodes?.length ?? 0) <= limits.maxNodes &&
    (delta.removedNodes?.length ?? 0) <= limits.maxNodes
  );
}

/**
 * Entry-table capacity caps; defaults to {@link WORKFLOW_RUNS_LIMITS}.
 * Delta application and merging must use consistent caps.
 */
export interface WorkflowRunWireBounds {
  readonly maxActors: number;
  readonly maxNodes: number;
}

/** Merge two same-run `workflowRun.updated` ops (the payload half of coalesce rule 6; the rule itself in coalesce.ts). */
export function mergeWorkflowRunUpdates(
  earlier: WorkflowRunUpdatedDelta,
  later: WorkflowRunUpdatedDelta,
): WorkflowRunUpdatedDelta {
  const run: Record<string, unknown> = { ...earlier.run, ...later.run };
  // header keys and `cleared` are negatives of each other and must cancel on merge: a later-set key is no longer "cleared",
  // and a later-cleared key no longer has a value. Keeping half would make apply write-then-delete (or delete-then-write), order-dependent.
  const laterCleared = new Set<string>(later.cleared ?? []);
  for (const key of laterCleared) delete run[key];
  const cleared: WorkflowRunHeaderKey[] = [];
  for (const key of earlier.cleared ?? []) {
    if (run[key] === undefined && !cleared.includes(key)) cleared.push(key);
  }
  for (const key of later.cleared ?? []) {
    if (!cleared.includes(key)) cleared.push(key);
  }
  const removedActors = mergeRemovedRefs(earlier.removedActors, later.removedActors);
  const removedNodes = mergeRemovedRefs(earlier.removedNodes, later.removedNodes);
  const actors = mergeEntryLists<WorkflowRunActor>(
    earlier.actors,
    later.actors,
    later.removedActors,
  );
  const nodes = mergeEntryLists<WorkflowRunNode>(earlier.nodes, later.nodes, later.removedNodes);
  return {
    op: "workflowRun.updated",
    runId: later.runId,
    // Take the highest watermark: the merged op sits earlier; apply's max keeps the container version converging on the highest revision.
    revision: Math.max(earlier.revision, later.revision),
    ...(Object.keys(run).length > 0 ? { run: run as WorkflowRunUpdatedDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(removedActors === undefined ? {} : { removedActors }),
    ...(removedNodes === undefined ? {} : { removedNodes }),
    ...(actors === undefined ? {} : { actors }),
    ...(nodes === undefined ? {} : { nodes }),
  };
}

/** Union of both sides' removals, deduped by first occurrence (removal filters by key; order affects bytes, not the result). */
function mergeRemovedRefs(
  earlier: readonly WorkflowRunEntryRef[] | undefined,
  later: readonly WorkflowRunEntryRef[] | undefined,
): WorkflowRunEntryRef[] | undefined {
  if (earlier === undefined && later === undefined) return undefined;
  const merged: WorkflowRunEntryRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...(earlier ?? []), ...(later ?? [])]) {
    const key = workflowRunEntryKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * Entry tables: later key wins, first occurrence keeps order; undefined when neither side has entries (key not created).
 *
 * **Keys upserted by the former and deleted by the latter are always stripped**: applied in order they enter the table then get
 // removed, so the merged op should not carry them at all. Should the latter re-add the same key, it appears once--in the latter's
 // table--landing at the tail, exactly where sequential application puts it.
 */
function mergeEntryLists<T extends { siteId: string; ordinal: number }>(
  earlier: readonly T[] | undefined,
  later: readonly T[] | undefined,
  laterRemoved: readonly WorkflowRunEntryRef[] | undefined,
): T[] | undefined {
  if (earlier === undefined && later === undefined) return undefined;
  const dropped = new Set((laterRemoved ?? []).map(workflowRunEntryKey));
  const kept =
    dropped.size === 0
      ? (earlier ?? [])
      : (earlier ?? []).filter((entry) => !dropped.has(workflowRunEntryKey(entry)));
  const merged = upsertWorkflowRunEntries(kept, later ?? []);
  return merged.length > 0 ? merged : undefined;
}
