import {
  Client,
  ClientCredentialsProvider,
  computeScopeUnion,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
  type AuthProvider,
  type OAuthClientProvider,
  type VersionNegotiationMode,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectionSnapshot,
  McpConnectOptions,
  McpContentBlock,
  McpElicitationPort,
  McpElicitationTrace,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpNotificationPort,
  McpOAuthConfig,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import {
  McpResourceSubscribeUnsupportedError,
  ZCODE_MCP_SERVER_REQUEST_ID_META_KEY,
} from "@zcode/contracts";
import {
  OFFICIAL_MCP_AUTH_META_KEY,
  ZCODE_OFFICIAL_MCP_AUTH_TYPE,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import { buildMcpAppsClientCapabilities } from "@zcode/shared/mcp-apps";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  type NetworkEgressEnvPolicy,
} from "./network.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import {
  classifyInteractiveAuthorizationTrigger,
  type InteractiveAuthorizationTrigger,
} from "./oauth-errors.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import {
  createCredentialKeyPrefix,
  type McpOAuthAuthorizationContext,
  type McpOAuthRuntimeOptions,
} from "./oauth.js";
import {
  createOfficialMcpAuthFetch,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "./official-auth.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import {
  createMcpDeadline,
  McpTimeoutError,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  withTimeout,
  type McpDeadline,
} from "./timeout.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// Liveness probes get a tiny budget only: they sit on the settings refresh sync path; timeout means dead and reconnect.
const MCP_PING_TIMEOUT_MS = 5_000;
const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
/**
 * Cap on buffered span-to-request-id entries. Normally each is consumed at tool-call end;
 * only unclaimed ones linger (connect-phase), tens suffice, purely bounding long sessions.
 */
const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * Official server MCP auth deps. Missing trustedOrigins still fails closed; authHeadersPort
   * may be absent, then requests degrade to anonymous and the server is the authority.
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * Current ZCode API origin. The stdio form has no url to validate, so targetOrigin must come from the host,
     * which also keeps plugins from aiming identity headers elsewhere.
     * Must share the source of truth with trustedOrigins' resolveZCodeApiOrigin or the two checks diverge.
     */
    resolveZCodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  workingDirectory?: string;
  /** With this port the server is told elicitation is supported; without it its elicitation/create gets method not found. */
  elicitation?: McpElicitationPort;
  /** Outlet for server->client notifications (resource updates / list changes / tool list changes / logs); default logs debug only. */
  notifications?: McpNotificationPort;
}

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * Identity header payload for official stdio MCP, delivered via _meta on every outbound message.
 *
 * Failures are delivered too (ok false plus enum reason): stdio plugins without headers never hit the official endpoint blind. The HTTP path
 * instead lets the adapter send an identity-less tools/call so the ZCode server returns the authoritative structured error. Only with the reason can the
 * stdio plugin present not-signed-in vs no-Coding-Plan
 * honestly instead of failing with a cryptic message.
 */
type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/** Subscribed server->client notification method names (MCP spec). */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = "notifications/tools/list_changed";
export const MCP_NOTIFICATION_RESOURCES_UPDATED = "notifications/resources/updated";
export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = "notifications/resources/list_changed";
export const MCP_NOTIFICATION_MESSAGE = "notifications/message";

interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  /** Set on tools/list_changed; the next listTools re-pulls. */
  toolsStale?: boolean;
  transport?: McpTransport;
}

/** A resources/list item: standard fields only (incl. _meta); SDK runtime extras dropped. */
function pickResourceDescriptor(
  resource: unknown,
  includeUri = true,
): {
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
} {
  const item = isRecord(resource) ? resource : {};
  return {
    ...(includeUri ? { uri: typeof item.uri === "string" ? item.uri : "" } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.title === "string" ? { title: item.title } : {}),
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
  };
}

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";

/** Elicitation mode allowlist (MCP form plus compat alias). */
const SUPPORTED_ELICITATION_MODES = new Set(["form", "openai/form", "openaiForm"]);
function isSupportedElicitationMode(mode: unknown): boolean {
  return mode === undefined || (typeof mode === "string" && SUPPORTED_ELICITATION_MODES.has(mode));
}

class NodeMcpAdapter implements McpPort {
  private readonly adapterInstanceId = randomUUID();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionContext?: McpConnectionContext;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly mcpOAuth?: McpOAuthRuntimeOptions;
  private readonly network?: NetworkEgressEnvPolicy;
  private readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  private readonly telemetry?: McpTelemetryTracker;
  private readonly connectionGenerations = new Map<string, number>();
  private credentialStore?: SharedZCodeCredentialStore;
  /**
   * Slot stashing the official-auth failure class. Not readable off the error object: SDK version
   * negotiation re-wraps OfficialMcpAuthError as plain Error, instanceof dies;
   * text parsing is banned. Write at the throw site; failConnection consumes and clears.
   */
  private readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();
  /**
   * span to server request id. Written only by official MCP (the auth fetch wrapper is the only response-header viewer),
   * letting in-band failures (HTTP 200 + isError) carry the id into the tool result.
   *
   * Keyed by span, not traceId: traceId covers the whole top-level session and is shared by its calls,
   * cross-wiring attribution; a span is one tool call.
   *
   * Bounded and take-and-clear: without a matching span (initialize/tools-list have no _meta) let the entry evict
   * naturally, never fallback to most-recent, which would staple the previous call's id onto this failure.
   */
  private readonly serverRequestIdBySpan = new Map<string, string>();
  private readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();
  private readonly records = new Map<string, McpServerRecord>();
  private readonly workingDirectory?: string;
  private readonly elicitation?: McpElicitationPort;
  private readonly notifications?: McpNotificationPort;
  /** Subscription registry serverName -> uri -> subscriberKey; single owner, counted at the connection layer. */
  private readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();
  /** Cumulative tools/list_changed count; the runtime decides re-registration from it. */
  private toolListRevisionCounter = 0;
  /** Each server's in-flight tool-call trace; elicitations attribute via it to session / tool row. */
  private readonly activeCallTraces = new Map<string, McpElicitationTrace>();

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
  }

  async connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options: McpConnectOptions = {},
  ): Promise<McpConnectionSnapshot> {
    const startedAt = Date.now();
    const serverNames = Object.keys(servers);
    this.logger?.info("MCP configured servers connection started", {
      event: "mcp.configured_servers.connect.started",
      serverCount: serverNames.length,
      serverNames,
      status: "started",
    });
    const configuredNames = new Set(Object.keys(servers));
    await Promise.all(
      Array.from(this.records.keys())
        .filter((name) => !configuredNames.has(name))
        .map((name) => this.disconnectServer(name)),
    );

    await Promise.all(
      Object.entries(servers).map(([name, config]) => {
        const record = this.records.get(name);
        if (
          record?.connecting &&
          record.status.status === "connecting" &&
          record.status.authorization &&
          isDeepStrictEqual(record.config, config)
        ) {
          // Full convergence of identical config can overlap the OAuth callback wait; reconnecting
          // closes the original session, voiding the authorization URL, PKCE/state and callback open in the browser.
          // Connection lifetime is shareable, but the session's 15s wait budget and AbortSignal must not inherit the page's 5 minutes.
          return this.waitForSharedConnection(name, record, options);
        }
        return this.connectServer(name, config, options);
      }),
    );

    const statuses = await this.status();
    const tools = await this.listTools();
    const statusCounts = Object.values(statuses).reduce<Record<string, number>>(
      (counts, status) => {
        counts[status.status] = (counts[status.status] ?? 0) + 1;
        return counts;
      },
      {},
    );
    this.logger?.info("MCP configured servers connection completed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.configured_servers.connect.completed",
      serverCount: serverNames.length,
      status: "completed",
      statusCounts,
      toolCount: tools.length,
    });
    return {
      statuses,
      tools,
    };
  }

  async connectServer(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerStatus> {
    const startedAt = Date.now();
    const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const generation = this.nextConnectionGeneration(name);
    this.lastOfficialAuthKind.delete(name);
    this.connectionDiagnosticByServer.delete(name);
    this.logger?.info("MCP server connection started", {
      event: "mcp.server.connect.started",
      mcpServerName: name,
      status: "started",
      timeoutMs,
      transport: config.type,
    });
    await this.closeRecord(name);

    if (config.enabled === false) {
      const status = this.createStatus(config, "disabled");
      this.records.set(name, { config, status, tools: [] });
      this.logger?.info("MCP server connection skipped", {
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connect.skipped",
        mcpServerName: name,
        status: "completed",
        transport: config.type,
      });
      return status;
    }

    const abortController = new AbortController();
    const abortExternal = () => {
      abortController.abort(
        options.signal?.reason instanceof Error ? options.signal.reason : undefined,
      );
    };
    if (options.signal?.aborted) {
      abortExternal();
    } else {
      options.signal?.addEventListener("abort", abortExternal, { once: true });
    }

    const connectingStatus = this.createStatus(config, "connecting");
    const record: McpServerRecord = {
      abortController,
      config,
      status: connectingStatus,
      tools: [],
    };
    this.records.set(name, record);
    const connecting = this.openServerConnection({
      config,
      generation,
      name,
      oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
      signal: abortController.signal,
      timeoutMs,
      workingDirectory: options.workingDirectory,
    }).finally(() => {
      options.signal?.removeEventListener("abort", abortExternal);
    });
    record.connecting = connecting;
    // oauthAuthorizationTimeoutMs (the session's 15s) used to be treated as the OAuth transaction lifetime,
    // killing the callback listener at 15s, far too short for a human (one observed grant took ~74s).
    // Now it is only this caller's wait budget: at expiry return the current
    // snapshot (URL included) while the background connect and the 300s grant transaction live on.
    return await this.waitForSharedConnection(name, record, options);
  }

  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    const record = this.records.get(name);
    if (!record) return undefined;

    this.nextConnectionGeneration(name);
    await this.closeRecord(name);
    const status = this.createStatus(record.config, "disconnected");
    this.records.set(name, {
      config: record.config,
      status,
      tools: [],
    });
    return status;
  }

  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Array.from(this.records.entries()).map(([name, record]) => [name, record.status]),
    );
  }

  // Stopped HTTP/SSE servers never dispatch onclose (no long-lived stream to drop), so the record sticks at
  // connected; the page refreshes read this silently-dead snapshot and the button looks broken.
  // ping is core MCP: use it to make transport liveness explicit.
  async pingServer(name: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") {
      return false;
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    const generation = this.connectionGenerations.get(name) ?? 0;
    try {
      await record.client.ping({ timeout: timeoutMs });
      return true;
    } catch (error) {
      // A JSON-RPC error reply (e.g. unimplemented ping) proves the connection lives; never tear down on it.
      if (isPeerAnsweredError(error)) {
        return true;
      }
      if (!this.isCurrentConnection(name, generation)) return false;
      const current = this.records.get(name);
      if (current && current.client === record.client) {
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server did not answer ping",
          failureKind: "unexpected_disconnect",
        });
      }
      this.logger?.warn("MCP server ping failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.server.ping.failed",
        mcpServerName: name,
        status: "failed",
        transport: record.config.type,
      });
      return false;
    }
  }

  toolListRevision(): number {
    return this.toolListRevisionCounter;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    // A server that received notifications/tools/list_changed re-pulls on its next listTools
    // (the runtime calls only before a turn; within a turn the tool table is frozen).
    for (const [name, record] of this.records) {
      if (!record.toolsStale || !record.client || record.status.status !== "connected") continue;
      try {
        const listed = await record.client.listTools();
        record.tools = listed.tools.map((tool) =>
          normalizeMcpToolDescriptor(
            name,
            tool,
            record.config.timeoutMs,
            record.config.type === "http" &&
              record.config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
          ),
        );
        record.status = { ...record.status, toolCount: record.tools.length };
        record.toolsStale = false;
        this.logger?.info("MCP tool list refreshed after list_changed", {
          event: "mcp.tools.refreshed",
          mcpServerName: name,
          toolCount: record.tools.length,
        });
      } catch (error) {
        this.logger?.warn("MCP tool list refresh failed", {
          event: "mcp.tools.refresh_failed",
          mcpServerName: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return Array.from(this.records.values()).flatMap((record) => record.tools);
  }

  /** `resources/list`, paging cursor passthrough. */
  async listResources(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourcesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/list",
      options,
    );
    const result = await record.client.listResources(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resources: (result.resources ?? []).map((resource) => {
        const { uri, ...rest } = pickResourceDescriptor(resource);
        return { uri: uri ?? "", ...rest };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listResourceTemplates(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourceTemplatesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/templates/list",
      options,
    );
    const result = await record.client.listResourceTemplates(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
        const item = template as Record<string, unknown>;
        return {
          uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
          ...pickResourceDescriptor(item, false),
        };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  /**
   * Subscriptions counted by (serverName, uri). A connection shared by several sessions subscribes to the server once;
   // without the server's resources.subscribe capability -> McpResourceSubscribeUnsupportedError.
   */
  async subscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/subscribe",
      options,
    );
    if (!record.client.getServerCapabilities()?.resources?.subscribe) {
      throw new McpResourceSubscribeUnsupportedError(request.serverName);
    }
    const { first } = this.resourceSubscriptions.add(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    if (!first) return;
    try {
      await record.client.subscribeResource(
        { uri: request.uri },
        { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
      );
    } catch (error) {
      this.resourceSubscriptions.remove(request.serverName, request.uri, request.subscriberKey);
      throw error;
    }
    this.logger?.info("MCP resource subscribed", {
      event: "mcp.resource.subscribe",
      mcpServerName: request.serverName,
      uri: request.uri,
      status: "completed",
    });
  }

  async unsubscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    const removed = this.resourceSubscriptions.remove(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    if (!removed?.last) return;
    await this.unsubscribeOnServer(request.serverName, request.uri, options);
  }

  async unsubscribeResourcesBySubscriber(subscriberKeyPrefix: string): Promise<number> {
    const released = this.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
    for (const { serverName, uri } of released) {
      await this.unsubscribeOnServer(serverName, uri, {});
    }
    return released.length;
  }

  /** Registry snapshot (tests / diagnostics): serverName -> uri -> subscriber count. */
  resourceSubscriptionCounts(): Record<string, Record<string, number>> {
    return this.resourceSubscriptions.counts();
  }

  private async unsubscribeOnServer(
    serverName: string,
    uri: string,
    options: McpCallToolOptions,
  ): Promise<void> {
    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") return;
    try {
      await record.client.unsubscribeResource({ uri }, { signal: options.signal });
      this.logger?.info("MCP resource unsubscribed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        status: "completed",
      });
    } catch (error) {
      // Unsubscribe failure logs only: the registry is already clear, and stray server notices drop for lack of subscribers.
      this.logger?.warn("MCP resource unsubscribe failed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }

  /** After disconnect/reconnect, replay subscribe from the registry (A3); one failure never blocks the rest. */
  private async replayResourceSubscriptions(serverName: string, client: McpClient): Promise<void> {
    const uris = this.resourceSubscriptions.uris(serverName);
    if (uris.length === 0) return;
    if (!client.getServerCapabilities()?.resources?.subscribe) return;
    for (const uri of uris) {
      try {
        await client.subscribeResource({ uri });
      } catch (error) {
        this.logger?.warn("MCP resource subscription replay failed", {
          event: "mcp.resource.subscribe",
          mcpServerName: serverName,
          uri,
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        });
      }
    }
    this.logger?.info("MCP resource subscriptions replayed after reconnect", {
      event: "mcp.resource.subscribe.replayed",
      mcpServerName: serverName,
      uriCount: uris.length,
    });
  }

  private async resolveForResourceRequest(
    serverName: string,
    operation: string,
    options: McpCallToolOptions,
  ): Promise<{
    record: McpServerRecord & { client: McpClient };
    deadline: McpDeadline;
    timeoutMessage: string;
  }> {
    const timeoutMs =
      options.timeoutMs ?? this.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    return { record, deadline, timeoutMessage };
  }

  /**
   * Server-initiated notifications. Subscription notices carry the registered subscriberKeys (the host splits by session);
   // tools/list_changed only marks stale, pulled on the next listTools; without the port the SDK default drops it.
   */
  private installNotificationHandlers(client: McpClient, serverName: string): void {
    const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
      .setNotificationHandler;
    if (typeof setNotificationHandler !== "function") return;
    // SDK 2.x: first arg is the notification method name (spec methods as plain strings), schema an optional second.
    const typed = client as unknown as {
      setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
    };
    typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
      const record = this.records.get(serverName);
      if (record) record.toolsStale = true;
      this.toolListRevisionCounter += 1;
      this.notifications?.onNotification({ kind: "toolListChanged", serverName });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
      const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
      if (typeof uri !== "string") return;
      this.notifications?.onNotification({
        kind: "resourceUpdated",
        serverName,
        uri,
        subscribers: this.resourceSubscriptions.subscribers(serverName, uri),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
      this.notifications?.onNotification({
        kind: "resourceListChanged",
        serverName,
        subscribers: this.resourceSubscriptions.allSubscribers(serverName),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
      const params = (notification as { params?: Record<string, unknown> }).params ?? {};
      this.notifications?.onNotification({
        kind: "loggingMessage",
        serverName,
        level: typeof params.level === "string" ? params.level : "info",
        ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
        data: params.data,
      });
    });
  }

  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    let record: McpServerRecord & { client: McpClient };
    if (options.appConnection) {
      const snapshot = this.appConnectionSnapshot(request.serverName);
      const current = this.records.get(request.serverName);
      if (
        !snapshot ||
        snapshot.identity !== options.appConnection.identity ||
        snapshot.generation !== options.appConnection.generation ||
        !current?.client
      )
        throw new Error("MCP App connection changed");
      options.signal?.throwIfAborted();
      record = current as McpServerRecord & { client: McpClient };
    } else {
      record = await this.resolveConnectedRecord(
        request.serverName,
        deadline,
        timeoutMessage,
        options.signal,
      );
    }

    try {
      return await this.callToolOnClient(
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    } catch (error) {
      if (options.appConnection) throw error;
      // Expired/revoked/under-scoped tokens after connect used to bubble raw and never self-heal, since OAuth
      // recovery existed only on the startup connect path. Runtime now shares the Phase 2 to Phase 1 orchestration.
      // path. Runtime now shares the Phase 2 to Phase 1 orchestration with connect.
      const trigger = classifyInteractiveAuthorizationTrigger(error);
      if (trigger && record.config.type !== "stdio") {
        return await this.recoverToolCallAuthorization({
          error,
          record,
          request,
          deadline,
          timeoutMessage,
          trigger,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
      }
      // Guard the not-yet-dispatched onclose race: the SDK throws bare Not connected on a broken transport.
      // Retry once, only for this known disconnected error; everything else bubbles.
      if (!(error instanceof Error) || error.message !== "Not connected") throw error;
      try {
        await waitWithinMcpDeadline(
          this.reconnectForCall(request.serverName, record.config),
          deadline,
          timeoutMessage,
          options.signal,
        );
      } catch (reconnectError) {
        this.logger?.warn("MCP server reconnect failed", {
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          event: "mcp.server.reconnect.failed",
          mcpServerName: request.serverName,
          status: "failed",
        });
        throw error;
      }
      const revived = this.records.get(request.serverName);
      if (!revived?.client || revived.status.status !== "connected") throw error;
      return await this.callToolOnClient(
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    }
  }

  /**
   // The plugin UI's `ui://` resource read. Shares callTool's connect-wait / reconnect skeleton (resolveConnectedRecord),
   // guaranteeing the same connection and OAuth recovery path; no per-tool OAuth second pass — a resource-read failure bubbles,
   // and the UI falls back to a plain card.
   */
  async readResource(
    request: McpReadResourceRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpReadResourceResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    const result = await record.client.readResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      contents: (result.contents ?? []).map((content) => {
        const item = content as Record<string, unknown>;
        return {
          uri: typeof item.uri === "string" ? item.uri : request.uri,
          ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          ...(typeof item.text === "string" ? { text: item.text } : {}),
          ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
          ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
        };
      }),
    };
  }

  /**
   // Shared by callTool / readResource: await the shared connecting task, reconnect a disconnected record once,
   // return a connected record. Extracted so resource reads and tool calls share the exact recovery path.
   */
  private async resolveConnectedRecord(
    serverName: string,
    deadline: McpDeadline,
    timeoutMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<McpServerRecord & { client: McpClient }> {
    const pending = this.records.get(serverName)?.connecting;
    if (pending) {
      // Why: connecting is the adapter-held shared connect/OAuth recovery task. This used to bare-await it,
      // caller's timeout/abort useless, while aborting the shared task kills other callers'
      // callback listener. Bound this waiter only; the shared task lives with the record.
      await waitWithinMcpDeadline(pending, deadline, timeoutMessage, signal);
    }

    // Bugfix: after a stdio MCP child dies (e.g. node_repl pierced by an async error) there was no recovery path at all:
    // connect happens once at session creation and resume does not rebuild, so the session's tools fail forever.
    // Reconnect broken records before the call; in-server state (REPL vars) is lost,
    // but the tools work again.
    const disconnected = this.records.get(serverName);
    if (disconnected && disconnected.status.status === "disconnected") {
      await waitWithinMcpDeadline(
        this.reconnectForCall(serverName, disconnected.config),
        deadline,
        timeoutMessage,
        signal,
      );
    }

    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") {
      throw new Error(`MCP server is not connected: ${serverName}`);
    }
    return record as McpServerRecord & { client: McpClient };
  }

  /** Connect-phase diagnostics per server; tool call request ids stay span-scoped. */
  private rememberServerResponse(
    serverName: string,
    response: OfficialMcpServerResponseInfo,
  ): void {
    if (
      !response.spanId &&
      response.rpcMethod !== "tools/call" &&
      this.records.get(serverName)?.status.status === "connecting"
    ) {
      if (response.failureKind) {
        this.connectionDiagnosticByServer.set(serverName, {
          failureKind: response.failureKind,
          ...(response.serverRequestId ? { serverRequestId: response.serverRequestId } : {}),
        });
      }
      return;
    }
    if (!response.spanId) return;
    if (!response.serverRequestId) return;
    // The 401 retry yields two responses per span, last-write-wins: the final one is exactly the one to report.
    this.serverRequestIdBySpan.set(response.spanId, response.serverRequestId);
    while (this.serverRequestIdBySpan.size > MAX_TRACKED_SERVER_REQUEST_IDS) {
      const oldest = this.serverRequestIdBySpan.keys().next();
      if (oldest.done) break;
      this.serverRequestIdBySpan.delete(oldest.value);
    }
  }

  /** Take and clear the span's request id; undefined when absent, never guessed. */
  private takeServerRequestId(spanId: string | undefined): string | undefined {
    if (!spanId) return undefined;
    const requestId = this.serverRequestIdBySpan.get(spanId);
    if (requestId !== undefined) this.serverRequestIdBySpan.delete(spanId);
    return requestId;
  }

  /**
   * Resolve identity headers for this outbound stdio official MCP message.
   * undefined means not-an-official-stdio-server: the key must not appear in _meta, or the
   * identity headers broadcast to arbitrary third-party plugins.
   */
  private async resolveOfficialStdioAuthMeta(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<OfficialMcpAuthMetaPayload | undefined> {
    if (config.type !== "stdio" || !isOfficialAuthConfig(config) || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    const resolveZCodeApiOrigin = this.officialMcpAuth?.resolveZCodeApiOrigin;
    const logBase = {
      event: "mcp.official_auth.stdio_meta",
      mcpKey: official.mcpKey,
      mcpServerName: serverName,
      module: "adapters.mcp",
    };
    const fail = (reason: OfficialMcpAuthFailureReason): OfficialMcpAuthMetaPayload => {
      // Deliberately no lastOfficialAuthKind: that map feeds failConnection's classification of connection
      // failures only. Missing stdio identity does not fail the connection; a stale entry would resurface
      // later as the cause of an unrelated disconnect. This path reports via its own event plus the reason payload.
      // This path's observability is its own event below plus the reason payload to the plugin.
      this.logger?.warn("Official MCP stdio auth headers unavailable", {
        ...logBase,
        reason,
        status: "failed",
      });
      return { ok: false, reason };
    };

    // A standalone CLI has no host auth port. Never omit the key silently: plugins cannot tell
    // host-unsupported from not-signed-in; only an explicit reason yields the right user hint.
    if (!authHeadersPort || !trustedOrigins || !resolveZCodeApiOrigin) {
      return fail("official_auth_unavailable");
    }

    // stdio has no url; origin comes from the host, not the plugin. isTrusted degenerates to always-true but still runs:
    // it validates https, rejects user:pass URLs, and keeps the dev loopback switch effective.
    //
    // Both used to be bare calls. Origin resolution reads settings/runtime env and isTrusted is
    // injected; either may throw, and a raw bubble skips the whole failure classification: the plugin never sees {ok:false, reason},
    // and reason is the cross adapter/host/UI contract (copy and retry policy). Map both to
    // official_auth_unavailable: from the plugin's view, an unresolvable trusted origin is exactly that.
    // Error text is log-only, never control flow.
    let targetOrigin: string;
    let trust: Awaited<ReturnType<OfficialMcpTrustedOriginRegistry["isTrusted"]>>;
    try {
      targetOrigin = resolveZCodeApiOrigin();
      trust = await trustedOrigins.isTrusted({
        mcpKey: official.mcpKey,
        origin: targetOrigin,
        pluginId: official.pluginId,
      });
    } catch (error) {
      this.logger?.warn("Official MCP stdio origin resolution failed", {
        ...logBase,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        pluginId: official.pluginId,
      });
      return fail("official_auth_unavailable");
    }
    if (!trust.trusted) {
      this.logger?.warn("Official MCP stdio origin is not trusted", {
        ...logBase,
        detail: trust.detail ?? "unknown",
        pluginId: official.pluginId,
        targetOrigin,
      });
      return fail("official_mcp_origin_untrusted");
    }

    const resolved = await authHeadersPort.resolveHeaders({
      mcpKey: official.mcpKey,
      pluginId: official.pluginId,
      targetOrigin,
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!resolved.ok) return fail(resolved.reason);

    // Header names and plan tier only, never values; log retention is uncontrolled.
    this.logger?.debug("Official MCP stdio auth headers attached", {
      ...logBase,
      identityHeaderNames: Object.keys(resolved.headers)
        .map((name) => name.toLowerCase())
        .sort(),
      ...(resolved.headers["Bigmodel-Target-Type"]
        ? { identityTargetType: resolved.headers["Bigmodel-Target-Type"] }
        : {}),
      status: "completed",
    });
    return { ok: true, headers: resolved.headers };
  }

  /** Server-initiated elicitation/create: attributed to the session of that server's current tool call, handed to the host question port. */
  private installElicitationHandler(client: McpClient, serverName: string): void {
    const port = this.elicitation;
    const setRequestHandler = (client as unknown as { setRequestHandler?: unknown })
      .setRequestHandler;
    if (!port || typeof setRequestHandler !== "function") return;
    (
      client as unknown as {
        setRequestHandler(
          method: "elicitation/create",
          handler: (request: {
            params: { message: string; requestedSchema?: unknown };
          }) => Promise<unknown>,
        ): void;
      }
    ).setRequestHandler("elicitation/create", async (request) => {
      // Accept default / "form" / compat "openai/form" / "openaiForm"; decline url and other modes.
      const mode = (request.params as { mode?: unknown }).mode;
      if (!isSupportedElicitationMode(mode)) {
        this.logger?.warn("MCP elicitation mode not supported, declining", {
          event: "mcp.elicitation.unsupported_mode",
          mcpServerName: serverName,
          mode: String(mode),
        });
        return { action: "decline" };
      }
      const trace = this.activeCallTraces.get(serverName);
      const result = await port.requestElicitation({
        serverName,
        message: request.params.message,
        requestedSchema: request.params.requestedSchema,
        ...(trace ? { trace } : {}),
      });
      return result.action === "accept"
        ? { action: "accept", content: result.content ?? {} }
        : { action: result.action };
    });
  }

  /** Registers the trace for the call's duration; only elicitations raised in that window attribute to the session / tool row. */
  private async callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    this.activeCallTraces.set(request.serverName, {
      ...(request.trace?.sessionId ? { sessionId: String(request.trace.sessionId) } : {}),
      ...(request.trace?.turnId ? { turnId: String(request.trace.turnId) } : {}),
      ...(request.trace?.traceId ? { traceId: String(request.trace.traceId) } : {}),
    });
    try {
      return await this.callToolOnClientInner(client, request, timeoutMs, signal, onProgress);
    } finally {
      this.activeCallTraces.delete(request.serverName);
    }
  }

  private async callToolOnClientInner(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    // Tool calls were logless: neither the budget nor slow-server-vs-small-budget was visible. Log budget and elapsed, keys of args only (values may be user input).
    // client-budget-too-small. Log budget and elapsed, arg keys only (values may be user input).
    const logBase = {
      event: "mcp.tool.call",
      mcpServerName: request.serverName,
      mcpToolName: request.toolName,
      module: "adapters.mcp",
      timeoutMs,
    };
    const argumentKeys = Object.keys(request.arguments ?? {}).sort();
    this.logger?.debug("MCP tool call started", {
      ...logBase,
      argumentKeys,
      status: "started",
    });

    const startedAt = Date.now();
    try {
      const result = await client.callTool(
        {
          name: request.toolName,
          arguments: request.arguments ?? {},
          ...(request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath
            ? { _meta: mcpRequestMeta(request) }
            : {}),
        },
        {
          signal,
          timeout: timeoutMs,
          // Progress notices reset the timeout (A8): a long task that keeps reporting is never cut by timeoutMs; total duration is bounded by the tool's _meta.timeoutMs.
          resetTimeoutOnProgress: true,
          ...(onProgress
            ? {
                onprogress: (notification: {
                  progress: number;
                  total?: number;
                  message?: string;
                }) =>
                  onProgress({
                    progress: notification.progress,
                    ...(notification.total !== undefined ? { total: notification.total } : {}),
                    ...(notification.message !== undefined
                      ? { message: notification.message }
                      : {}),
                  }),
              }
            : {}),
        },
      );

      const durationMs = Date.now() - startedAt;
      const isError = typeof result.isError === "boolean" ? result.isError : false;
      // Official in-band failures (quota, no plan) are HTTP 200 + isError, uncovered by the wrapper's
      // non-2xx warn; only the wrapper sees the request id, so take it here by span.
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      const outcome = {
        ...logBase,
        contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
        durationMs,
        hasStructuredContent: result.structuredContent !== undefined,
        // Business-level (isError) and transport-level failures must be countable separately.
        isError,
        ...(serverRequestId ? { serverRequestId } : {}),
      };
      if (isError) {
        // In-band failures had one debug line, invisible at the production Info floor:
        // quota exhaustion was wholly invisible in production logs.
        this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
      } else {
        this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
      }

      const meta = isRecord(result._meta) ? result._meta : undefined;
      return {
        content: Array.isArray(result.content)
          ? (result.content as McpContentBlock[])
          : [{ type: "text", text: "" }],
        structuredContent: result.structuredContent,
        isError: typeof result.isError === "boolean" ? result.isError : undefined,
        // Attach on failure only; on success it is noise. Never overwrite server-provided keys.
        _meta:
          isError && serverRequestId
            ? { ...meta, [ZCODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
            : meta,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      // Timeout detection: the SDK throws MCP error -32001 (RequestTimeout),
      // the underlying fetch abort throws AbortError. Both must be recognizable at a glance.
      const timedOut =
        /timed?\s*out|timeout/i.test(message) ||
        (error instanceof Error && error.name === "AbortError");
      // Attach on transport failure too: the 4xx/5xx SDK message carries no request id.
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      this.logger?.warn("MCP tool call failed", {
        ...logBase,
        argumentKeys,
        durationMs,
        error: message,
        ...(serverRequestId ? { serverRequestId } : {}),
        errorName: error instanceof Error ? error.name : "unknown",
        status: "failed",
        timedOut,
        // Elapsed near budget: we cut it; far below: the peer or network did.
        ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
      });
      throw error;
    }
  }

  private async reconnectForCall(name: string, config: McpServerConfig): Promise<void> {
    this.logger?.warn("MCP server reconnecting after lost connection", {
      event: "mcp.server.reconnect.started",
      mcpServerName: name,
      status: "started",
      transport: config.type,
    });
    await this.connectServer(name, config);
  }

  /**
   * Runtime auth recovery: Phase 2 interactive grant, Phase 1 reconnect, then at most one safe retry of the original call.
   *
   * Shares runInteractiveOAuthAuthorization with connect, so single-flight, fencing and caller budget semantics match exactly.
   */
  private async recoverToolCallAuthorization(input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    onProgress?: McpCallToolOptions["onProgress"];
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpToolCallResult> {
    const { record, request } = input;
    const config = record.config;
    if (config.type === "stdio") throw input.error;
    const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (!oauthConfig) throw input.error;

    this.logger?.warn("MCP tool call requires OAuth authorization", {
      event: "mcp.oauth.tool_call.authorization_required",
      mcpServerName: request.serverName,
      oauthTriggerReason: input.trigger.reason,
      status: "started",
      toolName: request.toolName,
    });

    const recovery = this.ensureToolCallAuthorizationRecovery({
      config,
      name: request.serverName,
      oauthConfig,
      record,
      trigger: input.trigger,
    });
    const recoveredStatus = await waitWithinMcpDeadline(
      recovery,
      input.deadline,
      input.timeoutMessage,
      input.signal,
    );
    if (recoveredStatus.status !== "connected") {
      throw input.error;
    }

    const revived = this.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw input.error;
    return await this.callToolOnClient(
      revived.client,
      request,
      remainingMcpDeadlineMs(input.deadline, input.timeoutMessage),
      input.signal,
      input.onProgress,
    );
  }

  /**
   * Create or reuse the runtime OAuth recovery. The full Phase 2 to Phase 1 is owned by the adapter record;
   * tool callers only await and must not terminate the shared transaction with their own AbortSignal.
   */
  private ensureToolCallAuthorizationRecovery(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const current = this.records.get(input.name);
    if (
      current?.connecting &&
      current.status.status === "connecting" &&
      isDeepStrictEqual(current.config, input.config)
    ) {
      return current.connecting;
    }

    const generation = this.nextConnectionGeneration(input.name);
    const abortController = new AbortController();
    const recoveryRecord: McpServerRecord = {
      abortController,
      config: input.config,
      status: this.createStatus(input.config, "connecting", {
        toolCount: input.record.tools.length,
      }),
      // Runtime tools are already advertised to core; keep descriptors during recovery so the page and borrow ports do not see tools vanish.
      tools: input.record.tools,
    };
    this.records.set(input.name, recoveryRecord);
    const connecting = this.runToolCallAuthorizationRecovery({
      abortController,
      config: input.config,
      generation,
      name: input.name,
      oauthConfig: input.oauthConfig,
      previousClient: input.record.client,
      previousTransport: input.record.transport,
      trigger: input.trigger,
    });
    recoveryRecord.connecting = connecting;
    return connecting;
  }

  private async runToolCallAuthorizationRecovery(input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const startedAt = Date.now();
    try {
      // The old transport's handshake and tokens are dead; only the shared owner may retire it. Never call connectServer here,
      // or closeRecord aborts recoveryRecord's own controller: self-cancellation.
      await this.closeClientAndTransport(input.name, input.previousClient, input.previousTransport);
      const outcome = await this.runInteractiveOAuthAuthorization({
        config: input.config,
        generation: input.generation,
        name: input.name,
        oauthConfig: input.oauthConfig,
        serverUrl: input.config.url,
        signal: input.abortController.signal,
        trigger: input.trigger,
      });
      if (outcome.status === "authorized" || outcome.status === "already-authorized") {
        return await this.openServerConnection({
          config: input.config,
          generation: input.generation,
          name: input.name,
          oauthAuthorizationAttempted: true,
          signal: input.abortController.signal,
          timeoutMs: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        });
      }
      return await this.failConnection({
        config: input.config,
        error:
          outcome.status === "pending"
            ? new Error(
                `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
              )
            : outcome.error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    } catch (error) {
      // Defense boundary: the shared recovery promise must be total. Any future orchestration throw also
      // settles as a failed record, never a rejected connecting promise poisoning later snapshots.
      return await this.failConnection({
        config: input.config,
        error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    }
  }

  async close(): Promise<void> {
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      this.nextConnectionGeneration(name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
    this.records.clear();
    this.connectionDiagnosticByServer.clear();
    this.logger?.info("MCP adapter closed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.adapter.closed",
      serverCount,
      status: "completed",
    });
  }

  private waitForSharedConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus> {
    const connecting = record.connecting;
    if (!connecting) return Promise.resolve(record.status);
    if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
      return connecting;
    }

    let abortHandler: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const currentStatus = () => this.records.get(name)?.status ?? record.status;
    const waiters: Promise<McpServerStatus>[] = [connecting];

    const timeoutMs = options.oauthAuthorizationTimeoutMs;
    if (timeoutMs !== undefined) {
      waiters.push(
        new Promise((resolvePromise) => {
          timeoutId = setTimeout(() => resolvePromise(currentStatus()), timeoutMs);
        }),
      );
    }
    if (options.signal) {
      waiters.push(
        new Promise((resolvePromise) => {
          if (options.signal?.aborted) {
            resolvePromise(currentStatus());
            return;
          }
          abortHandler = () => resolvePromise(currentStatus());
          options.signal?.addEventListener("abort", abortHandler, {
            once: true,
          });
        }),
      );
    }

    return Promise.race(waiters).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    });
  }

  private async openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus> {
    const {
      config,
      generation,
      name,
      oauthAuthorizationAttempted = false,
      oauthAuthorizationTimeoutMs,
      signal,
      timeoutMs,
      workingDirectory,
    } = input;
    const startedAt = Date.now();
    let client: McpClient | undefined;
    let connectDurationMs: number | undefined;
    let getRecentStderr: (() => string | undefined) | undefined;
    let listToolsDurationMs: number | undefined;
    let transport: McpTransport | undefined;
    let failureKind: McpServerFailureKind =
      config.type === "stdio" ? "process_start_failed" : "network_unreachable";

    try {
      const transportBundle = await this.createTransport(
        config,
        name,
        generation,
        oauthAuthorizationTimeoutMs,
        workingDirectory,
        signal,
      );
      transport = transportBundle.transport;
      getRecentStderr = this.attachStdioLogging(name, transport);
      client = new Client(
        {
          name: this.clientName,
          version: this.clientVersion,
        },
        {
          versionNegotiation: resolveVersionNegotiation(config, timeoutMs),
          capabilities: {
            // MCP Apps spec: the host declares renderable UI mime types via `extensions["io.modelcontextprotocol/ui"]`;
            // the official SDK's server decides from it whether to send ui resources (getUiCapability).
            ...buildMcpAppsClientCapabilities(),
            // Only the form mode is declared (no url mode); the server picks the elicitation shape from it.
            ...(this.elicitation ? { elicitation: { form: {} } } : {}),
          },
        },
      );
      this.installElicitationHandler(client, name);
      this.installNotificationHandlers(client, name);
      this.updateCurrentRecord(name, generation, {
        client,
        transport,
      });

      const connectStartedAt = Date.now();
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        `MCP server ${name} connection timed out after ${timeoutMs}ms`,
        signal,
      );
      connectDurationMs = Date.now() - connectStartedAt;

      failureKind = "tool_list_failed";
      const listToolsStartedAt = Date.now();
      const listed = await withTimeout(
        client.listTools(),
        timeoutMs,
        `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
        signal,
      );
      listToolsDurationMs = Date.now() - listToolsStartedAt;
      const tools = listed.tools.map((tool) =>
        normalizeMcpToolDescriptor(
          name,
          tool,
          config.timeoutMs,
          // Set for the http form only. The flag vouches for structured markers in the result
          // (quota/no-plan), so the test must be who produced the result:
          //   http: the ZCode backend, with per-request origin validation; sign-on resolves at
          //     tools/call, else the same trusted backend returns structured coding_plan_required;
          //   stdio: the plugin process itself, free to fake {"error_code":"quota_exceeded"} and
          //     trigger a misleading out-of-credit banner above the input box.
          // The old type !== sse check let stdio through, zeroing the gate there.
          // This gates result forgery, not credential leakage (origin validation's job).
          config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
        ),
      );
      const negotiatedProtocolEra = client.getProtocolEra();
      const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
      const status = this.createStatus(config, "connected", {
        protocolEra: negotiatedProtocolEra,
        toolCount: tools.length,
      });
      if (!this.isCurrentConnection(name, generation)) {
        await this.closeClientAndTransport(name, client, transport);
        return this.records.get(name)?.status ?? status;
      }
      this.connectionDiagnosticByServer.delete(name);
      this.records.set(name, {
        client,
        config,
        status,
        tools,
        transport,
      });
      // A3: after reconnect (same adapter instance) replay subscriptions from the registry; first connect has an empty registry, skip.
      await this.replayResourceSubscriptions(name, client);
      const mcpTransportPid = getStdioTransportPid(transport);
      const mcpProcessIdentity =
        mcpTransportPid != null && this.connectionContext
          ? this.telemetry?.recordProcessStarted({
              connectionId: this.connectionContext.mcpConnectionId,
              pid: mcpTransportPid,
            })
          : undefined;
      // A dead stdio child (node_repl pierced by an async cell error) must not pass silently:
      // no log, status stuck connected, later calls throw bare Not connected.
      // onclose makes unexpected drops explicit; the graceful path clears it first (closeClientAndTransport).
      client.onclose = () => {
        if (!this.isCurrentConnection(name, generation)) return;
        const current = this.records.get(name);
        if (!current || current.client !== client) return;
        this.nextConnectionGeneration(name);
        const recentStderr = getRecentStderr?.();
        const processExit = getStdioTransportExitInfo(transport);
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server connection closed unexpectedly",
          failureKind: "unexpected_disconnect",
        });
        this.logger?.warn("MCP server connection lost", {
          ...this.connectionContext,
          event: "mcp.server.connection_lost",
          mcpServerName: name,
          ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
          ...(mcpProcessIdentity ?? {}),
          ...(processExit
            ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
            : {}),
          status: "failed",
          transport: current.config.type,
          ...(recentStderr ? { stderr: recentStderr } : {}),
        });
        if (
          current.config.type === "stdio" &&
          this.connectionContext &&
          (processExit || !isStdioTransportProcessAlive(transport))
        ) {
          this.telemetry?.recordProcessCrashed({
            connectionId: this.connectionContext.mcpConnectionId,
            exitCode: processExit?.exitCode ?? null,
            signal: processExit?.signal ?? null,
          });
        }
      };
      // Connect logs used to record the transport only, leaving the negotiated modern/legacy choice invisible.
      // Record both the configured policy and the SDK handshake result; never present auto as a final version.
      // Pool context and stdio PID now share one event, joining session,
      // workspace, protocol version and real child; the stdio PID is the session transport, not the probe child.
      this.logger?.info("MCP server connected", {
        ...this.connectionContext,
        connectDurationMs,
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connected",
        listToolsDurationMs,
        mcpClientName: this.clientName,
        mcpClientVersion: this.clientVersion,
        mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
        mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
        mcpServerName: name,
        ...(mcpProcessIdentity ?? {}),
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
        status: "completed",
        toolCount: tools.length,
        transport: config.type,
      });
      return status;
    } catch (error) {
      // The old wait targeted the legacy provider's own listener with the session's 15s budget as a
      // hard close: 15s is the caller wait, not the grant lifetime. Now classify whether interactive
      // grant is needed and hand it to the isolated Phase 2 transaction (own lock, fresh DCR, 300s TTL).
      const trigger = oauthAuthorizationAttempted
        ? undefined
        : classifyInteractiveAuthorizationTrigger(error);
      const authorizationCodeOAuthConfig =
        trigger && config.type !== "stdio"
          ? resolveAuthorizationCodeOAuthConfig(config)
          : undefined;
      if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
        // On negotiation failure the SDK already closed the transport; Phase 2 needs none either.
        await this.closeClientAndTransport(name, client, transport);
        const outcome = await this.runInteractiveOAuthAuthorization({
          config,
          generation,
          name,
          oauthConfig: authorizationCodeOAuthConfig,
          serverUrl: config.url,
          signal,
          trigger,
        });
        if (outcome.status === "authorized" || outcome.status === "already-authorized") {
          return await this.openServerConnection({
            ...input,
            oauthAuthorizationAttempted: true,
          });
        }
        // client/transport closed before Phase 2, pass none; failureKind keeps the
        // diagnostic class so the page separates incomplete-grant from network/process failures.
        return this.failConnection({
          config,
          connectDurationMs,
          error:
            outcome.status === "pending"
              ? new Error(
                  `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
                )
              : outcome.error,
          failureKind: "oauth_authorization_failed",
          generation,
          getRecentStderr,
          listToolsDurationMs,
          name,
          startedAt,
        });
      }
      // The protocol_negotiation_failed enum and copy existed in shared/i18n, but the adapter never produced it:
      // under auto/pin a hard SDK server/discover probe failure (typically non-standard servers replying
      // HTTP 200 + id:null JSON-RPC errors whose body fails
      // JSONRPCMessageSchema) fell through to failureKind network_unreachable, and the page showed a misleading network error.
      // Classify SDK negotiation failure structurally (SdkErrorCode / isInstance), never by text; withTimeout does not wrap errors (timeout.ts
      // rethrows), cause chain is defensive only.
      //
      const negotiationFailureKind = isProtocolNegotiationFailure(error)
        ? ("protocol_negotiation_failed" as const)
        : undefined;
      return this.failConnection({
        client,
        config,
        connectDurationMs,
        error,
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
        transport,
        failureKind: negotiationFailureKind ?? failureKind,
      });
    }
  }

  /**
   * Phase 2: interactive grant.
   *
   * The grant transaction lives 300s, independent of the caller wait (session 15s); the caller-side
   * bound lives in connectServer/waitForSharedConnection, unseen here.
   */
  private async runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome> {
    try {
      const oauthOptions = this.createAuthorizationCodeOAuthOptions(
        input.config,
        input.name,
        input.generation,
      );
      const credentialStore = oauthOptions?.credentialStore ?? createSharedZCodeCredentialStore();
      const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
      // The final 403 step-up scope must union config, token.scope and challenge.
      // Re-granting with challenge scope only lets the server claw back previously granted scopes;
      // the next challenge 403s again: re-grant ping-pong. The token response scope is optional
      // (RFC 6749 3.3), so configured scopes must be unioned explicitly, never trusted from the echo.
      let requestedScope: string | undefined = input.oauthConfig.scope;
      if (input.trigger.requiredScope) {
        const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
        requestedScope = computeScopeUnion(
          input.oauthConfig.scope,
          currentPair?.tokens?.scope,
          input.trigger.requiredScope,
        );
      }
      return await runMcpInteractiveAuthorization({
        adapterInstanceId: this.adapterInstanceId,
        config: input.oauthConfig,
        credentialStore,
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        // 403 step-up: when requiredScope strictly extends the token scope, refresh cannot widen
        // (RFC 6749 6); force re-grant or the new scope is silently dropped and 403 repeats.
        ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
        keyPrefix,
        logger: this.logger,
        ...(oauthOptions?.onAuthorizationRequired
          ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
          : {}),
        ...(oauthOptions?.openAuthorizationUrl
          ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
          : {}),
        ...(requestedScope ? { requestedScope } : {}),
        ...(input.trigger.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
          : {}),
        serverName: input.name,
        serverUrl: input.serverUrl,
        signal: input.signal,
        transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
      });
    } catch (error) {
      // The return type already models orchestration failure as an outcome. Credential-load,
      // lease or follower-callback throws used to reject bare, bypassing failConnection, leaving
      // status connecting plus a rejected record.connecting and failing the whole connectConfiguredServers batch.
      this.logger?.warn("MCP OAuth authorization orchestration failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        event: "mcp.oauth.authorization.orchestration_failed",
        mcpServerName: input.name,
        status: "failed",
      });
      return { status: "failed", error };
    }
  }

  private async failConnection(input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  }): Promise<McpServerStatus> {
    const {
      client,
      config,
      connectDurationMs,
      error,
      failureKind: fallbackFailureKind,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
    } = input;
    const message = error instanceof Error ? error.message : String(error);
    // Stable classes of official auth failure must reach logs: failConnection logged only
    // error.message, where most classes never appear (only the auth-port one did), so
    // official_mcp_origin_untrusted / official_auth_rejected were ungreppable in production.
    const officialAuthKind =
      (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
      this.lastOfficialAuthKind.get(name);
    this.lastOfficialAuthKind.delete(name);
    const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
    this.connectionDiagnosticByServer.delete(name);
    const failureKind =
      (officialAuthKind === "official_mcp_origin_untrusted"
        ? "official_origin_untrusted"
        : undefined) ??
      responseDiagnostic?.failureKind ??
      (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
        ? "connection_timeout"
        : undefined) ??
      fallbackFailureKind ??
      "connection_failed";
    const displayMessage = responseDiagnostic?.serverRequestId
      ? `${message} - ${responseDiagnostic.serverRequestId}`
      : message;
    const status = this.createStatus(config, "failed", {
      error: displayMessage,
      failureKind,
      ...(responseDiagnostic?.serverRequestId
        ? { serverRequestId: responseDiagnostic.serverRequestId }
        : {}),
    });
    const recentStderr = getRecentStderr?.();
    const mcpTransportPid = getStdioTransportPid(transport);
    await this.closeClientAndTransport(name, client, transport);
    if (!this.isCurrentConnection(name, generation)) {
      return this.records.get(name)?.status ?? status;
    }
    this.records.set(name, { config, status, tools: [] });
    this.logger?.warn("MCP server connection failed", {
      ...this.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      error: displayMessage,
      event: "mcp.server.failed",
      listToolsDurationMs,
      mcpServerName: name,
      ...(officialAuthKind ? { officialAuthKind } : {}),
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "failed",
      ...(recentStderr ? { stderr: recentStderr } : {}),
      transport: config.type,
    });
    return status;
  }

  private async createTransport(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    _oauthAuthorizationTimeoutMs?: number,
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ transport: McpTransport }> {
    if (config.type === "stdio") {
      return {
        transport: new ProcessTreeStdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd
            ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
            : (workingDirectory ?? this.workingDirectory),
          env: {
            ...buildMcpStdioEnv({ env: this.env, network: this.network }),
            ...config.env,
          },
          stderr: "pipe",
          ...(isOfficialAuthConfig(config) && config.official
            ? {
                requestMetaProvider: async () => {
                  const authMeta = await this.resolveOfficialStdioAuthMeta(
                    serverName,
                    config,
                    signal,
                  );
                  return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
                },
              }
            : {}),
        }),
      };
    }

    const fetch = createMcpTransportFetch({
      env: this.env,
      network: this.network,
    });
    if (config.type === "http") {
      const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          // On the official auth path authProvider is always undefined: no OAuth credentials,
          // no localhost callback server, no 401/403-to-grant redirection.
          authProvider: this.createOAuthClientProvider(serverName, config),
          fetch: officialAuthFetch ?? fetch,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        }),
      };
    }

    return {
      transport: new SSEClientTransport(new URL(config.url), {
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  /**
   * Dynamic fetch for official-auth MCP; undefined means the plain MCP path.
   *
   * Missing trusted-origin deps fail closed. A missing auth port is fine: the wrapper still validates origin,
   * requests degrade to anonymous, the server is the authority.
   */
  private createOfficialAuthFetch(
    config: McpServerConfig,
    serverName: string,
    generation: number,
  ): typeof globalThis.fetch | undefined {
    if (!isOfficialAuthConfig(config) || config.type !== "http" || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    if (!trustedOrigins) {
      return (() => {
        throw new OfficialMcpAuthError(
          "official_auth_unavailable",
          `official MCP trusted origin registry is not available in this runtime: ${serverName}`,
        );
      }) as unknown as typeof globalThis.fetch;
    }
    return createOfficialMcpAuthFetch({
      baseFetch: createMcpTransportFetch({ env: this.env, network: this.network }),
      official,
      onAuthFailure: (kind) => this.lastOfficialAuthKind.set(serverName, kind),
      onServerResponse: (response) => {
        if (this.isCurrentConnection(serverName, generation)) {
          this.rememberServerResponse(serverName, response);
        }
      },
      serverName,
      trustedOrigins,
      url: config.url,
      ...(authHeadersPort ? { authHeadersPort } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
    });
  }

  /**
   * Runtime auth provider.
   *
   * Any HTTP/SSE MCP without an Authorization header used to get a full OAuth session,
   * whose listen(0) callback server started before returning even with perfectly valid credentials.
   * A full OAuthClientProvider also routed 401 into the SDK auth(), bypassing our refresh single-flight lock.
   // auth(), bypassing our refresh single-flight lock.
   *
   * Now authorization_code always uses the pure AuthProvider: passive connect has zero listeners/discovery/DCR,
   * and interactive grant happens only in the Phase 2 transaction.
   */
  private createOAuthClientProvider(
    serverName: string,
    config: McpServerConfig,
  ): AuthProvider | OAuthClientProvider | undefined {
    if (config.type === "stdio") return undefined;
    // Official auth and OAuth are mutually exclusive: official failures are solved by ZCode sign-in/plan only;
    // handing out any authProvider misroutes 401 into the MCP grant flow.
    if (isOfficialAuthConfig(config)) return undefined;
    const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (authorizationCodeOAuthConfig) {
      return createMcpOAuthTokenProvider({
        config: authorizationCodeOAuthConfig,
        credentialStore: this.resolveCredentialStore(),
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
        ...(this.logger ? { logger: this.logger } : {}),
        serverName,
        serverUrl: config.url,
      });
    }
    if (config.oauth?.type === "client_credentials") {
      return new ClientCredentialsProvider({
        clientId: config.oauth.clientId,
        clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
        clientSecret: config.oauth.clientSecret,
        scope: config.oauth.scope,
      });
    }
    return undefined;
  }

  private resolveCredentialStore(): SharedZCodeCredentialStore {
    this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedZCodeCredentialStore();
    return this.credentialStore;
  }

  private createAuthorizationCodeOAuthOptions(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    oauthAuthorizationTimeoutMs?: number,
  ): McpOAuthRuntimeOptions | undefined {
    if (config.type === "stdio") return this.mcpOAuth;
    return {
      ...this.mcpOAuth,
      authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
      onAuthorizationRequired: async (context) => {
        this.updateCurrentRecordStatus(serverName, generation, {
          authorization: createOAuthAuthorizationStatus(context),
          status: "connecting",
        });
        await this.mcpOAuth?.onAuthorizationRequired?.(context);
      },
    };
  }

  private attachStdioLogging(name: string, transport: McpTransport): () => string | undefined {
    const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
    const stderr = (
      transport as {
        stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
      }
    ).stderr;
    stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer.append(text);
      this.logger?.debug("MCP stdio stderr", {
        event: "mcp.stdio.stderr",
        mcpServerName: name,
        stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
      });
    });
    return () => {
      const text = stderrBuffer.read();
      if (!text) return undefined;
      // A lone Connection closed cannot explain a stdio child exit in production logs.
      // Attach a redacted stderr tail to the failure event only.
      return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
    };
  }

  private async closeRecord(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
    if (!record.client && !record.transport) return;
    await this.closeClientAndTransport(name, record.client, record.transport);
  }

  private async closeClientAndTransport(
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void> {
    const startedAt = Date.now();
    const mcpTransportPid = getStdioTransportPid(transport);
    // Remove the connection_lost listener before graceful close so normal reaps are not misreported as drops.
    if (client) client.onclose = undefined;
    // The SDK close guarantees only the direct stdio child; npx/npm wrappers or the
    // chrome-devtools-mcp watchdog may linger; reap the tree explicitly, then SDK-close the protocol state.
    await this.terminateStdioProcessTree(name, transport);

    try {
      await client?.close();
    } catch (error) {
      this.logger?.debug("MCP client close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.client.close.failed",
        mcpServerName: name,
      });
    }

    try {
      await transport?.close();
    } catch (error) {
      this.logger?.debug("MCP transport close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.transport.close.failed",
        mcpServerName: name,
      });
    }
    if (
      this.connectionContext &&
      transport instanceof ProcessTreeStdioClientTransport &&
      !transport.processAlive
    ) {
      this.telemetry?.recordProcessClosed({
        connectionId: this.connectionContext.mcpConnectionId,
      });
    }
    this.logger?.info("MCP server closed", {
      ...this.connectionContext,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.closed",
      mcpServerName: name,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "completed",
    });
  }

  private async terminateStdioProcessTree(name: string, transport?: McpTransport): Promise<void> {
    const pid = getStdioTransportPid(transport);
    if (pid == null) return;

    try {
      await terminateMcpStdioProcessTree(pid);
    } catch (error) {
      this.logger?.warn("MCP stdio process tree cleanup failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.stdio.process_tree_cleanup.failed",
        mcpServerName: name,
        mcpTransportPid: pid,
        pid,
        status: "failed",
      });
    }
  }

  private readonly appConnectionListeners = new Map<string, Set<() => void>>();
  onAppConnectionInvalidated(name: string, listener: () => void): () => void {
    const listeners = this.appConnectionListeners.get(name) ?? new Set();
    listeners.add(listener);
    this.appConnectionListeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.appConnectionListeners.delete(name);
    };
  }
  appConnectionSnapshot(name: string): { identity: string; generation: number } | null {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") return null;
    // Only a summary reaches the host; config credentials never enter protocol or logs. Key order avoids config serialization order forcing a source switch.
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        );
      return value;
    };
    return {
      identity: createHash("sha256")
        .update(
          JSON.stringify([
            process.platform,
            process.execPath,
            this.workingDirectory ?? "",
            name,
            canonical(record.config),
          ]),
        )
        .digest("hex"),
      generation: this.connectionGenerations.get(name) ?? 0,
    };
  }

  private nextConnectionGeneration(name: string): number {
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);
    // eslint-disable-next-line unicorn/no-useless-spread -- the callback may add/remove listeners; this notification must pin its recipients.
    for (const listener of [...(this.appConnectionListeners.get(name) ?? [])]) listener();
    return generation;
  }

  private isCurrentConnection(name: string, generation: number): boolean {
    return this.connectionGenerations.get(name) === generation;
  }

  private updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    Object.assign(record, patch);
  }

  private updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    record.status = {
      ...record.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  private createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    } = {},
  ): McpServerStatus {
    return {
      status,
      transport: config.type,
      toolCount: extra.toolCount ?? 0,
      updatedAt: new Date().toISOString(),
      authorization: extra.authorization,
      error: extra.error,
      failureKind: extra.failureKind,
      protocolEra: extra.protocolEra,
      serverRequestId: extra.serverRequestId,
    };
  }
}

function mcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // nodeRepl.requestMeta. Every ZCode MCP server may ignore these extension keys; the node_repl browser
  // bridge uses them as the only join back to the current BrowserControlPort session. runtime_scope
  // cannot be guessed from the child session id; the executing runtime must pass it explicitly.
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.zcode/request-context": requestContext,
  };
}

function resolveVersionNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.protocolVersion === "2026-07-28") return { pin: "2026-07-28" };
  // The deprecated SSE transport carries the legacy era only; an explicit modern pin must fail, not silently downgrade.
  if (config.type === "sse") return "legacy";
  if (config.protocolVersion === "legacy") return "legacy";
  return "auto";
}

/**
 * Stable detection of SDK version-negotiation (auto/pin server/discover probe) failure.
 *
 * Structural only, no text matching:
 * - SdkError(SdkErrorCode.EraNegotiationFailed): hard probe failure (including malformed 200s of non-standard
 *   legacy servers, failing transport Zod validation into the network-error branch);
 * - UnsupportedProtocolVersionError: recognized modern error, pin rejected by the server.
 */
function isProtocolNegotiationFailure(error: unknown): boolean {
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed) {
    return true;
  }
  if (UnsupportedProtocolVersionError.isInstance(error)) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return isProtocolNegotiationFailure(cause);
  }
  return false;
}

function formatVersionNegotiationMode(config: McpServerConfig): string {
  const mode = resolveVersionNegotiationMode(config);
  return typeof mode === "object" ? mode.pin : mode;
}

function resolveVersionNegotiation(
  config: McpServerConfig,
  timeoutMs: number,
): VersionNegotiationOptions {
  const mode = resolveVersionNegotiationMode(config);
  if (mode === "legacy") return { mode };

  // pin has no legacy fallback, the probe is the only initialize path; reusing auto's 5s
  // cap ignores server budgets and silently evicts slow-starting node_repl from the tool pool.
  const probeTimeoutMs =
    typeof mode === "object"
      ? Math.max(1, Math.floor(timeoutMs))
      : Math.min(MAX_MCP_VERSION_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));

  return {
    mode,
    probe: {
      // The SDK stdio auto/pin starts a disposable sibling first; with the SDK's 60s default,
      // ZCode's total connect timeout would fire first, orphaning the probe and starving legacy initialize.
      timeoutMs: probeTimeoutMs,
    },
  };
}

function createOAuthAuthorizationStatus(
  context: McpOAuthAuthorizationContext,
): NonNullable<McpServerStatus["authorization"]> {
  return {
    type: "oauth_authorization_code",
    authorizationUrl: context.authorizationUrl,
    startedAt: new Date().toISOString(),
  };
}

function resolveAuthorizationCodeOAuthConfig(
  config: McpServerConfig,
): AuthorizationCodeOAuthConfig | undefined {
  if (config.type === "stdio") return undefined;
  // Official auth preempts MCP OAuth; this must precede every existing branch:
  // official MCP writes no oauth field and forbids static authorization headers; without the short-circuit it falls
  // into the authorization_code fallback, popping the MCP grant UI on 401, though official failures
  // are solvable only by ZCode sign-in/plan, never by the target server's OAuth.
  if (isOfficialAuthConfig(config)) return undefined;
  if (config.oauth?.type === "authorization_code") return config.oauth;
  if (config.oauth?.type === "client_credentials") return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;

  // Fresh HTTP/SSE entries often store just the URL; OAuth support should be triggered by
  // WWW-Authenticate/discovery, never require a pre-written oauth field.
  return {
    type: "authorization_code",
  };
}

/**
 * True on exact auth.type/provider match with provenance present; no provenance means not Plugin-loader
 * produced.
 *
 * Covers http and stdio: different credential channels, one official-auth notion. Callers caring about one
 * form re-check config.type themselves (createOfficialAuthFetch handles http, _meta injection stdio).
 * handles http, _meta injection stdio).
 */
function isOfficialAuthConfig(config: McpServerConfig): boolean {
  return (
    (config.type === "http" || config.type === "stdio") &&
    config.auth?.type === "zcode_official" &&
    config.auth.provider === "jwt_token" &&
    config.official !== undefined
  );
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
      }
    },
    read() {
      return value;
    },
  };
}

function sanitizeMcpStdioStderr(text: string): string {
  const sensitiveKey = String.raw`(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  result = result.replace(
    new RegExp(`(["']${sensitiveKey}["']\\s*:\\s*)(["'])(?:(?!\\2).)*\\2`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}

function getStdioTransportPid(transport?: McpTransport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) return undefined;
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function getStdioTransportExitInfo(transport?: McpTransport):
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | undefined {
  return transport instanceof ProcessTreeStdioClientTransport ? transport.processExit : undefined;
}

function isStdioTransportProcessAlive(transport?: McpTransport): boolean {
  return transport instanceof ProcessTreeStdioClientTransport && transport.processAlive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A JSON-RPC error reply (numeric code) proves the request went through and the connection lives;
// only SDK-local errors (SdkError, string codes REQUEST_TIMEOUT/CONNECTION_CLOSED/NOT_CONNECTED
//SEND_FAILED) mean the transport died. The code-type check backstops instanceof across duplicate SDK copies.
function isPeerAnsweredError(error: unknown): boolean {
  if (error instanceof ProtocolError) return true;
  return isRecord(error) && typeof error.code === "number";
}
