// Pure model for the sidebar's workflow-run line.
// Inputs: sessions-index workflowActivity plus the renderer's seen-set; output: which rows draw, dots per row.
// No clocks, no DOM: finished rows collapse on the seen-set alone, never time.
import type {
  SessionWorkflowActivity,
  SessionWorkflowPhaseSummary,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { bandOf, foldPhaseBands, trackOf } from "../components/workflow-timeline/timeline-bands.js";

/** Max run lines drawn per session; the rest collapse into a "+n" suffix. */
export const WORKFLOW_RUN_LINE_MAX_LINES = 2;
/** Max stations on the mini rail; beyond that, fold to running station +/-2 with a "+n" tail. */
const WORKFLOW_RUN_RAIL_MAX_STATIONS = 6;
/** Stations kept on each side of the running station when folding. */
const RAIL_FOLD_RADIUS = 2;

export interface WorkflowRunRailStation {
  name: string;
  status: SessionWorkflowPhaseSummary["status"];
  /** Whether the rail segment entering this station was traversed by control flow (strong color). */
  reached: boolean;
  /**
   * The segment entering this station is a **twin segment**: this and the previous station share
   * a band but sit on different tracks, and control flow did not run between them -- parallel.
   * The flag lives on the **station**, not the segment, so it survives the window fold below.
   */
  twin?: true;
  /** This phase is an open hole: a dashed 6px dot, warning-colored while waiting (docs/dynamic-workflow/presentation.md, Holes on the timeline). */
  hole?: "open" | "waiting";
}

export interface WorkflowRunRail {
  stations: WorkflowRunRailStation[];
  /** Stations folded away, not drawn (the "+n" tail); no tail at 0. */
  hidden: number;
  /** The script has no phase vocabulary: draw one implicit "Workflow" station. */
  implicit: boolean;
}

/** Whether control flow reached this station: running / done / failed all count. */
function isWorkflowRunStationReached(status: SessionWorkflowPhaseSummary["status"]): boolean {
  return status !== "pending";
}

/**
 * Mini-track folding: <=6 phases draw all; beyond that center on the running phase (else the last reached, else the first)
 * keeping +/-2 (5 total) and synthesize a +n tail. A **fixed window**, not scrolling: no horizontal gestures in the sidebar.
 */
export function foldWorkflowRunRail(
  phases: readonly SessionWorkflowPhaseSummary[],
): WorkflowRunRail {
  if (phases.length === 0) {
    return { stations: [], hidden: 0, implicit: true };
  }
  // Fold bands over the **full** phase table: a band is a declaration-order connected component, and refolding
  // on window indexes would cut bands at window edges. Fold first, window second; double-line flags follow phases.
  const bands = foldPhaseBands(
    phases.length,
    phases.map((phase) => phase.alongside ?? []),
  );
  const all: WorkflowRunRailStation[] = phases.map((phase, index) => {
    const band = index === 0 ? undefined : bandOf(bands, index);
    const twin =
      band !== undefined &&
      band === bandOf(bands, index - 1) &&
      trackOf(bands, index) !== trackOf(bands, index - 1);
    return {
      name: phase.name,
      status: phase.status,
      // A hole awaiting its fill is where control flow stands: segments entering it are done.
      reached: isWorkflowRunStationReached(phase.status) || phase.hole === "waiting",
      ...(twin ? { twin: true as const } : {}),
      ...(phase.hole === undefined ? {} : { hole: phase.hole }),
    };
  });
  if (all.length <= WORKFLOW_RUN_RAIL_MAX_STATIONS) {
    return { stations: all, hidden: 0, implicit: false };
  }
  // The window anchors on the running phase; a run parked on a hole anchors there (dashed warning dot, not running).
  let anchor = all.findIndex(
    (station) => station.status === "running" || station.hole === "waiting",
  );
  if (anchor < 0) {
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (all[index]!.reached) {
        anchor = index;
        break;
      }
    }
  }
  if (anchor < 0) anchor = 0;
  const windowSize = RAIL_FOLD_RADIUS * 2 + 1;
  let start = Math.max(0, anchor - RAIL_FOLD_RADIUS);
  const end = Math.min(all.length, start + windowSize);
  start = Math.max(0, end - windowSize);
  const stations = all.slice(start, end);
  return { stations, hidden: all.length - stations.length, implicit: false };
}

/** Separator between parallel phases: simultaneously running stations sit side by side, not queued. */
export const WORKFLOW_RUN_PARALLEL_SEPARATOR = " ∥ ";

/**
 * Concurrently running phase names, joined into one tooltip segment. In parallel there is no single current phase --
 * none is more current -- so that segment lists every running phase.
 *
 * Returns `undefined` when one or zero stations are running: callers keep `currentPhase` untouched.
 */
export function workflowRunParallelPhaseLabel(
  phases: readonly SessionWorkflowPhaseSummary[],
): string | undefined {
  const running = phases.filter((phase) => phase.status === "running");
  return running.length > 1
    ? running.map((phase) => phase.name).join(WORKFLOW_RUN_PARALLEL_SEPARATOR)
    : undefined;
}

interface WorkflowRunLineSelection {
  lines: SessionWorkflowRunSummary[];
  /** Lines not drawn (the "+n" suffix). */
  overflow: number;
}

/**
 * Rows to draw: always the running ones; finished ones only while **unseen** (seen = the session was opened).
 * Input order is the projection's (running by start, then most-recently finished); here only filter+cap.
 */
export function selectWorkflowRunLines(
  activity: SessionWorkflowActivity | undefined,
  isAcknowledged: (runId: string) => boolean,
): WorkflowRunLineSelection {
  if (activity === undefined) return { lines: [], overflow: 0 };
  const visible = activity.runs.filter(
    (run) => isSessionWorkflowRunLive(run.status) || !isAcknowledged(run.runId),
  );
  return {
    lines: visible.slice(0, WORKFLOW_RUN_LINE_MAX_LINES),
    overflow: Math.max(0, visible.length - WORKFLOW_RUN_LINE_MAX_LINES),
  };
}

/** Settled (acknowledgable) run ids: acknowledged in bulk when the session opens. */
export function settledWorkflowRunIds(activity: SessionWorkflowActivity | undefined): string[] {
  if (activity === undefined) return [];
  return activity.runs
    .filter((run) => !isSessionWorkflowRunLive(run.status))
    .map((run) => run.runId);
}

/** Count of running runs (pulse dot and number next to a collapsed group header). */
export function countLiveWorkflowRuns(activity: SessionWorkflowActivity | undefined): number {
  if (activity === undefined) return 0;
  return activity.runs.filter((run) => isSessionWorkflowRunLive(run.status)).length;
}
