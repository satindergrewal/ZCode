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
   * 工具对谁开放（`_meta.ui.visibility`，缺省 `["model", "app"]`），与是否带 UI 资源无关。
   * 不含 "model" 的工具不进 provider contracts；不含 "app" 的工具拒绝 `mcp/uiCallTool`。
   * 由 adapter 归一化写入；缺省（旧 descriptor）时以 `ui.visibility` 兜底，再缺省视为两者都可见。
   */
  visibility?: McpAppsToolVisibility[];
  /**
   * 工具 `_meta` 归一化后的插件 UI 呈现描述。
   * 只有声明了合法 `ui://` resourceUri 的工具才有；其中的 visibility 与上面的字段同源。
   */
  ui?: McpToolUiDescriptor;
}

/** 可见性判定的唯一实现：descriptor.visibility → ui.visibility → 两者都可见。 */
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

/** `resources/list` / `resources/templates/list`（分页游标原样透传）。 */
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
 * 资源订阅。`subscriberKey` 由调用方给出（bootstrap 用 sessionId|scopeId|generation），
 * 登记表在连接层按 (serverName, uri) 计数：0→1 才真调 SDK subscribe，1→0 才 unsubscribe；断连重连后按登记表重放。
 */
export interface McpResourceSubscriptionRequest {
  serverName: string;
  uri: string;
  subscriberKey: string;
  trace?: TraceContext;
}
/** server 没有声明 `capabilities.resources.subscribe` 时抛出（协议层映射为 -32001 not_supported）。 */
export class McpResourceSubscribeUnsupportedError extends Error {
  readonly code = "not_supported" as const;
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} does not support resource subscriptions`);
    this.name = "McpResourceSubscribeUnsupportedError";
  }
}

/** server → client 通知，adapter 转成宿主可消费的形状；订阅类通知带当前登记的 subscriberKey。 */
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

/** MCP `notifications/progress`（A8）：progress 单调递增，total 可缺省；adapter 原样转发，不做节流。 */
export interface McpToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpCallToolOptions {
  /** 页面写操作固定此连接；禁止恢复或重新授权后自动重放。 */
  appConnection?: { identity: string; generation: number };
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 收到服务端进度通知时回调；SDK 侧同时以 resetTimeoutOnProgress 让每次进度重置超时。 */
  onProgress?: (progress: McpToolCallProgress) => void;
}

/** 工具级 `_meta.timeoutMs` 的允许区间：低于下限视为非法丢弃，高于上限截到上限。 */
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

/** MCP elicitation（server → client `elicitation/create`）交给宿主提问的端口。 */
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
  /** 发起 elicitation 时该 server 正在执行的工具调用；没有则无法归属会话，端口应拒绝。 */
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
  /** 可信配置派生的稳定来源与现有连接代际。断线时不签发新页面凭证。 */
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
   * 自端口创建以来收到 `notifications/tools/list_changed` 的累计次数。
   * runtime 在回合开始前比较该值，变了才重新 listTools 并重注册；未实现表示端口不会主动变化。
   */
  toolListRevision?(): number;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  /**
   * 读取 MCP 资源（插件 UI 的 `ui://` HTML）。与 pingServer 同样可选：mock port 不必实现，
   * 调用方缺失时按"不支持资源"处理。实现必须与 callTool 共用同一连接与重连路径。
   */
  readResource?(
    request: McpReadResourceRequest,
    options?: McpCallToolOptions,
  ): Promise<McpReadResourceResult>;
  /** 资源列表与订阅；缺省表示该端口不支持（协议层回 -32001）。 */
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
  /** 删除 subscriberKey 以 prefix 开头的全部登记（会话关闭）；返回真正向 server 退订的 uri 数。 */
  unsubscribeResourcesBySubscriber?(subscriberKeyPrefix: string): Promise<number>;
  close(): Promise<void>;
}
