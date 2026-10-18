import type { ModelUsage } from "@zcode/contracts";
import { formatTaskNotification } from "../runtime-task/notification.js";

type LocalAgentTaskNotificationStatus = "completed" | "failed" | "stopped";

interface LocalAgentTaskNotificationInput {
  agentId: string;
  agentType: string;
  description: string;
  error?: string;
  outputFile: string;
  parentToolCallId: string;
  result?: string;
  status: LocalAgentTaskNotificationStatus;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: ModelUsage;
}

export function formatLocalAgentTaskNotification(input: LocalAgentTaskNotificationInput): string {
  return formatTaskNotification({
    agentId: input.agentId,
    description: input.description,
    error: input.error,
    outputFile: input.outputFile,
    result: input.result,
    status: input.status,
    subagentType: input.agentType,
    summary: formatLocalAgentNotificationSummary(input),
    taskId: input.agentId,
    taskType: "local_agent",
    toolUseId: input.parentToolCallId,
    usage: {
      durationMs: input.totalDurationMs,
      modelUsage: input.usage,
      toolUseCount: input.totalToolUseCount,
      totalTokens: input.totalTokens,
    },
  });
}

function formatLocalAgentNotificationSummary(
  input: Pick<LocalAgentTaskNotificationInput, "agentType" | "description" | "error" | "status">,
): string {
  const summary = `Agent ${input.agentType} task "${input.description}" ${input.status}.`;
  const error = input.status === "failed" && input.error?.trim() ? input.error : undefined;
  // The failure summary feeds the Agent card's "subagent output" section; keep the original prefix and
  // append the same failure reason as <error>; completed/stopped copy stays unchanged.
  return error ? `${summary} ${error}` : summary;
}
