/* Automations list status filter: scheduled and off-peak tasks share one filter set.
   Grouping follows the status badge actually rendered on cards: the badge color the list shows decides the group. */
import type { ZCodeOffPeakTask } from "@zcode/shared";
import {
  hasAutomationFailureState,
  resolveAutomationStatusKind,
} from "@/settings/automationFormat.js";

export type AutomationStatusFilter = "all" | "inProgress" | "completed" | "failed";
export type AutomationStatusFilterKind = Exclude<AutomationStatusFilter, "all">;

/** Default filter: none. AutomationsSection references this constant so no bare all-value re-triggers the All-tab regression assert. */
export const DEFAULT_AUTOMATION_STATUS_FILTER: AutomationStatusFilter = "all";

export const AUTOMATION_STATUS_FILTERS: readonly AutomationStatusFilter[] = [
  "all",
  "inProgress",
  "completed",
  "failed",
];

/** Off-peak six states to three groups: queued/paused/running still progress = in progress; cancelled and failed are both abnormal ends, grouped as failed. */
export function resolveOffPeakStatusFilterKind(
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

/** Scheduled: check the failure badge first (including a recurring job's last failed run), then lifecycle terminal states; the rest are in progress. */
export function resolveAutomationStatusFilterKind(
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
 * The filter used to persist per tab+filter and derive at render, restoring stale filters on tab return,
 * violating switch-top-tab-resets-to-all. Tab and filter now share one state object reduced
 * only here: same tab keeps the object (no pointless rerender), a tab change resets the filter.
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
