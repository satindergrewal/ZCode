// MCP Apps app-provided tools -> core tool entries. An entry only describes how the model sees it, how approval flows, and how the result reaches the model;
// the invocation itself is delegated to the host-injected executor (bootstrap's instance mailbox: pending calls are delivered to the hosted page's renderer, which executes and returns the result).

import type { JsonSchema, McpToolCallResult, McpToolDescriptor } from "@zcode/contracts";
import {
  MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS,
} from "@zcode/shared/mcp-apps";
import type { ToolEntry, ToolExecutionContext } from "../tool/types.js";
import { normalizeMcpToolResultForModel } from "./image-normalization.js";
import { McpToolOutputJsonSchema, formatMcpToolResult } from "./index.js";

/** Per-entry timeout: claim deadline + execution deadline + slack; the real two-phase deadlines are judged by the executor against spec values. */
export const MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS =
  MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS + MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS + 5_000;

export interface McpAppProvidedToolDefinition {
  retainExecution?: ToolEntry["retainExecution"];
  /** Model-side name `app__<server>__<tool>`. */
  modelName: string;
  serverName: string;
  /** Display / keying only (equals serverName for non-plugin servers). */
  pluginId: string;
  /** Page instance exposing this tool (most recently initialized for the server): sandbox scope + generation. */
  scopeId: string;
  generation: number;
  /** The raw tool name inside the page. */
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export type McpAppProvidedToolExecutor = (
  call: {
    definition: McpAppProvidedToolDefinition;
    arguments: Record<string, unknown>;
    toolCallId: string;
  },
  options: { signal: AbortSignal },
) => Promise<McpToolCallResult>;

export function createMcpAppProvidedToolEntry(
  definition: McpAppProvidedToolDefinition,
  execute: McpAppProvidedToolExecutor,
): ToolEntry {
  const readOnly = definition.readOnlyHint === true;
  const destructive = definition.destructiveHint === true;
  // Read-only calls auto-approve, the rest follow the existing approval path; a page is untrusted sandbox code, so the risk floor is medium.
  const needsApproval = !readOnly;
  const riskLevel = destructive ? "high" : readOnly ? "low" : "medium";
  const source = `the ${definition.serverName} app page`;
  const description = [
    definition.title && definition.title !== definition.toolName ? definition.title : undefined,
    definition.description,
    `(Tool provided by ${source}; available only while the app is open.)`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const pseudoDescriptor: McpToolDescriptor = {
    serverName: definition.serverName,
    toolName: definition.toolName,
    name: definition.modelName,
    inputSchema: definition.inputSchema,
  };

  return {
    retainExecution: definition.retainExecution,
    capability: `App tool ${definition.toolName} provided by ${source}`,
    inputSchema: normalizeObjectSchema(definition.inputSchema),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      concurrentSafe: readOnly || definition.idempotentHint === true,
      destructive,
      description,
      name: definition.modelName,
      mcpPresentation: {
        serverName: definition.serverName,
        toolName: definition.toolName,
        ...(definition.description ? { description: definition.description } : {}),
        pluginId: definition.pluginId,
      },
      needsApproval,
      readOnly,
      riskLevel,
      sideEffectScope: "network",
      timeoutMs: MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS,
    },
    permission: {
      permission: "mcp",
      reason: `App tool "${definition.toolName}" provided by ${source}`,
      riskLevel,
      sideEffectScope: "network",
      needsApproval,
      patternSources: ["toolName", "input"],
      denyPriority: "beforeAsk",
      // Model-side names get reused across sessions by other pages: always-allow is per-session only, never a persisted rule.
      askOptions: { allowAlways: "session" },
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 50_000,
      strategy: "truncate",
      preview: { direction: "head" },
    },
    timeout: {
      defaultMs: MCP_APP_PROVIDED_TOOL_ENTRY_TIMEOUT_MS,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `App tool ${definition.modelName} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input: unknown, context: ToolExecutionContext) => {
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const result = await execute(
        { definition, arguments: args, toolCallId: context.toolCallId },
        { signal: context.abortSignal },
      );
      return normalizeMcpToolResultForModel({
        compressOversizedImages: false,
        context,
        descriptor: pseudoDescriptor,
        result,
        toolName: definition.modelName,
      });
    },
    formatModelContent: (output) => formatMcpToolResult(output),
  };
}

function normalizeObjectSchema(schema: JsonSchema): JsonSchema {
  return {
    ...schema,
    type: "object",
    properties:
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {},
  };
}
