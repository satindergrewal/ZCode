import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { OffPeakTakeNumberAvailabilityStatus } from "@/store/offPeakTaskStore.js";

export type OffPeakCreateBlockReason = "plan" | "quota" | "unavailable";

/** Idle-create disabled reasons are long-form; the generic short tooltip's single line will not do. */
export const OFF_PEAK_CREATE_TOOLTIP_CLASSNAME =
  "max-w-[220px] [&>span]:break-words [&>span]:whitespace-normal [&>span]:text-wrap-pretty";

/** Creation admits only a server-confirmed number; every other eligibility/dependency state is fail-closed. */
export function resolveOffPeakCreateBlockReason({
  availabilityStatus,
  canTakeNumber,
  grayEnabled,
  noPlan,
}: {
  availabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  canTakeNumber: boolean | undefined;
  grayEnabled: boolean;
  noPlan: boolean;
}): OffPeakCreateBlockReason | null {
  if (!grayEnabled) return null;
  if (availabilityStatus === "loading" || availabilityStatus === "error") {
    return "unavailable";
  }
  if (noPlan) return "plan";
  if (availabilityStatus !== "ready") return "unavailable";
  return canTakeNumber === true ? null : "quota";
}

/** Turn the server's absolute resume point into a localized remaining time, hours/minutes only. */
export function formatOffPeakRemainingWait(
  nextTakeAt: number,
  now: number,
  intl: IntlInstance,
): string {
  const remainingMs = nextTakeAt - now;
  if (remainingMs <= 0) {
    return intl.formatMessage({
      id: "offPeak.create.remaining.lessThanMinute",
    });
  }

  // The old tooltip showed a full date: too long, and users did the waiting math themselves.
  // Ceiling to the minute, so dozens of seconds left never display 0 minutes nor understate the resume point.
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hoursMinutes" }, { hours, minutes });
  }
  if (hours > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hours" }, { hours });
  }
  return intl.formatMessage({ id: "offPeak.create.remaining.minutes" }, { minutes });
}

export type OffPeakStatusIconKind =
  | "moon"
  | "pause"
  | "spinner"
  | "success"
  | "warning"
  | "stopped";

interface OffPeakStatusFooterPresentation {
  icon: OffPeakStatusIconKind;
  className: string;
  labelId: string;
  labelValues?: Record<string, string>;
}

/**
 * Syncs only create-state titles still on the auto default.
 * A locale switch must never overwrite user input, template drafts or saved titles.
 */
export function resolveLocalizedOffPeakCreateTitle({
  currentTitle,
  hasInitialTitle,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialTitle: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialTitle || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}

/** The single map for idle card status icon + copy, so a paused-with-rank never draws as the queued moon. */
export function resolveOffPeakStatusFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation {
  switch (task.status) {
    case "queued":
      return task.queuePosition
        ? {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.badge.queuePosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.status.queued",
          };
    case "paused":
      return task.queuePosition
        ? {
            icon: "pause",
            // Paused and Queued both need attention while waiting; the design gives both the same muted brand pill.
            className: "text-idle-task",
            labelId: "offPeak.badge.pausedPosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "pause",
            className: "text-idle-task",
            labelId: "offPeak.status.paused",
          };
    case "running":
      return {
        icon: "spinner",
        className: "text-success",
        labelId: "offPeak.status.running",
      };
    case "completed":
      return {
        icon: "success",
        // Completed is a terminal state needing no attention; success highlight would out-shout active tasks.
        className: "text-foreground-subtle",
        labelId: "offPeak.status.completed",
      };
    case "failed":
      return {
        icon: "warning",
        className: "text-destructive",
        labelId: "offPeak.status.failed",
      };
    case "cancelled":
      return {
        icon: "stopped",
        className: "text-foreground-subtle",
        labelId: "offPeak.status.cancelled",
      };
  }
}

/** Terminal tasks never schedule again; a dead historic choice is not a current to-fix error. */
export function shouldShowOffPeakModelSelectionIssue(
  status: Pick<ZCodeOffPeakTask, "status">["status"],
): boolean {
  return status === "queued" || status === "paused" || status === "running";
}

/**
 * While a failed task keeps its server queue rank, render the rank dimmed on its own.
 * The status map yields one footer; failure must keep queue context too, not be covered by Failure.
 */
export function resolveFailedOffPeakQueueFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation | null {
  if (task.status !== "failed" || task.queuePosition === undefined) return null;
  return {
    icon: "moon",
    className: "text-idle-task",
    labelId: "offPeak.badge.queuePosition",
    labelValues: { position: String(task.queuePosition) },
  };
}
