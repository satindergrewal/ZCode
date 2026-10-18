/**
 * The mcp-ui resource contract (): resources/list, resources/templates/list, and subscriptions.
 // Separate from contract.ts to keep the main contract under the public-method cap; the handler interface composes via extends.
 */
/** The UI request's ownership scope: session + MCP server (ownership truth) + pluginId (display/logging; = serverName for non-plugin servers). */
export interface McpUiPluginScope {
  workspace?: { workspacePath: string; workspaceIdentity?: string };
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
}

/** Parameters / results for resources/list, resources/templates/list, and subscribe. */
export interface McpUiListResourcesParams extends McpUiPluginScope {
  cursor?: string;
}
export interface McpUiResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** The spec puts resource-level csp / prefersBorder on resources/list entries' `_meta`; the host falls back here when an HTML item lacks `_meta`. */
  _meta?: Record<string, unknown>;
}
export interface McpUiListResourcesResult {
  resources: McpUiResourceDescriptor[];
  nextCursor?: string;
}
export interface McpUiListResourceTemplatesResult {
  resourceTemplates: Array<Omit<McpUiResourceDescriptor, "uri"> & { uriTemplate: string }>;
  nextCursor?: string;
}
export interface McpUiResourceSubscriptionParams extends McpUiPluginScope {
  scopeId: string;
  generation: number;
  uri: string;
}
/** Subscriber identity = sessionId | scopeId | generation; session close sweeps the `sessionId|` prefix. */
export function buildMcpUiSubscriberKey(
  sessionId: string,
  scopeId: string,
  generation: number,
): string {
  return `${sessionId}|${scopeId}|${generation}`;
}
export function parseMcpUiSubscriberKey(
  key: string,
): { sessionId: string; scopeId: string; generation: number } | null {
  const first = key.indexOf("|");
  const last = key.lastIndexOf("|");
  if (first <= 0 || last <= first) return null;
  const generation = Number(key.slice(last + 1));
  if (!Number.isInteger(generation) || generation < 0) return null;
  return { sessionId: key.slice(0, first), scopeId: key.slice(first + 1, last), generation };
}

/** The server declares no resources.subscribe capability (or the port lacks resources) -> -32001 not_supported. */
export class McpUiNotSupportedError extends Error {
  readonly code = -32001;
  readonly reason = "not_supported" as const;
  constructor(
    readonly serverName: string,
    readonly operation: string,
  ) {
    super(`MCP server "${serverName}" does not support ${operation}`);
    this.name = "McpUiNotSupportedError";
  }
}

/** The session view's resource port (passthrough; missing capability surfaces as McpResourceSubscribeUnsupportedError). */
export interface McpUiResourceSessionAccess {
  listResourcesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourcesResult>;
  listResourceTemplatesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourceTemplatesResult>;
  subscribeResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  unsubscribeResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

export interface McpUiResourceHandlers<Access extends McpUiResourceSessionAccess> {
  listResources(
    access: Access,
    params: McpUiListResourcesParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourcesResult>;
  listResourceTemplates(
    access: Access,
    params: McpUiListResourcesParams,
    options?: { signal?: AbortSignal },
  ): Promise<McpUiListResourceTemplatesResult>;
  subscribeResource(
    access: Access,
    params: McpUiResourceSubscriptionParams,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  unsubscribeResource(
    access: Access,
    params: McpUiResourceSubscriptionParams,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}
