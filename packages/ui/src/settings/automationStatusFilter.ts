/* Automations list status filter: one filter set shared by scheduled and idle tasks.
   Grouping follows the status badge actually shown on cards: the color the user sees decides the group. */
import type { ZCodeOffPeakTask } from "@zcode/shared";
import {
  hasAutomationFailureState,
  resolveAutomationStatusKind,
} from "@/settings/automationFormat.js";

export type AutomationStatusFilter = "all" | "inProgress" | "completed" | "failed";
type AutomationStatusFilterKind = Exclude<AutomationStatusFilter, "all">;

/** Default filter: none. Referenced via this constant so no bare all in source re-triggers All-tab assertions. */
export const DEFAULT_AUTOMATION_STATUS_FILTER: AutomationStatusFilter = "all";

export const AUTOMATION_STATUS_FILTERS: readonly AutomationStatusFilter[] = [
  "all",
  "inProgress",
  "completed",
  "failed",
];

/** Idle six-states to three groups: queued/paused/running still advance = running; cancelled and failed are both abnormal endings, into failed. */
function resolveOffPeakStatusFilterKind(
  task: Pick<ZCodeOffPeakTask, "status">,
): AutomationStatusFilterKind {
  switch (task.status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "inProgress";
  }
}

type AutomationFilterLike = Parameters<typeof resolveAutomationStatusKind>[0] &
  Parameters<typeof hasAutomationFailureState>[0];

/** Scheduled: failed badge first (incl. a loop's last run), then terminal lifecycle, else running. */
function resolveAutomationStatusFilterKind(
  automation: AutomationFilterLike,
): AutomationStatusFilterKind {
  if (hasAutomationFailureState(automation)) return "failed";
  return resolveAutomationStatusKind(automation) === "completed" ? "completed" : "inProgress";
}

export function filterOffPeakTasksByStatus<T extends Pick<ZCodeOffPeakTask, "status">>(
  tasks: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return tasks;
  return tasks.filter((task) => resolveOffPeakStatusFilterKind(task) === filter);
}

export function filterAutomationsByStatus<T extends AutomationFilterLike>(
  automations: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return automations;
  return automations.filter(
    (automation) => resolveAutomationStatusFilterKind(automation) === filter,
  );
}

/**
 * The filter once lived as {tab, filter} derived at render, restoring stale filters on tab return,
 * violating any-tab-change-resets-filter. Tab and filter now share one state object reduced
 * through this fn: same tab keeps the object (no pointless re-render), a tab change resets the filter.
 */
export interface AutomationTabState<Tab extends string> {
  tab: Tab;
  filter: AutomationStatusFilter;
}

export function resolveAutomationTabState<Tab extends string>(
  previous: AutomationTabState<Tab>,
  nextTab: Tab,
): AutomationTabState<Tab> {
  if (nextTab === previous.tab) return previous;
  return { tab: nextTab, filter: DEFAULT_AUTOMATION_STATUS_FILTER };
}
