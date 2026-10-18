import {
  createRootTraceContext,
  createTraceId,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type SessionEventStorePort,
  type SessionId,
  type SessionTaskType,
  type SessionStorePort,
  type TraceContext,
} from "@zcode/contracts";
import type { McpTelemetryTracker } from "@zcode/adapters";
import type { WorkspaceHookPolicyProvider } from "@zcode/core";
import type { AccountProviderConfigSnapshot } from "@zcode/provider";
import {
  zcodeProtocolErrorCodes,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeDeliveryKind,
  type ModelSelection,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolMessage,
  type ZCodeProtocolMethod,
  type ZCodeProtocolNotification,
  type ZCodeProtocolRequest,
  type ZCodeProtocolRequestId,
  type ZCodeProtocolTrace,
  type ZCodeSessionMode,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import type { V4InteractionRegistry } from "../zcode-protocol-v4/interaction-registry.js";
import type { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import type { SessionResidentPool, SessionResidentPoolOptions } from "./session-resident-pool.js";
import type { DynamicWorkflowMode } from "@zcode/shared";

export interface ParamsSchema<T> {
  parse(input: unknown): T;
}

export interface ZCodeProtocolAgentDependencies {
  createZCodeApp(options?: Omit<ZCodeAppOptions, "providerRegistry">): ZCodeApp | Promise<ZCodeApp>;
  /**
   * Per-session-record in-memory event store factory.
   * Default turn-window retention; tests inject spies or unbounded impls for contrast.
   */
  createSessionEventStore?(sessionId: string): SessionEventStorePort;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  mcpPort?: McpPort;
  /** Resource explorer: `process/childProcesses` reads MCP child pids and plugin ownership. */
  mcpTelemetry?: Pick<McpTelemetryTracker, "listProcesses">;
  platform?: NodeJS.Platform | string;
  /** Only for constructing a single CLI/app-server hybrid residency; production defaults live in the pool. */
  sessionResidentPoolOptions?: SessionResidentPoolOptions;
  /** Legacy test/embed compat; new code sets low-water via sessionResidentPoolOptions. */
  sessionResidentTargetCount?: number;
  sessionStore?: SessionStorePort;
  version?: string;
  /** The trusted Host's Hook policy; workspace/project config must not override it. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Syncs the Host-account-derived third-layer Config Overlay into the process Registry. */
  syncAccountProviderConfig?: (snapshot: AccountProviderConfigSnapshot) => Promise<boolean>;
  /** Before a connection test, re-read the process's Config Source and wait for the Registry to publish. */
  refreshProviderRegistry?: (reason: string) => Promise<void>;
}

export type ZCodeProtocolAgentResolvedDependencies = ZCodeProtocolAgentDependencies & {
  createSessionEventStore(sessionId: string): SessionEventStorePort;
  workspaceHookPolicyProvider: WorkspaceHookPolicyProvider;
};

export interface ZCodeProtocolEventSequenceState {
  lastSeq: number;
  seqBySourceEventKey: Map<string, number>;
}

export interface ZCodeProtocolToolInputTransmissionState {
  streamedToolCallIdsWithInput: Set<string>;
}

export interface ZCodeProtocolSessionRecord {
  app: ZCodeApp;
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  nativeSearchEnhancementsEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  createdAt: number;
  deliveryKind?: ZCodeDeliveryKind;
  /**
   * Legacy session/subscribe has no unsubscribe RPC; set only on a real subscribe, never
   * via the deliveryKind that session/read writes. Connection end destroys the whole CLI process.
   */
  legacyStreamSubscribed?: boolean;
  eventStore: SessionEventStorePort;
  parentSessionId?: SessionId;
  persistence: ZCodeSessionPersistence;
  protocolEventSequences: Map<string, ZCodeProtocolEventSequenceState>;
  protocolToolInputTransmissions: Map<string, ZCodeProtocolToolInputTransmissionState>;
  stateRevision: number;
  taskType?: SessionTaskType;
  traceContext: TraceContext;
  unsubscribe?: () => void;
  updatedAt: number;
  workspace: ZCodeWorkspaceRef;
  activeAbortController?: AbortController;
  /** After the background runner releases the ready lock, the refcount of pending persistence/snapshot/broadcast. */
  residencyFinalizationCount?: number;
  /** The automation dispatch turn in flight; lives only during the turn, forbidding recursive CronCreate. */
  activeAutomationId?: string;
  /** The off-peak dispatch turn in flight; lives only during the turn, forbidding recursive OffPeakCreate. */
  activeOffPeakTaskId?: string;
  /** The current bot-inbound turn's stable callback address; only CronCreate may read it this turn. */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  restoreWarning?: { message: string; type: string };
  /** Cold-restore candidates serve the initial projection only; a new model-selection event clears them -- never a Runtime execution binding. */
  restoredModelSelection?: ModelSelection;
}

export interface ZCodeProtocolClientRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  trace?: ZCodeProtocolTrace;
  reannounceIntervalMs?: number;
}

export interface ZCodeProtocolAgentServerContext {
  /** During process exit, late async materializations must not re-register sessions. */
  assertServing?: () => void;
  deps: ZCodeProtocolAgentResolvedDependencies;
  logger?: Logger;
  appRuntimePreferences: {
    askUserQuestionAutoResolutionEnabled: boolean;
    modelIoFullRetentionEnabled: boolean;
    /** The host-synced Off-Peak tool-surface gate; default false (fail-closed), read by host-less paths such as the v4 cold restore. */
    offPeakToolEnabled: boolean;
    /**
     * The host-synced dynamic-workflow rollout gate.
     * Default false (fail-closed): on legacy Hosts without the method, or in the pre-sync startup window,
     * the workflow tool surface, `/workflow`, and dynamic-workflow skills all stay hidden.
     */
    dynamicWorkflowEnabled: boolean;
    /**
     * The gradation mode arriving with dynamicWorkflowEnabled (launch.md "On demand: activation").
     // Absent (legacy Boolean-only hosts) = alwaysOn; onDemand makes createRecord write runtimeConfig.dynamicWorkflowToolsOnDemand.
     */
    dynamicWorkflowMode?: DynamicWorkflowMode;
  };
  // Vertical slice: the v4 conversation channel (subscribe/frames/commands), coexisting with legacy session/* methods.
  // The construction-order issue (gateway closure holds context) closes via an optional field, assigned right after server construction.
  v4Gateway?: ConversationV4Gateway;
  // Where the v4 forward command resolveInteraction meets the reverse requests (permission/AskUserQuestion).
  // The broker registers deferreds, the v4 command face delivers answers (one instance, injected into V4CommandCoreHost via the binder).
  v4Interactions: V4InteractionRegistry;
  // The single-CLI resident session pool. The cold-restore entrance awaits the old app.close via waitForDeactivation;
  // protocol requests hold the operation lease, keeping async handlers and capacity reclamation from interleaving.
  sessionResidentPool?: SessionResidentPool;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  notify(notification: ZCodeProtocolNotification): void;
  requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T>;
}

/** Protocol error codes for server->client request failures; thrown in server.ts, translated by code at the adapter layer — no literals in business logic. */
export const PROTOCOL_CLIENT_REQUEST_ERROR_CODES = {
  /** No ZCode Protocol client is attached; the request cannot be delivered. */
  noClientAttached: -32020,
  /** The request was cancelled before a response arrived. */
  cancelled: -32021,
  /** The request timed out waiting for a response. */
  timedOut: -32022,
} as const;

export class ProtocolRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolRequestError";
  }
}

export function isRequest(message: ZCodeProtocolMessage): message is ZCodeProtocolRequest {
  return "method" in message && "id" in message;
}

export function isNotification(
  message: ZCodeProtocolMessage,
): message is ZCodeProtocolNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(
  message: ZCodeProtocolMessage,
): message is { id: ZCodeProtocolRequestId; result: unknown } {
  return "id" in message && "result" in message;
}

export function isErrorResponse(message: ZCodeProtocolMessage): message is {
  id: ZCodeProtocolRequestId;
  error: { code: number; message: string; data?: unknown };
} {
  return "id" in message && "error" in message;
}

/**
 * Distills a readable field-level summary from zod-like validation errors, attached to the "Invalid params" message.
 * A bare "Invalid params" never said which field failed; models (a function passed to browser evaluate,
 * NaN coordinates, ...) could not self-correct and kept guessing. Duck-type ZodError.issues here (no zod dep)
 * into actionable hints like `expression: Expected string, received function`.
 */
function summarizeParamsError(error: unknown): string | undefined {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return undefined;
  }
  const parts = issues.slice(0, 5).map((issue) => {
    const path =
      Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message ?? "invalid"}`;
  });
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
  return parts.join("; ") + more;
}

export function parseParams<T>(schema: ParamsSchema<T>, params: unknown): T {
  try {
    return schema.parse(params);
  } catch (error) {
    const detail = summarizeParamsError(error);
    throw new ProtocolRequestError(
      -32602,
      detail ? `Invalid params — ${detail}` : "Invalid params",
      error,
    );
  }
}

export function assertExpectedRevision(
  record: ZCodeProtocolSessionRecord,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== record.stateRevision) {
    throw new ProtocolRequestError(-32009, "Session state revision mismatch", {
      actualRevision: record.stateRevision,
      expectedRevision,
    });
  }
}

export function toProtocolError(error: unknown): {
  code: number;
  data?: unknown;
  message: string;
} {
  if (error instanceof ProtocolRequestError) {
    return { code: error.code, data: error.data, message: error.message };
  }
  if (error instanceof Error) {
    const businessCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      code: -32603,
      // Business-error codes such as ModelProtocolError must survive JSON-RPC for the UI.
      // The outer envelope stays a JSON-RPC internal error; the stable code rides data.code for banner localization.
      // Never pass through error.context: upstream context is not guaranteed JSON-safe, and the error response must not fail twice over diagnostics.
      data: {
        name: error.name,
        stack: error.stack,
        ...(businessCode ? { code: businessCode } : {}),
      },
      message: error.message,
    };
  }
  return {
    code: -32603,
    message: String(error),
  };
}

export function createProtocolTraceId(_sessionId: SessionId): TraceContext["traceId"] {
  // Bugfix: traceId is an observation chain above the session, never derived from the sessionId.
  // Reuse agent/contracts' UUID scheme so the app and agent trace formats agree.
  return createTraceId();
}

export function createProtocolRootTraceContext(
  sessionId: SessionId,
  trace?: ZCodeProtocolTrace,
): TraceContext {
  const context = createRootTraceContext({
    sessionId,
    traceId: (trace?.traceId ?? createProtocolTraceId(sessionId)) as TraceContext["traceId"],
  });
  if (trace?.spanId) {
    context.spanId = trace.spanId;
  }
  if (trace?.parentId) {
    context.parentId = trace.parentId;
    context.parentSpanId = trace.parentId;
  }
  return context;
}

export function protocolTraceFromTraceContext(context: TraceContext): ZCodeProtocolTrace {
  return {
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...((context.parentId ?? context.parentSpanId)
      ? { parentId: context.parentId ?? context.parentSpanId }
      : {}),
  };
}

export function requireSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  options: { deliveryKind?: ZCodeDeliveryKind; operation?: string } = {},
): ZCodeProtocolSessionRecord {
  const record = context.sessions.get(sessionId);
  if (!record) {
    // Diagnostics: readSession reads live runtimes only; on a missing record, distinguish "cold, not yet restored" from "id invalidated" --
    // never one identical error text, or whether the UI read too early or the task index carries a stale ref is undecidable.
    context.logger?.warn("ZCode Protocol session runtime missing", {
      activeSessionCount: context.sessions.size,
      event: "zcode_protocol.session.require_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      operation: options.operation ?? "unknown",
      ...(options.deliveryKind ? { deliveryKind: options.deliveryKind } : {}),
      sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session is not active: ${sessionId}`,
    );
  }
  return record;
}

export function createProtocolLogger(deps: ZCodeProtocolAgentDependencies): Logger | undefined {
  return deps.loggerFactory?.createLogger("zcode").child({
    module: "bootstrap.zcode_protocol",
  });
}
