import { ServiceChannels } from "@zcode/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";
import type { PluginUiPluginScope } from "./contract.js";

/**
 * Renderer-to-agent channel for App-Provided Tools. Instance identity = session + sandbox scope + generation (same triple as resource subs).
 * Registration replaces per instance; model calls reach the renderer via the instance mailbox (pluginUi.appToolCall live delta), with claim/return idempotent by callId.
 * The agent solely owns registrations, exposed sets, and pending calls; this service is stateless.
 */
export interface PluginUiAppToolInstanceParams extends PluginUiPluginScope {
  scopeId: string;
  generation: number;
}
export interface PluginUiRegisterAppToolsParams extends PluginUiAppToolInstanceParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface PluginUiRegisterAppToolsResult {
  tools: Array<{ name: string; modelName: string }>;
}
export interface PluginUiAppToolCallParams extends PluginUiAppToolInstanceParams {
  callId: string;
}
export interface PluginUiResolveAppToolCallParams extends PluginUiAppToolCallParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface PluginUiAppToolAcceptedResult {
  accepted: boolean;
}

export interface IPluginUiAppToolsService {
  /** The page's tools/list result replaces this instance's registration; returns the names actually exposed. Throws unavailable without a backend (web/remote). */
  registerAppTools(params: PluginUiRegisterAppToolsParams): Promise<PluginUiRegisterAppToolsResult>;
  /** Unregisters on instance teardown; returns `{ removed: 0 }` without an agent or closed session. */
  unregisterAppTools(params: PluginUiAppToolInstanceParams): Promise<{ removed: number }>;
  /** Claims one pending call from the mailbox; only the first claim wins, then tools/call goes to the page. */
  claimAppToolCall(params: PluginUiAppToolCallParams): Promise<PluginUiAppToolAcceptedResult>;
  /** Returns the page result/error; unclaimed/finished calls get `{ accepted: false }`. */
  resolveAppToolCall(
    params: PluginUiResolveAppToolCallParams,
  ): Promise<PluginUiAppToolAcceptedResult>;
}

export const IPluginUiAppToolsService = createServiceDescriptor<IPluginUiAppToolsService>(
  ServiceChannels.PluginUiAppTools,
);
