import { z } from "zod";

/**
 * App-Provided Tools (the MCP Apps spec's App-Provided Tools): once the page declares `tools` at `ui/initialize`, the
 * host discovers page tools via `tools/list` and registers them with the agent for the model; model calls reach the
 * renderer via the instance mailbox (live-only delta `pluginUi.appToolCall`, by scopeId + generation); the page runs `tools/call` and returns.
 * Limits, descriptor normalization, and model-side naming only; pure domain, zero IO.
 */

/** Max tools registered per page instance (the spec's recommendation). */
export const MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE = 50;
export const MCP_APPS_APP_TOOL_NAME_MAX_CHARS = 128;
export const MCP_APPS_APP_TOOL_TITLE_MAX_CHARS = 256;
export const MCP_APPS_APP_TOOL_DESCRIPTION_MAX_CHARS = 4096;
/** Cap on serialized inputSchema / outputSchema (UTF-8 bytes). */
export const MCP_APPS_APP_TOOL_SCHEMA_MAX_BYTES = 64 * 1024;
/** Claim deadline for pending calls; timeout reads as the page not running (the mailbox never re-sends). */
export const MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS = 5_000;
/** Deadline for the page's tools/call after claiming (the spec's recommendation). */
export const MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS = 30_000;
/** Per-result serialization cap (the spec's recommendation). */
export const MCP_APPS_APP_TOOL_RESULT_MAX_BYTES = 10 * 1024 * 1024;
/** Cap on model call args before the mailbox; over-limit ends in error, never dispatched. */
export const MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES = 1024 * 1024;
/** Minimum interval between re-registrations triggered by list_changed. */
export const MCP_APPS_APP_TOOLS_REFRESH_INTERVAL_MS = 1_000;
export const MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS = 4096;
export const MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS = 128;
/** Model-side name prefix: naturally disjoint from server tools' `mcp__`. */
export const MCP_APPS_APP_TOOL_MODEL_NAME_PREFIX = "app__";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/** Same sanitizer as agent MCP tool names: non `[A-Za-z0-9_-]` to `_`, consecutive underscores merged. */
export function sanitizeMcpAppsModelNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

/** Model-side name `app__<server>__<tool>`. */
export function buildMcpAppsAppToolModelName(serverName: string, toolName: string): string {
  return `${MCP_APPS_APP_TOOL_MODEL_NAME_PREFIX}${sanitizeMcpAppsModelNamePart(serverName)}__${sanitizeMcpAppsModelNamePart(toolName)}`;
}

const objectSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.type === "object", { message: "schema type must be object" })
  .refine((value) => utf8Bytes(JSON.stringify(value)) <= MCP_APPS_APP_TOOL_SCHEMA_MAX_BYTES, {
    message: "schema is too large",
  });

export const mcpAppsAppToolAnnotationsSchema = z.strictObject({
  title: z.string().max(MCP_APPS_APP_TOOL_TITLE_MAX_CHARS).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpAppsAppToolAnnotations = z.infer<typeof mcpAppsAppToolAnnotationsSchema>;

export const mcpAppsAppToolDescriptorSchema = z.strictObject({
  name: z.string().min(1).max(MCP_APPS_APP_TOOL_NAME_MAX_CHARS),
  title: z.string().max(MCP_APPS_APP_TOOL_TITLE_MAX_CHARS).optional(),
  description: z.string().max(MCP_APPS_APP_TOOL_DESCRIPTION_MAX_CHARS).optional(),
  inputSchema: objectSchemaSchema,
  outputSchema: objectSchemaSchema.optional(),
  annotations: mcpAppsAppToolAnnotationsSchema.optional(),
});
export type McpAppsAppToolDescriptor = z.infer<typeof mcpAppsAppToolDescriptorSchema>;

const ANNOTATION_BOOLEAN_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

/**
 * Renderer-side: narrow a page `tools/list` result into registrable descriptors. Non-conforming entries skip (never failing
 * the whole registration); past 50 keep the first 50; skipped names and reasons come back for logs.
 */
export function normalizeMcpAppsAppTools(tools: readonly unknown[]): {
  tools: McpAppsAppToolDescriptor[];
  skipped: Array<{ name: string | null; reason: string }>;
} {
  const accepted: McpAppsAppToolDescriptor[] = [];
  const skipped: Array<{ name: string | null; reason: string }> = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const name = typeof record?.name === "string" ? record.name : null;
    if (accepted.length >= MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE) {
      skipped.push({ name, reason: "limit" });
      continue;
    }
    if (!record || name === null) {
      skipped.push({ name, reason: "invalid" });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: "duplicate" });
      continue;
    }
    const rawAnnotations =
      record.annotations && typeof record.annotations === "object"
        ? (record.annotations as Record<string, unknown>)
        : null;
    const annotations: Record<string, unknown> = {};
    if (typeof rawAnnotations?.title === "string") annotations.title = rawAnnotations.title;
    for (const key of ANNOTATION_BOOLEAN_KEYS) {
      if (typeof rawAnnotations?.[key] === "boolean") annotations[key] = rawAnnotations[key];
    }
    const candidate = {
      name,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      inputSchema: record.inputSchema,
      ...(record.outputSchema !== undefined ? { outputSchema: record.outputSchema } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    };
    const parsed = mcpAppsAppToolDescriptorSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped.push({ name, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    seen.add(name);
    accepted.push(parsed.data);
  }
  return { tools: accepted, skipped };
}

/** The page `tools/call` result (MCP CallToolResult shape, loose fields: content items verbatim). */
export const mcpAppsAppToolCallResultSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type McpAppsAppToolCallResult = z.infer<typeof mcpAppsAppToolCallResultSchema>;

/** One pending call in the mailbox: delivered to the single instance by (scopeId, generation). */
export interface McpAppsAppToolCallRequest {
  activity?: boolean;
  cancelled?: boolean;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}
