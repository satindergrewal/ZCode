import {
  MCP_TOOL_META_TIMEOUT_MAX_MS,
  MCP_TOOL_META_TIMEOUT_MIN_MS,
  type JsonSchema,
  type McpToolAnnotations,
  type McpToolDescriptor,
} from "@zcode/contracts";
import { normalizeMcpToolUiMeta, readMcpToolVisibility } from "@zcode/shared/mcp-apps";

export function normalizeMcpToolDescriptor(
  serverName: string,
  tool: unknown,
  timeoutMs?: number,
  official?: boolean,
): McpToolDescriptor {
  const record = isRecord(tool) ? tool : {};
  const toolName = typeof record.name === "string" ? record.name : "unknown";
  // Plugin UI: tools/list `_meta` is read exactly here, normalized into descriptor.ui; downstream never touches raw _meta.
  const ui = normalizeMcpToolUiMeta(record._meta);
  return {
    serverName,
    toolName,
    name: `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`,
    description: typeof record.description === "string" ? record.description : undefined,
    // Tool-level `_meta.timeoutMs` (A8) overrides the server timeout: long tasks (download engines, rendering) declare per tool, cap 30 min.
    timeoutMs: readToolMetaTimeoutMs(record._meta) ?? timeoutMs,
    inputSchema: normalizeInputSchema(record.inputSchema),
    outputSchema: isRecord(record.outputSchema) ? (record.outputSchema as JsonSchema) : undefined,
    annotations: normalizeAnnotations(record.annotations),
    // Only the http official-MCP tool error marker is trusted: that shape comes from the origin-validated
    // ZCode backend and cannot be forged by plugins (rationale and cost in mcp.port.ts official field docs).
    ...(official ? { official: true } : {}),
    // Visibility is independent of UI presence — an app-only data tool without resourceUri still stays out of the model tool table.
    visibility: readMcpToolVisibility(record._meta),
    ...(ui ? { ui } : {}),
  };
}

function readToolMetaTimeoutMs(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta.timeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MCP_TOOL_META_TIMEOUT_MIN_MS) return undefined;
  return Math.min(Math.floor(value), MCP_TOOL_META_TIMEOUT_MAX_MS);
}

function normalizeInputSchema(schema: unknown): JsonSchema {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
  };
}

function normalizeAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) return undefined;
  return {
    readOnlyHint: typeof value.readOnlyHint === "boolean" ? value.readOnlyHint : undefined,
    destructiveHint: typeof value.destructiveHint === "boolean" ? value.destructiveHint : undefined,
    idempotentHint: typeof value.idempotentHint === "boolean" ? value.idempotentHint : undefined,
    openWorldHint: typeof value.openWorldHint === "boolean" ? value.openWorldHint : undefined,
  };
}

function sanitizeMcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
