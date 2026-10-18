import type { FeedbackTicketStatus } from "@zcode/shared";

type MessageFormatter = (descriptor: { id: string }, values?: Record<string, string>) => string;

interface StatusMeta {
  className: string;
  dot: string;
}

export const STATUS_META: Record<FeedbackTicketStatus, StatusMeta> = {
  已提交: {
    className: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  信息不足: {
    className: "text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  已采纳: {
    className: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  答复关闭: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  // The public feedback API normalizes legacy "closed by reply" into the archived value.
  // The client must recognize both terminal states or the my-feedback list crashes on a missing
  // status meta.
  已归档: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已拒绝: {
    className: "text-foreground-subtle",
    dot: "bg-foreground-subtlest",
  },
  开发中: {
    className: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  已解决: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已上线: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

const FEEDBACK_STATUS_MESSAGE_IDS: Record<FeedbackTicketStatus, string> = {
  已提交: "feedback.status.pendingReview",
  信息不足: "feedback.status.needInfo",
  已采纳: "feedback.status.accepted",
  答复关闭: "feedback.status.closedByReply",
  // The backend's closed value normalizes to the archived compatibility value, but the internal
  // API name must not leak to users. Map it to the completed copy so the my-feedback list and
  // detail both show "completed".
  已归档: "feedback.status.completed",
  已拒绝: "feedback.status.rejected",
  开发中: "feedback.status.inDevelopment",
  已解决: "feedback.status.resolved",
  已上线: "feedback.status.released",
};

export function formatFeedbackStatusLabel(
  status: FeedbackTicketStatus,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: FEEDBACK_STATUS_MESSAGE_IDS[status] });
}
