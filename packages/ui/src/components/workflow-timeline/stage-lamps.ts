import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { StreamSpec } from "./timeline-bands.js";

// Two sequence-rule pieces (isCurrentPhase / stationStatus) lived in timeline-model.ts; after the
// dwf-recursive / dwf-pipeline-display merge that file hit 430 lines (oxlint max-lines 400), so lamp rules
// moved here.

/** How currentPhase relates to a station; same name rule as phaseEntryFor. */
export function isCurrentPhase(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/**
 * A station's lamp. Member nodes speak first, running/failed are hard facts. Only then control flow: current
 * phase plus a living run means running (from before the first ask dispatch to after the last settle and before
 * the next marker, control flow sits on this station). A station with no observed node (empty or fully skipped)
 * lights only from its entry record. nodeStatus is the fold; undefined literally means no nodes, the fold never
 * mints a pending for unvisited sites.
 */
export function stationStatus(
  run: WorkflowRunState | undefined,
  nodeStatus: StepRunStatus | undefined,
  current: boolean,
  entered: boolean,
): StepRunStatus | undefined {
  if (run === undefined) return undefined;
  if (nodeStatus === "running" || nodeStatus === "failed") return nodeStatus;
  const live = run.status === "running" || run.status === "pending";
  if (current && live) return "running";
  // The current phase closes with the run's terminal state: a failure at this station counts regardless of
  // nodes; cancelled draws like its nodes, also failed.
  if (current) return run.status === "completed" ? "done" : "failed";
  if (nodeStatus !== undefined) return nodeStatus;
  return entered ? "done" : "pending";
}

/**
 * Phase lamps and stream ink (docs/dynamic-workflow/presentation.md Station status, Ink).
 *
 * A STAGE = a station with an alongside partner or a stream and at least one member step. A stage's future runs
 * its own phase marker first thing, so entered / is-currentPhase say nothing: in the triggering run five markers
 * completed within 108ms, stations waiting on a channel drew done from entered-with-no-nodes, and the last
 * station (the only currentPhase) wore the run's stopped red without running a single node. A stage lamp
 * therefore reads only its own nodes plus the stations feeding it:
 *
 * 1. No nodes: pending while the run lives; ended, done when completed-and-entered, else pending.
 * 2. Else the fold, except done stays running while the run lives and some feeding station is still OPEN
 *    (more life may arrive). Open = run alive and the station running/pending by its own nodes (no nodes
 *    counts pending), or a feeder open. Solved to a fixed point; the feedback loop terminates.
 *
 * Non-stage stations and memberless stages (marker-only) keep the sequence rule (sequential).
 */
export function stageStatuses(input: {
  run: WorkflowRunState | undefined;
  /** Per-station fold of member step status; absent = no nodes. */
  nodeStatuses: readonly (StepRunStatus | undefined)[];
  entered: readonly boolean[];
  /** Per-station has-member-step (marker-only phases none). */
  hasMembers: readonly boolean[];
  /** Per-station alongside (subscripts; only later parties report, read symmetrically here). */
  alongside: readonly (readonly number[])[];
  streams: readonly StreamSpec[];
  /** Lamp from the sequence rule (used as-is for non-stage stations). */
  sequential: readonly (StepRunStatus | undefined)[];
}): (StepRunStatus | undefined)[] {
  const { alongside, entered, hasMembers, nodeStatuses, run, sequential, streams } = input;
  if (run === undefined) return [...sequential];
  const parallel = new Set([
    ...streams.flatMap((stream) => [stream.from, stream.to]),
    ...alongside.flatMap((near, i) => (near.length > 0 ? [i, ...near] : [])),
  ]);
  const stage = nodeStatuses.map((_, i) => hasMembers[i] === true && parallel.has(i));
  const live = run.status === "running" || run.status === "pending";
  const feeders = nodeStatuses.map(() => [] as number[]);
  for (const stream of streams) feeders[stream.to]?.push(stream.from);

  const own = (i: number): StepRunStatus | undefined =>
    stage[i] ? (nodeStatuses[i] ?? "pending") : sequential[i];
  const open = nodeStatuses.map((_, i) => live && (own(i) === "running" || own(i) === "pending"));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < open.length; i += 1) {
      if (open[i] || !live || !feeders[i]!.some((f) => open[f])) continue;
      open[i] = true;
      changed = true;
    }
  }

  return nodeStatuses.map((status, i) => {
    if (!stage[i]) return sequential[i];
    if (status === undefined) {
      if (live) return "pending";
      return run.status === "completed" && entered[i] ? "done" : "pending";
    }
    if (status === "done" && live && feeders[i]!.some((f) => open[f])) return "running";
    return status;
  });
}

/** Payload phaseStreams to subscript pairs: both ends listed, no self-loops, one per ordered pair. */
export function phaseStreamIndexes(
  streams: readonly { from: string; to: string }[] | undefined,
  index: ReadonlyMap<string, number>,
): StreamSpec[] {
  const out: StreamSpec[] = [];
  const seen = new Set<string>();
  for (const stream of streams ?? []) {
    const from = index.get(stream.from);
    const to = index.get(stream.to);
    if (from === undefined || to === undefined || from === to || seen.has(`${from}>${to}`))
      continue;
    seen.add(`${from}>${to}`);
    out.push({ from, to });
  }
  return out;
}

/**
 * A stream's ink: both ends running marches (something crossing); else strong when the target station
 * has observed a node (something crossed); else faint. Observed-a-node, not visited: a stage's entry record
 * exists from the run's first breath.
 */
export function streamInk(
  from: { status: StepRunStatus | undefined },
  to: { status: StepRunStatus | undefined; fraction?: unknown },
): "faint" | "strong" | "march" {
  if (from.status === "running" && to.status === "running") return "march";
  return to.fraction === undefined ? "faint" : "strong";
}
