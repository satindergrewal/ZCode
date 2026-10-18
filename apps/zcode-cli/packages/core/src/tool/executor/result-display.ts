import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RespondToCoordinatorOutputSchema,
  MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS,
  MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  CUA_TARGET_APP_DISPLAY_META_KEY,
  cuaTargetAppDisplaySchema,
  nodeReplCuaAppDisplaySchema,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageOutputSchema,
  TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS,
  TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputResultSchema,
  TASK_STOP_TOOL_NAME,
  TaskStopOutputSchema,
  type DiffHunk,
  type NodeReplCuaAppDisplay,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import { createBashResultDisplay } from "./bash-result-display.js";
import { countPatchLines } from "../diff.js";
import { boundDisplayText } from "./display-text.js";
import { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { createWorkflowObservationDisplay } from "./workflow-observation-display.js";

// Kept the export surface after the split to create-workflow-display.ts (handlers/create-workflow.ts still imports here).
export { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { isRecord } from "./utils.js";
import { parseOfficialMcpToolError, type OfficialMcpToolErrorCode } from "@zcode/shared";
import {
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_WIDGET_META_MAX_BYTES,
  type McpToolDisplayUi,
  type McpToolUiDescriptor,
} from "@zcode/shared/mcp-apps";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "@zcode/zcode-cua/request-access-contract";

const MAX_DISPLAY_DIFF_HUNKS = 8;
const MAX_DISPLAY_DIFF_LINES = 160;
const MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES = 4 * 1024;
const MAX_TASK_STOP_DISPLAY_FIELD_BYTES = 16 * 1024;
export const MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = 200 * 1024;
const MAX_NODE_REPL_DISPLAY_IMAGES = 2;

export interface McpToolDisplayMetadata {
  serverName: string;
  toolName: string;
  description?: string;
  official?: boolean;
  pluginId?: string;
  ui?: McpToolUiDescriptor;
}

export function createMcpToolDisplay(
  metadata: McpToolDisplayMetadata | undefined,
  output?: unknown,
): ToolResultDisplayPayload | undefined {
  if (!metadata) return undefined;
  const serverName = boundMcpDisplayText(metadata.serverName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  const toolName = boundMcpDisplayText(metadata.toolName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  if (!serverName || !toolName) return undefined;
  const description = metadata.description
    ? boundMcpDisplayText(metadata.description, MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS)
    : undefined;
  const unavailable = metadata.official ? readOfficialMcpUnavailable(output) : undefined;
  const ui = createMcpToolDisplayUi(metadata, output);
  return {
    kind: "mcp_tool",
    serverName,
    toolName,
    ...(description ? { description } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(ui ? { ui } : {}),
  };
}

/**
 * MCP App metadata projection. Any MCP server tool declaring a ui resource has it (ownership by serverName);
 * pluginId is display/keying only, substituted by serverName for non-plugin servers. structuredContent / _meta enter persisted metadata as JSON text,
 * truncated over the limit with truncated set; the UI hints "structured result truncated" from it.
 */
function createMcpToolDisplayUi(
  metadata: McpToolDisplayMetadata,
  output: unknown,
): McpToolDisplayUi | undefined {
  if (!metadata.ui) return undefined;
  const pluginId = boundMcpDisplayText(
    metadata.pluginId ?? metadata.serverName,
    MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  );
  if (!pluginId) return undefined;
  const record = isRecord(output) ? output : undefined;
  // All three JSON fields cap at UTF-8 bytes; over the limit omit the field entirely (no half JSON) and record truncatedBytes.
  const structured = boundJsonText(
    record?.structuredContent,
    MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  );
  const meta = boundJsonText(record?._meta, MCP_APPS_WIDGET_META_MAX_BYTES);
  const content = boundJsonText(
    Array.isArray(record?.content) ? record.content : undefined,
    MCP_APPS_CONTENT_MAX_BYTES,
  );
  const dropped = [structured, meta, content].filter(
    (item): item is { truncated: true; bytes: number } => item?.truncated === true,
  );
  const truncatedBytes = dropped.reduce((sum, item) => sum + item.bytes, 0);
  return {
    pluginId,
    resourceUri: metadata.ui.resourceUri,
    ...(metadata.ui.preferredDisplayMode
      ? { preferredDisplayMode: metadata.ui.preferredDisplayMode }
      : {}),
    ...(metadata.ui.prefersBorder !== undefined
      ? { prefersBorder: metadata.ui.prefersBorder }
      : {}),
    ...(metadata.ui.csp ? { csp: metadata.ui.csp } : {}),
    ...(structured && !structured.truncated ? { structuredContent: structured.text } : {}),
    ...(meta && !meta.truncated ? { widgetMeta: meta.text } : {}),
    ...(content && !content.truncated ? { content: content.text } : {}),
    ...(dropped.length > 0 ? { truncated: true, truncatedBytes } : {}),
    // H06: an isError MCP call is still success on the v4 row (the model sees completion); the page and panel distinguish via this field.
    ...(record?.isError === true ? { isError: true as const } : {}),
    ...(metadata.ui.surface ? { surface: metadata.ui.surface } : {}),
    // 4b-1: project true only; false/absent occupy no field.
    ...(metadata.ui.showInline === true ? { showInline: true as const } : {}),
  };
}

/** JSON text capped by UTF-8 bytes: at or under the limit return the text, over it return only the byte count (never a truncated string). */
function boundJsonText(
  value: unknown,
  maxBytes: number,
): { text: string; truncated: false } | { truncated: true; bytes: number } | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof text !== "string") return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  return { truncated: true, bytes };
}

/**
 * When the official Server MCP is out of quota / has no Coding Plan it renders a structured identifier into the
 * tool error content JSON (server-side `ToolError.Error()`). Read only that identifier; do not parse generic error copy.
 *
 * Only reached when `metadata.official` is true, and that flag is set only for **http** official MCP -- responses of
 * that shape come from the ZCode backend with verified origin. stdio official MCP and third-party MCP sending the
 * same payload are ignored: their output is produced by the plugin process itself and could fake a purchase prompt.
 */
function readOfficialMcpUnavailable(
  output: unknown,
): { code: OfficialMcpToolErrorCode } | undefined {
  if (!isRecord(output) || output.isError !== true || !Array.isArray(output.content)) {
    return undefined;
  }
  for (const block of output.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const parsed = parseOfficialMcpToolError(block.text);
    if (parsed) return { code: parsed.code };
  }
  return undefined;
}

export function createToolResultDisplay(
  toolName: string,
  output: unknown,
  options?: {
    officialCua?: boolean;
    mcp?: McpToolDisplayMetadata;
  },
): ToolResultDisplayPayload | undefined {
  if (toolName === "Bash") return createBashResultDisplay(output);

  const cuaToolName = readCuaToolName(toolName);
  if (cuaToolName) {
    return createCuaToolResultDisplay(cuaToolName, output, options?.officialCua === true);
  }

  const nodeReplDisplay = createNodeReplDisplay(toolName, output);
  if (nodeReplDisplay) return nodeReplDisplay;

  const createWorkflow = createCreateWorkflowDisplay(toolName, output);
  if (createWorkflow) return createWorkflow;

  const workflowObservation = createWorkflowObservationDisplay(toolName, output);
  if (workflowObservation) return workflowObservation;

  if (options?.mcp) {
    // Result-level builder: an official MCP unavailable marker is readable only from this result, so pass output along.
    return createMcpToolDisplay(options.mcp, output);
  }

  if (toolName === SEND_MESSAGE_TOOL_NAME) {
    const parsed = SendMessageOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    // Display bypasses the tool-result budget; bound it separately before entering live events and persisted metadata.
    const error =
      parsed.data.error === undefined
        ? undefined
        : boundDisplayText(parsed.data.error, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    const message =
      parsed.data.message === undefined
        ? undefined
        : boundDisplayText(parsed.data.message, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    return {
      kind: "local_agent_message",
      status: parsed.data.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  if (toolName === TASK_STOP_TOOL_NAME) {
    const parsed = TaskStopOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const command =
      parsed.data.command === undefined
        ? undefined
        : boundDisplayText(parsed.data.command, MAX_TASK_STOP_DISPLAY_FIELD_BYTES);
    const message = boundDisplayText(
      compactTaskStopDisplayMessage(parsed.data),
      MAX_TASK_STOP_DISPLAY_FIELD_BYTES,
    );
    const truncated = command?.truncated === true || message.truncated;
    return {
      kind: "task_stop",
      taskId: parsed.data.task_id,
      taskType: parsed.data.task_type,
      ...(command !== undefined ? { command: command.value } : {}),
      message: message.value,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === TASK_OUTPUT_TOOL_NAME) {
    const parsed = TaskOutputResultSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const taskStatus = parsed.data.task?.status
      .trim()
      .slice(0, TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS);
    const fullOutput = parsed.data.task?.output.trimEnd();
    const hasOutput = fullOutput !== undefined && fullOutput.trim().length > 0;
    const truncated = hasOutput && fullOutput.length > TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS;

    // UI display is a bounded projection independent of provider content; never stuff the full TaskOutput XML
    // or result object into live events or persisted metadata.
    return {
      kind: "task_output",
      retrievalStatus: parsed.data.retrieval_status,
      ...(taskStatus ? { taskStatus } : {}),
      ...(hasOutput ? { output: fullOutput.slice(0, TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS) } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === RESPOND_TO_COORDINATOR_TOOL_NAME) {
    const parsed = RespondToCoordinatorOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    return {
      kind: "respond_to_coordinator",
      status: parsed.data.status,
    };
  }

  if (!isRecord(output)) return undefined;
  const filePath = output.filePath;
  const structuredPatch = output.structuredPatch;
  if (typeof filePath !== "string" || !Array.isArray(structuredPatch)) {
    return undefined;
  }

  const hunks = structuredPatch.filter(isDiffHunk);
  if (hunks.length === 0) return undefined;

  const { additions, deletions } = countPatchLines(hunks);
  const { patch: boundedPatch, truncated } = boundDiffHunks(hunks);
  return {
    kind: "file_diff",
    filePath,
    additions,
    deletions,
    structuredPatch: boundedPatch,
    truncated,
  };
}

function boundMcpDisplayText(value: string, maxChars: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = trimmed.slice(0, maxChars);
  // MCP discovery is external input; a naive slice can cut inside a UTF-16 surrogate pair, producing strings
  // that do not survive events, persistence, and replayable snapshots uniformly.
  // If the boundary lands after a high surrogate, drop the half character; display stays safely serializable.
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

const MAX_CUA_DISPLAY_FIELD_BYTES = 32 * 1024;
const MAX_CUA_INLINE_MEDIA_BYTES = 256 * 1024;
const MAX_CUA_INLINE_MEDIA_TOTAL_BYTES = 512 * 1024;

function readCuaToolName(toolName: string): string | undefined {
  // Accept both CUA tool namings: direct `mcp__computer_use__<action>` and the plugin-namespace
  // form `mcp__plugin_zcode-cua_computer-use__<action>`.
  // After normalization (lowercase + `-`->`_`): name contains `computer_use` and action is the substring after the last `__`.
  const normalized = toolName.trim().toLowerCase().replaceAll("-", "_");
  if (!normalized.includes("computer_use")) return undefined;
  const lastSep = normalized.lastIndexOf("__");
  if (lastSep === -1) return undefined;
  const action = normalized.slice(lastSep + "__".length);
  return action.length > 0 ? action : undefined;
}

function createCuaToolResultDisplay(
  toolName: string,
  output: unknown,
  officialCua: boolean,
): ToolResultDisplayPayload {
  const result = isRecord(output) ? output : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const structuredContent = result.structuredContent;
  const structuredRecord = isRecord(structuredContent) ? structuredContent : undefined;
  const errorRecord = isRecord(structuredRecord?.error) ? structuredRecord.error : undefined;
  const structuredJson =
    structuredContent === undefined
      ? undefined
      : boundDisplayText(safeJson(structuredContent), MAX_CUA_DISPLAY_FIELD_BYTES);
  const boundedText = text ? boundDisplayText(text, MAX_CUA_DISPLAY_FIELD_BYTES) : undefined;
  // Artifact URIs are readable only on the Agent's machine; projecting them directly hands multi-device UIs unrenderable media.
  // Until a controlled read API exists, display carries only directly renderable inline images.
  const media: Array<{ mimeType: string; data: string }> = [];
  let inlineMediaBytes = 0;
  let mediaTruncated = false;
  for (const item of content) {
    if (!isRecord(item)) continue;
    let projectedMedia: { mimeType: string; data: string } | undefined;
    let decodedBytes = 0;
    if (
      item.type === "image" &&
      typeof item.mimeType === "string" &&
      typeof item.data === "string"
    ) {
      decodedBytes = Buffer.byteLength(item.data, "base64");
      projectedMedia = { mimeType: item.mimeType, data: item.data };
    }
    if (!projectedMedia) continue;
    // The media quota bounds real media only; a leading text block must not swallow the screenshot slot.
    if (media.length >= 4) {
      mediaTruncated = true;
      break;
    }
    if (
      decodedBytes > MAX_CUA_INLINE_MEDIA_BYTES ||
      inlineMediaBytes + decodedBytes > MAX_CUA_INLINE_MEDIA_TOTAL_BYTES
    ) {
      mediaTruncated = true;
      continue;
    }
    inlineMediaBytes += decodedBytes;
    media.push(projectedMedia);
  }
  const truncated =
    mediaTruncated || structuredJson?.truncated === true || boundedText?.truncated === true;
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const targetApp = officialCua
    ? cuaTargetAppDisplaySchema.safeParse(meta?.[CUA_TARGET_APP_DISPLAY_META_KEY])
    : undefined;
  const permissionStatus =
    officialCua && toolName === "request_access"
      ? cuaRequestAccessStatusSchema.safeParse(meta?.[CUA_REQUEST_ACCESS_STATUS_META_KEY])
      : undefined;

  // MCP modelContent flattens structuredContent into text; only a standalone bounded display built before
  // flattening lets live events and history tell CUA errors and structured results apart reliably.
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName,
    status: result.isError === true ? "failed" : "success",
    ...(structuredJson ? { structuredContent: structuredJson.value } : {}),
    ...(boundedText ? { text: boundedText.value } : {}),
    ...(typeof errorRecord?.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord?.suggested_action === "string"
      ? { suggestedAction: errorRecord.suggested_action }
      : {}),
    ...(targetApp?.success ? { targetApp: targetApp.data } : {}),
    ...(permissionStatus?.success ? { permissionStatus: permissionStatus.data } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

/**
 * Reads the host-written CUA target-app identity.
 *
 * Only `zcode/nodeReplCuaApp` is trusted: the producer's own `zcode.cua/app-associations-v1` can also appear in
 * `_meta`, but that key is equally reachable via the model-writable `nodeRepl.setResponseMeta` /
 * `nodeRepl.emitStructuredResult`, and the host already strips it in toMcpRunResult. No second-chance
 * parsing here -- do not re-admit a source already deemed untrusted onto the display surface.
 */
function readNodeReplCuaApp(output: Record<string, unknown>): NodeReplCuaAppDisplay | undefined {
  const meta = isRecord(output._meta) ? output._meta : undefined;
  const parsed = nodeReplCuaAppDisplaySchema.safeParse(
    meta?.[ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

function createNodeReplDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== "js" && toolName !== "mcp__node_repl__js") return undefined;
  if (!isRecord(output)) return undefined;

  const candidates = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.content) ? output.content : []),
  ];
  const images: Array<{ base64: string; mimeType: string }> = [];
  let truncated = false;

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const mimeType = candidate.mimeType;
    const encoded = candidate.base64 ?? candidate.data;
    if (
      typeof mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/iu.test(mimeType) ||
      typeof encoded !== "string"
    ) {
      continue;
    }
    const base64 = encoded.startsWith("data:")
      ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
      : encoded;
    if (
      base64.length === 0 ||
      Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES
    ) {
      truncated = true;
      continue;
    }
    if (images.length >= MAX_NODE_REPL_DISPLAY_IMAGES) {
      truncated = true;
      continue;
    }
    images.push({ base64, mimeType });
  }

  // Pure action cells (click, type) have no screenshot, yet the card's leading icon still needs the app identity;
  // so "has image" can no longer be the sole condition for producing display.
  const app = readNodeReplCuaApp(output);
  if (images.length === 0 && !app) return undefined;
  return {
    kind: "node_repl_images",
    ...(images.length > 0 ? { images } : {}),
    ...(app ? { app } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function compactTaskStopDisplayMessage(output: {
  command?: string;
  message: string;
  task_id: string;
}): string {
  if (output.command === undefined) {
    return output.message;
  }

  // TaskStop's canonical success copy re-joins the command in parentheses; display already carries a
  // dedicated command field, so the result row keeps only the stop verdict.
  const standardMessage = `Successfully stopped task: ${output.task_id} (${output.command})`;
  return output.message === standardMessage
    ? `Successfully stopped task: ${output.task_id}`
    : output.message;
}

function isDiffHunk(value: unknown): value is DiffHunk {
  if (!isRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

function boundDiffHunks(hunks: DiffHunk[]): { patch: DiffHunk[]; truncated: boolean } {
  const bounded: DiffHunk[] = [];
  let remainingLines = MAX_DISPLAY_DIFF_LINES;
  let truncated = hunks.length > MAX_DISPLAY_DIFF_HUNKS;

  for (const hunk of hunks.slice(0, MAX_DISPLAY_DIFF_HUNKS)) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    const lines = hunk.lines.slice(0, remainingLines);
    bounded.push({ ...hunk, lines });
    remainingLines -= lines.length;
    if (lines.length < hunk.lines.length) {
      truncated = true;
      break;
    }
  }

  return { patch: bounded, truncated };
}
