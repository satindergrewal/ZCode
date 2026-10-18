import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";
import type { McpUiPluginScope } from "./resourceContract.js";

/**
 * The renderer -> agent parameter shape for App-Provided Tools (isomorphic with @zcode/shared's zcodeMcpUi*AppTool* schema).
 // Instance identity = sandbox scope + generation, the same triple as resource subscriptions; mailbox delivery addresses by it too.
 */
export interface McpUiAppToolInstance {
  scopeId: string;
  generation: number;
}
export interface McpUiRegisterAppToolsParams extends McpUiPluginScope, McpUiAppToolInstance {
  tools: McpAppsAppToolDescriptor[];
}
export interface McpUiRegisterAppToolsResult {
  tools: Array<{ name: string; modelName: string }>;
}
export interface McpUiUnregisterAppToolsParams extends McpUiPluginScope, McpUiAppToolInstance {}
export interface McpUiUnregisterAppToolsResult {
  removed: number;
}
export interface McpUiAppToolCallParams extends McpUiPluginScope, McpUiAppToolInstance {
  callId: string;
}
export interface McpUiResolveAppToolCallParams extends McpUiAppToolCallParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface McpUiAppToolAcceptedResult {
  accepted: boolean;
}
