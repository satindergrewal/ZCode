import {
  type ZCodePersistedToolCall,
  type ZCodeSessionFile,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { buildPerTurnChangeSummaries } from "../session/taskChangeSummary.js";

const MS_IN_SECOND = 1_000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;
const MS_IN_DAY = 24 * MS_IN_HOUR;

export function taskStatus(task: ZCodeTaskMeta): string {
  return task.status ?? "running";
}

export function formatTaskRunningDuration(durationMs: number): string {
  const safeDurationMs = Math.max(durationMs, 0);
  const days = Math.floor(safeDurationMs / MS_IN_DAY);
  const hours = Math.floor((safeDurationMs % MS_IN_DAY) / MS_IN_HOUR);
  const minutes = Math.floor((safeDurationMs % MS_IN_HOUR) / MS_IN_MINUTE);
  const seconds = Math.floor((safeDurationMs % MS_IN_MINUTE) / MS_IN_SECOND);
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

function readRunningTaskStartedAt(
  snapshot: ZCodeSessionFile | null,
  task: ZCodeTaskMeta,
): number | null {
  const messages = snapshot?.messages ?? [];
  const assistantStartedAt = messages.findLast(
    (message) => message.role === "assistant",
  )?.timestamp;
  if (assistantStartedAt !== undefined) {
    return assistantStartedAt;
  }
  const userStartedAt = messages.findLast((message) => message.role === "user")?.timestamp;
  if (userStartedAt !== undefined) {
    return userStartedAt;
  }
  return task.createdAt ?? task.updatedAt ?? null;
}

export function formatStatusTaskLine(task: ZCodeTaskMeta, label = "Task"): string {
  return `${label}: ${task.title} (${task.taskId})`;
}

export function readTaskWorkedDurationMs(
  snapshot: ZCodeSessionFile | null,
  task: ZCodeTaskMeta,
): number | null {
  const status = taskStatus(task);
  if (status === "running") {
    const startedAt = readRunningTaskStartedAt(snapshot, task);
    if (startedAt === null) {
      return null;
    }
    // Bugfix: the third-party /status used to stuff runtime into the Task line; emit Worked separately, matching the UI's worked-time semantics.
    return Math.max(Date.now() - startedAt, 0);
  }
  const completedDurationMs = snapshot?.messages.findLast(
    (message) => message.role === "assistant",
  )?.durationMs;
  if (completedDurationMs !== undefined) {
    return completedDurationMs;
  }
  if (
    task.updatedAt !== undefined &&
    task.createdAt !== undefined &&
    task.updatedAt >= task.createdAt
  ) {
    return task.updatedAt - task.createdAt;
  }
  return null;
}

export function readLatestAssistantTurnChangeSummary(
  snapshot: ZCodeSessionFile | null,
): ZCodeTaskMeta["changeSummary"] | null {
  if (!snapshot?.fileChanges || snapshot.fileChanges.length === 0) {
    return null;
  }
  const latestAssistantTurnIndex = snapshot.messages.findLast(
    (message) => message.role === "assistant" && message.turnIndex !== undefined,
  )?.turnIndex;
  if (latestAssistantTurnIndex === undefined) {
    return null;
  }

  // Bugfix: meta.changeSummary is a task-level aggregate that merges earlier turns into the
  // third-party message; the completion reply must show only this turn's (turnIndex) file changes.
  const summary =
    buildPerTurnChangeSummaries(snapshot.fileChanges).get(latestAssistantTurnIndex) ?? null;
  return summary && summary.fileCount > 0 && summary.files.length > 0 ? summary : null;
}

export function normalizeStatusProgressText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncateStatusProgressText(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function truncateLiveStatusProgressText(value: string, maxLength = 1000): string {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function readStatusStringField(value: unknown, keys: readonly string[]): string | null {
  if (typeof value === "string") {
    const text = normalizeStatusProgressText(value);
    return text || null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const text = normalizeStatusProgressText(candidate);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function formatStatusToolProgress(tool: ZCodePersistedToolCall | undefined): string | null {
  if (!tool) {
    return null;
  }
  const title = normalizeStatusProgressText(tool.title ?? tool.toolName ?? tool.kind ?? "tool");
  const detail =
    readStatusStringField(tool.input, ["command", "path", "file_path", "filePath", "prompt"]) ??
    readStatusStringField(tool.output, ["command", "path", "file_path", "filePath", "prompt"]) ??
    readStatusStringField(tool.raw, ["command", "path", "file_path", "filePath", "prompt"]);
  const status = tool.status ? ` [${tool.status}]` : "";
  return detail ? `${title}${status}: ${detail}` : `${title}${status}`;
}

export function formatStatusStreamToolProgress(
  event: Extract<ZCodeStreamEvent, { type: "tool_call" | "tool_call_update" }>,
): string | null {
  const title = normalizeStatusProgressText(event.title ?? event.kind ?? "tool");
  const detail =
    readStatusStringField(event.input, ["command", "path", "file_path", "filePath", "prompt"]) ??
    ("content" in event
      ? readStatusStringField(event.content, ["command", "path", "file_path", "filePath", "prompt"])
      : null) ??
    readStatusStringField(event.raw, ["command", "path", "file_path", "filePath", "prompt"]);
  const status = "status" in event && event.status ? ` [${event.status}]` : "";
  return detail ? `${title}${status}: ${detail}` : `${title}${status}`;
}

export function readLatestTaskProgress(snapshot: ZCodeSessionFile | null): string | null {
  const messages = snapshot?.messages ?? [];
  for (const latestMessage of [...messages].reverse()) {
    if (latestMessage.role !== "assistant") {
      continue;
    }
    // Bugfix: /status Progress used to read the last message verbatim; when the last persisted
    // entry was the user prompt, third-party clients saw the question, not real progress. Read
    // content/thought/tool-calls only from the latest assistant message.
    for (const part of [...(latestMessage.parts ?? [])].reverse()) {
      if ((part.type === "content" || part.type === "thought") && part.content.trim()) {
        return truncateStatusProgressText(normalizeStatusProgressText(part.content));
      }
      if (part.type === "tool-call") {
        const toolProgress = formatStatusToolProgress(latestMessage.tools?.[part.toolIndex]);
        if (toolProgress) {
          return truncateStatusProgressText(toolProgress);
        }
      }
    }
    const text =
      readStatusStringField(latestMessage.content, []) ??
      readStatusStringField(latestMessage.thought, []) ??
      formatStatusToolProgress(latestMessage.tools?.at(-1));
    if (text) {
      return truncateStatusProgressText(text);
    }
  }
  return null;
}
