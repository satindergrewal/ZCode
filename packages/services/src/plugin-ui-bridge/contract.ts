import type { ZCodePluginUiSurface } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { McpToolUiCsp, PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";

/** Same workspace addressing as the rest of zcodeAgentService: workspaceIdentity for identity, workspacePath for paths. */
export interface PluginUiWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** Attribution scope shared by UI-initiated plugin MCP requests: one session, one plugin, one namespaced server. */
export interface PluginUiPluginScope extends PluginUiWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  /** Namespaced server (plugin:<name>:<server>) owning the display.ui/manifest surface; attribution checked by the agent catalog. */
  serverName: string;
}

export interface PluginUiPrepareSandboxParams extends Omit<PluginUiPluginScope, "instance"> {
  /** Sandbox scope id (buildPluginSandboxScopeId): tool cards `tool:<toolCallId>`, panels `surface:<surfaceId>`. */
  scopeId: string;
  resourceUri: string;
  /** webContents id of the requesting host window; main validates webview attach ownership with it. */
  ownerWebContentsId: number;
  /**
   * Tool-level declaration from display.ui. A fallback only: the ui:// resource's own _meta (csp / prefersBorder /
   * size hints) is authoritative, parsed and preferred at read time; product trusts plugin declarations fully.
   */
  csp?: McpToolUiCsp;
  prefersBorder?: boolean;
}

export interface PluginUiCallToolParams extends PluginUiPluginScope {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Host-generated call id; card teardown cancels into the agent MCP client via cancelToolCall. */
  callId: string;
}
export interface PluginUiCancelToolCallParams extends PluginUiPluginScope {
  callId: string;
}

export interface PluginUiCallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Page-initiated resources/read; MCP-shaped result, directly consumable. */
export interface PluginUiReadResourceParams extends PluginUiPluginScope {
  uri: string;
}
export interface PluginUiResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** base64。 */
  blob?: string;
}
export interface PluginUiReadResourceResult {
  contents: PluginUiResourceContent[];
}

/** Page-initiated resources/list and resources/templates/list; MCP-shaped with cursors passed through. */
export interface PluginUiListResourcesParams extends PluginUiPluginScope {
  cursor?: string;
}
export interface PluginUiResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface PluginUiListResourcesResult {
  resources: PluginUiResourceDescriptor[];
  nextCursor?: string;
}
export interface PluginUiListResourceTemplatesResult {
  resourceTemplates: Array<Omit<PluginUiResourceDescriptor, "uri"> & { uriTemplate: string }>;
  nextCursor?: string;
}
/**
 * Subscribe/unsubscribe. Subscriber identity = session + sandbox scope + instance generation (initId),
 * reference-counted by (server, uri) in the agent; dispose unsubscribes only its generation. Unsupported subs return -32001.
 */
export interface PluginUiResourceSubscriptionParams extends PluginUiPluginScope {
  scopeId: string;
  generation: number;
  uri: string;
}

/** Workspace-level panel entries (manifest ui.surfaces[]) from the agent's plugins/listUiSurfaces. */
export type PluginUiSurfaceEntry = ZCodePluginUiSurface;

/**
 * Plugin UI bridge. The UI depends on this descriptor only, never on zcodeAgentService directly (M5 3-3 capability surface).
 * prepareSandbox is idempotent on (ownerWebContentsId, workspaceKey, sessionId, pluginId, scopeId): repeats return the same
 * sandboxId with a fresh initId; concurrent same-key calls share resource reads but register separately (H15-a, per-caller initId),
 * and sequential calls re-read for fresh HTML.
 * The handle's resourceMeta carries resource-level prefersBorder/heightHint/minFrameHeight (H02).
 */
export interface IPluginUiBridgeService {
  validateInstance(params: PluginUiPluginScope): Promise<void>;
  recycleInstance(params: PluginUiPluginScope): Promise<boolean>;
  closeInstance(params: PluginUiPluginScope): Promise<void>;
  prepareSandbox(params: PluginUiPrepareSandboxParams): Promise<PluginSandboxHandle>;
  callTool(
    params: PluginUiCallToolParams,
    options?: { signal?: AbortSignal },
  ): Promise<PluginUiCallToolResult>;
  /**
   * Cancels the in-flight call by id. renderer-to-host RPC cannot carry an AbortSignal,
   * so cancel is an explicit request aborting into the agent MCP client. false = finished or unknown.
   */
  cancelToolCall(params: PluginUiCancelToolCallParams): Promise<{ cancelled: boolean }>;
  readResource(params: PluginUiReadResourceParams): Promise<PluginUiReadResourceResult>;
  //* Resource list/templates/subscribe: same-plugin servers only, like readResource; agent-checked. */
  listResources(params: PluginUiListResourcesParams): Promise<PluginUiListResourcesResult>;
  listResourceTemplates(
    params: PluginUiListResourcesParams,
  ): Promise<PluginUiListResourceTemplatesResult>;
  subscribeResource(params: PluginUiResourceSubscriptionParams): Promise<void>;
  unsubscribeResource(params: PluginUiResourceSubscriptionParams): Promise<void>;
  //* Panel entries of enabled plugins; the UI refetches on enable/disable (never cached). */
  listSurfaces(params: PluginUiWorkspaceTarget): Promise<PluginUiSurfaceEntry[]>;
}

export const IPluginUiBridgeService = createServiceDescriptor<IPluginUiBridgeService>(
  ServiceChannels.PluginUiBridge,
);
