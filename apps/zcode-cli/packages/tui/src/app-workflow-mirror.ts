// ============================================================
// TUI-side workflowRuns mirror.
//
// Single clock: run state is maintained **only** by reducing events through the shared reducer (@zcode/shared's
// workflow-runs-reducer, the same implementation as the v4 projection), plus a one-shot cold seed on start/resume.
// No polling, no setInterval -- the legacy workflow panel's per-second full refetch is the anti-pattern.
//
// The mirror carries two things beyond the protocol state, both deliberate:
//   1. `logTailByRunId`: log events are **not** in the workflowRuns schema (they only go to the journal event log),
//      but the expanded detail shows the log tail, so the TUI keeps a bounded recent slice itself.
//   2. `seedByRunId`: display metadata (label / updatedAt) returned by the cold seed's listDynamicWorkflowRuns.
//      Run state (status, steps, usage, resumable) does **not** come from summaries: on cold start / `/resume` the
//      journal events replay through `replayWorkflowRuns` into the same reducer, leaving the mirror byte-identical
//      to pre-restart; `resumable` is a state bit decided by the CLI on the run-settled payload -- the existing
//      ruling in dynamic-workflow-run.port.ts ("render the server boolean") stands.

import {
  reduceWorkflowRunsState,
  workflowRunStepCounts as sharedWorkflowRunStepCounts,
  type WorkflowRunActor,
  type WorkflowRunUsage,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";

/** Bounds for the log tail: both count and per-line length, so a chatty run cannot bloat the mirror. */
const TUI_WORKFLOW_LOG_TAIL_LIMITS = {
  maxEntries: 10,
  maxEntryLength: 200,
} as const;

/**
 * Display fields the TUI renders from a cold-seed summary (run state always comes from replay; see file header).
 *
 * `label` / `updatedAt` are additive optional (see the spec's `/dwf` boundary row, "implementation revisions"):
 * undefined until the server sends them; rendering falls back to runId and never fabricates a label here.
 */
export type TuiWorkflowRunSeed = {
  runId: string;
  label?: string;
  updatedAt?: number;
};

export type TuiWorkflowMirror = {
  /** Authoritative run state, maintained by the shared reducer. */
  state: WorkflowRunsState;
  logTailByRunId: Readonly<Record<string, readonly string[]>>;
  seedByRunId: Readonly<Record<string, TuiWorkflowRunSeed>>;
};

export const EMPTY_TUI_WORKFLOW_MIRROR: TuiWorkflowMirror = {
  state: { revision: 0, runs: [] },
  logTailByRunId: {},
  seedByRunId: {},
};

/**
 * One dwf progress event -> next mirror.
 *
 * **Returns the very same reference when nothing changed**, so React's setState skips the re-render: the shared
 * reducer's "null = no semantic change" contract lands here as "no repaint", with no extra equality check.
 */
export function applyWorkflowProgressToMirror(
  mirror: TuiWorkflowMirror,
  envelope: WorkflowRunProgressEnvelope,
): TuiWorkflowMirror {
  const state = reduceWorkflowRunsState(mirror.state, envelope);
  const logTailByRunId = appendWorkflowLogTail(mirror.logTailByRunId, envelope);
  if (state === null && logTailByRunId === mirror.logTailByRunId) return mirror;
  return {
    ...mirror,
    ...(state === null ? {} : { state }),
    logTailByRunId,
  };
}

/**
 * Cold seed: merge the **display names** from `listDynamicWorkflowRuns` session summaries into the mirror.
 *
 * Metadata only -- never fabricate run-state entries. Run state comes from the cold replay (`replayWorkflowRuns` ->
 * shared reducer) and is byte-identical to pre-restart; nothing beyond the label is invented here.
 */
export function seedWorkflowMirror(
  mirror: TuiWorkflowMirror,
  seeds: readonly TuiWorkflowRunSeed[],
): TuiWorkflowMirror {
  if (seeds.length === 0) return mirror;
  const seedByRunId = { ...mirror.seedByRunId };
  let changed = false;
  for (const seed of seeds) {
    if (!seed.runId) continue;
    const existing = seedByRunId[seed.runId];
    if (existing && sameSeed(existing, seed)) continue;
    seedByRunId[seed.runId] = seed;
    changed = true;
  }
  return changed ? { ...mirror, seedByRunId } : mirror;
}

/**
 * Step progress: **settled / scheduled**.
 *
 * Dynamic workflows have no static total, so the denominator is the scheduled node count -- never present it as a
 * whole-run percentage. The count lives in exactly one place: @zcode/shared's `workflowRunStepCounts` (shared by
 * the run card, timeline summary, and here). This used to count `nodes` locally, so a run that hit the node cap
 * showed three different numbers on three surfaces, all smaller than the real step count: capping rejects new
 * instances, and rejected instances never appear in `nodes` -- only in the two usage counters.
 * This function keeps the TUI field names (cards and i18n say nodesSettled / nodesTotal).
 */
export function workflowRunStepCounts(run: WorkflowRunState): {
  nodesSettled: number;
  nodesTotal: number;
} {
  const { total, settled } = sharedWorkflowRunStepCounts(run);
  return { nodesSettled: settled, nodesTotal: total };
}

/** Every fact the card render needs -- the view stays a pure function of props (TUI tests call components functionally). */
export type TuiWorkflowCard = {
  runId: string;
  status: WorkflowRunState["status"];
  /** Why `stopped`; the reducer copies it from the run-settled payload. */
  stopReason?: WorkflowRunState["stopReason"];
  nodesSettled: number;
  nodesTotal: number;
  label?: string;
  resumable?: boolean;
  usage?: WorkflowRunUsage;
  actors: readonly WorkflowRunActor[];
  logTail: readonly string[];
  error?: string;
  resultPreview?: string;
  truncated?: boolean;
};

/**
 * Tool card -> workflow run join, keyed by `toolCallId` (the schema notes it as "the tool card -> detail link").
 * Same rule as GUI `buildWorkflowRunByToolCallId`. Run state has one source -- mirror state (live events and cold
 * replay through the same reducer); seeding contributes display names only.
 */
export function buildTuiWorkflowCardIndex(
  mirror: TuiWorkflowMirror,
): ReadonlyMap<string, TuiWorkflowCard> {
  const byToolCallId = new Map<string, TuiWorkflowCard>();
  for (const run of mirror.state.runs) {
    // Runs without a toolCallId have no card to join; keep them out of the table.
    if (!run.toolCallId) continue;
    byToolCallId.set(run.toolCallId, cardFromRun(run, mirror));
  }
  return byToolCallId;
}

function cardFromRun(run: WorkflowRunState, mirror: TuiWorkflowMirror): TuiWorkflowCard {
  const { nodesSettled, nodesTotal } = workflowRunStepCounts(run);
  const seed = mirror.seedByRunId[run.runId];
  return {
    runId: run.runId,
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    nodesSettled,
    nodesTotal,
    // Only the server knows the label; projection entries lack it, so a seed hit wins.
    ...(seed?.label === undefined ? {} : { label: seed.label }),
    // resumable is a state bit (CLI-decided on the run-settled payload, reducer-carried); the TUI never re-derives it.
    ...(run.resumable === undefined ? {} : { resumable: run.resumable }),
    usage: run.usage,
    actors: run.actors,
    logTail: mirror.logTailByRunId[run.runId] ?? [],
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.resultPreview === undefined ? {} : { resultPreview: run.resultPreview }),
    ...(run.truncated === undefined ? {} : { truncated: run.truncated }),
  };
}

function appendWorkflowLogTail(
  current: Readonly<Record<string, readonly string[]>>,
  envelope: WorkflowRunProgressEnvelope,
): Readonly<Record<string, readonly string[]>> {
  if (envelope.eventType !== "log" || !envelope.runId) return current;
  const message = logMessage(envelope.payload);
  if (message === undefined) return current;
  const previous = current[envelope.runId] ?? [];
  const appended = [...previous, message].slice(-TUI_WORKFLOW_LOG_TAIL_LIMITS.maxEntries);
  return { ...current, [envelope.runId]: appended };
}

function logMessage(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const raw = payload.message;
  if (typeof raw !== "string") return undefined;
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, TUI_WORKFLOW_LOG_TAIL_LIMITS.maxEntryLength);
}

function sameSeed(left: TuiWorkflowRunSeed, right: TuiWorkflowRunSeed): boolean {
  return left.label === right.label && left.updatedAt === right.updatedAt;
}
