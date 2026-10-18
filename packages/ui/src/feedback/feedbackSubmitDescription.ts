import { redactFeedbackText } from "@zcode/shared";
import type { FeedbackAgentModelContext } from "@/feedback/feedbackSubmitModelContext.js";
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@zcode/shared";

const TITLE_MAX = 80;
const FEEDBACK_ZCODE_AGENT_LABEL = "ZCode Agent";

type MessageFormatter = (descriptor: { id: string }, values?: Record<string, string>) => string;

export function buildFeedbackTitle(description: string, formatMessage: MessageFormatter): string {
  const normalized =
    description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? description.replace(/\s+/g, " ").trim();
  return normalized.slice(0, TITLE_MAX) || formatMessage({ id: "feedback.title.fallback" });
}

export function buildDeveloperFacingDescription({
  raw,
  modelContext,
  ticketType = "bug",
  ticketModule = "其它",
  ticketSeverity = "P2-中",
  formatMessage,
}: {
  raw: string;
  modelContext: FeedbackAgentModelContext;
  ticketType?: FeedbackTicketType;
  ticketModule?: FeedbackTicketModule;
  ticketSeverity?: FeedbackTicketSeverity;
  formatMessage: MessageFormatter;
}): string {
  const notReported = formatMessage({ id: "feedback.submit.notReported" });
  return [
    "Original feedback",
    "",
    `Feedback type: ${ticketType}`,
    `Product module: ${ticketModule}`,
    `Severity: ${ticketSeverity}`,
    "Agent framework: zcode-agent",
    `Current agent: ${FEEDBACK_ZCODE_AGENT_LABEL}`,
    `Current model: ${redactFeedbackText(modelContext.display || modelContext.model || notReported)}`,
    "Handling: user submits a light form, the client attaches context, the backend may run AI analysis async",
    "",
    "User's original description",
    raw.trim(),
  ].join("\n");
}
