import {
  requiresRequestVerification,
  allowRequestVerificationHeaders,
  requestVerificationInteractionAvailable,
} from "@zcode/shared";
import { zcodeMcpUiSamplingResultSchema } from "@zcode/shared";
import { MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS } from "@zcode/shared/mcp-apps";
import {
  channelReplyRequestSchema,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
} from "@zcode/shared";
import { requestPluginReferenceCatalog } from "#src/zcode-agent/pluginReferenceCatalogRequest.js";
import {
  localTtftFactsSchema,
  sessionDebugSnapshotSchema,
  type LocalTtftFacts,
} from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- transport, notification wiring, and app-facing session methods share one client/emitter context. */
import { ensureIndependentPlanSupport } from "./independentPlanSupport.js";
import { createHash, randomUUID } from "node:crypto";
import { createTopicResourceBridge } from "./topicResourceBridge.js";
import { uploadTopicResourceToClient } from "./topicResourceUpload.js";
import {
  zcodeTopicResourceCancelParamsSchema,
  type ZCodeTopicResourceReadParams,
  type ZCodeProtocolTrace,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { IDisposable } from "@zcode/rpc";
import type {
  AccountProviderConfigSnapshot,
  ModelSelectionView,
  ProviderSource,
} from "@zcode/provider";
import { completeNewModelSelection } from "@zcode/provider";
import type { OffPeakClientConfig } from "#src/coding-plan-subscription/codingPlanSubscription.js";
import {
  subagentRuntimeConfigSchema,
  zcodeSubagentsReadRuntimeConfigParamsSchema,
  type SubagentRuntimeConfig,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  formatLogPrefix,
  resolveWorkspaceKey,
  type TraceId,
  ZCODE_AGENT_PROVIDER,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
  ZCODE_MODEL_REASONING_SEPARATOR,
  isRemoteWorkspaceIdentity,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeMcpListResultSchema,
  zcodePermissionRequestParamsSchema,
  zcodeBrowserListParamsSchema,
  zcodeBrowserExecuteParamsSchema,
  zcodePluginsConfigureResultSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsMarketplaceMutationResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodeProcessChildProcessesResultSchema,
  type ZCodeProcessChildProcess,
  zcodeSkillsReferenceCatalogResultSchema,
  zcodeMcpReadResourceResultSchema,
  zcodeMcpUiCallToolResultSchema,
  zcodeMcpUiCancelCallResultSchema,
  zcodeMcpUiReadResourceResultSchema,
  zcodeMcpUiListResourcesResultSchema,
  zcodeMcpUiAppToolAcceptedResultSchema,
  zcodeMcpUiRegisterAppToolsResultSchema,
  zcodeMcpUiUnregisterAppToolsResultSchema,
  zcodeMcpUiListResourceTemplatesResultSchema,
  zcodeMcpUiResourceSubscriptionResultSchema,
  zcodePluginsListUiSurfacesResultSchema,
  zcodeWorkflowsDeleteResultSchema,
  zcodeWorkflowsForRunResultSchema,
  zcodeWorkflowsGetResultSchema,
  zcodeWorkflowsListResultSchema,
  zcodeWorkflowsMoveResultSchema,
  zcodeWorkflowsRunsResultSchema,
  zcodeWorkflowsSaveResultSchema,
  zcodeWorkflowsUpdateMetaResultSchema,
  zcodePluginsResolveSuggestedReferenceResultSchema,
  zcodePluginOperationProgressNotificationSchema,
  zcodePluginsRestoreBuiltinResultSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsCancelOperationResultSchema,
  zcodePluginsUninstallResultSchema,
  zcodePluginsValidateResultSchema,
  zcodePluginsDescribeResultSchema,
  zcodeAutomationCheckTaskBindingParamsSchema,
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationDeleteParamsSchema,
  zcodeAutomationListParamsSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeOffPeakCreateParamsSchema,
  zcodeOffPeakListParamsSchema,
  OFF_PEAK_PROVIDER_IDS,
  zcodeComputerUseOperationEventSchema,
  zcodeProviderRuntimeHeadersCancelledSchema,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
  zcodeProviderTestModelConnectivityResultSchema,
  zcodeOfficialMcpAuthHeadersRequestParamsSchema,
  summarizeOfficialMcpIdentityHeaders,
  zcodeProtocolEmptyResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeMcpTelemetryEventSchema,
  zcodeMcpResourceSamplesSchema,
  zcodeToolExecResourceSchema,
  zcodeProcessResourceSampleSchema,
  zcodeSessionCloseResultSchema,
  zcodeSessionCompactResultSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionGoalResultSchema,
  zcodeSessionListResultSchema,
  zcodeSessionSubagentsResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionEventSchema,
  zcodeSessionSendResultSchema,
  zcodeSessionRequestRuntimePreferencesParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubscribeResultSchema,
  zcodeStateUpdatedNotificationSchema,
  zcodeUserInputRequestParamsSchema,
  zcodeWorkspacePresentationSchema,
  zcodeWorkspaceCancelGenerateTextResultSchema,
  zcodeWorkspaceGenerateTextResultSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
  zcodeProviderUpdateAccountConfigResultSchema,
  type ZCodeSessionStateSnapshot,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
  zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
  applyDynamicWorkflowUserMode,
  isDynamicWorkflowModeEnabled,
  normalizeDynamicWorkflowMode,
  type AgentLaneResourceSample,
  type ProcessResourceCliLane,
  type ZCodeMcpTelemetryEvent,
  type ZCodeMcpResourceSample,
  type ZCodeToolExecResource,
  type ZCodePluginOperationProgressNotification,
  type ZCodeTaskMode,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createOfficialMcpIssuanceAudit } from "#src/official-mcp/officialMcpIssuanceAudit.js";
import type {
  AccountRequestAuthMaterial,
  IAccountRequestAuthService,
} from "#src/model-provider/accountRequestAuthService.js";
import {
  mergeAutomationMutationToolDenylist,
  mergeOffPeakMutationToolDenylist,
} from "#src/zcode-agent/automationToolPolicy.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
import type {
  ZCodeProtocolRequestId,
  ModelSelection,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeProviderRuntimeHeadersCancelled,
  ZCodeSessionEvent,
  ZCodeSessionRuntimePreferencesScope,
  ZCodeSavedWorkflowScope,
  ZCodeStateUpdatedNotification,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceRef,
  ZCodeSessionRuntimePreferencesResult,
} from "@zcode/shared";
import type {
  IZCodeAgentService,
  ZCodeAgentBackgroundBashOutputParams,
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAppUsageParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentCompactParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentGenerateWorkspaceTextParams,
  ZCodeAgentTestModelConnectivityParams,
  ZCodeAgentGoalParams,
  ZCodeAgentGrantWorkspaceHookTrustParams,
  ZCodeAgentInitializeResult,
  ZCodeAgentListSessionsParams,
  ZCodeAgentListSessionSubagentsParams,
  ZCodeAgentReadWorkspacePresentationParams,
  ZCodeAgentReadSessionEventsParams,
  ZCodeAgentReadSessionMessagesParams,
  ZCodeAgentReadSessionParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRespondProviderRuntimeHeadersParams,
  ZCodeAgentRespondSessionRuntimePreferencesParams,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentSendPromptParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentTaskTokenUsageParams,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentReadMcpResourceParams,
  ZCodeAgentCallMcpToolForUiParams,
  ZCodeAgentCancelMcpToolCallForUiParams,
  ZCodeAgentReadMcpResourceForUiParams,
  ZCodeAgentListMcpResourcesForUiParams,
  ZCodeAgentAppToolCallForUiParams,
  ZCodeAgentAppToolInstanceForUiParams,
  ZCodeAgentRegisterAppToolsForUiParams,
  ZCodeAgentResolveAppToolCallForUiParams,
  ZCodeAgentMcpResourceSubscriptionForUiParams,
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentFindSavedWorkflowForRunParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentSaveSavedWorkflowFromRunParams,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentWorkspaceTarget,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentReadParams,
  ZCodeAgentConversationAttachmentReadParams,
  ZCodeAgentConversationAttachmentStatParams,
  ZCodeAgentAttachmentPreviewSourceParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentConversationCommandParams,
  ZCodeAgentCommandsQueryParams,
  ZCodeAgentConversationFileChangesParams,
  ZCodeAgentConversationFileRewindPreviewParams,
  ZCodeAgentConversationRowsRangeParams,
  ZCodeAgentConversationPlansParams,
  ZCodeAgentConversationWorkflowRunEventsParams,
  ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ZCodeAgentConversationWorkflowRunArtifactsParams,
  ZCodeAgentConversationWorkflowRunNodeResultParams,
  ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ZCodeAgentConversationWorkflowRunsParams,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationSubscribeParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentConnectionFlowParams,
  ZCodeAgentSessionsIndexSubscribeParams,
  ZCodeAgentWorkspaceConfigSubscribeParams,
} from "./zcodeAgent.js";
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  V4_WIRE_PROTOCOL_VERSION,
  PROTOCOL_V4_LIMITS,
  clientHelloSchema,
  commandAckSchema,
  commandPayloadSchemas,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  conversationTopic,
  conversationTopicWireCandidateSchema,
  conversationTelemetryFactSchema,
  cuaPermissionObservationSchema,
  sessionsIndexTopic,
  sessionsIndexTopicWireCandidateSchema,
  MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE,
  V4_METHODS,
  V4_NOTIFICATIONS,
  v4AttachmentAbortResultSchema,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowResultSchema,
  v4ConversationFileChangesResultSchema,
  v4ConversationFileRewindPreviewResultSchema,
  v4ConversationRowsRangeResultSchema,
  v4ConversationPlansResultSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationResyncResultSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationUsageResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  v4UsageStatsResultSchema,
  v4WorkspaceConfigSubscribeResultSchema,
  workspaceConfigTopic,
  workspaceConfigTopicWireCandidateSchema,
  utf8JsonByteLength,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  type CommandAck,
  type ConversationTopicWireCandidate,
  type ConversationTelemetryFact,
  type SessionsIndexTopicWireCandidate,
  type WorkspaceConfigTopicWireCandidate,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  readTrustedZCodeAgentV4Connection,
  readTrustedZCodeAgentV4UnsubscribeRoute,
  type ZCodeAgentV4ConnectionContext,
} from "./zcodeAgentConnectionScope.js";
import { createBackgroundSessionEventCoalescer } from "#src/zcode-agent/zcodeSessionEventCoalescer.js";
import { AutomationService } from "#src/session/automationService.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { ZCodeAgentMcpStatusModeUnsupportedError } from "#src/zcode-agent/zcodeAgentErrors.js";
import { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";
import type { ZCodeAgentProcessManagerOptions } from "./zcodeAgentProcessManager.js";
import type { IOffPeakTaskService } from "#src/session/offPeakTask.js";
import {
  ZCodeProtocolRequestTimeoutError,
  type ZCodeProtocolClient,
} from "./zcodeProtocolClient.js";
import { getDataBaseDir } from "../paths.js";
import {
  collectBrowserAmbientContext,
  type BrowserAmbientContextExecutor,
} from "./zcodeAgentBrowserAmbientContext.js";
import {
  createCuaOperationTurnTracker,
  type CuaOperationWorkspaceTarget,
  type CuaOperationStateReporter,
} from "./cuaOperationTurnTracker.js";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

import {
  zcodeMcpUiResourceSubscriptionResultSchema as mcpUiEmptyResultSchema,
  zcodeMcpUiCloseInstanceResultSchema,
  zcodeMcpUiOpenInstanceResultSchema,
} from "@zcode/shared";
const logger = createServiceLogger("zcode-agent-service");
const cuaOperationLogger = createServiceLogger("cua-operation-turn");
const PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME = "plugin-workspace";
// Release idle MCP children after the probe; control plane only, never session processes.
const MCP_STATUS_LANE_IDLE_TIMEOUT_MS = 5 * 60_000;
// First marketplace contact clones/copies a GitHub repo; the 30s default timeout kills healthy agents.
// Marketplace ops are rare network IO with their own timeout, leaving session failure edges alone.
const PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** One-second resource refresh; the child map is in-memory, and a timeout just means no map this tick. */
const CHILD_PROCESSES_REQUEST_TIMEOUT_MS = 800;
const PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS = 5_000;
const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000;

interface PendingPermissionRequest {
  client: ZCodeProtocolClient;
  protocolRequestId: ZCodeProtocolRequestId;
}

interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {
  request: ZCodeProviderRuntimeHeadersRequestParams;
  responding?: boolean;
}

interface PendingSessionRuntimePreferencesRequest extends PendingPermissionRequest {
  request: ZCodeAgentSessionRuntimePreferencesRequest;
  timeout: ReturnType<typeof setTimeout>;
  workspaceKey: string;
}

type SessionCreateCompatField =
  | "persistence"
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
type SessionResumeCompatField =
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
type SessionSendCompatField =
  | "browserAmbientContext"
  | "automationId"
  | "offPeakTaskId"
  | "offPeakRunType"
  | "botDeliveryTarget"
  | "toolDenylist";

const SESSION_CREATE_OPTIONAL_COMPAT_FIELDS = new Set<SessionCreateCompatField>([
  "persistence",
  "thoughtLevel",
  "mcpServers",
  // CUA tool isolation adds allow/deny lists in buildSessionCreateParams. If the old app-server
  // strict schema rejects them, retry degraded instead of failing createSession.
  "toolAllowlist",
  "toolDenylist",
  // The off-peak flag degrades the same way: omit and retry (tools stay unregistered, fail-closed).
  "offPeakToolEnabled",
  // Workflow gating flag likewise: on legacy CLIs
  /**   omit and retry, leaving workflow tools unregistered, never failing create. */
  "dynamicWorkflowEnabled",
  // Gating mode (launch.md on-demand): boolean-only CLIs omit it and behave alwaysOn.
  "dynamicWorkflowMode",
]);
const SESSION_RESUME_OPTIONAL_COMPAT_FIELDS = new Set<SessionResumeCompatField>([
  "thoughtLevel",
  "mcpServers",
  // Cold restore carries tool constraints too, degrading like create on old app-servers.
  "toolAllowlist",
  "toolDenylist",
  "offPeakToolEnabled",
  "dynamicWorkflowEnabled",
  "dynamicWorkflowMode",
]);
const SESSION_SEND_OPTIONAL_COMPAT_FIELDS = new Set<SessionSendCompatField>([
  "browserAmbientContext",
  "automationId",
  "offPeakTaskId",
  "offPeakRunType",
  "botDeliveryTarget",
  "toolDenylist",
]);
// If getClient/sessionSubscribe fails transiently while onDynamicSessionEvent subscribes
/**
(fresh process, Session-is-not-active races, transport flaps),
a bare catch caches the emitter as subscribed and never rebuilds:
terminal events never arrive,
sqlite stales, spinners spin. Bounded exponential retry covers the transient window.
*/
const SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS = 500;
const SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS = 5_000;
const SESSION_SUBSCRIBE_MAX_ATTEMPTS = 8;
const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;
const SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:ssh:";
const WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:wsl:";

export function supportsLegacyRemoteTaskAllowlist(workspaceIdentity: string | undefined): boolean {
  return Boolean(
    workspaceIdentity?.startsWith(SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX) ||
    workspaceIdentity?.startsWith(WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX),
  );
}

function isClosedStdioTransportError(error: unknown): boolean {
  return error instanceof Error && error.message === "ZCode agent stdio transport is closed";
}

interface SessionEventSequenceState {
  assignedSeqByEventId: Map<string, number>;
  assignedSeqEventIds: string[];
  liveEventIds: Set<string>;
  liveEventIdOrder: string[];
  lastAssignedSeq: number;
}

function isProtocolMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

function buildWorkspaceRef(params: ZCodeAgentWorkspaceTarget): ZCodeWorkspaceRef {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    workspaceKey: resolveWorkspaceKey(params),
  };
}

/**
Whether a saved-workflow target carries a workspace: project runs and
GUI global actions with an explicit workspace do; bare scope:global
does not, letting services pick the carrier.
*/
function savedWorkflowTargetHasWorkspace(
  params: ZCodeAgentSavedWorkflowTarget,
): params is ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope } {
  return typeof (params as Partial<ZCodeAgentWorkspaceTarget>).workspacePath === "string";
}

/** Push scope into RPC params only when defined: scope-less project calls keep today's exact wire shape. */
function savedWorkflowScopeParam(params: ZCodeAgentSavedWorkflowTarget): {
  scope?: ZCodeSavedWorkflowScope;
} {
  return params.scope === undefined ? {} : { scope: params.scope };
}

function ensurePluginManagementWorkspacePath(): string {
  const workspacePath = join(getDataBaseDir(), ".zcode", PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME);
  /**
  Plugin management is control-plane: never reuse session processes that EPIPE when workspaces vanish.
  Give it a fixed internal cwd; the real workspace still rides protocol params for scoping.
  */
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

// NOTE: this counts ONLY the per-session MCP servers passed through the ZCode Protocol
// session/create params (the app→protocol channel). It is deliberately independent of the
// CLI/bootstrap MCP servers configured in ~/.zcode/cli/config.json (mcp.servers), which the agent
// runtime connects separately and reports via the `mcp.server.connected`/toolCount events. So a
// createSession log line with mcpServerCount:0 is EXPECTED when zcode-cua is a CLI-config MCP server
// (e.g. the product Helper broker path injected through the gated bootstrap env): the model still receives those
// tools — the two numbers describe different channels, not a missing tool set. Verified on-machine:
// real kimi-k2.6 turns call mcp__zcode-cua__* tools (get_app_state/type/open_application, status
// completed) in sessions whose createSession logged mcpServerCount:0.
function getMcpServerCount(params: { mcpServers?: readonly unknown[] }): number {
  return params.mcpServers?.length ?? 0;
}

function getMcpServerNames(params: { mcpServers?: readonly { name: string }[] }): string[] {
  return params.mcpServers?.map((server) => server.name) ?? [];
}

function parseInvalidParamsIssues(error: unknown): unknown[] {
  const errorLike = error as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  const message = errorLike.message;
  if (
    errorLike.code !== -32602 ||
    typeof message !== "string" ||
    (message !== "Invalid params" && !message.startsWith("Invalid params — "))
  ) {
    return [];
  }
  const data = errorLike.data;
  if (!data || typeof data !== "object") {
    return [];
  }
  /**
  New agents append the Zod summary to message; the legacy parser accepts only exact
  Invalid params, blocking omit-retries on version skew. Trust only
  structured issues in data, never the mutable summary text.
  */
  const serializedIssues = (data as { message?: unknown }).message;
  if (typeof serializedIssues !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(serializedIssues) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getUnrecognizedTopLevelKeys(error: unknown): string[] {
  const keys = new Set<string>();
  for (const issue of parseInvalidParamsIssues(error)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueLike = issue as {
      code?: unknown;
      keys?: unknown;
      path?: unknown;
    };
    if (
      issueLike.code !== "unrecognized_keys" ||
      (Array.isArray(issueLike.path) && issueLike.path.length > 0) ||
      !Array.isArray(issueLike.keys)
    ) {
      continue;
    }
    for (const key of issueLike.keys) {
      if (typeof key === "string") {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

function getSessionCreateCompatFields(error: unknown): SessionCreateCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionCreateCompatField =>
      SESSION_CREATE_OPTIONAL_COMPAT_FIELDS.has(key as SessionCreateCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function getSessionResumeCompatFields(error: unknown): SessionResumeCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionResumeCompatField =>
      SESSION_RESUME_OPTIONAL_COMPAT_FIELDS.has(key as SessionResumeCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function getSessionSendCompatFields(error: unknown): SessionSendCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionSendCompatField =>
      SESSION_SEND_OPTIONAL_COMPAT_FIELDS.has(key as SessionSendCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function isProtocolRequestTimeout(error: unknown, method: string): boolean {
  if (error instanceof ZCodeProtocolRequestTimeoutError) {
    return error.method === method;
  }
  return error instanceof Error && error.message === `ZCode Protocol request timed out: ${method}`;
}

function assertV4AttachmentNdjsonEnvelope(method: string, params: unknown): void {
  /**   Real CLI ids increment; this wider 32-char id is a conservative exact-JSON meter. */
  const bytes = utf8JsonByteLength({ id: "9".repeat(32), method, params }) + 1; // NDJSON newline
  if (bytes > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}

function buildSessionCreateParams(
  params: ZCodeAgentCreateSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionCreateCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    workspace: buildWorkspaceRef(params),
    parentSessionId: params.parentSessionId,
    mode: params.mode,
    model: params.model,
    ...(params.persistence !== undefined && !omittedFields.has("persistence")
      ? { persistence: params.persistence }
      : {}),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    ...(params.titleGenerationEnabled !== undefined
      ? { titleGenerationEnabled: params.titleGenerationEnabled }
      : {}),
    /**
    Continuous first-sends/resumes use the session service, not the legacy task adapter.
    UI-resolved MCP never reached strict params, so runtimeConfig saw none.
    MCP is startup config: pass it at create/resume; sendPrompt cannot add it later.
    */
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // Isolation fields degrade: legacy compat retries move them into
    /**     omittedFields instead of failing; gate this path the same way. */
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    /**
    importedHistory is import integrity: unlike thoughtLevel/persistence it cannot
    be omitted on legacy retries, or you mint a switchable but empty session.
    */
    ...(params.importedHistory !== undefined ? { importedHistory: params.importedHistory } : {}),
    /**     Send true only when gating hits (omit otherwise); legacy strict schemas drop it via compat. */
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    /**
    Workflow gating mirrors the off-peak shape:
    omit when disabled; CLI default leaves the nine tools unregistered.
    */
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

/**
 The gating mode rides the boolean (launch.md): written only when enabled and only alongside it;
 alone it is meaningless. Legacy strict schemas omit via compat and act alwaysOn.
 */
function buildDynamicWorkflowModeField(
  params: { dynamicWorkflowEnabled?: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
  omittedFields: ReadonlySet<SessionCreateCompatField | SessionResumeCompatField>,
): { dynamicWorkflowMode?: DynamicWorkflowMode } {
  return params.dynamicWorkflowEnabled === true &&
    params.dynamicWorkflowMode !== undefined &&
    !omittedFields.has("dynamicWorkflowEnabled") &&
    !omittedFields.has("dynamicWorkflowMode")
    ? { dynamicWorkflowMode: params.dynamicWorkflowMode }
    : {};
}

function buildSessionResumeParams(
  params: ZCodeAgentResumeSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionResumeCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    workspace: buildWorkspaceRef(params),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    /**     Cold restore can respawn runtimes; MCP must ride the resume call too. */
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    /**
    Tool constraints ride resume exactly as create, or restored runtimes lose allow/deny
    isolation (CUA sessions resee Bash). Legacy app-servers degrade via omittedFields.
    */
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    /**     Resume without this flag drops the off-peak toolset (same as toolAllowlist). */
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    /**     Same cause: omitting it on resume loses the workflow toolset. */
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

function buildSessionSendParams(
  params: ZCodeAgentSendPromptParams,
  omittedFields: ReadonlySet<SessionSendCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    /**     Execution identity/constraints are not droppable: fail on old workers, never strip silently. */
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
    inputId: params.inputId,
    queryId: params.queryId,
    content: params.content,
    attachments: params.attachments,
    ...(params.browserAmbientContext !== undefined && !omittedFields.has("browserAmbientContext")
      ? { browserAmbientContext: params.browserAmbientContext }
      : {}),
    expectedRevision: params.expectedRevision,
    expectedProviderRevision: params.expectedProviderRevision,
    ...(params.automationId !== undefined && !omittedFields.has("automationId")
      ? { automationId: params.automationId }
      : {}),
    ...(params.offPeakTaskId !== undefined && !omittedFields.has("offPeakTaskId")
      ? { offPeakTaskId: params.offPeakTaskId }
      : {}),
    ...(params.offPeakRunType !== undefined && !omittedFields.has("offPeakRunType")
      ? { offPeakRunType: params.offPeakRunType }
      : {}),
    ...(params.botDeliveryTarget !== undefined && !omittedFields.has("botDeliveryTarget")
      ? { botDeliveryTarget: params.botDeliveryTarget }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
  };
}

function buildSessionCompactParams(params: ZCodeAgentCompactParams) {
  return {
    sessionId: params.sessionId,
    inputId: params.inputId,
    instructions: params.instructions,
    expectedRevision: params.expectedRevision,
  };
}

function formatModelSelectionForLog(ref: ModelSelection | undefined): string | null {
  if (!ref) {
    return null;
  }

  const base = `${ref.providerId}/${ref.modelId}`;
  const reasoningLevel = ref.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

function sessionEventKey(params: ZCodeAgentSessionTarget): string {
  return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
}

function rememberBoundedEventId(ids: Set<string>, order: string[], eventId: string): boolean {
  if (ids.has(eventId)) {
    return false;
  }
  ids.add(eventId);
  order.push(eventId);
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

function permissionRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function userInputRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function providerRuntimeHeadersRequestKey(
  params: ZCodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

/**
 Read-only selection projection of the process registry.
 *
 The worker owns the full registry; the host uses this projection only to gate execution,
 never expanding it into runtimeModel over the worker's truth.
 */
interface ModelSelectionReadinessSource {
  getView(): Promise<ModelSelectionView>;
  onDidChange?: (listener: (view: ModelSelectionView) => void) => IDisposable;
}

interface ZCodeAgentProviderReadinessSnapshot {
  readonly providerCount: number;
  readonly revision: string;
  readonly readiness: {
    readonly ready: boolean;
    readonly providerId?: string;
    readonly modelId?: string;
  };
}

function createProviderReadinessSnapshotFromSelectionView(
  view: ModelSelectionView,
): ZCodeAgentProviderReadinessSnapshot {
  for (const provider of view.providers) {
    const model = provider.models[0];
    if (!model) continue;
    return {
      providerCount: view.providers.length,
      revision: `model-selection:${view.revision}`,
      readiness: {
        ready: true,
        providerId: provider.providerId,
        modelId: model.modelId,
      },
    };
  }
  return {
    providerCount: view.providers.length,
    revision: `model-selection:${view.revision}`,
    readiness: { ready: false },
  };
}

interface WaitingWorkspaceStartup {
  cancelled: boolean;
  lastLoggedRevision?: string;
  starting?: Promise<ZCodeProtocolClient>;
  workspace: ZCodeAgentWorkspaceTarget;
}

interface ActiveWorkspaceClient {
  client: ZCodeProtocolClient;
  interactionPreferencesReady?: Promise<void>;
  /**
   Records only whether this process ever passed the provider/model gate.
   Read-only topics may start the CLI but never bypass gates for create/command.
   */
  modelExecutionEnabled: boolean;
  workspace: ZCodeAgentWorkspaceTarget;
  /**
   The workflow policy this CLI holds (launch.md). Off at start;
   updated only after workspace/updateDynamicWorkflowPolicy succeeds; resync skips no-ops.
   */
  dynamicWorkflowPolicyMode: DynamicWorkflowMode;
}

function createRuntimeUnavailableError(params: ZCodeAgentWorkspaceTarget): Error & {
  code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  workspaceKey: string;
} {
  const error = new Error("ZCode Agent runtime is not running.") as Error & {
    code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
    workspaceKey: string;
  };
  error.code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  error.workspaceKey = resolveWorkspaceKey(params);
  return error;
}

interface CreateZCodeAgentServiceOptions extends Omit<
  ZCodeAgentProcessManagerOptions,
  "idleTimeoutMs"
> {
  /** mcp-status probe lanes only; never leak idle reaping to chat. */
  mcpStatusIdleTimeoutMs?: number;
  accountProviderConfigSource?: ProviderSource<AccountProviderConfigSnapshot>;
  accountRequestAuthService?: IAccountRequestAuthService;
  /** Asks Main to register the exact local video path an Agent authorized. */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  modelSelectionReadinessSource?: ModelSelectionReadinessSource;
  readSubagentRuntimeConfig?: (workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<SubagentRuntimeConfig>;
  sessionRuntimePreferencesAuthority?: "local" | "external";
  resolveSessionRuntimePreferences?: (
    scope: ZCodeSessionRuntimePreferencesScope,
  ) => Promise<ZCodeSessionRuntimePreferencesResult>;
  /** The host dispatches manual runs inline; on return the session must have the prompt. */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /**
   Created inside off-peak sessions. config gates exposure (enabled && non-empty view ->
   session create/resume sends offPeakToolEnabled) and defaults (model = last whitelist /
   thoughtLevel = top); served to the offPeak/create and offPeak/list handlers.
   Either missing disables the whole surface (plain CLI/attached-remote omit it).
   */
  resolveOffPeakClientConfig?: () => Promise<OffPeakClientConfig | undefined>;
  /**
   Workflow gating snapshot. The host is the sole arbiter:
   it feeds the CLI as workspace fact and decides whether create/resume/v4 carry
   dynamicWorkflowEnabled. Omitted (plain CLI) means forever off, matching CLI default.
   */
  resolveDynamicWorkflowClientConfig?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  /**
   User-choice reader (launch.md): setting-authoritative hosts inject and read per use;
   attached remotes use the desktop-pushed value (syncDynamicWorkflowUserMode).
   */
  resolveDynamicWorkflowUserMode?: () => Promise<DynamicWorkflowMode | undefined>;
  /** Post-sync forwarder (desktop pushes to this window's remote hosts); value from local settings. */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  resolveOffPeakTaskService?: () =>
    | Pick<IOffPeakTaskService, "createTask" | "list" | "getCodingPlanSupport">
    | undefined;
  /**
   browser-use bridge: forwards agent interaction/browserExecute to main
   (WebContentsView+CDP). Injected by the desktop host; without it
   browser calls return backend_unavailable; nothing else suffers.
   */
  browserControlExecutor?: BrowserAmbientContextExecutor;
  channelReplyExecutor?: (request: ChannelReplyHostRequest) => Promise<ChannelReplyResult>;
  topicResourceExecutor?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<ZCodePromptAttachment>;
  topicResourceValidator?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   Official server MCP identity resolver. Agent processes hold no user authority;
   they ask the host via interaction/requestOfficialMcpAuthHeaders per request.
   *
   Without it: official_auth_unavailable, never anonymous fallback,
   (standalone CLIs have no host auth port).
   */
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(request: {
      mcpKey: string;
      pluginId: string;
      targetOrigin: string;
      workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
    }): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  /**
   Official MCP trusted-origin validator. The host is the identity boundary, so
   targetOrigin is checked here, not left to the agent fetch wrapper (the audited
   party would audit itself; remotes run agents while hosts hold identity).
   *
   This validates the credential target origin; no per-plugin ACLs.
   HTTP auth rides the host fetch wrapper; stdio hands credentials to the plugin process,
   which must be trusted code. The server still checks identity, grants, and quota per call.
   *
   Default deny (fail closed); never degrade to schema-check-and-issue.
   */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** Desktop-local injection; consumes validated, deduped live session events only. */
  cuaOperationStateReporter?: CuaOperationStateReporter;
  onCuaPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
}

function toProtocolAutomation(automation: ZCodeAutomation) {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    mode: automation.mode,
    targetTaskId: automation.targetTaskId,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    /**
    Pass the authoritative scheduleRule: cards need it to show true intervals cron cannot express
    (every 50h/40d); the cron fallback misrenders as hourly-at-00.
    */
    scheduleRule: automation.scheduleRule,
  };
}

export function toProtocolOffPeakTaskSnapshot(task: {
  offPeakTaskId: string;
  title: string;
  status: "queued" | "paused" | "running" | "completed" | "failed" | "cancelled";
  queuePosition?: number;
  sessionId?: string;
  createdAt: number;
}) {
  /**   Minimal protocol: no serverTicketId/providerName/workspace detail. */
  return {
    offPeakTaskId: task.offPeakTaskId,
    title: task.title,
    status: task.status,
    ...(typeof task.queuePosition === "number" && task.queuePosition > 0
      ? { queuePosition: task.queuePosition }
      : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    createdAt: task.createdAt,
  };
}

export const OFF_PEAK_INTERNAL_ERROR_CODE = "offpeak_internal_error";
export const OFF_PEAK_INTERNAL_ERROR_MESSAGE = "Internal off-peak service error";

/**
 The offPeak catch-all must not echo cross-layer exception text (SQLite/path/
 upstream fragments) over the protocol; it reaches CLI logs and model-visible errors. Raw errors stay server-side,
 with stable codes and generic copy; business failures keep respond({ok:false}).
 */
async function respondOffPeakInternalError(
  client: Pick<ZCodeProtocolClient, "respondError">,
  request: { id: ZCodeProtocolRequestId; method: string },
  workspace: ZCodeAgentWorkspaceTarget,
  error: unknown,
): Promise<void> {
  logger.warn(undefined, "Off-peak protocol request failed", {
    method: request.method,
    workspaceKey: resolveWorkspaceKey(workspace),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  await client.respondError(request.id, {
    code: -32603,
    message: OFF_PEAK_INTERNAL_ERROR_MESSAGE,
    data: { errorCode: OFF_PEAK_INTERNAL_ERROR_CODE },
  });
}

/** D49-8/SG-02: creatable only when gating is on with a non-empty list; otherwise disabled (empty). */
export function resolveOffPeakAllowedModels(
  grayConfig: OffPeakClientConfig | undefined,
  providerId?: string,
): readonly string[] {
  if (grayConfig?.enabled !== true) return [];
  return grayConfig.modelSelectionView.providers
    .filter((provider) => providerId === undefined || provider.providerId === providerId)
    .flatMap((provider) => provider.models.map((model) => model.modelId));
}

/**
 Model: omitted -> last whitelist entry (newest); explicit -> trim + case-insensitive match,
 returning the canonical spelling on hit, else null (model_not_allowed).
 */
export function resolveOffPeakCreateModel(
  allowedModels: readonly string[],
  requested: string | undefined,
): string | null {
  const wanted = requested?.trim();
  if (!wanted) return allowedModels[allowedModels.length - 1] ?? null;
  const lower = wanted.toLowerCase();
  return allowedModels.find((model) => model.trim().toLowerCase() === lower) ?? null;
}

/**
 New tool tasks reuse the shared top tier; legacy per-model ifs break values ordering.
 Explicit levels stay with createTask validation; never re-level here.
 */
export function resolveOffPeakToolSelection(
  view: ModelSelectionView,
  providerId: string,
  modelId: string,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const selection = completeNewModelSelection(view, { providerId, modelId });
  if (!selection) return undefined;
  return thoughtLevel === undefined
    ? selection
    : { ...selection, options: { reasoningLevel: thoughtLevel } };
}
export function createZCodeAgentService(
  options?: CreateZCodeAgentServiceOptions,
): IZCodeAgentService & { disposeAllAndWait(): Promise<void> } {
  const processManager = new ZCodeAgentProcessManager(options);
  /**   Windows indicator and the macOS producer lifecycle share validated, deduped sideband facts. */
  const cuaOperationTurnTracker =
    options?.cuaOperationStateReporter || options?.onCuaPipSessionLifecycle
      ? createCuaOperationTurnTracker({
          ...(options?.cuaOperationStateReporter
            ? { reporter: options.cuaOperationStateReporter }
            : {}),
          ...(options?.onCuaPipSessionLifecycle
            ? { onPipSessionLifecycle: options.onCuaPipSessionLifecycle }
            : {}),
          logger: {
            debug: (message) => cuaOperationLogger.debug(undefined, message),
            info: (message) => cuaOperationLogger.info(undefined, message),
            warn: (message) => cuaOperationLogger.warn(undefined, message),
          },
        })
      : undefined;
  /**   AutomationRepo also holds a tasks-index handle; disposeAll closes it too (see disposeAll). */
  const automationRepo = new AutomationRepo();
  const automationService = new AutomationService(automationRepo);
  const automationTaskIndexRepo = new TaskIndexRepo();
  const pluginProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
  });
  /**
  A merge dropped the dedicated process: slow mcp/list handshakes blocked the stdio queue and uninstalls.
  Restore the dedicated control-plane process and idle reap: shared cwd, separate queue/watchdog.
  */
  const mcpStatusProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    processLifecycleReporter: options?.processLifecycleReporter,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
    lane: "mcp-status",
    idleTimeoutMs: options?.mcpStatusIdleTimeoutMs ?? MCP_STATUS_LANE_IDLE_TIMEOUT_MS,
  });
  const sessionEmitters = new Map<string, Emitter<ZCodeAgentServiceEvent>>();
  /**
   (pluginId, mcpId, workspaceKey) triples that already logged first issuance.
   *
   Why: success cannot be debug-only (prod floors at Info); otherwise
   * which plugin took the credentials. But every initialize/tools call issues one,
   so full info logging would match message volume. Compromise: one info per triple per process
   then debug: enough to answer who/where/when-first.
   */
  const officialMcpIssuanceAudit = createOfficialMcpIssuanceAudit();
  const providerRuntimeHeadersWorkspaceEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersRequestParams>
  >();
  const providerRuntimeHeadersCancelledEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersCancelled>
  >();
  function cancelProviderRuntimeHeaders(
    key: string,
    pending: PendingProviderRuntimeHeadersRequest,
  ): void {
    pendingProviderRuntimeHeaders.delete(key);
    const { requestId, sessionId, workspace } = pending.request;
    /**     Delete before emit so late subscribers never revive cancelled validations. */
    providerRuntimeHeadersCancelledEmitters
      .get(resolveWorkspaceKey(workspace))
      ?.fire({ requestId, sessionId, workspace });
    logger.info(undefined, "Request validation cancelled", {
      requestId,
      sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
  }
  const sessionRuntimePreferencesRequestEmitter =
    new Emitter<ZCodeAgentSessionRuntimePreferencesRequest>();
  const processResourceSampleEmitter = new Emitter<AgentLaneResourceSample>();
  const toolExecResourceEmitter = new Emitter<ZCodeToolExecResource>();
  const mcpResourceSamplesEmitter = new Emitter<ZCodeMcpResourceSample[]>();
  const mcpTelemetryEmitter = new Emitter<ZCodeMcpTelemetryEvent>();
  const pluginOperationProgressEmitters = new Map<
    string,
    Emitter<ZCodePluginOperationProgressNotification>
  >();
  /**   v4 conversation fan-out: workspace emitter; renderers route by topic. */
  const conversationFrameEmitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();
  const localTtftFactsEmitter = new Emitter<{ workspaceKey: string; facts: LocalTtftFacts }>();
  const conversationTelemetryFactEmitters = new Map<string, Emitter<ConversationTelemetryFact>>();
  const cuaPermissionObservationEmitter = new Emitter<ZCodeAgentCuaPermissionObservation>();
  /**   sessions-index fan-out: same conversationFrame notification, prefix-split here. */
  const sessionsIndexFrameEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  /**   workspace-config fan-out: catalog liveness for the syncer, prefix-split. */
  const workspaceConfigFrameEmitters = new Map<
    string,
    Emitter<WorkspaceConfigTopicWireCandidate>
  >();
  /**
  v4 resubscribes key on (connectionId, topic); each host process serves one
  renderer window, so a stable id lets resubscribes replace cleanly.
  */
  const v4ConnectionId = `host-${randomUUID()}`;
  interface V4SubscriptionRoute {
    workspaceKey: string;
    topic: string;
    subscriptionId: string;
    connectionId: string;
  }
  const v4SubscriptionRoutes = new Map<string, V4SubscriptionRoute>();
  const v4RouteKeyByOwnership = new Map<string, string>();
  const v4RouteRuntimeRestartDisposable = processManager.onRuntimeRestarted(({ workspaceKey }) => {
    clearV4SubscriptionRoutes(workspaceKey);
    cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
  });
  const sessionEventSequenceStates = new Map<string, SessionEventSequenceState>();
  const wiredClients = new WeakSet<ZCodeProtocolClient>();
  const clientDisposables = new WeakMap<ZCodeProtocolClient, IDisposable[]>();
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const pendingUserInputs = new Map<string, PendingPermissionRequest>();
  /**   Memory diagnostics: sizes of per-session mirrors only. */
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("agent", () => ({
    sessionEmitters: sessionEmitters.size,
    seqStates: sessionEventSequenceStates.size,
    pendingPermissions: pendingPermissions.size,
    pendingUserInputs: pendingUserInputs.size,
  }));
  const pendingProviderRuntimeHeaders = new Map<string, PendingProviderRuntimeHeadersRequest>();
  const pendingSessionRuntimePreferences = new Map<
    string,
    PendingSessionRuntimePreferencesRequest
  >();
  const activeClientsByWorkspaceKey = new Map<string, ActiveWorkspaceClient>();
  const interactionPreferenceSyncByWorkspaceKey = new Map<string, Promise<void>>();
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  /** One in-process read of the server offer; see resolveDynamicWorkflowGate. */
  let dynamicWorkflowOffer: Promise<DynamicWorkflowClientConfig | undefined> | undefined;
  /** Desktop-pushed choice, used only without local settings authority. */
  let pushedDynamicWorkflowUserMode: DynamicWorkflowMode | undefined;
  /** Per-workspace sync chain: each step reads the effective mode after the previous lands. */
  const dynamicWorkflowPolicySyncByWorkspaceKey = new Map<string, Promise<void>>();
  const waitingWorkspaceStartups = new Map<string, WaitingWorkspaceStartup>();
  function cancelWaitingWorkspaceStartup(workspaceKey: string): void {
    const waiting = waitingWorkspaceStartups.get(workspaceKey);
    if (waiting) {
      waiting.cancelled = true;
      waitingWorkspaceStartups.delete(workspaceKey);
    }
  }
  function cancelAllWaitingWorkspaceStartups(): void {
    for (const waiting of waitingWorkspaceStartups.values()) {
      waiting.cancelled = true;
    }
    waitingWorkspaceStartups.clear();
  }
  const accountConfigSyncByClient = new WeakMap<ZCodeProtocolClient, Promise<void>>();
  /**   This dedupes delivered snapshots only; the worker registry may lag. */
  const accountConfigReceivedRevisionByClient = new WeakMap<ZCodeProtocolClient, string>();
  const sessionTraceIdBySessionKey = new Map<string, TraceId>();
  const accountRequestAuthService = options?.accountRequestAuthService;
  const accountProviderConfigSource = options?.accountProviderConfigSource;
  const modelSelectionReadinessSource = options?.modelSelectionReadinessSource;
  const sessionRuntimePreferencesAuthority = options?.sessionRuntimePreferencesAuthority ?? "local";
  const resolveSessionRuntimePreferences = options?.resolveSessionRuntimePreferences;

  function invalidateWorkspaceClient(workspaceKey: string, client: ZCodeProtocolClient): void {
    for (const [key, pending] of pendingPermissions) {
      if (pending.client === client) {
        pendingPermissions.delete(key);
      }
    }
    for (const [key, pending] of pendingUserInputs) {
      if (pending.client === client) {
        pendingUserInputs.delete(key);
      }
    }
    for (const [key, pending] of pendingProviderRuntimeHeaders) {
      if (pending.client === client) {
        cancelProviderRuntimeHeaders(key, pending);
      }
    }
    for (const [key, pending] of pendingSessionRuntimePreferences) {
      if (pending.client === client) {
        clearTimeout(pending.timeout);
        pendingSessionRuntimePreferences.delete(key);
      }
    }
    for (const disposable of clientDisposables.get(client) ?? []) {
      disposable.dispose();
    }
    clientDisposables.delete(client);

    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.client !== client) {
      /**
      Lifecycle events interleave with the next generation; late cleanup releases
      only its own binding, never the newer client/state.
      */
      return;
    }
    activeClientsByWorkspaceKey.delete(workspaceKey);
    /**
    Interaction preference lives in process memory: after any generation change, resync
    even at the same revision; never reuse the old done-Promise.
    */
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
  }

  const runtimeLifecycleDisposable = processManager.onRuntimeLifecycle((event) => {
    if (event.state !== "unavailable") return;
    /**
    On protocol close, crash, or timeout the runtime may never send turn-failed/
    session-closed, and the next generation may not start. Clear the CUA tracker at the
    authoritative unavailable boundary, or Windows banners and recovery gates stick forever.
    */
    cuaOperationTurnTracker?.clearWorkspaceKey(event.workspaceKey);
    const active = activeClientsByWorkspaceKey.get(event.workspaceKey);
    if (!active) return;
    /**
    The process manager fires unavailable for the current runtime only; bind the
    active client as a second identity guard so late reaps miss the new generation.
    */
    invalidateWorkspaceClient(event.workspaceKey, active.client);
  });

  async function resolveAccountRequestAuth(
    request: ZCodeProviderRuntimeHeadersRequestParams,
  ): Promise<AccountRequestAuthMaterial | undefined> {
    if (!request.accountAccess || !accountRequestAuthService) {
      return undefined;
    }
    return accountRequestAuthService.resolveCurrent({
      providerId: request.providerId,
      modelId: request.modelSelection.modelId,
      accountAccess: request.accountAccess,
      expectedAccountScope: request.expectedAccountScope,
      rejectedProjectTokenFingerprint: request.rejectedProjectTokenFingerprint,
      reason: request.reason,
    });
  }

  async function respondAccountRequestAuthWithoutInteraction(params: {
    key: string;
    pending: PendingProviderRuntimeHeadersRequest;
  }): Promise<void> {
    params.pending.responding = true;
    try {
      const requestAuth = await resolveAccountRequestAuth(params.pending.request);
      /**       Account resolution is async IO; after cancel/exit never deliver late materials. */
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      if (!requestAuth) {
        throw new Error("Account request auth resolver returned no material");
      }
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: true,
        requestAuth,
      });
      logger.info(undefined, "ZCode provider runtime headers applied", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
    } catch (error) {
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      logger.warn(undefined, "Failed to apply ZCode provider runtime headers", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        error: error instanceof Error ? error.message : String(error),
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (pendingProviderRuntimeHeaders.get(params.key) === params.pending) {
        pendingProviderRuntimeHeaders.delete(params.key);
      }
    }
  }

  function takePendingSessionRuntimePreferences(
    requestId: string,
  ): PendingSessionRuntimePreferencesRequest | undefined {
    const pending = pendingSessionRuntimePreferences.get(requestId);
    if (!pending) {
      return undefined;
    }
    pendingSessionRuntimePreferences.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  function expireSessionRuntimePreferencesRequest(requestId: string): void {
    const pending = takePendingSessionRuntimePreferences(requestId);
    if (!pending) {
      return;
    }
    /**
    If the remote transport lives but the responder never answers, pending entries
    block session lifecycle forever. Timeout ends this request only; no retry/degrade.
    */
    logger.warn(undefined, "Timed out waiting for the host runtime-preferences reply", {
      event: "zcode_agent.runtime_preferences.host_response_timeout",
      module: "services.zcode_agent",
      requestId,
      scope: pending.request.scope,
      sessionId: pending.request.sessionId,
      timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      workspaceKey: pending.workspaceKey,
    });
    void pending.client
      .respondError(pending.protocolRequestId, {
        code: -32022,
        message: "Session runtime preferences request timed out",
        data: {
          timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        },
      })
      .catch((error: unknown) => {
        logger.debug(undefined, "Failed to deliver the runtime-preferences timeout reply", {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          scope: pending.request.scope,
          sessionId: pending.request.sessionId,
        });
      });
  }

  let modelSelectionSubscription = modelSelectionReadinessSource?.onDidChange?.((view) => {
    void handleProviderReadinessChanged({
      reason: "model_selection_changed",
      snapshot: createProviderReadinessSnapshotFromSelectionView(view),
    }).catch((error) => {
      logger.warn(undefined, "Model-selection readiness hot sync failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  let accountProviderConfigUnsubscribe = accountProviderConfigSource?.onDidChange((reason) => {
    void handleAccountProviderConfigChanged(reason).catch((error) => {
      logger.warn(undefined, "Account provider config hot sync failed", {
        message: error instanceof Error ? error.message : String(error),
        reason,
      });
    });
  });

  async function syncAccountProviderConfigToClient(params: {
    client: ZCodeProtocolClient;
    reason: string;
  }): Promise<void> {
    if (!accountProviderConfigSource) return;
    const previous = accountConfigSyncByClient.get(params.client) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        /**         One failure never blocks newer configs; this call retries. */
      })
      .then(async () => {
        /**
        Pre-queue reads can land late, ordering old after new. Read and deliver
        share the client's serial queue; no extra barriers, no revision guessing.
        */
        const snapshot = await accountProviderConfigSource.read();
        if (accountConfigReceivedRevisionByClient.get(params.client) === snapshot.revision) return;
        const result = await params.client.request(
          zcodeProtocolMethods.providerUpdateAccountConfig,
          {
            revision: snapshot.revision,
            basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
            /**             Account is a runtime facts envelope, not disk rules; keep the wire shape. */
            providers: Object.fromEntries(
              [...snapshot.providers.entries()].map(([providerId, config]) => [
                providerId,
                config.toJSON(),
              ]),
            ),
            states: snapshot.states ?? {},
          },
          zcodeProviderUpdateAccountConfigResultSchema,
        );
        if (result.receivedRevision !== snapshot.revision) {
          throw new Error("Account config receipt version mismatches the delivered version");
        }
        accountConfigReceivedRevisionByClient.set(params.client, result.receivedRevision);
        logger.info(undefined, "Account provider config delivered to the ZCode agent", {
          providerCount: result.providerCount,
          reason: params.reason,
          receivedRevision: result.receivedRevision,
          status: result.status,
        });
      });
    accountConfigSyncByClient.set(params.client, current);
    try {
      await current;
    } finally {
      if (accountConfigSyncByClient.get(params.client) === current) {
        accountConfigSyncByClient.delete(params.client);
      }
    }
  }

  async function ensureAccountProviderConfigSynced(params: {
    client: ZCodeProtocolClient;
    reason: string;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    await syncAccountProviderConfigToClient({
      client: params.client,
      reason: params.reason,
    });
  }

  async function handleAccountProviderConfigChanged(reason: string): Promise<void> {
    await Promise.all(
      Array.from(activeClientsByWorkspaceKey.values()).map(async (active) => {
        await syncAccountProviderConfigToClient({
          client: active.client,
          reason,
        });
      }),
    );
  }

  function enqueueInteractionPreferenceSync(params: {
    client: ZCodeProtocolClient;
    preferences: ZCodeAgentAppRuntimePreferences;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const previous = interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        /**         Failures keep order intact: later toggles still commit in sequence. */
      })
      .then(async () => {
        await params.client.request(
          zcodeProtocolMethods.workspaceUpdateInteractionPreferences,
          {
            workspace: buildWorkspaceRef(params.workspace),
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                params.preferences.askUserQuestionAutoResolutionEnabled,
            },
          },
          zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
        );
        try {
          await params.client.request(
            zcodeProtocolMethods.workspaceUpdateModelIoPreferences,
            {
              workspace: buildWorkspaceRef(params.workspace),
              preferences: {
                fullRetentionEnabled: params.preferences.modelIoFullRetentionEnabled === true,
              },
            },
            zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
          );
        } catch (error) {
          /**           Compat for old CLIs: only method-not-found degrades; other failures throw. */
          if (!isProtocolMethodNotFoundError(error)) throw error;
        }
      });
    interactionPreferenceSyncByWorkspaceKey.set(workspaceKey, current);
    void current.then(
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
    );
    return current;
  }

  async function handleProviderReadinessChanged(event: {
    reason: string;
    snapshot: ZCodeAgentProviderReadinessSnapshot;
  }): Promise<void> {
    if (event.snapshot.readiness.ready) {
      await Promise.allSettled(
        Array.from(waitingWorkspaceStartups.entries()).map(async ([workspaceKey, waiting]) => {
          /**
          ready can beat the old read. Settle the old attempt, then read anew,
          or the event reuses a soon-failing Promise and the only ready notice is lost.
          */
          try {
            await waiting.starting;
          } catch (error) {
            if (!isProviderNotReadyError(error)) throw error;
          }
          /**
          Root cause: the ready handler snapshot waiting list then started async; if the workspace
          vanished mid-await the stale snapshot respawned released agents. Only the
          matching generation continues; removal/generation change invalidates callbacks.
          */
          if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
            return;
          }
          const { workspace } = waiting;
          const client = await getClient(workspace);
          await ensureAccountProviderConfigSynced({
            client,
            reason: `startup_ready:${event.reason}`,
            workspace,
          });
          logger.info(undefined, "Started the pending ZCode agent once provider/model readied", {
            providerCount: event.snapshot.providerCount,
            reason: event.reason,
            revision: event.snapshot.revision,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
        }),
      );
    }
  }

  function getSessionEmitter(params: ZCodeAgentSessionTarget) {
    const key = sessionEventKey(params);
    const existing = sessionEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ZCodeAgentServiceEvent>();
    sessionEmitters.set(key, created);
    return created;
  }

  function getPluginOperationProgressEmitter(operationId: string) {
    const existing = pluginOperationProgressEmitters.get(operationId);
    if (existing) return existing;
    let created: Emitter<ZCodePluginOperationProgressNotification>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (pluginOperationProgressEmitters.get(operationId) !== created) return;
        pluginOperationProgressEmitters.delete(operationId);
        created.dispose();
      },
    });
    pluginOperationProgressEmitters.set(operationId, created);
    return created;
  }

  function getConversationFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ConversationTopicWireCandidate>();
    conversationFrameEmitters.set(key, created);
    return created;
  }

  function getProviderRuntimeHeadersWorkspaceEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = providerRuntimeHeadersWorkspaceEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ZCodeProviderRuntimeHeadersRequestParams>();
    providerRuntimeHeadersWorkspaceEmitters.set(key, created);
    return created;
  }

  function getConversationTelemetryFactEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationTelemetryFactEmitters.get(key);
    if (existing) return existing;
    const created = new Emitter<ConversationTelemetryFact>();
    conversationTelemetryFactEmitters.set(key, created);
    return created;
  }

  function getSessionsIndexFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = sessionsIndexFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<SessionsIndexTopicWireCandidate>();
    sessionsIndexFrameEmitters.set(key, created);
    return created;
  }

  function getWorkspaceConfigFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = workspaceConfigFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<WorkspaceConfigTopicWireCandidate>();
    workspaceConfigFrameEmitters.set(key, created);
    return created;
  }

  /** v4 connectionId: co-resident consumers distinguish via scope suffixes. */
  function v4ConnectionIdFor(subscriberScope?: string): string {
    return subscriberScope ? `${v4ConnectionId}#${subscriberScope}` : v4ConnectionId;
  }

  function resolveV4Connection(
    params: unknown,
    fallbackConnectionId: string = v4ConnectionId,
  ): ZCodeAgentV4ConnectionContext {
    return (
      readTrustedZCodeAgentV4Connection(params) ?? {
        /**         No trusted carrier means in-host direct call: subscribe legacy-style (whole-key patch), no guessing. */
        connectionId: fallbackConnectionId,
        clientMode: "desktop-continuous" as const,
      }
    );
  }

  function v4SubscriptionRouteKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.subscriptionId}\0${route.connectionId}`;
  }

  function v4SubscriptionOwnershipKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.connectionId}`;
  }

  function rememberV4SubscriptionRoute(
    workspace: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ): void {
    const route: V4SubscriptionRoute = {
      workspaceKey: resolveWorkspaceKey(workspace),
      topic,
      subscriptionId,
      connectionId,
    };
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    const previous = v4RouteKeyByOwnership.get(ownershipKey);
    if (previous) v4SubscriptionRoutes.delete(previous);
    const routeKey = v4SubscriptionRouteKey(route);
    v4RouteKeyByOwnership.set(ownershipKey, routeKey);
    v4SubscriptionRoutes.set(routeKey, route);
  }

  function forgetV4SubscriptionRoute(route: V4SubscriptionRoute): void {
    const routeKey = v4SubscriptionRouteKey(route);
    v4SubscriptionRoutes.delete(routeKey);
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    if (v4RouteKeyByOwnership.get(ownershipKey) === routeKey) {
      v4RouteKeyByOwnership.delete(ownershipKey);
    }
  }

  function isCurrentV4SubscriptionRoute(route: V4SubscriptionRoute): boolean {
    return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) === route;
  }

  function clearV4SubscriptionRoutes(workspaceKey?: string): void {
    for (const route of v4SubscriptionRoutes.values()) {
      if (workspaceKey !== undefined && route.workspaceKey !== workspaceKey) {
        continue;
      }
      forgetV4SubscriptionRoute(route);
    }
  }

  function resolveV4UnsubscribeRoute(
    params: ZCodeAgentConversationUnsubscribeParams | ZCodeAgentConversationResyncParams,
    topicPrefix: string,
  ): V4SubscriptionRoute | null {
    const expectedWorkspaceKey = resolveWorkspaceKey(params);
    const trusted = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (trusted) {
      if (!trusted.topic.startsWith(topicPrefix)) return null;
      const route: V4SubscriptionRoute = {
        workspaceKey: expectedWorkspaceKey,
        topic: trusted.topic,
        subscriptionId: params.subscriptionId,
        connectionId: trusted.connectionId,
      };
      return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) ?? null;
    }
    /**
    Internal direct consumers lack facade carriers; accept only unique method-topic
    matches; on collision refuse to guess and never multi-publish deletions.
    */
    const matches = [...v4SubscriptionRoutes.values()].filter(
      (route) =>
        route.workspaceKey === expectedWorkspaceKey &&
        route.subscriptionId === params.subscriptionId &&
        route.topic.startsWith(topicPrefix),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  async function unsubscribeV4Route(
    params: ZCodeAgentConversationUnsubscribeParams,
    topicPrefix: string,
  ): Promise<void> {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) return;
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    /**
    getReadOnlyClient can spawn mid-await; the restart listener cleared old routes and new
    runtimes reuse keys. Recheck by identity; never send stale local routes to the new CLI.
    */
    if (!isCurrentV4SubscriptionRoute(route)) return;
    await client.request(
      V4_METHODS.conversationUnsubscribe,
      {
        topic: route.topic,
        subscriptionId: route.subscriptionId,
        connectionId: route.connectionId,
      },
      zcodeProtocolEmptyResultSchema,
    );
    /**
    While a request flies, restarts can mint same-key routes;
    late responses clean only their generation, never the new route.
    */
    if (isCurrentV4SubscriptionRoute(route)) forgetV4SubscriptionRoute(route);
  }

  async function resyncV4Route(params: ZCodeAgentConversationResyncParams, topicPrefix: string) {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) throw new Error("fault.subscription.notOwned");
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = await client.request(
      V4_METHODS.conversationResync,
      {
        topic: route.topic,
        connectionId: route.connectionId,
        subscriptionId: route.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      },
      v4ConversationResyncResultSchema,
    );
    /**
    A resync ACK binds to its generation; post-restart
    stale successes would read old recoveries as new-subscription results.
    */
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    return result;
  }

  function emitSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
    event: ZCodeAgentServiceEvent,
  ): void {
    sessionEmitters.get(sessionEventKey({ ...workspace, sessionId }))?.fire(event);
  }

  function emitWorkspaceEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeAgentServiceEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    for (const [key, emitter] of sessionEmitters) {
      if (key.startsWith(`${workspaceKey}\u0000`)) {
        emitter.fire(event);
      }
    }
  }

  function getSessionEventSequenceState(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): SessionEventSequenceState {
    const key = sessionEventKey({ ...workspace, sessionId });
    const existing = sessionEventSequenceStates.get(key);
    if (existing) {
      return existing;
    }
    const created: SessionEventSequenceState = {
      assignedSeqByEventId: new Map<string, number>(),
      assignedSeqEventIds: [],
      liveEventIds: new Set<string>(),
      liveEventIdOrder: [],
      lastAssignedSeq: 0,
    };
    sessionEventSequenceStates.set(key, created);
    return created;
  }

  function normalizeSessionEventSeq(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): ZCodeSessionEvent {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    if (event.seq > 0) {
      state.lastAssignedSeq = Math.max(state.lastAssignedSeq, event.seq);
      return event;
    }

    const assignedSeq = state.assignedSeqByEventId.get(event.eventId);
    if (assignedSeq !== undefined) {
      return { ...event, seq: assignedSeq };
    }

    const nextSeq = state.lastAssignedSeq + 1;
    state.lastAssignedSeq = nextSeq;
    state.assignedSeqByEventId.set(event.eventId, nextSeq);
    state.assignedSeqEventIds.push(event.eventId);
    while (state.assignedSeqEventIds.length > MAX_TRACKED_SESSION_EVENT_IDS) {
      const removed = state.assignedSeqEventIds.shift();
      if (removed) {
        state.assignedSeqByEventId.delete(removed);
      }
    }
    /**
    Legacy live sinks emit createSessionEvent seq=0 straight to the app
    while replay backs numbers from the store. Legacy compat only; the store stays authoritative.
    */
    return { ...event, seq: nextSeq };
  }

  function shouldDeliverLiveSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): boolean {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    return rememberBoundedEventId(state.liveEventIds, state.liveEventIdOrder, event.eventId);
  }

  function handleSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): void {
    const normalizedEvent = normalizeSessionEventSeq(workspace, event);
    if (!shouldDeliverLiveSessionEvent(workspace, normalizedEvent)) {
      return;
    }
    emitSessionEvent(workspace, normalizedEvent.sessionId, {
      type: "session.event",
      event: normalizedEvent,
    });
  }

  function handleStateUpdated(
    workspace: ZCodeAgentWorkspaceTarget,
    notification: ZCodeStateUpdatedNotification,
  ): void {
    if (notification.sessionId) {
      emitSessionEvent(workspace, notification.sessionId, {
        type: "state.updated",
        notification,
      });
      return;
    }
    emitWorkspaceEvent(workspace, { type: "state.updated", notification });
  }

  function wireClient(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    /**
     The lane of this client's process. CLIs never know their manager,
     so lanes attach here per caller.
     */
    lane: ProcessResourceCliLane,
  ): void {
    if (wiredClients.has(client)) {
      return;
    }
    wiredClients.add(client);
    const topicResources = createTopicResourceBridge(() => {
      /**
      Warmup may lack remoteSessionId; never pin wireClient's first args forever.
      Resolve the route from the live CLI each time and pin it for the whole operation.
      */
      const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
      const resourceWorkspace =
        active?.client === client ? { ...active.workspace } : { ...workspace };
      return {
        validate: (request, signal, trace) => {
          if (!options?.topicResourceValidator)
            throw new Error("Topic resource authorization is unavailable");
          return options.topicResourceValidator(
            { ...request, ...resourceWorkspace, trace },
            signal,
          );
        },
        read: (request, signal, trace) => {
          if (!options?.topicResourceExecutor)
            throw new Error("Topic attachment retrieval is unavailable on this host");
          return options.topicResourceExecutor({ ...request, ...resourceWorkspace, trace }, signal);
        },
        upload: (request, attachment, signal, trace) =>
          uploadTopicResourceToClient(
            client,
            v4ConnectionId,
            { ...resourceWorkspace, sessionId: request.taskId },
            attachment,
            signal,
            trace,
          ),
      };
    });
    const disposables = [
      topicResources,
      client.onNotification((message) => {
        if (message.method === zcodeProtocolNotifications.providerRuntimeHeadersCancelled) {
          const parsed = zcodeProviderRuntimeHeadersCancelledSchema.safeParse(message.params);
          if (
            !parsed.success ||
            resolveWorkspaceKey(parsed.data.workspace) !== resolveWorkspaceKey(workspace)
          )
            return;
          const key = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = pendingProviderRuntimeHeaders.get(key);
          /**           Cancels from old clients or same-path-different-identity must not kill newer routes. */
          if (pending?.client === client) cancelProviderRuntimeHeaders(key, pending);
          return;
        }
        if (message.method === zcodeProtocolNotifications.processResourceSample) {
          const parsed = zcodeProcessResourceSampleSchema.safeParse(message.params);
          if (parsed.success) {
            processResourceSampleEmitter.fire({ ...parsed.data, lane });
          } else {
            logger.debug(undefined, "Dropped invalid ZCode CLI resource sample", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.toolExecResource) {
          const parsed = zcodeToolExecResourceSchema.safeParse(message.params);
          if (parsed.success) toolExecResourceEmitter.fire(parsed.data);
          return;
        }
        if (message.method === zcodeProtocolNotifications.mcpResourceSamples) {
          const parsed = zcodeMcpResourceSamplesSchema.safeParse(message.params);
          if (parsed.success) mcpResourceSamplesEmitter.fire(parsed.data);
          else logger.debug(undefined, "Dropped invalid MCP resource sample");
          return;
        }

        if (message.method === zcodeProtocolNotifications.mcpTelemetry) {
          const parsed = zcodeMcpTelemetryEventSchema.safeParse(message.params);
          if (parsed.success) {
            mcpTelemetryEmitter.fire(parsed.data);
          } else {
            logger.debug(undefined, "Dropped invalid ZCode CLI MCP telemetry event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.pluginOperationProgress) {
          const parsed = zcodePluginOperationProgressNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            pluginOperationProgressEmitters.get(parsed.data.operationId)?.fire(parsed.data);
          } else {
            logger.warn(undefined, "Dropped invalid ZCode Protocol plugin operation progress", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolMethods.computerUseOperationEvent) {
          const parsed = zcodeComputerUseOperationEventSchema.safeParse(message.params);
          if (parsed.success) {
            /**
            v4 never projects legacy session/event: CUA hints consume the sideband directly,
            keeping the two sequence domains apart.
            */
            cuaOperationTurnTracker?.accept(workspace, parsed.data);
          } else {
            logger.warn(undefined, "Dropped invalid ZCode Protocol Computer Use operation event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === "session/event") {
          const parsed = zcodeSessionEventSchema.safeParse(message.params);
          if (parsed.success) {
            handleSessionEvent(workspace, parsed.data);
          } else {
            const rawParams =
              typeof message.params === "object" && message.params !== null
                ? (message.params as Record<string, unknown>)
                : {};
            logger.warn(
              typeof rawParams.traceId === "string" ? rawParams.traceId : undefined,
              "Dropped invalid ZCode Protocol session event",
              {
                eventId: rawParams.eventId,
                issues: parsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                sessionId: rawParams.sessionId,
                type: rawParams.type,
              },
            );
          }
          return;
        }

        if (message.method === "state.updated") {
          const parsed = zcodeStateUpdatedNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            handleStateUpdated(workspace, parsed.data);
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.localTtftFacts) {
          const parsed = localTtftFactsSchema.safeParse(message.params);
          if (parsed.success && !workspace.remoteSessionId && !workspace.workspaceIdentity?.trim())
            localTtftFactsEmitter.fire({
              workspaceKey: resolveWorkspaceKey(workspace),
              facts: parsed.data,
            });
          return;
        }
        if (message.method === V4_NOTIFICATIONS.conversationTelemetryFact) {
          const parsed = conversationTelemetryFactSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationTelemetryFactEmitter(workspace).fire(parsed.data);
          } else {
            /**             Drop unknown fields: new CLI fields must not reach renderer reporters unaudited. */
            logger.warn(undefined, "Dropped invalid v4 conversation telemetry fact", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.cuaPermissionObservation) {
          const parsed = cuaPermissionObservationSchema.safeParse(message.params);
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
          ) {
            cuaPermissionObservationEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          } else if (!parsed.success) {
            /**             Permission observations drive renderer side effects; fail closed on unknowns. */
            logger.warn(undefined, "Dropped invalid v4 CUA permission observation", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.conversationFrame) {
          /**
          The same notification carries sessions-index frames; prefix-split to the list emitter
          or the conversation schema drops them.
          */
          const topic = (message.params as { topic?: unknown } | null)?.topic;
          if (typeof topic === "string" && topic.startsWith("sessions-index/")) {
            const indexParsed = sessionsIndexTopicWireCandidateSchema.safeParse(message.params);
            if (indexParsed.success) {
              getSessionsIndexFrameEmitter(workspace).fire(indexParsed.data);
            } else {
              logger.warn(undefined, "Dropped invalid v4 sessions-index frame", {
                issues: indexParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          if (typeof topic === "string" && topic.startsWith("workspace-config/")) {
            const configParsed = workspaceConfigTopicWireCandidateSchema.safeParse(message.params);
            if (configParsed.success) {
              getWorkspaceConfigFrameEmitter(workspace).fire(configParsed.data);
            } else {
              logger.warn(undefined, "Dropped invalid v4 workspace-config frame", {
                issues: configParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          const parsed = conversationTopicWireCandidateSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationFrameEmitter(workspace).fire(parsed.data);
          } else {
            logger.warn(undefined, "Dropped invalid v4 conversation frame", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
      }),
      client.onRequest((request) => {
        if (request.method === zcodeProtocolMethods.subagentsReadRuntimeConfig) {
          void (async () => {
            const parsed = zcodeSubagentsReadRuntimeConfigParamsSchema.safeParse(request.params);
            if (!parsed.success) {
              await client.respondError(request.id, {
                code: -32602,
                message: "Invalid subagent runtime config request",
              });
              return;
            }
            let configuration: SubagentRuntimeConfig;
            try {
              if (!options?.readSubagentRuntimeConfig)
                throw new Error("Subagent runtime config is unavailable on this Host");
              configuration = subagentRuntimeConfigSchema.parse(
                await options.readSubagentRuntimeConfig(workspace),
              );
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
              return;
            }
            await client.respond(request.id, configuration);
          })().catch((error) =>
            logger.debug(undefined, "Failed to deliver the subagent config response", {
              error: String(error),
            }),
          );
          return;
        }
        if (request.method === zcodeProtocolMethods.channelReply) {
          void (async () => {
            const params = channelReplyRequestSchema.parse(request.params);
            if (!options?.channelReplyExecutor) throw new Error("Channel reply unavailable");
            const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
            if (active?.client !== client)
              throw new Error("Channel reply client is no longer active");
            const currentWorkspace = active.workspace;
            const result = await options.channelReplyExecutor({
              ...params,
              /**               Live carries carry V4 internals; replies project workspace identity only, never the object. */
              workspacePath: currentWorkspace.workspacePath,
              workspaceIdentity: currentWorkspace.workspaceIdentity,
              remoteSessionId: currentWorkspace.remoteSessionId,
              trace: request.trace,
            });
            await client.respond(request.id, result);
          })().catch((error: unknown) =>
            client.respondError(request.id, {
              code: -32603,
              message: error instanceof Error ? error.message : "Channel reply failed",
            }),
          );
          return;
        }
        if (request.method === zcodeProtocolMethods.topicResourceRead) {
          void topicResources
            .read(request.params, request.trace)
            .then((result) => client.respond(request.id, result))
            .catch((error: unknown) =>
              client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : "Topic resource read failed",
              }),
            );
          return;
        }
        if (request.method === zcodeProtocolMethods.topicResourceCancel) {
          const parsed = zcodeTopicResourceCancelParamsSchema.safeParse(request.params);
          void client.respond(request.id, {
            cancelled: parsed.success && topicResources.cancel(parsed.data),
          });
          return;
        }
        if (request.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
          const reportResponseFailure = (error: unknown): void => {
            logger.debug(undefined, "Failed to deliver the runtime-preferences response", {
              error: error instanceof Error ? error.message : String(error),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          };
          const parsed = zcodeSessionRequestRuntimePreferencesParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            void client
              .respondError(request.id, {
                code: -32602,
                message: "Invalid session runtime preferences request params",
                data: parsed.error.flatten(),
              })
              .catch(reportResponseFailure);
            return;
          }
          if (sessionRuntimePreferencesAuthority === "local") {
            void (async () => {
              let preferences: ZCodeSessionRuntimePreferencesResult;
              try {
                preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
                  /**
                  One RPC covers creation and first execution: keep the validated scope
                  so first execution need not re-await remote config for Shell.
                  */
                  (await resolveSessionRuntimePreferences?.(parsed.data.scope)) ?? {
                    askUserQuestionAutoResolutionEnabled: true,
                    nativeSearchEnhancementsEnabled: true,
                    memoryEnabled: false,
                  },
                );
                preferences.subagentRuntimeConfigEnabled =
                  Boolean(options?.readSubagentRuntimeConfig) &&
                  !(
                    workspace.workspaceIdentity &&
                    isRemoteWorkspaceIdentity(workspace.workspaceIdentity)
                  );
              } catch (error) {
                await client.respondError(request.id, {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                });
                return;
              }
              /**
              A failed reply means closed transport, not a settings failure;
              never send a second error response.
              */
              await client.respond(request.id, preferences);
            })().catch(reportResponseFailure);
            return;
          }

          const requestId = randomUUID();
          const dynamicRequest: ZCodeAgentSessionRuntimePreferencesRequest = {
            ...parsed.data,
            requestId,
          };
          pendingSessionRuntimePreferences.set(requestId, {
            client,
            protocolRequestId: request.id,
            request: dynamicRequest,
            timeout: setTimeout(
              () => expireSessionRuntimePreferencesRequest(requestId),
              ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
            ),
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          logger.info(undefined, "Runtime-preferences request forwarded to the host", {
            event: "zcode_agent.runtime_preferences.host_request_dispatched",
            module: "services.zcode_agent",
            requestId,
            scope: dynamicRequest.scope,
            sessionId: dynamicRequest.sessionId,
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          sessionRuntimePreferencesRequestEmitter.fire(dynamicRequest);
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestPermission) {
          const parsed = zcodePermissionRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid permission request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const key = permissionRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const wasPending = pendingPermissions.has(key);
          pendingPermissions.set(key, {
            client,
            protocolRequestId: request.id,
          });
          if (!wasPending) {
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "permission.request",
              request: parsed.data,
            });
          }
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestUserInput) {
          const parsed = zcodeUserInputRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid user input request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const key = userInputRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const wasPending = pendingUserInputs.has(key);
          pendingUserInputs.set(key, { client, protocolRequestId: request.id });
          if (!wasPending) {
            /**
            Agents re-send the same requestId to recover lost protocol ids.
            The host must refresh the answerable protocolRequestId without re-broadcasting,
            */
            // or multi-question AskUserQuestion resets to page one.
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "userInput.request",
              request: parsed.data,
            });
          }
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders) {
          const parsed = zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid provider runtime headers request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const pendingKey = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = {
            client,
            protocolRequestId: request.id,
            request: parsed.data,
          };
          pendingProviderRuntimeHeaders.set(pendingKey, pending);
          logger.info(request.trace?.traceId, "ZCode provider runtime headers requested", {
            modelId: parsed.data.modelSelection.modelId,
            providerId: parsed.data.providerId,
            requestId: parsed.data.requestId,
            sessionId: parsed.data.sessionId,
            turnId: parsed.data.turnId ?? null,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
          const accountAccess = parsed.data.accountAccess;
          if (
            accountRequestAuthService &&
            accountAccess &&
            !requiresRequestVerification(accountAccess)
          ) {
            /**
            API-key/Team keys need no UI: the host auto-answers from the model
            bound access, so background tasks and pane-less sessions never wait on UI.
            */
            void respondAccountRequestAuthWithoutInteraction({
              key: pendingKey,
              pending,
            });
            return;
          }
          if (!requestVerificationInteractionAvailable) {
            pendingProviderRuntimeHeaders.delete(pendingKey);
            void pending.client.respond(pending.protocolRequestId, {
              headersApplied: false,
              errorMessage: "Provider request auth is unavailable",
            });
            return;
          }
          emitSessionEvent(workspace, parsed.data.sessionId, {
            type: "providerRuntimeHeaders.request",
            request: parsed.data,
          });
          /**
          Workspace-mirror delivery: resident responders per open tab
          are sessionId-blind; catch them here by workspaceKey.
          */
          providerRuntimeHeadersWorkspaceEmitters
            .get(resolveWorkspaceKey(workspace))
            ?.fire(parsed.data);
          return;
        }

        /**
        Official MCP identity: pure RPC relay; the host resolves and answers.
        No emitSessionEvent, no pending map: no UI semantics.
        */
        if (request.method === zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders) {
          const parsed = zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/requestOfficialMcpAuthHeaders params",
              data: parsed.error.flatten(),
            });
            return;
          }
          /**
          Host revalidation precedes credential reads: return early, never calling resolveHeaders,
          so no credentials enter memory.
          */
          void (async () => {
            const trustedOrigins = options?.officialMcpTrustedOrigins;
            const trust = trustedOrigins
              ? await trustedOrigins
                  .isTrusted({
                    mcpKey: parsed.data.mcpKey,
                    origin: parsed.data.targetOrigin,
                    pluginId: parsed.data.pluginId,
                  })
                  /**                   Validator faults count as untrusted; never pass on validation errors. */
                  .catch(() => ({ detail: "validator_error", trusted: false }))
              : { detail: "validator_missing", trusted: false };
            if (!trust.trusted) {
              /**               Log non-sensitive context only; credentials unread, nothing to leak. */
              logger.warn(
                request.trace?.traceId,
                "Official MCP identity request failed host trust validation",
                {
                  detail: trust.detail ?? "unknown",
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  requestId: parsed.data.requestId,
                  targetOrigin: parsed.data.targetOrigin,
                  workspaceKey: parsed.data.workspace.workspaceKey,
                },
              );
              void client.respond(request.id, {
                ok: false,
                reason: "official_mcp_origin_untrusted",
              });
              return;
            }
            const resolver = options?.officialMcpAuthHeadersResolver;
            if (!resolver) {
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
              return;
            }
            try {
              const resolveStartedAt = Date.now();
              const result = await resolver.resolveHeaders({
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                targetOrigin: parsed.data.targetOrigin,
                workspace: parsed.data.workspace,
              });
              /**
              Success cannot be silent, or which headers flew is unanswerable.
              Header names and plan dims only; values never (retention is uncontrolled).
              */
              if (result.ok) {
                const firstIssuance = officialMcpIssuanceAudit.markFirst(
                  parsed.data.pluginId,
                  parsed.data.mcpKey,
                  parsed.data.workspace.workspaceKey,
                );
                const logIssuance = firstIssuance ? logger.info : logger.debug;
                logIssuance(request.trace?.traceId, "Official MCP identity headers resolved", {
                  firstIssuance,
                  ...summarizeOfficialMcpIdentityHeaders(result.headers),
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              } else {
                logger.info(request.trace?.traceId, "Official MCP identity unavailable", {
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  reason: result.reason,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              }
              void client.respond(request.id, result);
            } catch (error: unknown) {
              /**
              Resolution faults return unavailable, not respondError: adapters branch on the enum
              and MCP must never go anonymous. No credential values in logs.
              */
              logger.warn(request.trace?.traceId, "Official MCP identity resolution failed", {
                error: error instanceof Error ? error.message : String(error),
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                requestId: parsed.data.requestId,
                targetOrigin: parsed.data.targetOrigin,
              });
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
            }
          })();
          return;
        }

        /**         browser-use discovery: backend liveness and exposure are two layers. */
        // No executor: empty list; facades never fake availability.
        if (request.method === zcodeProtocolMethods.interactionBrowserList) {
          const parsed = zcodeBrowserListParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserList params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, { browsers: [] });
            return;
          }
          void executor
            .list(parsed.data)
            .then((browsers) => client.respond(request.id, { browsers }))
            .catch((error: unknown) => {
              void client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          return;
        }

        /**
        browser-use: agent.browsers.* arrives via interaction/browserExecute.
        Pure relay: run in main, respondResult; no emitSessionEvent
        and no pending map (unlike permission's UI blocking). No executor: backend_unavailable.
        */
        if (request.method === zcodeProtocolMethods.interactionBrowserExecute) {
          const parsed = zcodeBrowserExecuteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserExecute params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: "browser control not available",
              },
              elapsedMs: 0,
            });
            return;
          }
          void executor
            .execute({
              requestId: parsed.data.requestId,
              ...(parsed.data.browserId ? { browserId: parsed.data.browserId } : {}),
              ...(parsed.data.browserGeneration !== undefined
                ? { browserGeneration: parsed.data.browserGeneration }
                : {}),
              sessionId: parsed.data.sessionId,
              ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
              workspaceKey: parsed.data.workspaceKey ?? resolveWorkspaceKey(workspace),
              workspacePath: parsed.data.workspacePath ?? workspace.workspacePath,
              ...((parsed.data.workspaceIdentity ?? workspace.workspaceIdentity)
                ? {
                    workspaceIdentity: parsed.data.workspaceIdentity ?? workspace.workspaceIdentity,
                  }
                : {}),
              ...(parsed.data.remoteSessionId
                ? { remoteSessionId: parsed.data.remoteSessionId }
                : {}),
              clientMode: parsed.data.clientMode ?? "desktop-continuous",
              sessionContext: parsed.data.sessionContext ?? "live",
              command: parsed.data.command,
            })
            .then((result) => client.respond(request.id, result))
            .catch((error: unknown) => {
              void client.respond(request.id, {
                ok: false,
                error: {
                  code: "execution_error",
                  message: error instanceof Error ? error.message : String(error),
                },
                elapsedMs: 0,
              });
            });
          return;
        }

        if (request.method === zcodeProtocolMethods.automationCreate) {
          const parsed = zcodeAutomationCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automation = await automationService.create({
                title: parsed.data.title ?? "",
                cronExpr: parsed.data.cronExpr,
                relativeDelayMinutes: parsed.data.relativeDelayMinutes,
                /**                 Session long-interval carriers pass through for normalization into the authoritative rule. */
                intervalUnit: parsed.data.intervalUnit,
                interval: parsed.data.interval,
                prompt: parsed.data.prompt,
                modelSelection: parsed.data.modelSelection,
                mode: parsed.data.mode,
                targetTaskId: parsed.data.targetTaskId,
                botDeliveryTarget: parsed.data.botDeliveryTarget,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                recurring: parsed.data.recurring ?? true,
                maxRuns: parsed.data.maxRuns,
              });
              if (automation.targetTaskId) {
                const taskMeta = await automationTaskIndexRepo
                  .getTaskMeta({
                    workspacePath: automation.workspacePath,
                    workspaceIdentity: automation.workspaceIdentity,
                    taskId: automation.targetTaskId,
                  })
                  .catch(() => null);
                if (taskMeta) {
                  await automationTaskIndexRepo.syncTaskMeta({
                    meta: {
                      ...taskMeta,
                      /**                       In-session automations reuse the session; flag explicitly for the V4 sidebar. */
                      cronAutomationId: automation.automationId,
                      updatedAt: Math.max(taskMeta.updatedAt, Date.now()),
                    },
                  });
                }
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.offPeakCreate) {
          const parsed = zcodeOffPeakCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              const grayConfig = await options
                ?.resolveOffPeakClientConfig?.()
                .catch(() => undefined);
              /**
              If gating turns off or config parse fails post-registration, skip empty-list inference
              (explicit models would misreport; empty models would persist); return the stable class.
              Views can span both families; confirm via the support snapshot, never the first provider.
              */
              const support =
                resolveOffPeakAllowedModels(grayConfig).length > 0
                  ? await offPeakTaskService.getCodingPlanSupport()
                  : undefined;
              const providerId = support?.supported
                ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
                : undefined;
              const allowedModels = providerId
                ? resolveOffPeakAllowedModels(grayConfig, providerId)
                : [];
              if (allowedModels.length === 0) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "offpeak_disabled",
                });
                return;
              }
              /**
              Prevalidate against the whitelist: off-list input returns the stable class
              reusing client_validation plus a dedicated code, no new enum members.
              Match like thoughtLevel/UI (trim, case-insensitive), echoing the canonical spelling.
              */
              const model = resolveOffPeakCreateModel(allowedModels, parsed.data.model);
              if (model === null) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              const modelSelection =
                grayConfig && providerId
                  ? resolveOffPeakToolSelection(
                      grayConfig.modelSelectionView,
                      providerId,
                      model,
                      parsed.data.thoughtLevel,
                    )
                  : undefined;
              if (!modelSelection) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              const result = await offPeakTaskService.createTask({
                title: parsed.data.title,
                prompt: parsed.data.prompt,
                permissionMode: parsed.data.permissionMode ?? "yolo",
                modelSelection,
                /**                 In-session creation binds it; dispatch resumes that session. */
                ...(parsed.data.boundSessionId
                  ? { boundSessionId: parsed.data.boundSessionId }
                  : {}),
                /**                 The host injects workspace from the session (mirroring automation/create), not a param. */
                workspacePath: workspace.workspacePath,
                ...(workspace.workspaceIdentity
                  ? { workspaceIdentity: workspace.workspaceIdentity }
                  : {}),
              });
              if (!result.ok) {
                /**                 Failure classes pass through (no respondError) for CLI translation. */
                await client.respond(request.id, {
                  ok: false,
                  failureStage: result.failureStage,
                  errorCategory: result.errorCategory,
                  errorCode: result.errorCode,
                });
                return;
              }
              await client.respond(request.id, {
                ok: true,
                task: toProtocolOffPeakTaskSnapshot(result.task),
              });
            } catch (error) {
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.offPeakList) {
          const parsed = zcodeOffPeakListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              const workspaceKey = resolveWorkspaceKey(workspace);
              const tasks = (await offPeakTaskService.list())
                .filter((task) => task.workspaceKey === workspaceKey)
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 20);
              await client.respond(request.id, {
                tasks: tasks.map(toProtocolOffPeakTaskSnapshot),
              });
            } catch (error) {
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationList) {
          const parsed = zcodeAutomationListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automations = await automationService.list(workspace);
              await client.respond(request.id, {
                automations: automations.map(toProtocolAutomation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationCheckTaskBinding) {
          const parsed = zcodeAutomationCheckTaskBindingParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation task binding params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const bound = await automationService.hasTaskBinding({
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                targetTaskId: parsed.data.targetTaskId,
              });
              await client.respond(request.id, { bound });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationUpdate) {
          const parsed = zcodeAutomationUpdateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation update params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automation = await automationService.update(
                parsed.data.automationId,
                {
                  title: parsed.data.title,
                  cronExpr: parsed.data.cronExpr,
                  prompt: parsed.data.prompt,
                  recurring: parsed.data.recurring,
                  maxRuns: parsed.data.maxRuns,
                  // Session long-interval carriers normalize into the authoritative scheduleRule.
                  intervalUnit: parsed.data.intervalUnit,
                  interval: parsed.data.interval,
                },
                workspace,
              );
              if (!automation) {
                throw new Error("Scheduled task not found in the current workspace.");
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationDelete) {
          const parsed = zcodeAutomationDeleteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation delete params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const deleted = await automationService.delete(parsed.data.automationId, workspace);
              await client.respond(request.id, { deleted });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        void client.respondError(request.id, {
          code: -32601,
          message: `Unsupported ZCode Protocol request: ${request.method}`,
        });
      }),
      client.onClose(() => {
        invalidateWorkspaceClient(resolveWorkspaceKey(workspace), client);
      }),
    ];
    clientDisposables.set(client, disposables);
  }

  function rememberSessionTrace(
    target: ZCodeAgentSessionTarget,
    snapshot: ZCodeSessionStateSnapshot,
  ): TraceId | undefined {
    const traceId = snapshot.session.traceId as TraceId | undefined;
    if (traceId) {
      sessionTraceIdBySessionKey.set(sessionEventKey(target), traceId);
    }
    return traceId;
  }

  function getSessionTraceId(target: ZCodeAgentSessionTarget): TraceId | undefined {
    return sessionTraceIdBySessionKey.get(sessionEventKey(target));
  }

  function createProviderNotReadyError(params: {
    snapshot?: ZCodeAgentProviderReadinessSnapshot;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Error & {
    code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    data: {
      providerCount: number;
      reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
      revision: string | null;
      workspaceKey: string;
      workspacePath: string;
    };
  } {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const error = new Error(
      "No usable model provider; sign in or configure an API key first.",
    ) as Error & {
      code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
      data: {
        providerCount: number;
        reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
        revision: string | null;
        workspaceKey: string;
        workspacePath: string;
      };
    };
    error.code = ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    error.data = {
      providerCount: params.snapshot?.providerCount ?? 0,
      reason: ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
      revision: params.snapshot?.revision ?? null,
      workspaceKey,
      workspacePath: params.workspace.workspacePath,
    };
    return error;
  }

  function isProviderNotReadyError(
    error: unknown,
  ): error is Error & { code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE } {
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE
    );
  }

  async function resolveStartupReadiness(): Promise<
    ZCodeAgentProviderReadinessSnapshot | undefined
  > {
    if (modelSelectionReadinessSource) {
      return createProviderReadinessSnapshotFromSelectionView(
        await modelSelectionReadinessSource.getView(),
      );
    }
    return undefined;
  }

  /**
   Stop/cancel timeouts and watchdogs reap clients, but processes exit async;
   until onClose, the map still points at disposed clients.
   Every reuse path checks this first; on disposed, clean and return false so callers
   restart (start-if-needed) or treat as absent (existing-only).
   */
  function isReusableActiveClientEntry(
    params: ZCodeAgentWorkspaceTarget,
    active: ActiveWorkspaceClient | undefined,
  ): boolean {
    if (!active) {
      return false;
    }
    if (!active.client.isDisposed) {
      return true;
    }
    const workspaceKey = resolveWorkspaceKey(params);
    activeClientsByWorkspaceKey.delete(workspaceKey);
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
    logger.warn(undefined, "Reused ZCode Protocol client disposed; clearing the stale entry", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return false;
  }

  async function getOrStartReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ActiveWorkspaceClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      await active.interactionPreferencesReady;
      return active;
    }

    const client = await processManager.getClient(params);
    wireClient(client, params, "chat");

    /**
    The manager single-flights per workspace; if a read/write path
    registered the client meanwhile, reuse it; never demote promoted write ability.
    */
    const concurrent = activeClientsByWorkspaceKey.get(workspaceKey);
    if (concurrent && isReusableActiveClientEntry(params, concurrent)) {
      concurrent.workspace = params;
      await concurrent.interactionPreferencesReady;
      return concurrent;
    }

    const entry: ActiveWorkspaceClient = {
      client,
      modelExecutionEnabled: false,
      workspace: params,
      dynamicWorkflowPolicyMode: "disabled",
    };
    activeClientsByWorkspaceKey.set(workspaceKey, entry);
    const interactionPreferencesReady = (async () => {
      let appliedSnapshot: ZCodeAgentAppRuntimePreferences | undefined;
      while (latestAppRuntimePreferences && latestAppRuntimePreferences !== appliedSnapshot) {
        const snapshot = latestAppRuntimePreferences;
        await enqueueInteractionPreferenceSync({
          client,
          preferences: { ...snapshot },
          workspace: params,
        });
        appliedSnapshot = snapshot;
      }
    })();
    /**
    Off-peak support is workspace fact: sync to the CLI before any session work
    so v4 cold restores get the toolset (no per-request channel). Legacy missing-method degrades silently.
    CLI defaults false and one process serves one workspace: skip the call when disabled
    (zero noise for legacy CLIs/test doubles).
    */
    const offPeakToolPolicyReady = (async () => {
      if (!isOffPeakToolSupported(params)) return;
      try {
        await client.request(
          zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
        );
      } catch (error) {
        /**
        Policy sync is best-effort distribution failing closed (tools unregistered),
        so timeouts/transient IPC never block readiness; -32601 is normal legacy degrade.
        */
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "Off-peak tool policy sync failed; CLI keeps defaults off", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    /**
    Workflow gating: same pattern as off-peak,
    workspace-level fact synced before any session work so cold restores get the toolset.
    Skip the call when disabled (CLI default, zero noise); on later choice changes
    resend over the same workspace serial chain (launch.md).
    */
    const dynamicWorkflowPolicyReady = enqueueDynamicWorkflowPolicySync(entry);
    entry.interactionPreferencesReady = Promise.all([
      interactionPreferencesReady,
      offPeakToolPolicyReady,
      dynamicWorkflowPolicyReady,
    ]).then(() => undefined);
    try {
      /**
      New/restarted runtimes catch up before any session work; toggles arriving mid-sync
      queue on the same workspace chain, preserving order.
      */
      await entry.interactionPreferencesReady;
    } catch (error) {
      if (activeClientsByWorkspaceKey.get(workspaceKey) === entry) {
        activeClientsByWorkspaceKey.delete(workspaceKey);
      }
      throw error;
    } finally {
      delete entry.interactionPreferencesReady;
    }
    logger.info(undefined, "Starting the ZCode agent for the read-only control plane", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry;
  }

  async function getClient(params: ZCodeAgentWorkspaceTarget) {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.modelExecutionEnabled && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      return active.client;
    }

    const waiting: WaitingWorkspaceStartup = waitingWorkspaceStartups.get(workspaceKey) ?? {
      cancelled: false,
      workspace: params,
    };
    waiting.workspace = params;
    waitingWorkspaceStartups.set(workspaceKey, waiting);

    // Bug: racing readiness deletes the wait on first success, so late callers
    // misread success as release. Share the start Promise; cancels key on identity.
    const starting = (waiting.starting ??= startModelExecutionClient(params, waiting));
    try {
      return await starting;
    } finally {
      if (waiting.starting === starting) delete waiting.starting;
    }
  }

  async function startModelExecutionClient(
    params: ZCodeAgentWorkspaceTarget,
    waiting: WaitingWorkspaceStartup,
  ): Promise<ZCodeProtocolClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);

    const readinessSnapshot = await resolveStartupReadiness();
    // Readiness races release; once the waiting identity is deleted,
    /**     Old continuations never spawn; reopening mints a fresh identity. */
    if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
      throw createRuntimeUnavailableError(params);
    }
    const readiness = readinessSnapshot?.readiness;
    if (!readinessSnapshot || !readiness?.ready) {
      const revision = readinessSnapshot?.revision ?? "missing";
      if (waiting.lastLoggedRevision !== revision) {
        waiting.lastLoggedRevision = revision;
        logger.info(
          undefined,
          active
            ? "provider/model not ready; ZCode agent stays read-only"
            : "provider/model not ready; ZCode agent stays unstarted",
          {
            providerCount: readinessSnapshot?.providerCount ?? 0,
            revision: readinessSnapshot?.revision ?? null,
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
      }
      throw createProviderNotReadyError({ snapshot: readinessSnapshot, workspace: params });
    }

    const entry = await getOrStartReadOnlyClient(params);
    if (waiting.cancelled) {
      throw createRuntimeUnavailableError(params);
    }
    entry.modelExecutionEnabled = true;
    processManager.markReady(params, entry.client);
    entry.workspace = params;
    waitingWorkspaceStartups.delete(workspaceKey);
    logger.info(undefined, "provider/model ready; allowing ZCode agent model execution", {
      modelId: readiness.modelId,
      providerId: readiness.providerId,
      revision: readinessSnapshot.revision,
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry.client;
  }

  async function getReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
    runtimePolicy: "start-if-needed" | "existing-only" = "start-if-needed",
  ) {
    if (runtimePolicy === "existing-only") {
      const workspaceKey = resolveWorkspaceKey(params);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      /**
      Observer paths reject disposed entries too: clean, then treat as absent,
      Never spawn for observers (existing-only).
      */
      if (active && isReusableActiveClientEntry(params, active)) {
        active.workspace = params;
        return active.client;
      }
      // available can beat the starter's await; allow the
      // promote registered clients to service entries; never spawn.
      const existingClient = processManager.getExistingClient(params);
      if (!existingClient) {
        throw createRuntimeUnavailableError(params);
      }
      wireClient(existingClient, params, "chat");
      activeClientsByWorkspaceKey.set(workspaceKey, {
        client: existingClient,
        modelExecutionEnabled: false,
        workspace: params,
        /**         Promote existing clients only, no ready-phase replay; treat as off until a change re-sends. */
        dynamicWorkflowPolicyMode: "disabled",
      });
      return existingClient;
    }
    return (await getOrStartReadOnlyClient(params)).client;
  }

  async function getPluginManagementClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await pluginProcessManager.getClient(workspace);
    wireClient(client, workspace, "plugin");
    return client;
  }

  // Carrier runtime for global workflows:
  /**
  With bare scope:global, reuse any live local runtime first
  (existing-only: map lookups, no spawns) or fall back to
  management workspace: spawn a control plane via pluginProcessManager (see getPluginManagementClient)
  */
  // runtime. Not getOrStartReadOnlyClient: workflows are sessionless, provider-free,
  /**
  workspace-ready method; the management process exists for exactly such project-less control work and
  real workspace lifecycle; getOrStartReadOnlyClient would treat the synthetic
  it would pollute the client map and re-run preference sync. Both paths are local,
  */
  // homedir is real, so ~/.zcode/workflows resolves truly.
  /**   Remote runtimes (SSH/WSL/remoteSessionId) have foreign homes; never carriers. */
  function isLocalActiveWorkspaceClient(workspace: ZCodeAgentWorkspaceTarget): boolean {
    return (
      !workspace.remoteSessionId &&
      !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
    );
  }

  async function resolveGlobalSavedWorkflowCarrier(): Promise<{
    client: ZCodeProtocolClient;
    workspace: ZCodeWorkspaceRef;
  }> {
    for (const active of activeClientsByWorkspaceKey.values()) {
      if (!isLocalActiveWorkspaceClient(active.workspace)) {
        continue;
      }
      // Disposal matches getReadOnlyClient (existing-only):
      // isReusableActiveClientEntry prunes reaped entries; skip and continue.
      if (!isReusableActiveClientEntry(active.workspace, active)) {
        continue;
      }
      return { client: active.client, workspace: buildWorkspaceRef(active.workspace) };
    }
    const managementWorkspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await getPluginManagementClient();
    return { client, workspace: buildWorkspaceRef(managementWorkspace) };
  }

  // workflows/* carriers: with a workspace go direct (project runs, or explicit-scope GUI actions),
  /**   Bare scope:global lets services pick the local carrier. */
  async function resolveSavedWorkflowCarrier(
    params: ZCodeAgentSavedWorkflowTarget,
  ): Promise<{ client: ZCodeProtocolClient; workspace: ZCodeWorkspaceRef }> {
    if (savedWorkflowTargetHasWorkspace(params)) {
      return { client: await getReadOnlyClient(params), workspace: buildWorkspaceRef(params) };
    }
    return resolveGlobalSavedWorkflowCarrier();
  }

  // mcp/list-only: isolated process, see mcpStatusProcessManager.
  async function getMcpStatusClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await mcpStatusProcessManager.getClient(workspace);
    wireClient(client, workspace, "mcp-status");
    return client;
  }

  function disposeLocalState(): void {
    accountProviderConfigUnsubscribe?.();
    accountProviderConfigUnsubscribe = undefined;
    modelSelectionSubscription?.dispose();
    modelSelectionSubscription = undefined;
    memoryDiagnostics.dispose();
    for (const emitter of sessionEmitters.values()) {
      emitter.dispose();
    }
    sessionEmitters.clear();
    for (const emitter of providerRuntimeHeadersWorkspaceEmitters.values()) {
      emitter.dispose();
    }
    providerRuntimeHeadersWorkspaceEmitters.clear();
    for (const emitter of providerRuntimeHeadersCancelledEmitters.values()) emitter.dispose();
    providerRuntimeHeadersCancelledEmitters.clear();
    sessionRuntimePreferencesRequestEmitter.dispose();
    processResourceSampleEmitter.dispose();
    mcpTelemetryEmitter.dispose();
    toolExecResourceEmitter.dispose();
    mcpResourceSamplesEmitter.dispose();
    for (const emitter of pluginOperationProgressEmitters.values()) {
      emitter.dispose();
    }
    pluginOperationProgressEmitters.clear();
    for (const emitter of conversationFrameEmitters.values()) {
      emitter.dispose();
    }
    conversationFrameEmitters.clear();
    for (const emitter of conversationTelemetryFactEmitters.values()) {
      emitter.dispose();
    }
    conversationTelemetryFactEmitters.clear();
    localTtftFactsEmitter.dispose();
    cuaPermissionObservationEmitter.dispose();
    for (const emitter of workspaceConfigFrameEmitters.values()) {
      emitter.dispose();
    }
    workspaceConfigFrameEmitters.clear();
    for (const emitter of sessionsIndexFrameEmitters.values()) {
      emitter.dispose();
    }
    sessionsIndexFrameEmitters.clear();
    sessionEventSequenceStates.clear();
    pendingPermissions.clear();
    pendingUserInputs.clear();
    pendingProviderRuntimeHeaders.clear();
    for (const pending of pendingSessionRuntimePreferences.values()) {
      clearTimeout(pending.timeout);
    }
    pendingSessionRuntimePreferences.clear();
    activeClientsByWorkspaceKey.clear();
    cancelAllWaitingWorkspaceStartups();
    interactionPreferenceSyncByWorkspaceKey.clear();
    cuaOperationTurnTracker?.clearAll();
    clearV4SubscriptionRoutes();
    v4RouteRuntimeRestartDisposable.dispose();
    runtimeLifecycleDisposable.dispose();
  }

  // 3.12.2: keep gating reads off ready/create; retries block chat.
  /**   Registration proves support only; gating/entitlement/model stay in offPeak/create pre-ticket. */
  function isOffPeakToolSupported(params: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): boolean {
    if (!options?.resolveOffPeakClientConfig || !options.resolveOffPeakTaskService) return false;
    if (params.remoteSessionId) return false;
    return !params.workspaceIdentity || !isRemoteWorkspaceIdentity(params.workspaceIdentity);
  }

  /**
   * Server offer (gray release): read once, pinned per process.
   * Why:
   *   1. On the ready path; per-create remote reads regressed once (3.12.2);
   *   2. Fail closed, no retry, so offline creates skip timeouts;
   *   3. Flips land next host process (1h snapshot/forceRefresh upstream).
   * Unlike off-peak, remotes work: no identity checks here.
   */
  function resolveDynamicWorkflowOffer(): Promise<DynamicWorkflowClientConfig | undefined> {
    const resolve = options?.resolveDynamicWorkflowClientConfig;
    if (!resolve) return Promise.resolve(undefined);
    dynamicWorkflowOffer ??= (async () => {
      try {
        return await resolve();
      } catch (error) {
        logger.warn(undefined, "Dynamic-workflow gating read failed; treating as disabled", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })();
    return dynamicWorkflowOffer;
  }

  /** User choice (launch.md): live-read where authority exists; else desktop-pushed. */
  async function resolveDynamicWorkflowUserMode(): Promise<DynamicWorkflowMode | undefined> {
    const read = options?.resolveDynamicWorkflowUserMode;
    if (!read) return pushedDynamicWorkflowUserMode;
    try {
      return normalizeDynamicWorkflowMode(await read());
    } catch (error) {
      /**       Read failure neither disables nor blocks: follow the server. */
      logger.warn(undefined, "Dynamic-workflow user choice read failed; following the server", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Effective = latched offer + choice. One source for sync and creation, so no
   * policy-on/create-off splits; no latching: next create sees new settings.
   * onDemand passes through: register-now vs wait-for-/workflow.
   */
  async function resolveDynamicWorkflowGate(): Promise<DynamicWorkflowMode> {
    const offer = await resolveDynamicWorkflowOffer();
    if (!offer) return "disabled";
    return applyDynamicWorkflowUserMode(offer, await resolveDynamicWorkflowUserMode()).mode;
  }

  /**
   * Sync effective mode per workspace (launch.md). Serialized:
   * Steps read the mode at run time; late steps see newer choices.
   * Skip no-op sends; disabled sends enabled:false so menus drop workflow.
   */
  function enqueueDynamicWorkflowPolicySync(entry: ActiveWorkspaceClient): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(entry.workspace);
    const previous = dynamicWorkflowPolicySyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous.then(async () => {
      const mode = await resolveDynamicWorkflowGate();
      if (mode === entry.dynamicWorkflowPolicyMode) return;
      const enabled = isDynamicWorkflowModeEnabled(mode);
      try {
        await entry.client.request(
          zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
          // Mode rides the boolean (launch.md); boolean-only strict schemas
          // reject mode: warn, stay disabled, like other non--32601 errors.
          { workspace: buildWorkspaceRef(entry.workspace), enabled, ...(enabled ? { mode } : {}) },
          zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
        );
        entry.dynamicWorkflowPolicyMode = mode;
      } catch (error) {
        // As in off-peak: -32601 is normal legacy degrade (z.object drops flags,)
        /**         falls back to disabled); other errors warn without blocking readiness. */
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "Dynamic-workflow policy sync failed; CLI keeps its policy", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    dynamicWorkflowPolicySyncByWorkspaceKey.set(workspaceKey, current);
    return current;
  }

  /** Shared by creation paths: the boolean+mode pair (absent when off). */
  async function resolveDynamicWorkflowSessionFlags(): Promise<{
    dynamicWorkflowEnabled: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  }> {
    const mode = await resolveDynamicWorkflowGate();
    return isDynamicWorkflowModeEnabled(mode)
      ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode: mode }
      : { dynamicWorkflowEnabled: false };
  }

  async function buildConversationCommandEnvelope(
    params: ZCodeAgentConversationCommandParams,
  ): Promise<CommandEnvelope> {
    const envelope = params.envelope;
    if (envelope.type === "createSession") {
      // V4 createSession skips legacy params; flags must ride
      // envelope injection; disabled omits the field (fail-closed, legacy parity).
      const { dynamicWorkflowEnabled, dynamicWorkflowMode } =
        await resolveDynamicWorkflowSessionFlags();
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      if (!offPeakToolEnabled && !dynamicWorkflowEnabled) return envelope;
      const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
      return {
        ...envelope,
        payload: {
          ...payload,
          ...(offPeakToolEnabled ? { offPeakToolEnabled: true } : {}),
          // V4 createSession is the real desktop path; without it the nine tools
          /**           never registered. */
          ...(dynamicWorkflowEnabled ? { dynamicWorkflowEnabled: true } : {}),
          ...(dynamicWorkflowEnabled && dynamicWorkflowMode !== undefined
            ? { dynamicWorkflowMode }
            : {}),
        },
      };
    }
    if (envelope.type !== "sendText") return envelope;

    const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
    /**
    A persisted cronAutomationId must not permanently brand the session
    context; later inputs lose CronUpdate/Delete. Trust this turn's payload only;
    */
    // runId-less payloads rely on the CLI's resolveTurnAutomationId.
    if (payload.automationId) {
      // Continuous automation may skip the task adapter; merge at the envelope
      // denylists, never overriding caller policy.
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeAutomationMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    if (payload.offPeakTaskId) {
      // Off-peak dispatch depth: deny OffPeakCreate only (List readable).
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeOffPeakMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    return envelope;
  }

  return {
    async prepareStorage(params) {
      const client = await processManager.getClient(params);
      wireClient(client, params, "chat");
      await client.storageStartup.wait();
    },
    async getStorageStartupState(params) {
      return processManager.getStorageStartupState(params);
    },
    onDynamicStorageStartupState(params) {
      const workspaceKey = resolveWorkspaceKey(params);
      return (listener) =>
        processManager.onStorageStartupChanged((event) => {
          if (event.workspaceKey === workspaceKey) listener(event.snapshot);
        });
    },
    hasActiveCuaOperationTurn(): boolean {
      return cuaOperationTurnTracker?.hasActiveTurn() ?? false;
    },
    async initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult> {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "Initializing the ZCode agent", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getClient(params);
        logger.info(undefined, "ZCode agent initialization complete", {
          durationMs: Date.now() - startedAt,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return {
          available: true,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
        };
      } catch (error) {
        const providerNotReady = isProviderNotReadyError(error);
        logger[providerNotReady ? "info" : "warn"](
          undefined,
          providerNotReady
            ? "ZCode agent waits provider/model"
            : "ZCode agent initialization failed",
          {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
        // initialize prewarms hosts; a missing agent must not crash first paint.
        // Keep available=false so callers reuse the recoverable path.
        return {
          available: false,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : String(error),
          ...(providerNotReady ? { reasonCode: ZCODE_AGENT_PROVIDER_NOT_READY_REASON } : {}),
        };
      }
    },

    async syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void> {
      // launch.md: with local authority pushes are signals; the file wins;
      // Attached remotes have no local settings: the pushed value rules.
      pushedDynamicWorkflowUserMode = normalizeDynamicWorkflowMode(params.mode);
      options?.forwardDynamicWorkflowUserMode?.(await resolveDynamicWorkflowUserMode());
      await Promise.all(
        [...activeClientsByWorkspaceKey.values()].map((entry) =>
          enqueueDynamicWorkflowPolicySync(entry),
        ),
      );
    },

    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      const normalizedPreferences: ZCodeAgentAppRuntimePreferences = {
        ...preferences,
        modelIoFullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
      };
      latestAppRuntimePreferences = normalizedPreferences;
      const activeClients = [...activeClientsByWorkspaceKey.values()];
      await Promise.all(
        activeClients.map((entry) =>
          enqueueInteractionPreferenceSync({
            client: entry.client,
            preferences: { ...normalizedPreferences },
            workspace: entry.workspace,
          }),
        ),
      );
    },

    async getWorkspaceRuntimeIdentity(params: ZCodeAgentWorkspaceTarget) {
      /**       Identity lookups observe only; dormant workspaces stay dormant. */
      await getReadOnlyClient(params, "existing-only");
      return await processManager.getRuntimeIdentity(params);
    },

    async createSession(params: ZCodeAgentCreateSessionParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_create",
        workspace: params,
      });
      const sessionTraceId = params.sessionTraceId;
      logger.info(sessionTraceId, "Requesting ZCode Protocol session/create", {
        hasInitialModel: params.model !== undefined,
        hasInitialThoughtLevel: params.thoughtLevel !== undefined,
        initialModel: formatModelSelectionForLog(params.model),
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        persistence: params.persistence,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      /**       Gating resolved at ready; this reawaits a local promise (no remote). */
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams({ ...params, offPeakToolEnabled, ...dynamicWorkflowFlags }),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        logger.info(sessionTraceId, "ZCode Protocol session/create complete", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          persistence: params.persistence,
          sessionId: snapshot.session.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionCreateCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(sessionTraceId, "ZCode Protocol session/create failed", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            persistence: params.persistence,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(sessionTraceId, "session/create entered legacy-compat retry", {
          compatFields,
          durationMs: Date.now() - startedAt,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        // Hosts/UIs may send new optional fields while local bundles
        /**
        Old deployments keep strict schemas; only known
        Degrade optional fields on retry so version skew never blocks first sends.
        */
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        if (!compatFields.includes("thoughtLevel") || !params.thoughtLevel) {
          logger.info(sessionTraceId, "session/create compat retry complete", {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshot.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return snapshot;
        }
        /**         If legacy create lacks thoughtLevel, apply it after via the existing */
        // session/setThoughtLevel keeps the toolbar level on the first prompt.
        const snapshotWithThoughtLevel = await client.request(
          zcodeProtocolMethods.sessionSetThoughtLevel,
          {
            sessionId: snapshot.session.sessionId,
            thoughtLevel: params.thoughtLevel,
            persistAsWorkspaceLastUsed: true,
          },
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace(
          { ...params, sessionId: snapshotWithThoughtLevel.session.sessionId },
          snapshotWithThoughtLevel,
        );
        logger.info(sessionTraceId, "session/create compat retry then thoughtLevel set", {
          durationMs: Date.now() - startedAt,
          sessionId: snapshot.session.sessionId,
          snapshotTraceId: snapshotWithThoughtLevel.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshotWithThoughtLevel;
      }
    },

    async resumeSession(params: ZCodeAgentResumeSessionParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_resume",
        workspace: params,
      });
      const cachedTraceId = getSessionTraceId(params);
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // Cold restore applies host gating or loses workflow tools.
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      logger.info(cachedTraceId, "Requesting ZCode Protocol session/resume", {
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        modelHint: params.model ?? null,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams({ ...params, offPeakToolEnabled, ...dynamicWorkflowFlags }),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume complete", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionResumeCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(cachedTraceId, "ZCode Protocol session/resume failed", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(cachedTraceId, "session/resume entered legacy-compat retry", {
          compatFields,
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "session/resume compat retry complete", {
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      }
    },

    async listSessions(params: ZCodeAgentListSessionsParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const result = await client.request(
        zcodeProtocolMethods.sessionList,
        {
          workspace: buildWorkspaceRef(params),
          includeArchived: params.includeArchived ?? false,
          limit: params.limit,
          ...(params.sessionIds ? { sessionIds: params.sessionIds } : {}),
        },
        zcodeSessionListResultSchema,
      );
      for (const session of result.sessions) {
        if (session.traceId) {
          sessionTraceIdBySessionKey.set(
            sessionEventKey({ ...params, sessionId: session.sessionId }),
            session.traceId as TraceId,
          );
        }
      }
      return result.sessions;
    },

    async listSessionSubagents(params: ZCodeAgentListSessionSubagentsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSubagents,
        {
          sessionId: params.sessionId,
          endedCursor: params.endedCursor,
          endedLimit: params.endedLimit ?? 20,
        },
        zcodeSessionSubagentsResultSchema,
      );
    },

    async getAppUsageStats(params: ZCodeAgentAppUsageParams) {
      // Usage lives in the global DB; any live client reaches it.
      const active = activeClientsByWorkspaceKey.values().next().value;
      if (!active) {
        throw new Error("no_active_workspace");
      }
      // usage/stats maps to v4 (additive; store-owned truth,)
      /**       same-shape payload; legacy consumption zeros, old cases retire with the verbs). */
      return active.client.request(
        V4_METHODS.usageStats,
        { range: params.range, timeZone: params.timeZone },
        v4UsageStatsResultSchema,
      );
    },

    async getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams) {
      const client = await getReadOnlyClient(params);
      // session/usage to v4 usage (task is a UI projection,)
      // v4 namespace under conversation).
      return client.request(
        V4_METHODS.conversationUsage,
        { sessionId: params.sessionId },
        v4ConversationUsageResultSchema,
      );
    },

    async readSession(params: ZCodeAgentReadSessionParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // Index backfill readSession must not let default policy
      /**
      and respawning agents; this observation never touches session lifecycle.
      reads sync registries; existing-only stays pure observation.
      */
      if (params.runtimePolicy !== "existing-only") {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "session_read",
          workspace: params,
        });
      }
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionRead,
        {
          sessionId: params.sessionId,
          deliveryKind: params.deliveryKind,
          messageLimit: params.messageLimit,
          afterSeq: params.afterSeq,
          contentProfile: params.contentProfile,
        },
        zcodeSessionStateSnapshotSchema,
      );
      rememberSessionTrace(params, snapshot);
      return snapshot;
    },

    async readSessionMessages(params: ZCodeAgentReadSessionMessagesParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionMessages,
        {
          sessionId: params.sessionId,
          afterMessageId: params.afterMessageId,
          limit: params.limit,
        },
        zcodeSessionMessagesResultSchema,
      );
      return result.messages;
    },

    async readSessionDebug(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(
        zcodeProtocolMethods.sessionDebug,
        { sessionId: params.sessionId },
        sessionDebugSnapshotSchema,
      );
    },

    async readSessionEvents(params: ZCodeAgentReadSessionEventsParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionEvents,
        {
          sessionId: params.sessionId,
          afterSeq: params.afterSeq,
          limit: params.limit,
        },
        zcodeSessionEventsResultSchema,
      );
      return result.events;
    },

    async readWorkspacePresentation(params: ZCodeAgentReadWorkspacePresentationParams) {
      const startedAt = Date.now();
      logger.info(undefined, "Requesting ZCode Protocol workspace/readPresentation", {
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        let presentation: ZCodeWorkspacePresentation | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const client = await getReadOnlyClient(params);
          try {
            await ensureAccountProviderConfigSynced({
              client,
              reason: "workspace_read_presentation",
              workspace: params,
            });
            presentation = await client.request(
              zcodeProtocolMethods.workspaceReadPresentation,
              { workspace: buildWorkspaceRef(params) },
              zcodeWorkspacePresentationSchema,
            );
            break;
          } catch (error) {
            if (attempt > 0 || !isClosedStdioTransportError(error)) {
              throw error;
            }
            /**
            Config updates can restart the workspace agent mid-read.
            client grabbed but unsent when stdio closes; read-only calls reacquire
            client once; never surface lifecycle races.
            */
            logger.warn(
              undefined,
              "workspace/readPresentation hit a closed transport; reacquiring agent",
              {
                workspaceKey: resolveWorkspaceKey(params),
                workspacePath: params.workspacePath,
              },
            );
            const workspaceKey = resolveWorkspaceKey(params);
            if (activeClientsByWorkspaceKey.get(workspaceKey)?.client === client) {
              // transport.send can see the close pre-onClose; cleanup routes via identity-
              // Guarded invalidation never leaves preference/model sync behind.
              invalidateWorkspaceClient(workspaceKey, client);
            }
          }
        }
        if (!presentation) {
          throw new Error("ZCode Protocol workspace/readPresentation did not return a result");
        }
        logger.info(undefined, "workspace/readPresentation complete", {
          durationMs: Date.now() - startedAt,
          slashCommandCount: presentation.slashCommands.length,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return presentation;
      } catch (error) {
        logger.warn(undefined, "workspace/readPresentation failed", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async grantWorkspaceHookTrust(params: ZCodeAgentGrantWorkspaceHookTrustParams) {
      /**       Without a task, pretrust still works but read-only; never */
      // fake sessions for settings nor demand ready providers.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workspaceHookTrustGrant,
        {
          workspace: buildWorkspaceRef(params),
          bundleDigest: params.bundleDigest,
          hookDeclarationDigest: params.hookDeclarationDigest,
        },
        zcodeWorkspaceHookTrustGrantResultSchema,
      );
    },

    async listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams) {
      const requestMcpList = async (options?: { omitMcpServers?: boolean; omitMode?: boolean }) => {
        const client = await getMcpStatusClient();
        return client.request(
          zcodeProtocolMethods.mcpList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.mcpServers !== undefined && !options?.omitMcpServers
              ? { mcpServers: params.mcpServers }
              : {}),
            ...(params.mode !== undefined && !options?.omitMode ? { mode: params.mode } : {}),
          },
          zcodeMcpListResultSchema,
        );
      };
      try {
        return await requestMcpList();
      } catch (error) {
        const unrecognizedKeys = getUnrecognizedTopLevelKeys(error);
        if (params.mode === "status" && unrecognizedKeys.includes("mode")) {
          /**           Without status-only, omitting mode on retry reconnects broadly; */
          // re-converge via replace, possibly dropping UI-pushed MCP absent legacy-side;
          /**           Stable codes survive RPC so UI can stop futile polls. */
          logger.warn(
            undefined,
            "Legacy agent lacks MCP status-only; skipping connection-changing retry",
            {
              workspaceKey: resolveWorkspaceKey(params),
              workspacePath: params.workspacePath,
            },
          );
          throw new ZCodeAgentMcpStatusModeUnsupportedError();
        }
        if (
          (params.mode !== undefined && unrecognizedKeys.includes("mode")) ||
          (params.mcpServers !== undefined && unrecognizedKeys.includes("mcpServers"))
        ) {
          const omitMode = unrecognizedKeys.includes("mode");
          const omitMcpServers = unrecognizedKeys.includes("mcpServers");
          logger.warn(undefined, "MCP status list entered legacy-compat retry", {
            omittedKeys: [...(omitMode ? ["mode"] : []), ...(omitMcpServers ? ["mcpServers"] : [])],
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return await requestMcpList({
            omitMcpServers,
            omitMode,
          });
        }
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.mcpList)) {
          throw error;
        }
        logger.warn(undefined, "MCP status list timed out; restarting the silent agent once", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        return await requestMcpList();
      }
    },

    async listPlugins(params: ZCodeAgentPluginViewParams) {
      const requestPluginsList = async () => {
        const client = await getPluginManagementClient();
        // plugins/list reads local metadata on the default timeout like mcp/list,
        /**         so stale clients recycle promptly instead of waiting out 5-minute market IO. */
        return client.request(
          zcodeProtocolMethods.pluginsList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.configScope ? { configScope: params.configScope } : {}),
          },
          zcodePluginsListResultSchema,
        );
      };
      try {
        return await requestPluginsList();
      } catch (error) {
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.pluginsList)) {
          throw error;
        }
        logger.warn(undefined, "Plugin list timed out; restarting the silent agent once", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        /**
        Plugin lists read metadata only; a live-but-silent agent
        After the first plugins/list timeout never reuse the stale client; the manager reaps it
        Retry idempotent list calls once so settings recover from respawns.
        */
        return await requestPluginsList();
      }
    },

    async getPluginReferenceCatalog(params: ZCodeAgentPluginReferenceCatalogParams) {
      // Plugin catalogs hit the workspace agent holding the session
      /**       (getReadOnlyClient reuses active clients) never the management process, */
      // session-less processes hide session catalogs.
      const client = await getReadOnlyClient(params);
      return requestPluginReferenceCatalog(client, {
        workspace: buildWorkspaceRef(params),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
    },

    async getSkillReferenceCatalog(params: ZCodeAgentSkillReferenceCatalogParams) {
      // Session snapshots live in the workspace agent; the manager
      /**       with no resident session it is no conversation authority. */
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.skillsReferenceCatalog,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        zcodeSkillsReferenceCatalogResultSchema,
      );
    },

    async openMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiOpenInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          accountContext: params.accountContext,
          resourceUri: params.resourceUri,
          ownerWebContentsId: params.ownerWebContentsId,
        },
        zcodeMcpUiOpenInstanceResultSchema,
      );
    },
    async validateMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiValidateInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
        mcpUiEmptyResultSchema,
      );
    },
    async recycleMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
          onlyIfIdle: true,
        },
        zcodeMcpUiCloseInstanceResultSchema,
      );
      return result.closed;
    },
    async closeMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
        zcodeMcpUiCloseInstanceResultSchema,
      );
    },
    async readMcpResource(params: ZCodeAgentReadMcpResourceParams) {
      // Frozen catalogs live in the workspace agent.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpReadResourceResultSchema,
      );
    },

    async sampleMcpApp(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      const wire = { ...bound, workspace: buildWorkspaceRef(params) };
      try {
        return await client.request(
          zcodeProtocolMethods.mcpUiSampling,
          wire,
          zcodeMcpUiSamplingResultSchema,
          { timeoutMs: MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS },
        );
      } catch (error) {
        /**         Timeout/channel failure cancels the call; never respawn agents to resample. */
        const { request: _request, ...cancelParams } = wire;
        void client
          .request(
            zcodeProtocolMethods.mcpUiCancelSampling,
            cancelParams,
            zcodeMcpUiCancelCallResultSchema,
          )
          .catch(() => undefined);
        throw error;
      }
    },
    async cancelMcpAppSampling(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      return client.request(
        zcodeProtocolMethods.mcpUiCancelSampling,
        { ...bound, workspace: buildWorkspaceRef(params) },
        zcodeMcpUiCancelCallResultSchema,
      );
    },
    async callMcpToolForUi(params: ZCodeAgentCallMcpToolForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiCallTool,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          toolName: params.toolName,
          ...(params.arguments ? { arguments: params.arguments } : {}),
          callId: params.callId,
        },
        zcodeMcpUiCallToolResultSchema,
      );
    },

    async cancelMcpToolCallForUi(params: ZCodeAgentCancelMcpToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiCancelCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          callId: params.callId,
        },
        zcodeMcpUiCancelCallResultSchema,
      );
    },

    async readMcpResourceForUi(params: ZCodeAgentReadMcpResourceForUiParams) {
      // Same process as callMcpToolForUi: attribution/mime/8MiB fail closed agent-side.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpUiReadResourceResultSchema,
      );
    },

    async listMcpResourcesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiListResources,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourcesResultSchema,
      );
    },

    async listMcpResourceTemplatesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiListResourceTemplates,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourceTemplatesResultSchema,
      );
    },

    async subscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
      /**       Subscriptions register agent-side (refcounted, replayed on reconnect); hosts relay the identity triple. */
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiSubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    async unsubscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiUnsubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    async registerAppToolsForUi(params: ZCodeAgentRegisterAppToolsForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiRegisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          tools: params.tools,
        },
        zcodeMcpUiRegisterAppToolsResultSchema,
      );
    },

    async unregisterAppToolsForUi(params: ZCodeAgentAppToolInstanceForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiUnregisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
        },
        zcodeMcpUiUnregisterAppToolsResultSchema,
      );
    },

    async claimAppToolCallForUi(params: ZCodeAgentAppToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiClaimAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          callId: params.callId,
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    async resolveAppToolCallForUi(params: ZCodeAgentResolveAppToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiResolveAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          callId: params.callId,
          ...(params.result ? { result: params.result } : {}),
          ...(params.error ? { error: params.error } : {}),
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    async listPluginUiSurfaces(params: ZCodeAgentWorkspaceTarget) {
      /**       Panels open only with sessions, so the agent exists: read its parsed list via the read-only client */
      // not the management process (no per-workspace state, as in mcp/readResource).
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.pluginsListUiSurfaces,
        { workspace: buildWorkspaceRef(params) },
        zcodePluginsListUiSurfacesResultSchema,
      );
    },

    /**     Saved-workflow hub: same */
    // workspace agent path; remotes scan remotely.
    // Global: carrier via resolveSavedWorkflowCarrier,
    // Push scope only when defined.
    async listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsList,
        { workspace, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsListResultSchema,
      );
    },

    async getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsGet,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsGetResultSchema,
      );
    },

    async updateSavedWorkflowMeta(params: ZCodeAgentUpdateSavedWorkflowMetaParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsUpdateMeta,
        { workspace, name: params.name, meta: params.meta, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsUpdateMetaResultSchema,
      );
    },

    async deleteSavedWorkflow(params: ZCodeAgentDeleteSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsDelete,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsDeleteResultSchema,
      );
    },

    async listSavedWorkflowRuns(params: ZCodeAgentListSavedWorkflowRunsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsRuns,
        {
          workspace,
          ...(params.name === undefined ? {} : { name: params.name }),
          limit: params.limit,
          ...savedWorkflowScopeParam(params),
        },
        zcodeWorkflowsRunsResultSchema,
      );
    },

    /**     Global-to-project moves (the only direction): */
    // workspace is mandatory: carrier and target; so
    // getReadOnlyClient(params) direct; no carrier pick.
    async moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsMove,
        { workspace: buildWorkspaceRef(params), name: params.name },
        zcodeWorkflowsMoveResultSchema,
      );
    },

    /**     Completion-card direct save (transcript-and-notifications.md) must target */
    // the run's workspace owns the journal, global runs included
    /**     (the agent derives destination from scope, not carrier) via getReadOnlyClient directly. */
    async saveSavedWorkflowFromRun(params: ZCodeAgentSaveSavedWorkflowFromRunParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsSave,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          name: params.name,
          meta: params.meta,
          ...(params.scope === undefined ? {} : { scope: params.scope }),
          ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
        },
        zcodeWorkflowsSaveResultSchema,
      );
    },

    async findSavedWorkflowForRun(params: ZCodeAgentFindSavedWorkflowForRunParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsForRun,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          ...(params.candidates === undefined ? {} : { candidates: [...params.candidates] }),
        },
        zcodeWorkflowsForRunResultSchema,
      );
    },

    async resolveSuggestedPluginReference(params: ZCodeAgentResolveSuggestedPluginReferenceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResolveSuggestedReference,
        {
          workspace: buildWorkspaceRef(params),
          stableId: params.stableId,
          operationId: params.operationId,
          clientMode: params.clientMode,
          deliveryKind: params.deliveryKind,
        },
        zcodePluginsResolveSuggestedReferenceResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    onDynamicPluginOperationProgress(operationId: string) {
      return getPluginOperationProgressEmitter(operationId).event;
    },

    async collectLocalRuntimeChildProcesses(signal?: AbortSignal) {
      const managed = [processManager, pluginProcessManager, mcpStatusProcessManager]
        .flatMap((manager) => manager.listManagedProcesses())
        .filter(
          (runtime) => !runtime.client.isDisposed && !runtime.client.storageStartup.isWaiting,
        );
      return Promise.all(
        managed.map(async (runtime) => {
          let children: ZCodeProcessChildProcess[] = [];
          try {
            const result = await runtime.client.request(
              zcodeProtocolMethods.processChildProcesses,
              {},
              zcodeProcessChildProcessesResultSchema,
              { timeoutMs: CHILD_PROCESSES_REQUEST_TIMEOUT_MS, lifecycle: "observation", signal },
            );
            children = result.processes;
          } catch {
            /**             Unknown method or busy runtime: this agent's descendants attribute to cli; others unaffected. */
          }
          return {
            pid: runtime.pid,
            provider: ZCODE_AGENT_PROVIDER,
            workspacePath: runtime.workspacePath,
            ...(runtime.lane ? { lane: runtime.lane } : {}),
            children,
          };
        }),
      );
    },

    async getPluginsOverview(params: ZCodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsOverview,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.configScope ? { configScope: params.configScope } : {}),
        },
        zcodePluginsOverviewResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async addPluginMarketplace(params: ZCodeAgentAddPluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceAdd,
        {
          workspace: buildWorkspaceRef(params),
          source: params.source,
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async removePluginMarketplace(params: ZCodeAgentRemovePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceRemove,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePluginMarketplace(params: ZCodeAgentUpdatePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async installPlugin(params: ZCodeAgentInstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsInstall,
        {
          workspace: buildWorkspaceRef(params),
          pluginName: params.pluginName,
          marketplace: params.marketplace,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async cancelPluginOperation(params: ZCodeAgentCancelPluginOperationParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsCancelOperation,
        { operationId: params.operationId },
        zcodePluginsCancelOperationResultSchema,
        { timeoutMs: PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS },
      );
    },

    async uninstallPlugin(params: ZCodeAgentUninstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUninstall,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.removeCache !== undefined ? { removeCache: params.removeCache } : {}),
        },
        zcodePluginsUninstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePlugin(params: ZCodeAgentUpdatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async restoreBuiltinPlugin(params: ZCodeAgentRestoreBuiltinPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsRestoreBuiltin,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
        },
        zcodePluginsRestoreBuiltinResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async configurePlugin(params: ZCodeAgentConfigurePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsConfigure,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          options: params.options,
          ...(params.clearOptionKeys?.length ? { clearOptionKeys: params.clearOptionKeys } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async resetPluginConfig(params: ZCodeAgentResetPluginConfigParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResetConfig,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async validatePlugin(params: ZCodeAgentValidatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsValidate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.source ? { source: params.source } : {}),
        },
        zcodePluginsValidateResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async describePlugin(params: ZCodeAgentDescribePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsDescribe,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
          pluginName: params.pluginName,
        },
        zcodePluginsDescribeResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsSetEnabled,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          enabled: params.enabled,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsSetEnabledResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async listAutomations(params: ZCodeAgentWorkspaceTarget) {
      return automationService.list(params);
    },

    async listAllAutomations() {
      return automationService.list();
    },

    async createAutomation(params: ZCodeAgentCreateAutomationParams) {
      return automationService.create({
        title: params.title,
        cronExpr: params.cronExpr,
        relativeDelayMinutes: params.relativeDelayMinutes,
        prompt: params.prompt,
        modelSelection: params.modelSelection,
        mode: params.mode as ZCodeTaskMode | undefined,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        recurring: params.recurring ?? true,
        maxRuns: params.maxRuns,
        endAt: params.endAt,
        scheduleRule: params.scheduleRule,
      });
    },

    async updateAutomation(params: ZCodeAgentUpdateAutomationParams) {
      return automationService.update(
        params.automationId,
        {
          title: params.title,
          cronExpr: params.cronExpr,
          prompt: params.prompt,
          modelSelection: params.modelSelection,
          mode: params.mode === null ? null : (params.mode as ZCodeTaskMode | undefined),
          recurring: params.recurring,
          maxRuns: params.maxRuns,
          endAt: params.endAt,
          scheduleRule: params.scheduleRule,
          scheduleEditedByUser: params.scheduleEditedByUser,
        },
        /**         Ownership: writes stay in the caller's workspace; no cross-workspace rights. */
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      );
    },

    async deleteAutomation(params: ZCodeAgentAutomationIdParams) {
      await automationService.delete(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams) {
      return automationService.setEnabled(params.automationId, params.enabled, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async restartAutomation(params: ZCodeAgentAutomationIdParams) {
      return automationService.restart(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async runAutomationNow(params: ZCodeAgentAutomationIdParams) {
      const dispatch = options?.onAutomationManualRunRequested;
      if (!dispatch) {
        // runNow writes the manual run and claims single-flight; dispatcher
        /**         A missing id is a sync-detectable config error: fail pre-claim, not via crash reaping. */
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      const claimed = await automationService.runNow(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      if (!claimed) {
        // when single-flight rejects, empty successes read as
        /**         new runs enqueued, so every click toasts triggered again. */
        return { status: "duplicate" as const };
      }
      await dispatch(claimed);
      return { status: "queued" as const };
    },

    async listAutomationRuns(params: ZCodeAgentAutomationIdParams) {
      return automationService.listRuns(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams) {
      return automationService.deleteRun(params.runId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async generateWorkspaceText(params: ZCodeAgentGenerateWorkspaceTextParams) {
      const client = await getClient(params);
      // Workers read built-in/personal config; the host gates account state
      // account overlays land first; no modeling from stale plans.
      await ensureAccountProviderConfigSynced({
        client,
        reason: "workspace_generate_text",
        workspace: params,
      });
      const operationId = params.signal ? randomUUID() : undefined;
      const cancel = () => {
        if (!operationId) return;
        void client
          .request(
            zcodeProtocolMethods.workspaceCancelGenerateText,
            { operationId },
            zcodeWorkspaceCancelGenerateTextResultSchema,
            { timeoutMs: 5_000 },
          )
          .catch((error: unknown) => {
            /**             Cancel is best-effort: never mask the caller's AbortError; */
            // Debug traces split local waits from received cancels.
            logger.debug(undefined, "Failed to notify workspace model-request cancel", {
              operationId,
              workspaceKey: resolveWorkspaceKey(params),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      };
      params.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await client.request(
          zcodeProtocolMethods.workspaceGenerateText,
          {
            workspace: buildWorkspaceRef(params),
            selection: params.selection,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.messages ? { messages: params.messages } : {}),
            ...(params.tools ? { tools: params.tools } : {}),
            querySource: params.querySource,
            ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
            ...(operationId ? { operationId } : {}),
          },
          zcodeWorkspaceGenerateTextResultSchema,
          // Without timeoutMs the 3m default fires early on long thinking calls
          // and onRequestTimeout kills the agent as stale.
          /**           Caller-supplied requestTimeoutMs (deadline + cancel slack) wins. */
          {
            signal: params.signal,
            ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
          },
        );
      } finally {
        params.signal?.removeEventListener("abort", cancel);
      }
    },

    async testModelConnectivity(params: ZCodeAgentTestModelConnectivityParams) {
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "provider_test_model_connectivity",
        workspace: params,
      });
      return client.request(
        zcodeProtocolMethods.providerTestModelConnectivity,
        {
          workspace: buildWorkspaceRef(params),
          selection: params.selection,
        },
        zcodeProviderTestModelConnectivityResultSchema,
        { signal: params.signal },
      );
    },

    async sendPrompt(params: ZCodeAgentSendPromptParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = params.sessionTraceId?.trim() || getSessionTraceId(params);
      const logTraceId = sessionTraceId ?? params.inputId;
      const browserAmbientContext =
        params.browserAmbientContext ??
        (await collectBrowserAmbientContext(options?.browserControlExecutor, {
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        }));
      const protocolParams: ZCodeAgentSendPromptParams = {
        ...params,
        ...(browserAmbientContext ? { browserAmbientContext } : {}),
      };
      logger.info(logTraceId, "ZCode Agent session/send start", {
        attachmentCount: params.attachments?.length ?? 0,
        hasBrowserAmbientContext: browserAmbientContext !== undefined,
        inputId: params.inputId,
        queryId: params.queryId ?? null,
        sessionId: params.sessionId,
        sessionTraceId: sessionTraceId ?? null,
        textLength: params.content.length,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionSend,
          buildSessionSendParams(protocolParams),
          zcodeSessionSendResultSchema,
        );
        logger.info(logTraceId, "ZCode Agent session/send ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        const compatFields = getSessionSendCompatFields(error);
        if (compatFields.length > 0) {
          logger.warn(logTraceId, "session/send entered legacy-compat retry", {
            compatFields,
            durationMs: Date.now() - startedAt,
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          const result = await client.request(
            zcodeProtocolMethods.sessionSend,
            buildSessionSendParams(protocolParams, new Set(compatFields)),
            zcodeSessionSendResultSchema,
          );
          return result;
        }
        logger.warn(logTraceId, "ZCode Agent session/send failed", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async compactSession(params: ZCodeAgentCompactParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = getSessionTraceId(params);
      logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact start", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionCompact,
          buildSessionCompactParams(params),
          zcodeSessionCompactResultSchema,
          {
            // Compact maintenance runs minutes; only the ACK edge widens,
            /**             Terminals still arrive via timeline/snapshot; never treat this as the compact result. */
            timeoutMs: SESSION_COMPACT_REQUEST_TIMEOUT_MS,
          },
        );
        logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(sessionTraceId ?? params.inputId, "session/compact failed", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async goalSession(params: ZCodeAgentGoalParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(params.inputId, "Requesting ZCode Protocol session/goal", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionGoal,
          {
            sessionId: params.sessionId,
            inputId: params.inputId,
            action: params.action,
            objective: params.objective,
            expectedRevision: params.expectedRevision,
          },
          zcodeSessionGoalResultSchema,
        );
        logger.info(params.inputId, "session/goal complete", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          messageCount: result.snapshot.messages.length,
          responseLength: result.response?.length ?? 0,
          sessionId: params.sessionId,
          startedTurn: result.startedTurn,
          status: result.snapshot.session.status,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(params.inputId, "session/goal failed", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async closeSession(
      params: ZCodeAgentSessionTarget & {
        expectedPersistence?: "deferred" | "immediate";
      },
    ): Promise<boolean> {
      const client = await getClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionClose,
        {
          sessionId: params.sessionId,
          ...(params.expectedPersistence
            ? { expectedPersistence: params.expectedPersistence }
            : {}),
        },
        zcodeSessionCloseResultSchema,
      );
      // Tolerate clean closes lacking a closed field.
      return result.closed ?? true;
    },

    async setModel(params: ZCodeAgentSetModelParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(undefined, "Requesting ZCode Protocol session/setModel", {
        expectedRevision: params.expectedRevision ?? null,
        persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed ?? null,
        requestedModel: formatModelSelectionForLog(params.model),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionSetModel,
          {
            sessionId: params.sessionId,
            model: params.model,
            expectedRevision: params.expectedRevision,
            persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
          },
          zcodeSessionStateSnapshotSchema,
        );
        logger.info(undefined, "session/setModel complete", {
          durationMs: Date.now() - startedAt,
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          snapshotModel: formatModelSelectionForLog(snapshot.settings.model.current),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        logger.warn(undefined, "session/setModel failed", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams) {
      const client = await getClient(params);
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionSetThoughtLevel,
        {
          sessionId: params.sessionId,
          thoughtLevel: params.thoughtLevel,
          expectedRevision: params.expectedRevision,
          persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
        },
        zcodeSessionStateSnapshotSchema,
      );
      return snapshot;
    },

    async setMode(params: ZCodeAgentSetModeParams) {
      const client = await getClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSetMode,
        {
          sessionId: params.sessionId,
          mode: params.mode,
          expectedRevision: params.expectedRevision,
        },
        zcodeSessionStateSnapshotSchema,
      );
    },

    async respondSessionRuntimePreferences(
      params: ZCodeAgentRespondSessionRuntimePreferencesParams,
    ): Promise<void> {
      const pending = takePendingSessionRuntimePreferences(params.requestId);
      if (!pending) {
        logger.warn(undefined, "Runtime-preferences response has no pending request", {
          event: "zcode_agent.runtime_preferences.response_without_pending",
          module: "services.zcode_agent",
          requestId: params.requestId,
        });
        throw new Error(`ZCode session runtime preferences request not found: ${params.requestId}`);
      }
      const responseContext = {
        event: "zcode_agent.runtime_preferences.host_response_received",
        module: "services.zcode_agent",
        requestId: params.requestId,
        scope: pending.request.scope,
        sessionId: pending.request.sessionId,
        workspaceKey: pending.workspaceKey,
      };
      if (params.resolution.status === "failed") {
        logger.warn(undefined, "Host runtime-preferences lookup failed", {
          ...responseContext,
          error: params.resolution.message,
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: params.resolution.message,
        });
        return;
      }
      let preferences: ZCodeSessionRuntimePreferencesResult;
      try {
        preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
          params.resolution.preferences,
        );
      } catch (error) {
        logger.warn(undefined, "Host runtime-preferences payload invalid", {
          ...responseContext,
          error: error instanceof Error ? error.message : String(error),
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      /**       Send failure means closed transport, not invalid preferences; no second response. */
      await pending.client.respond(pending.protocolRequestId, preferences);
      logger.info(undefined, "Runtime-preferences relayed to the agent", responseContext);
    },

    onDynamicWorkspaceProviderRuntimeHeadersCancelled(params: ZCodeAgentWorkspaceTarget) {
      const key = resolveWorkspaceKey(params);
      let emitter = providerRuntimeHeadersCancelledEmitters.get(key);
      if (!emitter) {
        emitter = new Emitter<ZCodeProviderRuntimeHeadersCancelled>();
        providerRuntimeHeadersCancelledEmitters.set(key, emitter);
      }
      return emitter.event;
    },

    onDynamicSessionRuntimePreferencesRequest() {
      return (listener) => {
        const disposable = sessionRuntimePreferencesRequestEmitter.event(listener);
        for (const pending of pendingSessionRuntimePreferences.values()) {
          listener(pending.request);
        }
        return disposable;
      };
    },

    async respondProviderRuntimeHeaders(
      params: ZCodeAgentRespondProviderRuntimeHeadersParams,
    ): Promise<void> {
      const key = providerRuntimeHeadersRequestKey(params);
      const pending = pendingProviderRuntimeHeaders.get(key);
      if (!pending) {
        throw new Error(`ZCode provider runtime headers request not found: ${params.requestId}`);
      }
      if (pending.responding) {
        throw new Error(
          `ZCode provider runtime headers response already pending: ${params.requestId}`,
        );
      }
      // Never delete pending pre-IO: later cancels find nothing;
      // keep identity to resolution; dedupe responders.
      pending.responding = true;
      if (!params.response.headersApplied) {
        pendingProviderRuntimeHeaders.delete(key);
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          ...(params.response.errorMessage ? { errorMessage: params.response.errorMessage } : {}),
        });
        return;
      }
      let accountRequestAuth: AccountRequestAuthMaterial | undefined;
      try {
        accountRequestAuth = await resolveAccountRequestAuth(pending.request);
      } catch (error) {
        if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
        pendingProviderRuntimeHeaders.delete(key);
        logger.warn(undefined, "Failed to apply ZCode provider runtime headers", {
          modelId: pending.request.modelSelection.modelId,
          providerId: pending.request.providerId,
          requestId: pending.request.requestId,
          sessionId: pending.request.sessionId,
          error: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(pending.request.workspace),
        });
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
      pendingProviderRuntimeHeaders.delete(key);
      const requestHeaders = {
        ...accountRequestAuth?.headers,
      };
      Object.assign(
        requestHeaders,
        allowRequestVerificationHeaders(params.response.runtimeProviderHeaders ?? {}),
      );
      const requestAuth =
        accountRequestAuth?.apiKey || Object.keys(requestHeaders).length > 0
          ? {
              ...(accountRequestAuth?.apiKey ? { apiKey: accountRequestAuth.apiKey } : {}),
              ...(accountRequestAuth?.apiKeyId ? { apiKeyId: accountRequestAuth.apiKeyId } : {}),
              ...(accountRequestAuth?.accountScope
                ? { accountScope: accountRequestAuth.accountScope }
                : {}),
              ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
            }
          : undefined;
      await pending.client.respond(
        pending.protocolRequestId,
        requestAuth
          ? { headersApplied: true, requestAuth }
          : { headersApplied: false, errorMessage: "Provider request auth is missing" },
      );
      const logContext = {
        modelId: pending.request.modelSelection.modelId,
        providerId: pending.request.providerId,
        requestId: pending.request.requestId,
        sessionId: pending.request.sessionId,
        ...(params.response.errorMessage ? { error: params.response.errorMessage } : {}),
        workspaceKey: resolveWorkspaceKey(pending.request.workspace),
      };
      if (requestAuth) {
        logger.info(undefined, "ZCode provider runtime headers applied", logContext);
      } else {
        logger.warn(undefined, "Failed to apply ZCode provider runtime headers", logContext);
      }
    },

    onDynamicProviderRuntimeHeadersRequest(params: ZCodeAgentSessionTarget) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        const disposable = emitter.event((event) => {
          if (event.type !== "providerRuntimeHeaders.request") {
            return;
          }
          listener(event.request);
        });
        // Bug: draft first-sends start turns before panes bind ids;
        // header requests can precede subscriptions; events alone
        /**
        the request would sit pending with no validator and the real send never fires.
        Register the live listener first, then replay pending, closing both windows.
        */
        const pendingSessionPrefix = `${sessionEventKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingSessionPrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    onDynamicWorkspaceProviderRuntimeHeadersRequest(params: ZCodeAgentWorkspaceTarget) {
      const emitter = getProviderRuntimeHeadersWorkspaceEmitter(params);
      return (listener) => {
        const disposable = emitter.event((request) => {
          listener(request);
        });
        // Bug (2026-08-16): session entry needs the sessionId,)
        /**
        web-created sessions have no desktop pane, so header requests
        pending forever. Workspace subscription mirrors session: listener first,
        */
        // then replay pending by prefix, closing the pre-subscribe window;
        // Isolate by workspaceKey (identity first); no cross-delivery.
        const pendingWorkspacePrefix = `${resolveWorkspaceKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingWorkspacePrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        // cancelled/retryTimer are per-subscriber; dispose cancels its own
        // leaving shared-emitter subscribers untouched.
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let subscriptionReady = false;
        const pendingLiveEvents: ZCodeAgentServiceEvent[] = [];
        const deliveredEventIds = new Set<string>();
        const deliveredEventIdOrder: string[] = [];
        const eventCoalescer =
          params.eventCoalescing?.mode === "background-summary"
            ? createBackgroundSessionEventCoalescer({
                emit: listener,
                flushDelayMs: params.eventCoalescing.intervalMs,
              })
            : null;

        const deliverToListener = (event: ZCodeAgentServiceEvent): void => {
          if (cancelled) {
            return;
          }
          if (event.type === "session.event") {
            const firstDelivery = rememberBoundedEventId(
              deliveredEventIds,
              deliveredEventIdOrder,
              event.event.eventId,
            );
            if (!firstDelivery) {
              return;
            }
          }
          /**
          Perf: background tasks need sparse summaries; invisible tasks' token/progress
          Wakes renderers at full rate; active subscriptions skip coalescing, staying live.
          */
          if (eventCoalescer) {
            eventCoalescer.accept(event);
            return;
          }
          listener(event);
        };

        const releaseBufferedLiveEvents = (): void => {
          if (subscriptionReady) {
            return;
          }
          subscriptionReady = true;
          const bufferedEvents = pendingLiveEvents.splice(0);
          for (const event of bufferedEvents) {
            deliverToListener(event);
          }
        };

        const subscription = emitter.event((event) => {
          if (cancelled) {
            return;
          }
          if (!subscriptionReady) {
            pendingLiveEvents.push(event);
            return;
          }
          deliverToListener(event);
        });

        const establishSubscription = async (attempt: number): Promise<void> => {
          if (cancelled) {
            return;
          }
          try {
            const client = await getReadOnlyClient(params);
            if (cancelled) {
              return;
            }
            const result = await client.request(
              zcodeProtocolMethods.sessionSubscribe,
              {
                sessionId: params.sessionId,
                deliveryKind: params.deliveryKind,
                afterSeq: params.afterSeq,
                includeSnapshot: params.includeSnapshot ?? false,
              },
              zcodeSessionSubscribeResultSchema,
            );
            if (cancelled) {
              return;
            }
            const replayEvents = result.events
              .map((event) => normalizeSessionEventSeq(params, event))
              .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp);
            // session/subscribe returns this subscriber's replay gap.
            // Never replay into the shared emitter: history would rebroadcast.
            /**             or finished tools reinsert after model output. */
            for (const event of replayEvents) {
              deliverToListener({ type: "session.event", event });
            }
            if (result.snapshot) {
              deliverToListener({
                type: "snapshot",
                snapshot: result.snapshot,
              });
            }
            releaseBufferedLiveEvents();
          } catch (error) {
            if (cancelled) {
              return;
            }
            if (attempt >= SESSION_SUBSCRIBE_MAX_ATTEMPTS - 1) {
              /**               On final failure, warn observably instead of failing silently. */
              console.warn(
                formatLogPrefix("zcode-agent", process.pid),
                "session subscription failed; retries exhausted, giving up",
                {
                  sessionId: params.sessionId,
                  workspaceKey: resolveWorkspaceKey(params),
                  attempts: attempt + 1,
                  message: error instanceof Error ? error.message : String(error),
                },
              );
              /**               After subscription failure stop suppressing live events; without replay authority, restore continuous. */
              releaseBufferedLiveEvents();
              return;
            }
            const delay = Math.min(
              SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** attempt,
              SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS,
            );
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void establishSubscription(attempt + 1);
            }, delay);
          }
        };

        void establishSubscription(0);

        return {
          dispose() {
            cancelled = true;
            if (retryTimer) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            pendingLiveEvents.length = 0;
            eventCoalescer?.dispose();
            subscription.dispose();
          },
        };
      };
    },

    // -- v4 conversation channel: pure pass-through --

    async helloConversationV4() {
      return {
        kind: "hello" as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: v4ConnectionId,
        clientMode: "desktop-continuous" as const,
        deliveryProfile: "continuous" as const,
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none" as const,
          workspaceHookReview: true,
          independentPlanState: true,
          // Same capabilities as the scope hello: in-host direct consumers
          // may also get workflowRun.* (their hello decides).
          workflowRunDeltas: true,
        },
        auth: {},
      };
    },

    async initializeConversationV4(rawClientHello) {
      clientHelloSchema.parse(rawClientHello);
    },

    async setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.connection.flowControlUntrusted");
      const client = await getReadOnlyClient(params);
      await client.request(
        V4_METHODS.connectionFlow,
        { connectionId: trusted.connectionId, state: params.state },
        v4ConnectionFlowResultSchema,
      );
    },

    async subscribeConversationV4(params: ZCodeAgentConversationSubscribeParams) {
      const subscribeStartedAt = performance.now();
      const existingClient = processManager.getExistingClient(params);
      const cliProcessState: "reused" | "spawned" =
        existingClient && !existingClient.isDisposed ? "reused" : "spawned";
      const cliBootstrapStartedAt = performance.now();
      // History topics are read-only on click. Reusing
      /**       execution gates: entries appear but never open; subscription starts CLIs, not writes. */
      const client = await getReadOnlyClient(params);
      const cliBootstrapMs =
        cliProcessState === "spawned"
          ? Math.max(0, Math.round(performance.now() - cliBootstrapStartedAt))
          : undefined;
      // Cold subscribes restore history in-CLI and emit the first frame.
      /**       Pre-overlay registries would resolve the first frame; establish */
      // Account barrier, no execution uplift; worker keeps built-in/personal.
      const providerRegistryStartedAt = performance.now();
      await ensureAccountProviderConfigSynced({
        client,
        reason: "conversation_subscribe",
        workspace: params,
      });
      const providerRegistrySyncMs = Math.max(
        0,
        Math.round(performance.now() - providerRegistryStartedAt),
      );
      const connection = resolveV4Connection(params);
      const topic = conversationTopic(params.sessionId);
      const taskMetaStartedAt = performance.now();
      const resumeThoughtLevel = await automationTaskIndexRepo
        .getTaskMeta({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.sessionId,
        })
        .then((meta) => meta?.thoughtLevel?.trim() || undefined)
        .catch((error) => {
          // Continuous V4 cold subscribes skip the task adapter; legacy rows lack
          // durable selections lose task thought. Index failure still allows resume.
          logger.warn(undefined, "Cold-resume thought hint read failed; subscribing without it", {
            error: error instanceof Error ? error.message : String(error),
            event: "v4.conversation.subscribe.resume_thought_hint_failed",
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return undefined;
        });
      const taskMetaReadMs = Math.max(0, Math.round(performance.now() - taskMetaStartedAt));
      const cliRequestStartedAt = performance.now();
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          // clientMode-family trust bit: injected from the connection hello.
          /**           Absence means legacy whole-key patches clipped to the old set; resubscribe/recovery/phone */
          // relay attachments share this subscribe; covered here.
          ...(connection.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
          // Cold subscribes sent only sessionId; CLI inferred from session.path
          // identity; path.resolve may have rewritten it. Live attachment is truth.
          workspace: buildWorkspaceRef(params),
          ...(resumeThoughtLevel ? { resumeThoughtLevel } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4ConversationSubscribeResultSchema,
      );
      const cliRequestMs = Math.max(0, Math.round(performance.now() - cliRequestStartedAt));
      const hostPrepareMs = Math.max(0, Math.round(cliRequestStartedAt - subscribeStartedAt));
      const openTiming = {
        ...(result.ack.openTiming ? result.ack.openTiming : {}),
        version: 1 as const,
        hostPrepareMs,
        ...(cliBootstrapMs !== undefined ? { cliBootstrapMs } : {}),
        cliProcessState,
        providerRegistrySyncMs,
        taskMetaReadMs,
        cliRequestMs,
      };
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return {
        ...result,
        ack: {
          ...result.ack,
          openTiming,
        },
      };
    },

    async unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "conversation/");
    },

    async resyncConversationV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "conversation/");
    },

    async sendConversationCommandV4(params: ZCodeAgentConversationCommandParams) {
      const client = await getClient(params);
      const planPayload = params.envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      if (
        planPayload.planEnabled ||
        planPayload.config?.planEnabled ||
        planPayload.firstInput?.planEnabled
      ) {
        await ensureIndependentPlanSupport(client);
      }
      // Facades strip caller clientMode; carrier injects host identity
      /**       truth; in-host adapter calls may still pass clientMode. */
      const commandClientMode =
        readTrustedZCodeAgentV4Connection(params)?.clientMode ??
        params.clientMode ??
        "desktop-continuous";
      if (params.envelope.type === "createSession") {
        // V4 draft warmup forwards commands; Account Config gates creation,
        // built-in/personal config is the worker registry's job.
        await ensureAccountProviderConfigSynced({
          client,
          reason: "v4_command_create_session",
          workspace: params,
        });
      }
      let envelope = await buildConversationCommandEnvelope(params);
      // TTFT v1: trusted desktop-local only; phone/remote never enable it.
      if (
        commandClientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      ) {
        const { ttft: _ttft, ...withoutTtft } = envelope;
        envelope = withoutTtft;
      }
      if (envelope.type === "sendText" && envelope.sessionId) {
        const sessionId = envelope.sessionId;
        const payload = {
          ...commandPayloadSchemas.sendText.parse(envelope.payload),
          inputOrigin:
            commandClientMode === "web-remote-replayable"
              ? ("mobile" as const)
              : ("desktop" as const),
        };
        envelope = { ...envelope, payload };
        const browserAmbientContext = await collectBrowserAmbientContext(
          options?.browserControlExecutor,
          {
            sessionId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            clientMode: commandClientMode,
          },
        );
        if (browserAmbientContext) {
          envelope = {
            ...envelope,
            payload: { ...payload, browserAmbientContext },
          };
        }
      }
      const ack: CommandAck = await client.request(V4_METHODS.command, envelope, commandAckSchema);
      // Prompt commands land on committed TurnStarted/ReviewRequested
      // Return on first authority; review never holds host RPC. Default stays.
      // watchdogs; audit deadlines hide serial-queue deadlocks.
      // duplicate proves delivery, not target match.
      /**       A replayed B after the user chose C must not revert derived state via duplicate. */
      return ack;
    },

    async queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.command.queryConnectionUntrusted");
      }
      const query = commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.commandsQuery, query, commandsQueryResultSchema);
    },

    async attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: params.totalBytes,
        totalChunks: params.totalChunks,
        checksum: params.checksum,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentBegin, wireParams);
      return client.request(V4_METHODS.attachmentBegin, wireParams, v4AttachmentBeginResultSchema);
    },

    async attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        chunkIndex: params.chunkIndex,
        dataBase64: params.dataBase64,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentChunk, wireParams);
      return client.request(V4_METHODS.attachmentChunk, wireParams, v4AttachmentChunkResultSchema);
    },

    async attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentCommit, wireParams);
      return client.request(
        V4_METHODS.attachmentCommit,
        wireParams,
        v4AttachmentCommitResultSchema,
      );
    },

    async attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentAbort, wireParams);
      await client.request(V4_METHODS.attachmentAbort, wireParams, v4AttachmentAbortResultSchema);
    },

    async attachmentReadV4(params: ZCodeAgentAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.attachment.readConnectionUntrusted");
      }
      const wireParams = v4AttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.attachmentRead, wireParams, v4AttachmentReadResultSchema);
    },

    async conversationAttachmentReadV4(params: ZCodeAgentConversationAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentRead,
        wireParams,
        v4ConversationAttachmentReadResultSchema,
      );
    },

    async conversationAttachmentStatV4(params: ZCodeAgentConversationAttachmentStatParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentStatParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentStat,
        wireParams,
        v4ConversationAttachmentStatResultSchema,
      );
    },

    async attachmentPreviewSourceV4(params: ZCodeAgentAttachmentPreviewSourceParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.previewSourceConnectionUntrusted");
      if (trusted.clientMode !== "desktop-continuous" || params.remoteSessionId) {
        return { kind: "chunked" } as const;
      }
      const wireParams = v4AttachmentPreviewSourceParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        clientMode: trusted.clientMode,
      });
      const client = await getReadOnlyClient(params);
      const source = await client.request(
        V4_METHODS.attachmentPreviewSource,
        wireParams,
        v4AttachmentPreviewSourceResultSchema,
      );
      if (source.kind !== "local_path") return source;
      if (!options?.authorizeLocalMediaPreviewPath) {
        throw new Error("fault.attachment.previewPathAuthorizationUnavailable");
      }
      return {
        ...source,
        path: await options.authorizeLocalMediaPreviewPath(source.path),
      };
    },

    /**     Row paging: read-only pass-through (resend-safe, stateless). */
    async conversationRowsRangeV4(params: ZCodeAgentConversationRowsRangeParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.conversation.rowsRangeConnectionUntrusted");
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationRowsRange,
        {
          sessionId: params.sessionId,
          clientMode: trusted.clientMode,
          ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
          limit: params.limit,
        },
        v4ConversationRowsRangeResultSchema,
      );
    },

    /**     Read-only plans ride the existing attachment; no new runtime. */
    async conversationPlansV4(params: ZCodeAgentConversationPlansParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationPlans,
        { sessionId: params.sessionId },
        v4ConversationPlansResultSchema,
      );
    },

    // Run journals: read-only pass-through
    // Paging is storage-side; no slicing here;
    /**     RPC-side slicing would load the whole journal per page. */
    async conversationWorkflowRunEventsV4(params: ZCodeAgentConversationWorkflowRunEventsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunEvents,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunEventsResultSchema,
      );
    },

    // Run enum: journal-backed rediscovery (projections die cross-process).
    async conversationWorkflowRunsV4(params: ZCodeAgentConversationWorkflowRunsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRuns,
        {
          sessionId: params.sessionId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunsResultSchema,
      );
    },

    // dwf user-artifact reads (three).
    // artifact = user-facing output, not the run's return.
    // plans-family: read-only, stateless, resend-safe.
    async conversationWorkflowRunArtifactsV4(
      params: ZCodeAgentConversationWorkflowRunArtifactsParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifacts,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunArtifactsResultSchema,
      );
    },

    /**
    Board feeds: the gateway owns limit defaults/clamps; pass through (each side clamps once),
    One limit, eventually two page sizes.
    */
    async conversationWorkflowRunArtifactDataV4(
      params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactData,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunArtifactDataResultSchema,
      );
    },

    // one chunk (512KiB); hooks assemble. CLI authorizes:
    /**     The id only addresses journal rows, never paths. */
    async conversationWorkflowRunArtifactReadV4(
      params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactRead,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          version: params.version,
          offset: params.offset,
          limit: params.limit,
        },
        v4ConversationWorkflowRunArtifactReadResultSchema,
      );
    },

    // dwf transcript reads (two). Family:
    /**     Read-only, stateless, resend-safe via the read-only client; maxBytes clamps at the gateway. */
    async conversationWorkflowRunWorkspaceV4(
      params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunWorkspace,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunWorkspaceResultSchema,
      );
    },

    async conversationWorkflowRunNodeResultV4(
      params: ZCodeAgentConversationWorkflowRunNodeResultParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunNodeResult,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          siteId: params.siteId,
          ordinal: params.ordinal,
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        },
        v4ConversationWorkflowRunNodeResultResultSchema,
      );
    },

    async backgroundBashOutputV4(params: ZCodeAgentBackgroundBashOutputParams) {
      if (!readTrustedZCodeAgentV4Connection(params))
        throw new Error("fault.bashOutput.connectionUntrusted");
      const wireParams = v4BackgroundBashOutputParamsSchema.parse({
        sessionId: params.sessionId,
        workId: params.workId,
      });
      try {
        const client = await getReadOnlyClient(params, "existing-only");
        return await client.request(
          V4_METHODS.backgroundBashOutput,
          wireParams,
          backgroundBashOutputResultSchema,
        );
      } catch (error) {
        if (isProtocolMethodNotFoundError(error))
          return { kind: "unsupported", workId: params.workId };
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          return { kind: "unavailable", workId: params.workId };
        }
        throw error;
      }
    },

    async conversationFileChangesV4(params: ZCodeAgentConversationFileChangesParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileChanges,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileChangesResultSchema,
      );
    },

    async conversationFileRewindPreviewV4(params: ZCodeAgentConversationFileRewindPreviewParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileRewindPreview,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileRewindPreviewResultSchema,
      );
    },

    onDynamicConversationFrame(params: ZCodeAgentWorkspaceTarget) {
      return getConversationFrameEmitter(params).event;
    },

    onDynamicLocalTtftFacts(params: ZCodeAgentWorkspaceTarget) {
      return (listener: (facts: LocalTtftFacts) => void) =>
        localTtftFactsEmitter.event((event) => {
          if (event.workspaceKey === resolveWorkspaceKey(params)) listener(event.facts);
        });
    },
    onDynamicConversationTelemetryFact(params: ZCodeAgentWorkspaceTarget) {
      return getConversationTelemetryFactEmitter(params).event;
    },

    onDynamicCuaPermissionObservation() {
      return cuaPermissionObservationEmitter.event;
    },

    // -- sessions-index channel: reuses conversationSubscribe,
    /**     prefixed dispatch happens CLI-side -- */

    async subscribeSessionsIndexV4(params: ZCodeAgentSessionsIndexSubscribeParams) {
      // sidebars register every restored workspace; spawning subscribers
      // workspaces multiply into CLIs; existing-only stays dormant.
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = sessionsIndexTopic(resolveWorkspaceKey(params));
      // 3.3.6 rows lack remote workspace_id; same-version indexes
      /**
      already isolated by identity. Upgrades must prove ownership with the taskId under the current key;
      Never pass workspacePath alone: same-path SSH/WSL authorities would steal history.
      */
      let legacyTaskIds: string[] = [];
      if (supportsLegacyRemoteTaskAllowlist(params.workspaceIdentity)) {
        try {
          legacyTaskIds = (
            await automationTaskIndexRepo.listTaskMetas({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              provider: "glm",
            })
          )
            .slice(0, MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE)
            .map((task) => task.taskId);
        } catch (error) {
          /**           Ownership proofs serve migration only; with the index down, complete */
          // identity (3.4) query strictly; compat failures never kill lists.
          logger.warn(
            undefined,
            "Remote task ownership proof read failed; strict-identity subscribe continues",
            {
              error: error instanceof Error ? error.message : String(error),
              event: "sessions_index.legacy_remote_allowlist_read_failed",
              workspaceIdentity: params.workspaceIdentity,
              workspacePath: params.workspacePath,
            },
          );
        }
      }
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(legacyTaskIds.length > 0 ? { legacyTaskIds } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4SessionsIndexSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "sessions-index/");
    },

    async resyncSessionsIndexV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "sessions-index/");
    },

    onDynamicSessionsIndexFrame(params: ZCodeAgentWorkspaceTarget) {
      return getSessionsIndexFrameEmitter(params).event;
    },

    // -- workspace-config channel: reuses conversationSubscribe,
    // prefix-dispatched CLI-side --

    async subscribeWorkspaceConfigV4(params: ZCodeAgentWorkspaceConfigSubscribeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = workspaceConfigTopic(resolveWorkspaceKey(params));
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4WorkspaceConfigSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "workspace-config/");
    },

    async resyncWorkspaceConfigV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "workspace-config/");
    },

    onDynamicWorkspaceConfigFrame(params: ZCodeAgentWorkspaceTarget) {
      return getWorkspaceConfigFrameEmitter(params).event;
    },

    onDynamicProcessResourceSample() {
      return processResourceSampleEmitter.event;
    },

    onDynamicToolExecResource() {
      return toolExecResourceEmitter.event;
    },
    onDynamicMcpResourceSamples() {
      return mcpResourceSamplesEmitter.event;
    },

    onDynamicMcpTelemetry() {
      return mcpTelemetryEmitter.event;
    },

    /**     CLI re-subscribe: generations surface via the manager; v4 subscribers (task-index */
    // syncers must re-subscribe: subscriptions die with the process.
    onAgentRuntimeRestarted(listener) {
      return processManager.onRuntimeRestarted(listener);
    },

    onAgentRuntimeLifecycle(listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) {
      return processManager.onRuntimeLifecycle(listener);
    },

    async disposeWorkspace(params): Promise<void> {
      const workspaceKey = resolveWorkspaceKey(params);
      // Release stops the process and invalidates queued continuations;
      /**       Else it respawns the workspace's agent after dispose. */
      cancelWaitingWorkspaceStartup(workspaceKey);
      clearV4SubscriptionRoutes(workspaceKey);
      cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      if (active) {
        invalidateWorkspaceClient(workspaceKey, active.client);
      } else {
        interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
      }
      /**       restartWorkspaceProcess uses this as invalidation, not */
      // workspace teardown; killing emitters strands UI/task-index
      // listeners would bind to dead objects; emitters die with dispose paths.
      await processManager.disposeWorkspace(params);
    },

    disposeAll(): void {
      processManager.disposeAll();
      pluginProcessManager.disposeAll();
      mcpStatusProcessManager.disposeAll();
      // automation repos hold tasks-index handles
      /**       handles must close on dispose or Windows rm hits EBUSY */
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },

    async disposeAllAndWait(): Promise<void> {
      await Promise.all([
        processManager.disposeAllAndWait(),
        pluginProcessManager.disposeAllAndWait(),
        mcpStatusProcessManager.disposeAllAndWait(),
      ]);
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },
  };
}
