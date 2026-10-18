import type {
  BackgroundBashOutputResult,
  SessionDebugSnapshot,
  ZCodeSessionContentProfile,
} from "@zcode/shared";
/* eslint-disable max-lines -- the ZCode agent service declares protocol/session/workspace surface together; splitting raises descriptor migration cost. */
import type { Event, IDisposable } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { AppUsageRange, AppUsageSnapshot, ZCodeTaskTokenUsageResult } from "@zcode/shared";
import type { DynamicWorkflowMode } from "@zcode/shared";
import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import type {
  ZCodeStorageStartupState,
  ZCodeDeliveryKind,
  ZCodeAgentMcpServer,
  ZCodeBackgroundTurnAttribution,
  TraceId,
  ZCodeSessionCompactResult,
  ZCodeSessionGoalAction,
  ZCodeSessionGoalResult,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeSessionImportHistory,
  ZCodePermissionRequestParams,
  AgentLaneResourceSample,
  ZCodeMcpTelemetryEvent,
  ZCodeMcpResourceSample,
  ZCodeToolExecResource,
  ZCodeProcessChildProcess,
  ZCodeMcpListResult,
  ZCodePluginsListResult,
  ZCodePluginsOverviewResult,
  ZCodePluginsMarketplaceMutationResult,
  ZCodePluginsInstallResult,
  ZCodePluginsReferenceCatalogResult,
  ZCodeSkillsReferenceCatalogResult,
  ZCodeMcpReadResourceResult,
  ZCodeMcpUiCallToolResult,
  ZCodeMcpUiCancelCallResult,
  ZCodeMcpUiReadResourceResult,
  ZCodeMcpUiListResourcesResult,
  ZCodeMcpUiAppToolAcceptedResult,
  ZCodeMcpUiRegisterAppToolsResult,
  ZCodeMcpUiUnregisterAppToolsResult,
  ZCodeMcpUiListResourceTemplatesResult,
  ZCodePluginsListUiSurfacesResult,
  ZCodeWorkflowsDeleteResult,
  ZCodeWorkflowsForRunResult,
  ZCodeWorkflowsGetResult,
  ZCodeWorkflowsListResult,
  ZCodeWorkflowsMoveResult,
  ZCodeWorkflowsRunsResult,
  ZCodeWorkflowsSaveResult,
  ZCodeWorkflowsUpdateMetaResult,
  ZCodePluginsUninstallResult,
  ZCodePluginsRestoreBuiltinResult,
  ZCodePluginsConfigureResult,
  ZCodePluginsDescribeResult,
  ZCodePluginsValidateResult,
  ZCodePluginsSetEnabledResult,
  ZCodePluginsCancelOperationResult,
  ZCodePluginOperationProgressNotification,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeProviderRuntimeHeadersCancelled,
  ZCodeProviderTestModelConnectivityParams,
  ZCodeProviderTestModelConnectivityResult,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
  ZCodeSessionEvent,
  ZCodeSessionInfo,
  ZCodeSessionMode,
  ZCodeSessionPersistence,
  ZCodeSessionSendResult,
  ZCodeSessionRequestRuntimePreferencesParams,
  ZCodeSessionRuntimePreferencesResult,
  ZCodeSessionStateSnapshot,
  ZCodeSessionSubagentsResult,
  ZCodeStateUpdatedNotification,
  ZCodeTaskClientMode,
  ZCodeBrowserAmbientContext,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceGenerateTextResult,
  ZCodeWorkspaceGenerateTextParams,
  ZCodeWorkspaceHookTrustGrantResult,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export * from "./zcodeAgentPluginParams.js";
export * from "./zcodeAgentWorkflowParams.js";
import type {
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentReadMcpResourceParams,
  ZCodeAgentReadMcpResourceForUiParams,
  ZCodeAgentListMcpResourcesForUiParams,
  ZCodeAgentAppToolCallForUiParams,
  ZCodeAgentAppToolInstanceForUiParams,
  ZCodeAgentRegisterAppToolsForUiParams,
  ZCodeAgentResolveAppToolCallForUiParams,
  ZCodeAgentMcpResourceSubscriptionForUiParams,
  ZCodeAgentCallMcpToolForUiParams,
  ZCodeAgentCancelMcpToolCallForUiParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgentPluginParams.js";
import type {
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentFindSavedWorkflowForRunParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentSaveSavedWorkflowFromRunParams,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
} from "./zcodeAgentWorkflowParams.js";

export interface ZCodeAgentSessionTarget extends ZCodeAgentWorkspaceTarget {
  sessionId: string;
}

export interface ZCodeAgentResumeSessionParams extends ZCodeAgentSessionTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  // Cold restore rebuilds runtimes; tool isolation must match create's boundary (CUA allows only zcode-cua tools,
  // Bash disabled and so on) or resume surfaces wider tools/permissions than creation did.
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface ZCodeAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZCodeAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface ZCodeAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE";

export type ZCodeAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface ZCodeAgentRuntimeLifecycleEvent extends ZCodeAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type ZCodeAgentCuaPermissionObservation = CuaPermissionObservation &
  ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentCreateSessionParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZCodeSessionMode;
  model?: ModelSelection;
  persistence?: ZCodeSessionPersistence;
  thoughtLevel?: string;
  /** Automation sessions skip model renaming; the first user query stays the title. */
  titleGenerationEnabled?: boolean;
  mcpServers?: ZCodeAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: ZCodeSessionImportHistory;
}

export interface ZCodeAgentListSessionsParams extends ZCodeAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: ZCodeAgentRuntimePolicy;
  includeArchived?: boolean;
  limit?: number;
}

export interface ZCodeAgentListSessionSubagentsParams extends ZCodeAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** Host connection identity of the remote workspace; selects hosts only, never a CLI wire param. */
  remoteSessionId?: string;
}

export interface ZCodeAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

export interface ZCodeAgentTaskTokenUsageParams extends ZCodeAgentSessionTarget {}

export interface ZCodeAgentReadSessionParams extends ZCodeAgentSessionTarget {
  deliveryKind?: ZCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** Passive indexers/observers read existing runtimes only; never spawn sessions for snapshots. */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
  /** index mode is task-index only: same-shape snapshot minus heavy payloads; never feeds UI state. */
  contentProfile?: ZCodeSessionContentProfile;
}

export interface ZCodeAgentReadSessionMessagesParams extends ZCodeAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZCodeAgentReadSessionEventsParams extends ZCodeAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type ZCodeAgentReadWorkspacePresentationParams = ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentGrantWorkspaceHookTrustParams extends ZCodeAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface ZCodeAgentSendPromptParamsBase extends ZCodeAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** provider-only in-agent-buffer state; UI/persistence keep the raw content. */
  browserAmbientContext?: ZCodeBrowserAmbientContext;
  clientMode?: ZCodeTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  /** Stable callback address for bot turns; read by CronCreate within the turn only. */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type ZCodeAgentSendPromptParams = ZCodeAgentSendPromptParamsBase &
  ZCodeBackgroundTurnAttribution;

export interface ZCodeAgentCompactParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentGoalParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  action: ZCodeSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentSetModelParams extends ZCodeAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetThoughtLevelParams extends ZCodeAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetModeParams extends ZCodeAgentSessionTarget {
  mode: ZCodeSessionMode;
  expectedRevision?: number;
}

export interface ZCodeAgentGenerateWorkspaceTextParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: ZCodeWorkspaceGenerateTextParams["messages"];
  tools?: ZCodeWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * Protocol RPC timeout. Thinking models overrun the client's default
   * 3 minutes; callers must thread their deadline here or the default fires first
   * and onRequestTimeout misreads it as stale and kills the process.
   */
  requestTimeoutMs?: number;
}

export interface ZCodeAgentTestModelConnectivityParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

// A past merge leaked the full agent auth response; UIs return request checks only, the Host synthesizes account auth.
export type ProviderRuntimeHeadersUiResponse =
  | { headersApplied: true; runtimeProviderHeaders: Record<string, string>; errorMessage?: string }
  | { headersApplied: false; errorMessage?: string };

export interface ZCodeAgentRespondProviderRuntimeHeadersParams extends ZCodeAgentSessionTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface ZCodeAgentSessionRuntimePreferencesRequest extends ZCodeSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface ZCodeAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface ZCodeAgentSessionSubscribeParams extends ZCodeAgentSessionTarget {
  deliveryKind: ZCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// -- v4 conversation channel (vertical slice) --
// The host only relays: subscribe/unsubscribe/command pass to the CLI v4 gateway,
// and v4/conversation/frame fans out to renderers per workspace.

export interface ZCodeAgentConversationSubscribeParams extends ZCodeAgentSessionTarget {
  /** Watermark invariant: attach only when the client truly holds that consistent state. */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface ZCodeAgentConversationUnsubscribeParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export interface ZCodeAgentConversationResyncParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** Row paging (rows/range): one older window per cursor. */
export interface ZCodeAgentConversationRowsRangeParams extends ZCodeAgentSessionTarget {
  /** Rows with rowId < beforeRowId; default walks back from the tail. */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** Terminal ExitPlanMode entries in the active branch. */
export type ZCodeAgentConversationPlansParams = ZCodeAgentSessionTarget;

/** Workflow run journal paging (detail audit); cursor = journal sequence. */
export interface ZCodeAgentConversationWorkflowRunEventsParams extends ZCodeAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** dwf run enumeration (post-restart discovery). */
export interface ZCodeAgentConversationWorkflowRunsParams extends ZCodeAgentSessionTarget {
  limit?: number;
}

// -- dwf user-facing artifacts --
// Terms: an artifact is what the script publishes to the user via artifact.* (files/markdown/boards),
// not the run's top-level return (which the engine also calls artifact).

/** Artifact manifest; durable read for cold restore and the hub detail view. */
export interface ZCodeAgentConversationWorkflowRunArtifactsParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** Board data feed; cursor = journal sequence (strictly greater). */
export interface ZCodeAgentConversationWorkflowRunArtifactDataParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** Artifact bytes, one chunk at a time (512 KiB max, attachmentRead-shaped). */
export interface ZCodeAgentConversationWorkflowRunArtifactReadParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// -- dwf workspace transcript --
/** Light row list: a run's files / git / world.run rows, no bodies. */
export interface ZCodeAgentConversationWorkflowRunWorkspaceParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** One workspace node's body, shape-preserving bounded by maxBytes (defaults at the CLI gateway). */
export interface ZCodeAgentConversationWorkflowRunNodeResultParams extends ZCodeAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface ZCodeAgentBackgroundBashOutputParams extends ZCodeAgentSessionTarget {
  workId: string;
}

export interface ZCodeAgentConversationFileChangesParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationFileRewindPreviewParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationCommandParams extends ZCodeAgentWorkspaceTarget {
  envelope: CommandEnvelope;
  /** Host-internal Browser Use runtime boundary; never in the v4 envelope. */
  clientMode?: ZCodeTaskClientMode;
}

export interface ZCodeAgentCommandsQueryParams extends ZCodeAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI carries no connectionId; the trusted carrier injects it into wire identity. */
export interface ZCodeAgentAttachmentBeginParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface ZCodeAgentAttachmentChunkParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface ZCodeAgentAttachmentTerminalParams extends ZCodeAgentSessionTarget {
  uploadId: string;
}

export interface ZCodeAgentAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentStatParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface ZCodeAgentAttachmentPreviewSourceParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** Host-scope internal transport control; connectionId only via trusted carrier. */
export interface ZCodeAgentConnectionFlowParams extends ZCodeAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index: workspace-level list subscription (no sessionId axis). */
export interface ZCodeAgentSessionsIndexSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * Subscriber scope suffix: the CLI replaces resubscribes by (connectionId, topic), so distinct
   * in-host consumers (renderer sidebar, task-index syncer) on one topic need distinct
   * connectionIds or they clobber each other's generations. Defaults to the shared host id.
   */
  subscriberScope?: string;
  /**
   * Passive observers (task lists) must pass existing-only: a missing runtime yields stable unavailable
   * and never spawns agents. Default keeps the explicit-session behavior.
   */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** workspace-config: workspace-level config catalog subscription (options + slash commands). */
export interface ZCodeAgentWorkspaceConfigSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export type ZCodeAgentServiceEvent =
  | { type: "session.event"; event: ZCodeSessionEvent }
  | { type: "state.updated"; notification: ZCodeStateUpdatedNotification }
  | { type: "permission.request"; request: ZCodePermissionRequestParams }
  | { type: "userInput.request"; request: ZCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ZCodeUserInputResponse;
    }
  | { type: "providerRuntimeHeaders.request"; request: ZCodeProviderRuntimeHeadersRequestParams }
  | { type: "snapshot"; snapshot: ZCodeSessionStateSnapshot };

export interface ZCodeAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface ZCodeAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: ZCodeProcessChildProcess[];
}

export interface ZCodeAgentStorageStartupSnapshot {
  generation: number;
  state: ZCodeStorageStartupState | null;
}

export interface IZCodeAgentService {
  //* The control plane needs no account/model and sends no normal requests. */
  prepareStorage(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeAgentStorageStartupSnapshot>;
  initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult>;
  /**
   * Sync app-wide runtime preferences to live workspaces; never spawn idle agents for it.
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  /**
   * Dynamic-workflow choice signal (launch.md): the host recomputes the effective mode and serially
   * re-sends workspace/updateDynamicWorkflowPolicy. Setting-authoritative hosts read the file;
   * attached remotes trust the pushed value (absent = follow server). No idle spawns.
   */
  syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentWorkspaceRuntimeIdentity>;
  createSession(params: ZCodeAgentCreateSessionParams): Promise<ZCodeSessionStateSnapshot>;
  resumeSession(params: ZCodeAgentResumeSessionParams): Promise<ZCodeSessionStateSnapshot>;
  listSessions(params: ZCodeAgentListSessionsParams): Promise<ZCodeSessionInfo[]>;
  listSessionSubagents(
    params: ZCodeAgentListSessionSubagentsParams,
  ): Promise<ZCodeSessionSubagentsResult>;
  getAppUsageStats(params: ZCodeAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams): Promise<ZCodeTaskTokenUsageResult>;
  readSession(params: ZCodeAgentReadSessionParams): Promise<ZCodeSessionStateSnapshot>;
  readSessionMessages(
    params: ZCodeAgentReadSessionMessagesParams,
  ): Promise<ZCodeMessageWithParts[]>;
  readSessionDebug(params: ZCodeAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: ZCodeAgentReadSessionEventsParams): Promise<ZCodeSessionEvent[]>;
  readWorkspacePresentation(
    params: ZCodeAgentReadWorkspacePresentationParams,
  ): Promise<ZCodeWorkspacePresentation>;
  //* Pre-trust for settings without a task/session; the agent re-discovers and validates.
  grantWorkspaceHookTrust(
    params: ZCodeAgentGrantWorkspaceHookTrustParams,
  ): Promise<ZCodeWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams): Promise<ZCodeMcpListResult>;
  listPlugins(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsListResult>;
  /**
   * Plugin conversation reference catalog: session-scoped read-only projection.
   * Via the workspace agent client (session state lives there), never a plugin-manager process.
   */
  getPluginReferenceCatalog(
    params: ZCodeAgentPluginReferenceCatalogParams,
  ): Promise<ZCodePluginsReferenceCatalogResult>;
  //* Composer skill catalog; with a sessionId reads that runtime's frozen snapshot. */
  getSkillReferenceCatalog(
    params: ZCodeAgentSkillReferenceCatalogParams,
  ): Promise<ZCodeSkillsReferenceCatalogResult>;
  //* Plugin UI: read plugin MCP ui:// resources via the session's workspace agent. */
  openMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPrepareSandboxParams & {
      accountContext?: string;
    },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppInstance>;
  validateMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  recycleMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<boolean>;
  closeMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  readMcpResource(params: ZCodeAgentReadMcpResourceParams): Promise<ZCodeMcpReadResourceResult>;
  //* Plugin UI: UI-invoked tools; reuse approval flows, no transcript rows. */
  sampleMcpApp(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiSamplingParams,
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;
  cancelMcpAppSampling(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiCancelSamplingParams,
  ): Promise<{ cancelled: boolean }>;
  callMcpToolForUi(params: ZCodeAgentCallMcpToolForUiParams): Promise<ZCodeMcpUiCallToolResult>;
  //* Plugin UI: cancel an in-flight call by id; aborts into the MCP client. */
  cancelMcpToolCallForUi(
    params: ZCodeAgentCancelMcpToolCallForUiParams,
  ): Promise<ZCodeMcpUiCancelCallResult>;
  /** Plugin UI resources/read; same-plugin servers, 8 MiB, mime allow-list. */
  readMcpResourceForUi(
    params: ZCodeAgentReadMcpResourceForUiParams,
  ): Promise<ZCodeMcpUiReadResourceResult>;
  //* Plugin UI resources/list, templates/list, subscribe, unsubscribe proxies. */
  listMcpResourcesForUi(
    params: ZCodeAgentListMcpResourcesForUiParams,
  ): Promise<ZCodeMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi(
    params: ZCodeAgentListMcpResourcesForUiParams,
  ): Promise<ZCodeMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  unsubscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  //* App-Provided Tools: register/unrevoke plus claim/return (mailbox over v4 live deltas). */
  registerAppToolsForUi(
    params: ZCodeAgentRegisterAppToolsForUiParams,
  ): Promise<ZCodeMcpUiRegisterAppToolsResult>;
  unregisterAppToolsForUi(
    params: ZCodeAgentAppToolInstanceForUiParams,
  ): Promise<ZCodeMcpUiUnregisterAppToolsResult>;
  claimAppToolCallForUi(
    params: ZCodeAgentAppToolCallForUiParams,
  ): Promise<ZCodeMcpUiAppToolAcceptedResult>;
  resolveAppToolCallForUi(
    params: ZCodeAgentResolveAppToolCallForUiParams,
  ): Promise<ZCodeMcpUiAppToolAcceptedResult>;
  //* Workspace panel entries (enabled manifests' ui.surfaces[]). */
  listPluginUiSurfaces(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodePluginsListUiSurfacesResult>;
  // Saved-workflow hub: workspace-scoped, sessionless, rescanning .zcode/workflows per call.
  // global passes scope=global: with a workspace it is the carrier, else services pick a local one.
  listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams): Promise<ZCodeWorkflowsListResult>;
  getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams): Promise<ZCodeWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: ZCodeAgentUpdateSavedWorkflowMetaParams,
  ): Promise<ZCodeWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: ZCodeAgentDeleteSavedWorkflowParams,
  ): Promise<ZCodeWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: ZCodeAgentListSavedWorkflowRunsParams,
  ): Promise<ZCodeWorkflowsRunsResult>;
  // Moving same-named files between project and global scopes:
  // workspace is the carrier (target when moving in, source when out) and to is the destination; never overwrite.
  moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams): Promise<ZCodeWorkflowsMoveResult>;
  // Completion-card direct save (transcript-and-notifications.md): fetch the script actually
  // run by id from the journal and persist it, no model turn. Both require the workspace (the journal lives there).
  saveSavedWorkflowFromRun(
    params: ZCodeAgentSaveSavedWorkflowFromRunParams,
  ): Promise<ZCodeWorkflowsSaveResult>;
  //* Which saved workflow this run maps to (inferred, not stored); returns args for run-again prefill. */
  findSavedWorkflowForRun(
    params: ZCodeAgentFindSavedWorkflowForRunParams,
  ): Promise<ZCodeWorkflowsForRunResult>;
  resolveSuggestedPluginReference(
    params: ZCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zcode/shared").ZCodePluginsResolveSuggestedReferenceResult>;
  //* Operation-scoped refresh progress after a recommendation plugin misses locally. */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZCodePluginOperationProgressNotification>;
  getPluginsOverview(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsOverviewResult>;
  /**
   * Resource view: enumerate local agent processes in this host (plugin/mcp-status lanes included),
   * asking each live runtime for process/childProcesses; one failure empties only its children.
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<ZCodeAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: ZCodeAgentAddPluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZCodeAgentRemovePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  installPlugin(params: ZCodeAgentInstallPluginParams): Promise<ZCodePluginsInstallResult>;
  cancelPluginOperation(
    params: ZCodeAgentCancelPluginOperationParams,
  ): Promise<ZCodePluginsCancelOperationResult>;
  uninstallPlugin(params: ZCodeAgentUninstallPluginParams): Promise<ZCodePluginsUninstallResult>;
  updatePlugin(params: ZCodeAgentUpdatePluginParams): Promise<ZCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZCodeAgentRestoreBuiltinPluginParams,
  ): Promise<ZCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ZCodeAgentConfigurePluginParams): Promise<ZCodePluginsConfigureResult>;
  resetPluginConfig(
    params: ZCodeAgentResetPluginConfigParams,
  ): Promise<ZCodePluginsConfigureResult>;
  validatePlugin(params: ZCodeAgentValidatePluginParams): Promise<ZCodePluginsValidateResult>;
  describePlugin(params: ZCodeAgentDescribePluginParams): Promise<ZCodePluginsDescribeResult>;
  setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams): Promise<ZCodePluginsSetEnabledResult>;
  //---- Scheduled task (automation) management ----
  listAutomations(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAutomation[]>;
  listAllAutomations(): Promise<ZCodeAutomation[]>;
  createAutomation(params: ZCodeAgentCreateAutomationParams): Promise<ZCodeAutomation>;
  updateAutomation(params: ZCodeAgentUpdateAutomationParams): Promise<ZCodeAutomation | null>;
  deleteAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAgentRunAutomationNowResult>;
  listAutomationRuns(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAutomationRun[]>;
  deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: ZCodeAgentGenerateWorkspaceTextParams,
  ): Promise<ZCodeWorkspaceGenerateTextResult>;
  testModelConnectivity(
    params: ZCodeAgentTestModelConnectivityParams,
  ): Promise<ZCodeProviderTestModelConnectivityResult>;
  /**
   * @deprecated The send mainline is v4 sendText. Two consumers remain:
   * the adapter's attachment fallback (pending a command surface) and the zcodeSessionService
   * pass-through. Do not reuse.
   */
  sendPrompt(params: ZCodeAgentSendPromptParams): Promise<ZCodeSessionSendResult>;
  compactSession(params: ZCodeAgentCompactParams): Promise<ZCodeSessionCompactResult>;
  goalSession(params: ZCodeAgentGoalParams): Promise<ZCodeSessionGoalResult>;
  closeSession(
    params: ZCodeAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  setModel(params: ZCodeAgentSetModelParams): Promise<ZCodeSessionStateSnapshot>;
  setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams): Promise<ZCodeSessionStateSnapshot>;
  setMode(params: ZCodeAgentSetModeParams): Promise<ZCodeSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: ZCodeAgentRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  respondSessionRuntimePreferences(
    params: ZCodeAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  /**
   * The v4 Start Plan auth bridge needs only local pending-request events;
   * do not open legacy session/subscribe for it, or replay/continuous read paths
   * leak back into the v4 pane.
   */
  onDynamicProviderRuntimeHeadersRequest(
    params: ZCodeAgentSessionTarget,
  ): Event<ZCodeProviderRuntimeHeadersRequestParams>;
  /**
   * Workspace-level subscription for Start Plan runtime headers (production responders).
   * Bug (2026-08-16 web-remote hang): session-level entry subscribed only with desktop panes,
   * so web-created sessions had no desktop pane/responder and validation stuck pending,
   * leaving tasks working forever. Desktop windows keep a resident responder per open workspace tab;
   // subscribe registers the live listener first, then replays pending by prefix, matching session semantics.
   */
  onDynamicWorkspaceProviderRuntimeHeadersRequest(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeProviderRuntimeHeadersRequestParams>;
  //* Delivers this workspace's validation cancels only; not a conversation stream. */
  onDynamicWorkspaceProviderRuntimeHeadersCancelled(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeProviderRuntimeHeadersCancelled>;
  onDynamicSessionRuntimePreferencesRequest(): Event<ZCodeAgentSessionRuntimePreferencesRequest>;
  /**
   * Process-level resource samples tagged with the services lane (the CLI never knows it).
   * A dynamic event so RPC buffers no periodic samples without watchers;
   * outside session/conversation continuous and replayable state.
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  //* MCP lifecycle and sparse memory events, for trusted host relays to ARMS. */
  onDynamicMcpTelemetry(): Event<ZCodeMcpTelemetryEvent>;
  //* MCP process-tree resource facts for trusted host rollups. */
  onDynamicMcpResourceSamples(): Event<ZCodeMcpResourceSample[]>;
  //* Bash completion facts, trusted-host resource side-channel only. */
  onDynamicToolExecResource(): Event<ZCodeToolExecResource>;
  /**
   * @deprecated Legacy subscription surface (session/subscribe + session/event + state.updated).
   * The task-index syncer moved to v4 sessions-index/workspace-config frames;
   * only zcodeTaskServiceAdapter.onDynamicTaskEvent (replayable reads) remains.
   * Writes converged on v4 commands; this feeds read-path projections.
   */
  onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams): Event<ZCodeAgentServiceEvent>;
  //-- v4 conversation channel (vertical slice) --
  //* Read the trusted host hello right after the RPC attaches. */
  helloConversationV4(): Promise<HelloMessage>;
  //* Reply clientHello post-validation; metadata never overrides mode/profile. */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  //* Trusted host relays/facades only; terminal RPC callers are scope-rejected. */
  setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: ZCodeAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  //* rows/range paging (loadOlder backfills history). */
  conversationRowsRangeV4(
    params: ZCodeAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: ZCodeAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  //* Run journal paging; plans-family (read-only, stateless, resend-safe). */
  conversationWorkflowRunEventsV4(
    params: ZCodeAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  //* Run enumeration; journal-backed post-restart discovery. */
  conversationWorkflowRunsV4(
    params: ZCodeAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  //* User-facing artifact manifest; plans-family (read-only, stateless, resend-safe). */
  conversationWorkflowRunArtifactsV4(
    params: ZCodeAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  //* Board entry paging; hooks pull on itemCount deltas. */
  conversationWorkflowRunArtifactDataV4(
    params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  //* Artifact bytes per chunk; the CLI authorizes (journal rows gate reads). */
  conversationWorkflowRunArtifactReadV4(
    params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  //* dwf workspace transcript index. */
  conversationWorkflowRunWorkspaceV4(
    params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  //* One workspace node's bounded body. */
  conversationWorkflowRunNodeResultV4(
    params: ZCodeAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: ZCodeAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: ZCodeAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: ZCodeAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: ZCodeAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
  //* Desktop-local sent-video source query; remote/web chunk it. */
  attachmentPreviewSourceV4(
    params: ZCodeAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  //* Read-only chunked sent image/video; connection scope injects the trusted link. */
  attachmentReadV4(params: ZCodeAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  //* Share reads userInput attachments, non-media types included. */
  conversationAttachmentReadV4(
    params: ZCodeAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  //* Share selection reads attachment metadata only. */
  conversationAttachmentStatV4(
    params: ZCodeAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  //* Workspace downlink frames (v4/conversation/frame); renderers route by topic. */
  onDynamicConversationFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  //* Workspace live telemetry; the facade exposes it to trusted desktop-continuous only. */
  onDynamicLocalTtftFacts(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<import("@zcode/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  //* CUA permission observations for local live tasks; history/remote/replayable excluded. */
  onDynamicCuaPermissionObservation(): Event<ZCodeAgentCuaPermissionObservation>;
  //-- sessions-index channel (list liveness) --
  subscribeSessionsIndexV4(
    params: ZCodeAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  //* Workspace sessions-index downlink (same notification, split by prefix). */
  onDynamicSessionsIndexFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  //-- workspace-config channel (catalog liveness; task-index syncer) --
  subscribeWorkspaceConfigV4(
    params: ZCodeAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  //* Workspace workspace-config downlink (same notification, split by prefix). */
  onDynamicWorkspaceConfigFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * CLI reconnection-resubscribe: agent process generation changed (reaped or respawned).
   * v4 subscriptions live in process memory and die with it; subscribers (task-index syncer etc.)
   * must re-subscribe per workspaceKey or frames stop silently.
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * available fires once the client registers in the service; unavailable when it closes.
   * The only attach/detach signal for passive observers, never a user lease.
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  //* Whether a desktop-local CUA turn is live; guards Helper recovery mid-turn. */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const IZCodeAgentService = createServiceDescriptor<IZCodeAgentService>(
  ServiceChannels.ZCodeAgent,
);
