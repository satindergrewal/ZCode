import type { FeedbackTicketStatus } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Simplified ticket flow (user view):
 *   submitted -> evaluating -> in progress -> closed (zh backend values, see the stage map).
 * Rejected is a separate terminal state, drawn as its own grey-red end node.
 */
type Stage = "submitted" | "reviewing" | "in_progress" | "done";

const STAGES: { key: Stage; label: string }[] = [
  { key: "submitted", label: "feedback.progress.stage.submitted" },
  { key: "reviewing", label: "feedback.progress.stage.reviewing" },
  { key: "in_progress", label: "feedback.progress.stage.inProgress" },
  { key: "done", label: "feedback.progress.stage.done" },
];

function statusToStage(status: FeedbackTicketStatus): {
  current: Stage;
  rejected: boolean;
} {
  switch (status) {
    case "已提交":
      return { current: "submitted", rejected: false };
    case "信息不足":
      return { current: "reviewing", rejected: false };
    case "已采纳":
    case "开发中":
    case "已解决":
      return { current: "in_progress", rejected: false };
    case "已上线":
    case "答复关闭":
    case "已归档":
      return { current: "done", rejected: false };
    case "已拒绝":
      return { current: "done", rejected: true };
    default:
      return { current: "submitted", rejected: false };
  }
}

export function FeedbackProgress({
  status,
  assigneeDisplay,
}: {
  status: FeedbackTicketStatus;
  assigneeDisplay?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const { current, rejected } = statusToStage(status);
  const currentIdx = STAGES.findIndex((item) => item.key === current);
  // Bugfix: hide engineer names from users; the backend keeps real assignees for admin views.
  const assigneeLabel = assigneeDisplay
    ? formatMessage({ id: "feedback.progress.assignee.dev" })
    : formatMessage({ id: "feedback.progress.assignee.unassigned" });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
        <span className="font-medium">{formatMessage({ id: "feedback.progress.title" })}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-foreground-subtle">
          <span>{formatMessage({ id: "feedback.progress.currentHandler" })}</span>
          <span className="font-medium text-foreground">{assigneeLabel}</span>
        </span>
      </div>
      <ol className="grid grid-cols-4 gap-2">
        {STAGES.map((stage, idx) => {
          const reached = idx <= currentIdx;
          const isCurrent = idx === currentIdx && !rejected;
          const isRejected = rejected && idx === currentIdx;
          return (
            <li key={stage.key} className="flex flex-col gap-1.5">
              <span
                className={cn(
                  "h-1.5 w-full rounded-full transition-colors",
                  isRejected
                    ? "bg-destructive/70"
                    : reached
                      ? isCurrent
                        ? "bg-primary"
                        : "bg-primary/65"
                      : "bg-border",
                )}
              />
              <span
                className={cn(
                  "text-ui-xs leading-tight",
                  isRejected
                    ? "text-destructive"
                    : isCurrent
                      ? "font-medium text-primary"
                      : reached
                        ? "text-foreground"
                        : "text-foreground-subtle",
                )}
              >
                {isRejected && stage.key === "done"
                  ? formatMessage({ id: "feedback.progress.stage.closed" })
                  : formatMessage({ id: stage.label })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
