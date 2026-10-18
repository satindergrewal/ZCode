// MCP Port - Model Context Protocol adapter boundary

import type { McpServerFailureKind, OfficialMcpAuthPortFailureReason } from "@zcode/shared";
import type { McpAppsToolVisibility, McpToolUiDescriptor } from "@zcode/shared/mcp-apps";
import type { JsonSchema } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";

export type McpServerTransportType = "stdio" | "http" | "sse";
export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";
export type McpServerIsolation = "session" | "workspace";

/** Runtime provenance attached by the host after public MCP config validation. */
export interface McpServerRuntimeSource {
  kind: "builtin" | "plugin";
}

export interface McpServerConfigBase {
  enabled?: boolean;
  isolation?: McpServerIsolation;
  protocolVersion?: McpProtocolVersion;
  /** Host-generated only; the public config schema rejects the field. */
  source?: McpServerRuntimeSource;
  timeoutMs?: number;
}

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

/**
 * Auth declaration of the ZCode official Server MCP.
 * Allowed on `type: "http"` and `type: "stdio"`; `sse` still rejected.
 * `type`/`provider` are exact values; no aliases or case variants.
 *
 * Note: the field alone is **not** proof of official identity. Official identity is decided by the runtime-resolved ZCode API origin
 * (the host re-validates); a third-party plugin copying the field can only send credentials to the real ZCode backend.
 *
 * The two shapes deliver credentials differently:
 * - http: the host injects identity headers per request in its fetch wrapper; credentials never enter the plugin process;
 * - stdio: the plugin process issues requests itself; identity headers ride the `_meta` of every outbound protocol message.
 */
export interface ZCodeOfficialMcpAuthConfig {
  type: "zcode_official";
  provider: "jwt_token";
}

/**
 * Runtime provenance produced by the plugin loader; `.mcp.json` cannot override.
 * For credential resolution and log correlation; not a trust input.
 * The target origin must pass `isOfficialMcpOriginTrusted`; plugin identity itself is not
 * an authorization filter. Destination validation, server-side entitlement, and quota checks are separate boundaries.
 */
export interface McpOfficialProvenance {
  pluginId: string;
  /** Raw MCP key inside the plugin (without the `plugin:<name>:` namespace prefix). */
  mcpKey: string;
  source: "plugin";
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** Host-generated; never from file config. */
  official?: McpOfficialProvenance;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** Host-generated; never from file config. */
  official?: McpOfficialProvenance;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export type McpServerStatusKind =
  | "connecting"
  | "connected"
  | "disabled"
  | "disconnected"
  | "failed"
  | "untrusted";

export interface McpServerStatus {
  status: McpServerStatusKind;
  transport: McpServerTransportType;
  toolCount: number;
  updatedAt: string;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  protocolEra?: "legacy" | "modern";
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const ZCODE_MCP_ERROR_PRESENTATION_META_KEY = "zcode/errorPresentation";
export const ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY = "message-only";
/** Index of the image block from an explicit model tab.screenshot() within MCP content. */
export const ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY =
  "zcode/browserScreenshotContentIndices";
/**
 * Target app identity of this node_repl cell, for the tool card's app icon.
 *
 * **Only node-repl-host may write it**: the host's CUA bridge reads the producer's
 * `zcode.cua/app-associations-v1` from the broker response and projects the minimal shape here. The producer key itself also reaches `_meta` via
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult`, and both
 * APIs hang off the model-visible sandbox globals, hence untrusted: dropped host-side (same
 * disposition as `ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY`).
 */
export const ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY = "zcode/nodeReplCuaApp";
/**
 * `x-request-id` from official Server MCP response headers, attached to failed tool results (string value).
 *
 * Short prefix `zcode/`, not `com.zcode/`: not a cross-language protocol - the server sends the header, the client
 * moves it into `_meta` itself; producing and consuming are both client-side (`com.zcode/` is for keys produced directly on the Go side,
 * e.g. `com.zcode/mcp-unavailable`).
 *
 * Attached only on `isError`: a human debugging clue (take it to the server logs); pure noise on success.
 */
export const ZCODE_MCP_SERVER_REQUEST_ID_META_KEY = "zcode/officialMcpServerRequestId";

export interface McpToolDescriptor {
  serverName: string;
  toolName: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  /**
   * The tool result is **trusted enough to change the UI**: from a `type: "http"` MCP server declaring
   * `auth.type = zcode_official`.
   *
   * Sole use: trusting structured identifiers in the result (quota-exhausted / no-plan `error_code`). The test is "who produced the result",
   * not "which plugin":
   * - http: responses come from the ZCode backend. A live connection implies every request passed origin validation, fail-closed;
   *   third-party plugins, even declaring official auth, can only hit the real ZCode, and the body is not written by them;
   * - stdio: produced by the plugin process, freely forgeable, hence **not set**.
   *
   * Deliberately **not** "plugin from the official marketplace": that would break official plugins from unofficial install sources (local
   * self-testing, zcode-plugins-test), and it is no real barrier - see `@zcode/shared`'s
   * `isOfficialMcpOriginTrusted`。
   */
  official?: boolean;
  /**
   * Who the tool is exposed to (`_meta.ui.visibility`, default \`["model", "app"]\`), independent
   * of carrying a UI resource. Tools without "model" stay out of provider contracts; without
   * "app" they refuse \`mcp/uiCallTool\`. Normalized in by the adapter; legacy descriptors fall
   * back to \`ui.visibility\`, else both visible.
   */
  visibility?: McpAppsToolVisibility[];
  /**
   * Plugin-UI presentation description normalized from the tool \`_meta\`.
   * Only tools declaring a legal \`ui://\` resourceUri have it; its visibility shares the source of the field above.
   */
  ui?: McpToolUiDescriptor;
}

/** The single visibility referee: descriptor.visibility -> ui.visibility -> both visible. */
export function resolveMcpToolVisibility(
  descriptor: Pick<McpToolDescriptor, "visibility" | "ui">,
): McpAppsToolVisibility[] {
  return descriptor.visibility ?? descriptor.ui?.visibility ?? ["model", "app"];
}

export type McpContentBlock = Record<string, unknown>;

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceRequest {
  serverName: string;
  uri: string;
  trace?: TraceContext;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

/** `resources/list` / `resources/templates/list` (pagination cursors pass through verbatim). */
export interface McpListResourcesRequest {
  serverName: string;
  cursor?: string;
  trace?: TraceContext;
}
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface McpListResourcesResult {
  resources: McpResourceDescriptor[];
  nextCursor?: string;
}
export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface McpListResourceTemplatesResult {
  resourceTemplates: McpResourceTemplateDescriptor[];
  nextCursor?: string;
}
/**
 * Resource subscription. \`subscriberKey\` is caller-supplied (bootstrap:
 * sessionId|scopeId|generation); the registry counts per (serverName, uri) at the connection
 * layer: 0->1 really subscribes via SDK, 1->0 unsubscribes; after reconnect the registry replays.
 */
export interface McpResourceSubscriptionRequest {
  serverName: string;
  uri: string;
  subscriberKey: string;
  trace?: TraceContext;
}
/** Thrown when the server declares no \`capabilities.resources.subscribe\` (protocol maps to -32001 not_supported). */
export class McpResourceSubscribeUnsupportedError extends Error {
  readonly code = "not_supported" as const;
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} does not support resource subscriptions`);
    this.name = "McpResourceSubscribeUnsupportedError";
  }
}

/** Server -> client notification, shaped by the adapter for host consumption; subscription notifications carry the registered subscriberKey. */
export type McpServerNotification =
  | { kind: "resourceUpdated"; serverName: string; uri: string; subscribers: string[] }
  | { kind: "resourceListChanged"; serverName: string; subscribers: string[] }
  | { kind: "toolListChanged"; serverName: string }
  | { kind: "loggingMessage"; serverName: string; level: string; logger?: string; data: unknown };
export interface McpNotificationPort {
  onNotification(notification: McpServerNotification): void;
}

export interface McpConnectionSnapshot {
  statuses: Record<string, McpServerStatus>;
  tools: McpToolDescriptor[];
}

export interface McpConnectOptions {
  /**
   * Wait ceiling for the authorization_code OAuth callback.
   * Plain MCP timeoutMs bounds protocol requests only; session startup needs a separate OAuth wait bound.
   */
  oauthAuthorizationTimeoutMs?: number;
  /**
   * Validate an existing connection's liveness before reuse (see McpPort.pingServer); reconnect when dead.
   * Calls like the settings-page refresh ("user explicitly asked to re-probe") must set it; session startup need not -
   * a freshly established pooled connection suffices.
   */
  revalidate?: boolean;
  signal?: AbortSignal;
  trace?: TraceContext;
  workingDirectory?: string;
  /** Identity isolation uses workspaceIdentity; fall back to workingDirectory only when absent locally. */
  workspaceIdentity?: string;
}

export interface McpCallToolRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  trace?: TraceContext;
  /** Call origin; the host MCP may restrict capabilities that cannot safely inherit into subagents. */
  runtimeScope?: "main" | "subagent";
  /** Request context serves shared-host isolation only; never alters MCP tool args. */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: string;
  deliveryKind?: string;
  turnId?: string;
}

/** MCP \`notifications/progress\` (A8): progress monotonic, total optional; the adapter forwards verbatim, no throttling. */
export interface McpToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallToolOptions {
  /** Page writes pin this connection; no auto-replay after recovery or re-auth. */
  appConnection?: { identity: string; generation: number };
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Invoked on server progress notifications; SDK-side resetTimeoutOnProgress resets the timeout per progress. */
  onProgress?: (progress: McpToolCallProgress) => void;
}

/** Allowed range of tool-level \`_meta.timeoutMs\`: below the floor is dropped as invalid; above the ceiling clamps to it. */
export const MCP_TOOL_META_TIMEOUT_MIN_MS = 1_000;
export const MCP_TOOL_META_TIMEOUT_MAX_MS = 30 * 60 * 1_000;

/**
 * Port-level failure classes (the "no request sent" cases).
 * `official_mcp_origin_untrusted` may come from adapter-local validation or the host-side re-check.
 */
export type OfficialMcpAuthFailureReason = OfficialMcpAuthPortFailureReason;

export type OfficialMcpAuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * DI port through which the MCP adapter consumes identity headers.
 * The adapter does not depend on `packages/services` directly; the Agent process asks the host for per-request identity headers here.
 *
 * Failures return values, never throw; callers must not parse error text for the cause.
 * `workspaceIdentity` / `workspacePath` / `pluginId` / `mcpKey` / `targetOrigin`
 * For routing, re-validation, and audit only; **not credential selection** - credentials are host-global state.
 */
export interface OfficialMcpAuthHeadersPort {
  resolveHeaders(input: {
    pluginId: string;
    mcpKey: string;
    targetOrigin: string;
    workspaceIdentity?: string;
    workspacePath?: string;
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
}

/**
 * Official MCP trust decision.
 *
 * One rule only: **the target origin equals the current ZCode API origin character-for-character (https, no user/password)**,
 * plus a local self-test switch relaxing http loopback only. `pluginId` / `mcpKey` serve logging and credential
 * attribution only, **never the verdict** - the former "must be an official-marketplace plugin" check was removed in 2026-08
 * (it blocked pre-release self-tests against the real endpoint; third-party plugins could read the same credentials via hooks anyway -
 * no real barrier).
 *
 * Implemented in `@zcode/shared`: host and adapter share one copy, so neither side diverges on allow/deny.
 * Async so the host can resolve the origin with settings overrides.
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
    detail?: string;
    trusted: boolean;
  }>;
}

/** Port handing MCP elicitation (server -> client \`elicitation/create\`) to the host asker. */
export interface McpElicitationTrace {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  traceId?: string;
}
export interface McpElicitationRequest {
  serverName: string;
  message: string;
  requestedSchema: unknown;
  /** Tool call in flight on that server when elicitation started; without it the session cannot be attributed and the port should refuse. */
  trace?: McpElicitationTrace;
}
export interface McpElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export interface McpElicitationPort {
  requestElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult>;
}

export interface McpPort {
  /** Stable origin derived from trusted config, plus the live connection generation. No new page credentials across disconnects. */
  onAppConnectionInvalidated?(serverName: string, listener: () => void): () => void;
  appConnectionSnapshot?(serverName: string): { identity: string; generation: number } | null;

  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  /**
   * Actively probe connection liveness; false means the transport is gone.
   * A stopped HTTP/SSE MCP dispatches no onclose, so status() stays connected forever;
   * only an explicit ping exposes the silent death. Optional: callers treat unimplemented as alive.
   */
  pingServer?(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  status(): Promise<Record<string, McpServerStatus>>;
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * Count of \`notifications/tools/list_changed\` since port creation.
   * runtime compares it before a turn and only re-lists/re-registers on change; unimplemented
   * means the port never changes on its own.
   */
  toolListRevision?(): number;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  /**
   * Read an MCP resource (plugin UI's \`ui://\` HTML). Optional like pingServer: mock ports need
   * not implement; on absence callers treat as "no resource support". Implementations must share
   * callTool's connection and reconnect path.
   */
  readResource?(
    request: McpReadResourceRequest,
    options?: McpCallToolOptions,
  ): Promise<McpReadResourceResult>;
  /** Resource listing and subscription; absent means unsupported (protocol replies -32001). */
  listResources?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourcesResult>;
  listResourceTemplates?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourceTemplatesResult>;
  subscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  unsubscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  /** Drop every registration whose subscriberKey starts with prefix (session close); returns the count actually unsubscribed at the server. */
  unsubscribeResourcesBySubscriber?(subscriberKeyPrefix: string): Promise<number>;
  close(): Promise<void>;
}
