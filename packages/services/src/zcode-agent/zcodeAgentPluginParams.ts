import type {
  ModelSelection,
  ZCodeAgentMcpServer,
  ZCodeAutomationScheduleRule,
  ZCodeMcpListMode,
} from "@zcode/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";

export interface ZCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Runtime session identity of a remote workspace; for isolation/routing only, never a path. */
  remoteSessionId?: string;
}

export interface ZCodeAgentPluginViewParams extends ZCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface ZCodeAgentListMcpServerStatusesParams extends ZCodeAgentWorkspaceTarget {
  mcpServers?: ZCodeAgentMcpServer[];
  mode?: ZCodeMcpListMode;
}

export interface ZCodeAgentAddPluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface ZCodeAgentRemovePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface ZCodeAgentUpdatePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface ZCodeAgentInstallPluginParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface ZCodeAgentUninstallPluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface ZCodeAgentUpdatePluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface ZCodeAgentRestoreBuiltinPluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface ZCodeAgentConfigurePluginParams extends ZCodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentResetPluginConfigParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentValidatePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface ZCodeAgentDescribePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface ZCodeAgentSetPluginEnabledParams extends ZCodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin conversation-reference catalog:
// with sessionId -> session-owned frozen catalog (route to the workspace client holding it);
// without -> the workspace current catalog (new-draft picker).
export interface ZCodeAgentPluginReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer skill catalog: same split by sessionId between workspace dir and resident session
// runtime snapshot; never part of the settings management dirs.
export interface ZCodeAgentSkillReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

/** Plugin UI: UI-initiated ui:// resource reads. */
export interface ZCodeAgentReadMcpResourceParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  uri: string;
}

/** Plugin-UI resources/read; same shape as readMcpResource, results capped at 8 MiB and mime-allow-listed. */
export type ZCodeAgentReadMcpResourceForUiParams = ZCodeAgentReadMcpResourceParams;

/** Plugin UI: UI invokes this plugin's tool; no approval flow, attribution resolved fail-closed by the agent catalog. */
export interface ZCodeAgentCallMcpToolForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Host-generated call id, paired with cancelMcpToolCallForUi. */
  callId: string;
}
/** Plugin-UI resources/list, resources/templates/list, subscribe, and unsubscribe. */
export interface ZCodeAgentListMcpResourcesForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  cursor?: string;
}
/** App-Provided Tools: instance identity = session + sandbox scope + generation. */
export interface ZCodeAgentAppToolInstanceForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
}
export interface ZCodeAgentRegisterAppToolsForUiParams extends ZCodeAgentAppToolInstanceForUiParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface ZCodeAgentAppToolCallForUiParams extends ZCodeAgentAppToolInstanceForUiParams {
  callId: string;
}
export interface ZCodeAgentResolveAppToolCallForUiParams extends ZCodeAgentAppToolCallForUiParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface ZCodeAgentMcpResourceSubscriptionForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
  uri: string;
}
export interface ZCodeAgentCancelMcpToolCallForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  callId: string;
}
export interface ZCodeAgentResolveSuggestedPluginReferenceParams extends ZCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- Automation management params ----

export interface ZCodeAgentCreateAutomationParams extends ZCodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
}

export interface ZCodeAgentUpdateAutomationParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface ZCodeAgentAutomationIdParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface ZCodeAgentSetAutomationEnabledParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface ZCodeAgentDeleteAutomationRunParams extends ZCodeAgentWorkspaceTarget {
  runId: string;
}
