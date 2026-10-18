// The workflow run's mini rail (docs/dynamic-workflow/presentation.md The sidebar run line): 6px lamps in
// declaration order joined by 6x1px segments. Walked segments use the strong color, parallel sites get a
// double-line segment; past six sites it folds to running+-1 with a +n tail. Shared by the sidebar run line and
// the task-island run row: one run, one face in both places.
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunRail as WorkflowRunRailModel } from "@/lib/workflowRunLine.js";

export interface WorkflowRunRailIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

const TRACE_FAINT = "var(--color-workflow-trace)";
const TRACE_STRONG = "var(--color-workflow-trace-strong)";

export function WorkflowRunRail({
  rail,
  intl,
}: {
  rail: WorkflowRunRailModel;
  intl: WorkflowRunRailIntl;
}) {
  if (rail.implicit) {
    return (
      <span
        data-workflow-run-rail="true"
        data-implicit="true"
        className="flex shrink-0 items-center"
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
      </span>
    );
  }
  return (
    <span data-workflow-run-rail="true" className="flex shrink-0 items-center">
      {rail.stations.map((station, index) => (
        <span key={`${station.name}:${index}`} className="flex items-center">
          {index > 0 ? (
            station.twin === true ? (
              // Double-line segment: this site runs parallel to the previous one, control flow did not walk there
              // to here. Two 1px lines 2px apart (4px container, one at each edge); width and ink rules identical
              // to plain segments.
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                data-rail-twin="true"
                className="flex h-1 w-1.5 flex-col justify-between"
              >
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                className="h-px w-1.5"
                style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
              />
            )
          ) : null}
          {station.hole === undefined ? (
            <span
              aria-hidden="true"
              data-rail-station={station.status}
              title={station.name}
              className={cn("size-1.5 rounded-full", STATUS_DOT[station.status])}
            />
          ) : (
            // Hole (docs/dynamic-workflow/presentation.md Holes on the timeline, The sidebar): dashed 6px lamp,
            // warning color while waiting. Once filled it is a plain site and this branch is gone.
            <span
              aria-hidden="true"
              data-rail-station={station.status}
              data-rail-hole={station.hole}
              title={station.name}
              className={cn(
                "size-1.5 rounded-full border border-dashed bg-transparent",
                station.hole === "waiting" ? "border-warning" : "border-foreground-subtlest",
              )}
            />
          )}
        </span>
      ))}
      {rail.hidden > 0 ? (
        <span className="ml-1 text-ui-xs leading-none text-foreground-subtlest">
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreStations" },
            { count: String(rail.hidden) },
          )}
        </span>
      ) : null}
    </span>
  );
}
