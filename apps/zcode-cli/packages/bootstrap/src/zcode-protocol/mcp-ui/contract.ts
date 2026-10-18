/**
 * The mcp-ui contract: agent-side handler interfaces for UI-initiated MCP resource reads and tool calls.
 // Request/result shapes are isomorphic with @zcode/shared's zcodeMcpReadResource* / zcodeMcpUiCallTool* schemas,
 // contract.test asserts the two stay identical.
 */

import type {
  McpUiPluginScope,
  McpUiResourceHandlers,
  McpUiResourceSessionAccess,
} from "./resourceContract.js";
export * from "./resourceContract.js";

export interface McpUiReadResourceParams extends McpUiPluginScope {
  uri: string;
}

export interface McpUiResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpUiReadResourceResult {
  contents: McpUiResourceContent[];
}

/** A page-initiated resources/read result: no _meta; each item is text or blob (base64), never both. */
export interface McpUiReadResourceForUiResult {
  contents: Array<Pick<McpUiResourceContent, "uri" | "mimeType" | "text" | "blob">>;
}

export interface McpUiCallToolParams extends McpUiPluginScope {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Host-minted required call id; shared by admission, cancel, and terminal dedup. */
  callId: string;
}

export interface McpUiCancelCallParams extends McpUiPluginScope {
  callId: string;
}
export interface McpUiCancelCallResult {
  /** false = no such in-flight call (finished or never admitted). */
  cancelled: boolean;
}

export interface McpUiCallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * The minimal session view the handlers depend on: adapted from bootstrap's session record,
 // handlers never touch the rest of ZCodeApp or mcpPort.
 */
export interface McpUiSessionAccess extends McpUiResourceSessionAccess {
  /** Whether serverName is an MCP server configured on this session (plugin and plain servers share one table). */
  hasMcpServer(serverName: string): Promise<boolean>;
  /** Tool visibility (normalized `_meta.ui.visibility`); null when the tool is unknown. */
  getToolVisibility(
    serverName: string,
    toolName: string,
  ): Promise<readonly ("model" | "app")[] | null>;
  readResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceResult>;
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiCallToolResult>;
  /** Page-initiated resources/read (A7); size/mime validation happens in the handler, this is a passthrough. */
  readResourceForUi(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceResult>;
}

/**
 // fail closed: serverName outside this session's MCP server table throws, mapped to JSON-RPC -32602.
 // Ownership sees the server only (any connected MCP server may render an MCP App); pluginId is display/logging.
 */
export class McpUiServerScopeError extends Error {
  readonly code = -32602;
  constructor(readonly serverName: string) {
    super(`MCP server "${serverName}" is not available in this session`);
    this.name = "McpUiServerScopeError";
  }
}

/**
 * The UI called a missing or model-only tool. Passing ownership does not confer eligibility:
 // a tool whose visibility lacks "app" is model-only. Maps to JSON-RPC -32602.
 */
export class McpUiToolAccessError extends Error {
  readonly code = -32602;
  constructor(
    readonly reason: "tool_not_found" | "tool_not_app_visible",
    readonly serverName: string,
    readonly toolName: string,
  ) {
    super(
      reason === "tool_not_found"
        ? `MCP tool "${toolName}" is not available on server "${serverName}"`
        : `MCP tool "${toolName}" on server "${serverName}" is not visible to plugin UI`,
    );
    this.name = "McpUiToolAccessError";
  }
}

/** A7: thrown when the result exceeds 8 MiB or the mimeType is not allowlisted; maps to JSON-RPC -32001 (resource rejected). */
export class McpUiResourceRejectedError extends Error {
  readonly code = -32001;
  constructor(
    readonly reason: "too_large" | "mime_not_allowed",
    readonly uri: string,
    readonly detail: { bytes?: number; maxBytes?: number; mimeType?: string },
  ) {
    super(
      reason === "too_large"
        ? `MCP resource "${uri}" is ${detail.bytes} bytes, exceeding the ${detail.maxBytes} byte limit for plugin UI reads`
        : `MCP resource "${uri}" has mimeType "${detail.mimeType}" which is not allowed for plugin UI reads`,
    );
    this.name = "McpUiResourceRejectedError";
  }
}

export interface McpUiHandlers extends McpUiResourceHandlers<McpUiSessionAccess> {
  readResource(
    access: McpUiSessionAccess,
    params: McpUiReadResourceParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceResult>;
  callTool(
    access: McpUiSessionAccess,
    params: McpUiCallToolParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiCallToolResult>;
  /** Aborts the in-flight call for this callId; same ownership check as callTool. */
  cancelToolCall(
    access: McpUiSessionAccess,
    params: McpUiCancelCallParams,
  ): Promise<McpUiCancelCallResult>;
  readResourceForUi(
    access: McpUiSessionAccess,
    params: McpUiReadResourceParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiReadResourceForUiResult>;
}
