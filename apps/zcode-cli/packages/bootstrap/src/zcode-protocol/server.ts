import { querySessionDebug } from "./session-debug.js";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { networkCaptureControlSchema, zcodeProtocolNotifications } from "@zcode/shared";
import {
  zcodePluginsCancelOperationParamsSchema,
  zcodeProtocolMethods,
  zcodeWorkspaceCancelGenerateTextParamsSchema,
  zcodeWorkspaceHookTrustGrantParamsSchema,
} from "@zcode/shared";
import type { BrowserControlPort } from "@zcode/contracts";
import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpServerNotification,
} from "@zcode/contracts";
import { requestMcpElicitation } from "./interaction-broker.js";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolMethod,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import {
  cancelBackgroundTask,
  closeSession,
  compactSession,
  createSession,
  forkSession,
  generateWorkspaceText,
  goalSession,
  getTaskTokenUsage,
  getUsageStats,
  listSessions,
  listSessionSubagents,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  sendPrompt,
  setMode,
  setModel,
  setThoughtLevel,
  stopSession,
  subscribeSession,
} from "./server-operations.js";
import { listChildProcesses } from "./process-child-processes.js";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
import {
  readWorkspacePresentation,
  testProviderModelConnectivity,
} from "./workspace-model-runtime.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "./plugins.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows.js";
import { findSavedWorkflowForRunOp, saveSavedWorkflowFromRunOp } from "./saved-workflows-run.js";
import { listMcpServers } from "./mcp.js";
import {
  callMcpUiTool,
  sampleMcpUi,
  cancelMcpUiSampling,
  cancelMcpUiToolCall,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  claimMcpUiAppToolCall,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  unregisterMcpUiAppTools,
  readMcpUiResource,
  readMcpUiResourceForUi,
  routeMcpServerNotification,
  subscribeMcpUiResource,
  unsubscribeMcpUiResource,
} from "./mcp-ui/index.js";
import { listPluginUiSurfaces } from "./plugin-ui-surfaces.js";
import { updateInteractionPreferences } from "./interaction-preferences.js";
import { updateAccountProviderConfig } from "./account-provider-config.js";
import { updateModelIoPreferences } from "./model-io-preferences.js";
import { updateOffPeakToolPolicy } from "./off-peak-tool-policy.js";
import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";
import { grantWorkspaceHookTrustForProtocol } from "./workspace-hook-trust.js";
import {
  V4InteractionRegistry,
  resolveV4InteractionRegistryOptionsFromEnv,
} from "../zcode-protocol-v4/interaction-registry.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import {
  DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT,
  SessionResidentPool,
} from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import {
  createProtocolLogger,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
  type ParamsSchema,
  parseParams,
  toProtocolError,
  type ZCodeProtocolClientRequestOptions,
  type ZCodeProtocolAgentDependencies,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createInMemorySessionEventStore } from "@zcode/contracts";

export type { ZCodeProtocolAgentDependencies, ZCodeProtocolSessionRecord };

import { closeMcpUiInstance, openMcpUiInstance, validateMcpUiInstance } from "./mcp-ui/index.js";
const MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS = 10_000;

type ZCodeProtocolOutboundMessage = ZCodeProtocolNotification | ZCodeProtocolRequest;

/**
 * After the trust store persists, each session coordinator's
 * in-memory mirror (loaded at creation only) never refreshes: trusted hooks keep being rejected and the banner pendingCount
 * goes stale. After a successful pretrust grant, notify every matching live session by workspaceKey to reload.
 * Exported standalone as pure dispatch (no network, no events) so regression tests can construct the sessions Map directly.
 */
export async function notifyWorkspaceHookTrustGrantSessions(input: {
  grantedWorkspaceKey?: string;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
}): Promise<void> {
  if (!input.grantedWorkspaceKey) return;
  await Promise.all(
    [...input.sessions.values()]
      .filter((record) => record.workspace.workspaceKey === input.grantedWorkspaceKey)
      .map((record) => record.app.reloadWorkspaceHookTrust()),
  );
}

function collectResidencySessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const candidate = params as {
    commands?: unknown;
    sessionId?: unknown;
    topic?: unknown;
  };
  const sessionIds = new Set<string>();
  if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
    sessionIds.add(candidate.sessionId);
  }
  if (typeof candidate.topic === "string") {
    const topicSessionId = parseConversationTopic(candidate.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  if (Array.isArray(candidate.commands)) {
    for (const command of candidate.commands) {
      if (!command || typeof command !== "object") continue;
      const sessionId = (command as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }
  return [...sessionIds];
}

function getPluginOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

function getOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

export interface ZCodeProtocolPostResponseBatch {
  readonly messages: readonly ZCodeProtocolOutboundMessage[];
  commit(): boolean;
}

interface PendingClientRequest<T> {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  resultSchema: ParamsSchema<T>;
  requestKeys: Set<string>;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  reannounceTimer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

export class ZCodeProtocolAgentServer {
  private readonly networkCapture = createNodeNetworkCapture("cli", (batch) => {
    this.messageSink?.({
      method: zcodeProtocolNotifications.processNetworkRequests,
      params: batch,
    });
  });
  private readonly runtimeResources: ProtocolRuntimeResources;
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * The minimal context the official-MCP identity-header port needs.
   * The MCP pool is constructed before the server; backfill the closure-held reference once the server is ready --
   * the same construction-order closing as v4Gateway. Expose only requestClient, never the whole context.
   */
  /** MCP-server-initiated elicitation/create -> a user question. */
  requestMcpElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult> {
    return requestMcpElicitation(this.context, request, options);
  }

  /** MCP server notifications -> session live events / agent log. */
  handleMcpNotification(notification: McpServerNotification): void {
    routeMcpServerNotification(this.context, notification);
  }

  get officialMcpAuthRequestContext(): Pick<ZCodeProtocolAgentServerContext, "requestClient"> {
    return this.context;
  }

  private messageSink?: (message: ZCodeProtocolOutboundMessage) => void;
  private clientDisconnectError?: Error;
  private readonly context: ZCodeProtocolAgentServerContext;
  private readonly logger;
  private readonly pendingClientRequests = new Map<string, PendingClientRequest<unknown>>();
  private readonly pluginOperationControllers = new Map<string, AbortController>();
  private readonly workspaceGenerateTextControllers = new Map<string, AbortController>();
  /**
   * The subscribe initial frame isolates by JSON-RPC request id. Take the connection first,
   * then the response line, then notifications in array order -- never trust microtask ordering.
   */
  private readonly postResponseOutbox = new Map<
    ZCodeProtocolRequestId,
    ZCodeProtocolPostResponseBatch
  >();
  private nextClientRequestId = 1;

  constructor(deps: ZCodeProtocolAgentDependencies) {
    this.runtimeResources = new ProtocolRuntimeResources(deps.createZCodeApp);
    const resolvedDeps = {
      ...deps,
      createZCodeApp: this.runtimeResources.create,
      // The default turn retention policy.
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
    };
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        // The dynamic-workflow rollout gate fails closed: only an explicit workspace/updateDynamicWorkflowPolicy
        // from the Host turns it on.
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.requestClient(method, params, resultSchema, options),
      sessions: new Map<string, ZCodeProtocolSessionRecord>(),
      // The interaction-answer registry (where broker reverse requests meet the v4 resolveInteraction command).
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    // The v4 channel: the gateway closure holds context as frame exit and command side-effect face, hung back right after construction.
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // The single-CLI resident session pool: protocol request releases converge actively; the resource sampler is backup only.
    this.context.sessionResidentPool = new SessionResidentPool(
      createSessionResidentPoolHost(this.context),
      {
        ...deps.sessionResidentPoolOptions,
        // The legacy target covered high/low at once, collapsing the hysteresis window to 0; cover low only.
        // A configured target above the default high raises the implicit high; invalid explicit combos stay pool-rejected.
        highWaterCount: sessionResidentHighWaterCount,
        targetCount: sessionResidentTargetCount,
      },
    );
  }

  /** The low-frequency sampler backstop entry; normal convergence triggers on each protocol request's operation-lease release. */
  rebalanceResidentSessions(): void {
    this.context.sessionResidentPool?.rebalance();
  }

  /**
   * The same 60s tick doubles as the event store's time-based expiry fallback:
   * subagent child sessions have a single turn and may never see the next turn_started, so clear by time. Returns the evicted count.
   */
  pruneSessionEventStores(nowMs: number = Date.now()): number {
    let evicted = 0;
    for (const record of this.context.sessions.values()) {
      evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
    }
    return evicted;
  }

  /** The same 60s tick: releases detached subagent child publishers that are terminal, subscriber-less, and record-less. */
  pruneDetachedChildPublishers(nowMs: number = Date.now()): number {
    return this.context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
  }

  /**
   * In-memory diagnostics counters, written to the local log with the 60s resource sample.
   * Reads Map.size / array lengths only, never session state; counts 0 when the persistent event store offers no getStats.
   */
  collectMemoryDiagnostics(): Record<string, number> {
    let eventRows = 0;
    let eventEvicted = 0;
    let eventTransientRetained = 0;
    for (const record of this.context.sessions.values()) {
      const stats = record.eventStore.getStats?.();
      eventRows += stats?.events ?? 0;
      eventEvicted += stats?.evictedEvents ?? 0;
      eventTransientRetained += stats?.retainedTransient ?? 0;
    }
    const counters: Record<string, number> = {
      sessions: this.context.sessions.size,
      eventRows,
      eventEvicted,
      eventTransientRetained,
    };
    const v4 = this.context.v4Gateway?.collectMemoryDiagnostics();
    if (v4) {
      for (const [key, value] of Object.entries(v4)) {
        counters[`v4.${key}`] = value;
      }
    }
    return counters;
  }

  setNotificationSink(sink: (message: ZCodeProtocolOutboundMessage) => void): void {
    this.runtimeResources.assertServing();
    this.clientDisconnectError = undefined;
    this.messageSink = sink;
  }

  disconnectClient(error: Error): void {
    this.networkCapture.setCaptureId(null);
    this.clientDisconnectError = error;
    // Once the connection closes, reverse requests can no longer be answered: end pending first,
    // or a handler materializing a session blocks the connection's close path.
    const pendingRequests = new Set(this.pendingClientRequests.values());
    for (const pending of pendingRequests) {
      this.cleanupClientRequest(pending);
      pending.reject(error);
    }
  }

  /** Process-resource shutdown; not session/close, which deletes product sessions and emits session.removed. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runtimeResources.close();
    const error = new Error("ZCode Protocol runtime stopping");
    this.disconnectClient(error);
    this.messageSink = undefined;
    this.clearPostResponseMessages();
    for (const controller of this.pluginOperationControllers.values()) controller.abort(error);
    for (const controller of this.workspaceGenerateTextControllers.values())
      controller.abort(error);
    for (const record of this.context.sessions.values()) {
      record.activeAbortController?.abort(error);
      try {
        record.unsubscribe?.();
      } catch {
        this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
          event: "zcode_protocol.session.unsubscribe.failed",
        });
      }
    }
    return this.shutdownPromise;
  }

  /** Releases projections once the app drain ends bounded; must run even if some app.close hangs. */
  disposeProjections(): void {
    this.context.v4Gateway?.dispose();
    this.context.sessions.clear();
  }

  /** Takes a request's post-response messages once; a repeated take returns empty. */
  takePostResponseMessages(requestId: ZCodeProtocolRequestId): ZCodeProtocolOutboundMessage[] {
    const batch = this.takePostResponseBatch(requestId);
    batch?.commit();
    return [...(batch?.messages ?? [])];
  }

  /** Production NDJSON takes the full batch; commit only after every write succeeded. */
  takePostResponseBatch(requestId: ZCodeProtocolRequestId): ZCodeProtocolPostResponseBatch | null {
    const batch = this.postResponseOutbox.get(requestId) ?? null;
    this.postResponseOutbox.delete(requestId);
    return batch;
  }

  /** On connection close / server dispose, releases the not-yet-written initial frame reference. */
  clearPostResponseMessages(): void {
    this.postResponseOutbox.clear();
  }

  async handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined> {
    this.runtimeResources.assertServing();
    if (isResponse(message)) {
      this.resolveClientRequest(message.id, message.result);
      return undefined;
    }
    if (isErrorResponse(message)) {
      this.rejectClientRequest(
        message.id,
        new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
      );
      return undefined;
    }
    if (isRequest(message)) {
      return await this.handleRequest(message);
    }
    if (isNotification(message)) {
      if (message.method === zcodeProtocolMethods.processNetworkCapture) {
        const control = networkCaptureControlSchema.safeParse(message.params);
        if (control.success) this.networkCapture.setCaptureId(control.data.captureId);
        return undefined;
      }
      this.logger?.debug("ZCode Protocol notification ignored", {
        event: "zcode_protocol.notification.ignored",
        method: message.method,
        module: "bootstrap.zcode_protocol",
      });
    }
    return undefined;
  }

  private async handleRequest(
    request: ZCodeProtocolRequest,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse> {
    // A request id may be reused after the previous request completes; a new request must not inherit an unconsumed old outbox.
    this.postResponseOutbox.delete(request.id);
    let releaseResidencyOperation: (() => void) | undefined;
    try {
      // Subscribe hydration, workspace config, and resume all cross awaits. Keying on the session's
      // current state alone, the sampler would close it while a handler holds the stale record. The process-level lease
      // spans the whole request; recognizable sessionIds also feed the cold-restore gate and the LRU touch.
      releaseResidencyOperation = await this.context.sessionResidentPool?.acquireOperation(
        collectResidencySessionIds(request.params),
      );
      const result = await this.dispatchRequest(request);
      return this.ok(request.id, result);
    } catch (error) {
      this.postResponseOutbox.delete(request.id);
      const protocolError = toProtocolError(error);
      return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
    } finally {
      releaseResidencyOperation?.();
    }
  }

  private async dispatchRequest(request: ZCodeProtocolRequest) {
    switch (request.method) {
      // -- the v4 conversation channel (a vertical slice, coexisting with legacy session/*) --
      case V4_METHODS.connectionFlow: {
        this.requireV4Gateway().setConnectionFlowState(request.params);
        return {};
      }
      case V4_METHODS.conversationSubscribe: {
        // One subscribe method, dispatched by topic prefix:
        // sessions-index/* -> list subscription; workspace-config/* -> config catalog; else conversation.
        const gateway = this.requireV4Gateway();
        const topic = (request.params as { topic?: unknown } | null)?.topic;
        let dispatch;
        if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
          dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
        } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
          dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
        } else {
          dispatch = await gateway.subscribeReserved(request.params);
        }
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      case V4_METHODS.conversationResync: {
        // same-sub recovery shares subscribe's deterministic post-response outbox; the common
        // response is still strict ACK-only, so physical recovery can only follow the ACK line.
        const dispatch = this.requireV4Gateway().resyncReserved(request.params);
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      case V4_METHODS.conversationUnsubscribe: {
        // topic + subscriptionId + connectionId pins exactly one publisher; never blanket-match
        // by bare subId across conversation/sessions-index/workspace-config.
        this.requireV4Gateway().unsubscribe(request.params);
        return {};
      }
      // -- row-paging query (separate branch, easy to merge with frame-dispatch changes) --
      case V4_METHODS.conversationRowsRange:
        return await this.requireV4Gateway().rowsRange(request.params);
      case V4_METHODS.conversationPlans:
        return await this.requireV4Gateway().plans(request.params);
      case V4_METHODS.backgroundBashOutput:
        return await this.requireV4Gateway().backgroundBashOutput(request.params);
      case V4_METHODS.conversationFileChanges:
        return await this.requireV4Gateway().fileChanges(request.params);
      case V4_METHODS.conversationFileRewindPreview:
        return await this.requireV4Gateway().fileRewindPreview(request.params);
      // Workflow run event-log paging (read-only, stateless, resend-safe on timeout; new methods are skew-safe by construction).
      case V4_METHODS.conversationWorkflowRunEvents:
        return await this.requireV4Gateway().workflowRunEvents(request.params);
      // dwf run enumeration (the post-restart discovery query).
      case V4_METHODS.conversationWorkflowRuns:
        return await this.requireV4Gateway().workflowRuns(request.params);
      // The three read faces of dwf user-facing artifacts. Same family: read-only, stateless,
      // resend-safe on timeout; ArtifactRead authorization lives in the host port, the gateway validates params and chunking only.
      case V4_METHODS.conversationWorkflowRunArtifacts:
        return await this.requireV4Gateway().workflowRunArtifacts(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactData:
        return await this.requireV4Gateway().workflowRunArtifactData(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactRead:
        return await this.requireV4Gateway().workflowRunArtifactRead(request.params);
      // The two read faces of the dwf workspace transcript. Same family.
      case V4_METHODS.conversationWorkflowRunWorkspace:
        return await this.requireV4Gateway().workflowRunWorkspace(request.params);
      case V4_METHODS.conversationWorkflowRunNodeResult:
        return await this.requireV4Gateway().workflowRunNodeResult(request.params);
      // Attachments only via small RPC transactions; never a full-data attachment/put single line.
      case V4_METHODS.attachmentBegin:
        return await this.requireV4Gateway().attachmentBegin(request.params);
      case V4_METHODS.attachmentChunk:
        return await this.requireV4Gateway().attachmentChunk(request.params);
      case V4_METHODS.attachmentCommit:
        return await this.requireV4Gateway().attachmentCommit(request.params);
      case V4_METHODS.attachmentAbort:
        await this.requireV4Gateway().attachmentAbort(request.params);
        return {};
      case V4_METHODS.attachmentRead:
        return await this.requireV4Gateway().attachmentRead(request.params);
      case V4_METHODS.conversationAttachmentRead:
        return await this.requireV4Gateway().conversationAttachmentRead(request.params);
      case V4_METHODS.conversationAttachmentStat:
        return await this.requireV4Gateway().conversationAttachmentStat(request.params);
      case V4_METHODS.attachmentPreviewSource:
        return await this.requireV4Gateway().attachmentPreviewSource(request.params);
      // -- usage query (additive): the same data-access layer as legacy usage/stats and session/usage
      // (the usage-store aggregation), only the v4 namespace -- not via v4Gateway (no session-projection deps)
      // nor legacy op dispatch (no bridge). The legacy case stays until the legacy name is deleted (old-host compat). --
      case V4_METHODS.usageStats:
        return await getUsageStats(this.context, request.params);
      case V4_METHODS.conversationUsage:
        return await getTaskTokenUsage(this.context, request.params);
      case V4_METHODS.command:
        return this.requireV4Gateway().handleCommand(request.params);
      case V4_METHODS.commandsQuery:
        return this.requireV4Gateway().queryCommands(request.params);
      case zcodeProtocolMethods.sessionCreate:
        return await createSession(this.context, request.params, request.trace);
      case zcodeProtocolMethods.sessionResume:
        return await resumeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionList:
        return await listSessions(this.context, request.params);
      case zcodeProtocolMethods.sessionSubagents:
        return await listSessionSubagents(this.context, request.params);
      case zcodeProtocolMethods.sessionRead:
        return await readSession(this.context, request.params);
      case zcodeProtocolMethods.sessionMessages:
        return await readMessages(this.context, request.params);
      case zcodeProtocolMethods.sessionEvents:
        return await readEvents(this.context, request.params);
      case zcodeProtocolMethods.sessionSubscribe:
        return await subscribeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSend:
        return await sendPrompt(this.context, request.params);
      case zcodeProtocolMethods.sessionStop:
        return await stopSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCancelBackgroundTask:
        return await cancelBackgroundTask(this.context, request.params);
      case zcodeProtocolMethods.sessionFork:
        return await forkSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCompact:
        return await compactSession(this.context, request.params);
      case zcodeProtocolMethods.sessionGoal:
        return await goalSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSetModel:
        return await setModel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetThoughtLevel:
        return await setThoughtLevel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetMode:
        return await setMode(this.context, request.params);
      case zcodeProtocolMethods.sessionClose:
        return await closeSession(this.context, request.params);
      case zcodeProtocolMethods.workspaceReadPresentation:
        return await readWorkspacePresentation(this.context, request.params);
      case zcodeProtocolMethods.workspaceHookTrustGrant: {
        const grantResult = await grantWorkspaceHookTrustForProtocol(request.params, {
          appVersion: this.context.deps.version,
          policyProvider: this.context.deps.workspaceHookPolicyProvider,
        });
        if (grantResult.accepted) {
          await notifyWorkspaceHookTrustGrantSessions({
            // Dispatch-layer params are weakly typed; grant already parsed with the same schema, so this
            // safeParse only extracts workspaceKey for matching -- on failure skip the notification (defensive; normally succeeds).
            grantedWorkspaceKey: zcodeWorkspaceHookTrustGrantParamsSchema.safeParse(request.params)
              .success
              ? zcodeWorkspaceHookTrustGrantParamsSchema.parse(request.params).workspace
                  .workspaceKey
              : undefined,
            sessions: this.context.sessions,
          });
        }
        return grantResult;
      }
      case zcodeProtocolMethods.providerUpdateAccountConfig:
        return await updateAccountProviderConfig(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateInteractionPreferences:
        return await updateInteractionPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateModelIoPreferences:
        return await updateModelIoPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy:
        return await updateOffPeakToolPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
        return await updateDynamicWorkflowPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceGenerateText:
        return await this.withWorkspaceGenerateTextSignal(request, (signal) =>
          generateWorkspaceText(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.workspaceCancelGenerateText:
        return this.cancelWorkspaceGenerateText(request.params);
      case zcodeProtocolMethods.providerTestModelConnectivity:
        return await testProviderModelConnectivity(this.context, request.params);
      case zcodeProtocolMethods.mcpList:
        return await listMcpServers(this.context, request.params);
      case zcodeProtocolMethods.mcpReadResource:
        return await readMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiOpenInstance:
        return openMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiValidateInstance:
        return validateMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCloseInstance:
        return closeMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSampling:
        return sampleMcpUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelSampling:
        return cancelMcpUiSampling(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCallTool:
        return await callMcpUiTool(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelCall:
        return await cancelMcpUiToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiReadResource:
        return await readMcpUiResourceForUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResources:
        return await listMcpUiResources(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResourceTemplates:
        return await listMcpUiResourceTemplates(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSubscribeResource:
        return await subscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnsubscribeResource:
        return await unsubscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiRegisterAppTools:
        return await registerMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnregisterAppTools:
        return await unregisterMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiClaimAppToolCall:
        return await claimMcpUiAppToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiResolveAppToolCall:
        return await resolveMcpUiAppToolCall(this.context, request.params);
      case zcodeProtocolMethods.pluginsList:
        return await listPlugins(this.context, request.params);
      case zcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
        return await getPluginReferenceCatalog(this.context, request.params, true);
      case zcodeProtocolMethods.pluginsReferenceCatalog:
        return await getPluginReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.pluginsListUiSurfaces:
        return await listPluginUiSurfaces(this.context, request.params);
      case zcodeProtocolMethods.skillsReferenceCatalog:
        return await getSkillReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.workflowsList:
        return await listSavedWorkflowsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsGet:
        return await getSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsUpdateMeta:
        return await updateSavedWorkflowMetaOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsDelete:
        return await deleteSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsRuns:
        return await listSavedWorkflowRunsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsMove:
        return await moveSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsSave:
        return await saveSavedWorkflowFromRunOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsForRun:
        return await findSavedWorkflowForRunOp(this.context, request.params);
      case zcodeProtocolMethods.pluginsResolveSuggestedReference:
        return await this.withPluginOperationSignal(request, (signal) =>
          resolveSuggestedPluginReference(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsSetEnabled:
        return await this.withPluginOperationSignal(request, (signal) =>
          setPluginEnabled(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsOverview:
        return await getPluginsOverview(this.context, request.params);
      case zcodeProtocolMethods.processChildProcesses:
        return listChildProcesses(this.context.deps.mcpTelemetry?.listProcesses() ?? []);
      case zcodeProtocolMethods.runtimeCapabilities:
        return { independentPlanState: true };
      case zcodeProtocolMethods.pluginsMarketplaceAdd:
        return await this.withPluginOperationSignal(request, (signal) =>
          addPluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsMarketplaceRemove:
        return await removePluginMarketplace(this.context, request.params);
      case zcodeProtocolMethods.pluginsMarketplaceUpdate:
        return await this.withPluginOperationSignal(request, (signal) =>
          updatePluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsInstall:
        return await this.withPluginOperationSignal(request, (signal) =>
          installPlugin(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsCancelOperation:
        return this.cancelPluginOperation(request.params);
      case zcodeProtocolMethods.pluginsUninstall:
        return await uninstallPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsUpdate:
        return await updatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsRestoreBuiltin:
        return await restoreBuiltinPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsConfigure:
        return await configurePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsResetConfig:
        return await resetPluginConfig(this.context, request.params);
      case zcodeProtocolMethods.pluginsValidate:
        return await validatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsDescribe:
        return await describePlugin(this.context, request.params);
      case zcodeProtocolMethods.usageStats:
        return await getUsageStats(this.context, request.params);
      case zcodeProtocolMethods.sessionDebug:
        return querySessionDebug(this.context, request.params);
      case zcodeProtocolMethods.sessionUsage:
        return await getTaskTokenUsage(this.context, request.params);
      default:
        throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
    }
  }

  private requireV4Gateway() {
    if (!this.context.v4Gateway) {
      throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
    }
    return this.context.v4Gateway;
  }

  private async withPluginOperationSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getPluginOperationId(request.params);
    if (!operationId) return await run();

    const controller = new AbortController();
    this.pluginOperationControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.pluginOperationControllers.get(operationId) === controller) {
        this.pluginOperationControllers.delete(operationId);
      }
    }
  }

  private cancelPluginOperation(rawParams: unknown) {
    const params = parseParams(zcodePluginsCancelOperationParamsSchema, rawParams);
    const controller = this.pluginOperationControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    // Cancellable plugin-sync capabilities stay on the V4 server; abort only the chain matching the operationId.
    controller.abort();
    this.pluginOperationControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  private async withWorkspaceGenerateTextSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getOperationId(request.params);
    if (!operationId) return await run();

    if (this.workspaceGenerateTextControllers.has(operationId)) {
      // A duplicate operationId would overwrite the first request's AbortController, dropping its cancellation.
      // Active operationIds stay unique; the finally releases after the request ends; only then reusable.
      throw new ProtocolRequestError(
        -32600,
        `Workspace generate operation is already active: ${operationId}`,
      );
    }

    const controller = new AbortController();
    this.workspaceGenerateTextControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.workspaceGenerateTextControllers.get(operationId) === controller) {
        this.workspaceGenerateTextControllers.delete(operationId);
      }
    }
  }

  private cancelWorkspaceGenerateText(rawParams: unknown) {
    const params = parseParams(zcodeWorkspaceCancelGenerateTextParamsSchema, rawParams);
    const controller = this.workspaceGenerateTextControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
    this.workspaceGenerateTextControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  private ok(id: ZCodeProtocolRequestId, result: unknown): ZCodeProtocolResponse {
    return { id, result };
  }

  private fail(
    id: ZCodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): ZCodeProtocolError {
    return { error: { code, data, message }, id };
  }

  private requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    if (this.clientDisconnectError) {
      throw this.clientDisconnectError;
    }
    if (!this.messageSink) {
      throw new ProtocolRequestError(
        PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached,
        `No ZCode Protocol client is attached for ${method}`,
      );
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      const pending: PendingClientRequest<T> = {
        method,
        reject,
        resolve,
        resultSchema,
        requestKeys: new Set(),
        signal: options?.signal,
      };
      const cleanup = () => {
        active = false;
        this.cleanupClientRequest(pending);
      };
      pending.abortHandler = () => {
        cleanup();
        reject(
          new ProtocolRequestError(
            PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled,
            `Client request cancelled: ${method}`,
          ),
        );
      };
      if (options?.signal?.aborted) {
        pending.abortHandler();
        return;
      }
      if (options?.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          cleanup();
          reject(
            new ProtocolRequestError(
              PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut,
              `Client request timed out: ${method}`,
              {
                timeoutMs: options.timeoutMs,
              },
            ),
          );
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
      const sendClientRequest = () => {
        if (!active) {
          return;
        }
        const id = `server-${this.nextClientRequestId++}`;
        const key = String(id);
        pending.requestKeys.add(key);
        this.pendingClientRequests.set(key, pending as PendingClientRequest<unknown>);
        this.messageSink?.({
          id,
          method,
          params,
          ...(options?.trace ? { trace: options.trace } : {}),
        });
      };
      sendClientRequest();
      const reannounceIntervalMs =
        options?.reannounceIntervalMs !== undefined &&
        Number.isFinite(options.reannounceIntervalMs) &&
        options.reannounceIntervalMs > 0
          ? Math.floor(options.reannounceIntervalMs)
          : undefined;
      if (reannounceIntervalMs !== undefined) {
        let nextReannounceIntervalMs = reannounceIntervalMs;
        const scheduleReannounce = () => {
          pending.reannounceTimer = setTimeout(() => {
            if (!active) {
              return;
            }
            sendClientRequest();
            nextReannounceIntervalMs = Math.min(
              nextReannounceIntervalMs * 2,
              MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
            );
            scheduleReannounce();
          }, nextReannounceIntervalMs);
        };
        scheduleReannounce();
      }
    });
  }

  private resolveClientRequest(id: ZCodeProtocolRequestId, result: unknown): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    try {
      pending.resolve(pending.resultSchema.parse(result));
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`),
      );
    }
  }

  private rejectClientRequest(id: ZCodeProtocolRequestId, error: Error): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    pending.reject(error);
  }

  private cleanupClientRequest<T>(pending: PendingClientRequest<T>): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.reannounceTimer) {
      clearTimeout(pending.reannounceTimer);
    }
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    for (const requestKey of pending.requestKeys) {
      this.pendingClientRequests.delete(requestKey);
    }
    pending.requestKeys.clear();
  }
}
