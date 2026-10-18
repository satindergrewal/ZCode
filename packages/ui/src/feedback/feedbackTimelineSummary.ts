import type { FeedbackTicketEvent, FeedbackTicketStatus } from "@zcode/shared";
import { FEEDBACK_STATUS_MESSAGE_IDS, formatFeedbackStatusLabel } from "@/feedback/feedbackMeta.js";

type MessageFormatter = (descriptor: { id: string }, values?: Record<string, string>) => string;

export function getUserFacingEventSummary(
  event: FeedbackTicketEvent,
  formatMessage?: MessageFormatter,
) {
  const normalizedSummary = event.summary.trim();
  // Bugfix: backend event summaries persist as zh and would show verbatim after a locale switch.
  // Translate known system summaries only; handwritten user/staff content stays untouched.
  const knownSummary = formatKnownSystemEventSummary(normalizedSummary, formatMessage);
  if (knownSummary) {
    return knownSummary;
  }
  // Bugfix: the user view exposes only the PM/dev roles, never concrete engineer names.
  if (event.type === "assignee_changed" && /^已交由 .+ 跟进$/.test(normalizedSummary)) {
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.assignedToDev",
      "已交由研发跟进",
    );
  }
  return event.summary;
}

function formatKnownSystemEventSummary(summary: string, formatMessage?: MessageFormatter) {
  const directMessageId = getKnownSystemSummaryMessageId(summary);
  if (directMessageId) {
    return formatOptionalMessage(formatMessage, directMessageId, summary);
  }

  const statusChanged = summary.match(/^状态更新为「(.+)」$/);
  if (statusChanged) {
    const status = toKnownFeedbackStatus(statusChanged[1]);
    if (!status) return summary;
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.event.statusChanged",
      `状态更新为「${status}」`,
      { status: formatStatusLabel(status, formatMessage) },
    );
  }

  const agentSubmitted = summary.match(/^(.+) 通过 Agent 提交反馈$/);
  if (agentSubmitted) {
    const name = agentSubmitted[1] ?? "";
    return formatOptionalMessage(formatMessage, "feedback.timeline.event.agentSubmitted", summary, {
      name,
    });
  }

  const progressWithStatus = summary.match(/^进度更新（状态→(.+)）：(.+)$/);
  if (progressWithStatus) {
    const status = toKnownFeedbackStatus(progressWithStatus[1]);
    const message = progressWithStatus[2] ?? "";
    if (!status) return formatProgressWithMessage(message, formatMessage);
    return formatOptionalMessage(
      formatMessage,
      "feedback.timeline.event.progressUpdatedWithStatus",
      summary,
      { status: formatStatusLabel(status, formatMessage), message },
    );
  }

  const progressWithMessage = summary.match(/^进度更新：(.+)$/);
  if (progressWithMessage) {
    return formatProgressWithMessage(progressWithMessage[1] ?? "", formatMessage);
  }

  const markedStatus = summary.match(/^标记为「(.+)」：(.+)$/);
  if (markedStatus) {
    const status = toKnownFeedbackStatus(markedStatus[1]);
    const message = markedStatus[2] ?? "";
    if (!status) return summary;
    return formatOptionalMessage(formatMessage, "feedback.timeline.event.markedStatus", summary, {
      status: formatStatusLabel(status, formatMessage),
      message,
    });
  }

  return null;
}

function getKnownSystemSummaryMessageId(summary: string) {
  switch (summary) {
    case "反馈已提交":
      return "feedback.timeline.event.submitted";
    case "你补充了信息":
      return "feedback.timeline.yourSupplement";
    case "官方回复":
      return "feedback.timeline.officialReply";
    case "处理进度更新":
      return "feedback.timeline.event.progressUpdated";
    case "处理结论":
      return "feedback.timeline.event.conclusion";
    case "完整日志已上传，反馈进入待评估":
    case "完整日志已上传，反馈进入已提交":
      return "feedback.timeline.event.fullLogUploaded";
    default:
      return null;
  }
}

function formatProgressWithMessage(message: string, formatMessage?: MessageFormatter) {
  return formatOptionalMessage(
    formatMessage,
    "feedback.timeline.event.progressUpdatedWithMessage",
    `进度更新：${message}`,
    { message },
  );
}

function toKnownFeedbackStatus(value: string | undefined): FeedbackTicketStatus | null {
  if (!value) return null;
  return value in FEEDBACK_STATUS_MESSAGE_IDS ? (value as FeedbackTicketStatus) : null;
}

function formatStatusLabel(status: FeedbackTicketStatus, formatMessage?: MessageFormatter) {
  if (!formatMessage) return status;
  return formatFeedbackStatusLabel(status, formatMessage);
}

function formatOptionalMessage(
  formatMessage: MessageFormatter | undefined,
  id: string,
  fallback: string,
  values?: Record<string, string>,
) {
  return formatMessage ? formatMessage({ id }, values) : fallback;
}
