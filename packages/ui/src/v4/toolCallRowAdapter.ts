// Adapts v4 ToolCallRows into the legacy ToolCallBlocks input shape
// (TaskChatToolCallTreeNode). Pure functions: ToolCallBlock and its renderers
// (execute/read/edit/...) consume the old ZCode Agent TaskChatToolCall shape; v4 rows are
// self-contained, so a field-by-field mapping suffices - never consult sibling rows.
import { buildZCodeStreamingToolInputPreview } from "@zcode/shared";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { normalizeWrappedErrorText } from "@/lib/toolError.js";

// v4 status -> legacy ChatToolCall.status (the mapToolStatus input vocabulary:
// pending/in_progress/completed/failed/stopped).
// pendingApproval counts as pending: input is fixed during approval, shown as awaiting-run.
const STATUS_MAP: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

interface ResolvedToolInputPreview {
  input: unknown;
  inputPreviewComplete?: boolean;
  streamingRawInputLength?: number;
}

function isEmptyPlainRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** When input is absent, rebuild the full or streaming-truncated tool-argument preview from v4 inputText. */
function resolveToolInputPreview(row: ToolCallRow): ResolvedToolInputPreview {
  if (row.input !== undefined) {
    return {
      input: row.input,
      inputPreviewComplete: true,
      ...(row.inputText.length > 0 ? { streamingRawInputLength: row.inputText.length } : {}),
    };
  }
  if (!row.inputText) {
    return { input: undefined };
  }
  const preview = buildZCodeStreamingToolInputPreview(row.inputText);
  return {
    input: isEmptyPlainRecord(preview.input) ? undefined : preview.input,
    inputPreviewComplete: preview.complete,
    streamingRawInputLength: row.inputText.length,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveV4ToolErrorText(row: ToolCallRow): string | undefined {
  if (row.status !== "error") {
    return undefined;
  }

  const directMessage = readNonEmptyString(row.error?.message);
  if (directMessage) {
    return directMessage;
  }

  const outputText = readNonEmptyString(row.output?.text);
  if (outputText) {
    return normalizeWrappedErrorText(outputText);
  }

  return readNonEmptyString(row.error?.code);
}

export function toolCallRowToLegacyNode(row: ToolCallRow): TaskChatToolCallTreeNode {
  const legacyStatus = STATUS_MAP[row.status];
  const errorText = resolveV4ToolErrorText(row);
  const inputPreview = resolveToolInputPreview(row);
  // Structured display facts such as CUA live in output.display; top-level display is just the
  // legacy Node REPL image channel. Read canonical output first, keeping compat paths for old
  // snapshots and Browser turn-end screenshots.
  const display = row.output?.display ?? row.display;
  // Legacy CUA v1 display duplicated the input; the tool row already owns the single input, so the bridge drops the stale copy.
  const legacyDisplay =
    display?.kind === "cua" ? (({ input: _legacyInput, ...rest }) => rest)(display) : display;
  return {
    toolCall: {
      toolId: row.toolCallId,
      toolName: row.toolName,
      // kind follows the legacy grouping classes: with no legacy snapshot shape in v4, use the fixed tool names.
      kind: row.toolName,
      input: inputPreview.input,
      status: legacyStatus,
      output: row.output?.text,
      // A v4 ToolCallRow has no legacy taskNotification raw; a background Agent's terminal
      // summary lands in output only. The Agent renderer reads content to show live results, so
      // Agent/Task rows bridge explicitly - otherwise failure details project while the card
      // stays empty.
      ...((row.toolName === "Agent" || row.toolName === "Task") && row.output?.text
        ? { content: row.output.text }
        : {}),
      // A v4 row is a self-contained projection; some providers put the failure text only in
      // output. Without backfilling legacy error, ToolOutput never sees the reason - just an
      // empty failed summary.
      error: errorText,
      raw: {
        error: row.error,
        rawOutput: row.output?.text,
        outputPreview: row.outputPreview,
        outputTruncated: row.output?.truncated,
        status: legacyStatus,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        v4Status: row.status,
        ...(row.cuaApp ? { cuaApp: row.cuaApp } : {}),
        ...(legacyDisplay ? { display: legacyDisplay } : {}),
        // R7：运行中进度（MCP notifications/progress）供 McpToolCallBlock 头部进度条消费。
        ...(row.progress ? { progress: row.progress } : {}),
        inputPreviewComplete: inputPreview.inputPreviewComplete,
        streamingRawInputLength: inputPreview.streamingRawInputLength,
      },
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
    },
    // Subagents never embed child rows: v4 tool rows have no subtree, and nested tools were
    // separate rows (subagent/toolCall) in the legacy shape too.
    childToolCalls: [],
  };
}
