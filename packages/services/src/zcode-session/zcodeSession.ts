import { ServiceChannels } from "@zcode/shared";
import type {
  TraceId,
  ZCodeAgentMcpServer,
  ZCodeDeliveryKind,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodePermissionRequestParams,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
  ZCodeSessionInfo,
  ZCodeSessionImportHistory,
  ZCodeSessionEvent,
  ZCodeSessionMode,
  ZCodeSessionPersistence,
  ZCodeSessionStateSnapshot,
  ZCodeStateUpdatedNotification,
  ZCodeWorkspacePresentation,
} from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { ProviderRuntimeHeadersUiResponse } from "#src/zcode-agent/zcodeAgent.js";

export interface ZCodeSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type ZCodeSessionReadWorkspacePresentationParams = ZCodeSessionWorkspaceTarget;

export interface ZCodeTaskTarget extends ZCodeSessionWorkspaceTarget {
  sessionId: string;
}

export interface ZCodeSessionCreateParams extends ZCodeSessionWorkspaceTarget {
  //* Preallocated id for import transactions only; normal sessions keep agent-assigned ids. */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZCodeSessionMode;
  model?: ModelSelection;
  persistence?: ZCodeSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  importedHistory?: ZCodeSessionImportHistory;
}

export interface ZCodeSessionResumeParams extends ZCodeTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  /**
   * Broadcast the resumed history snapshot by default and let shadow subscribers request an initial snapshot.
   * Pre-resume before a follow-up send disables it so a stale terminal snapshot cannot cover local in-flight state.
   */
  broadcastSnapshot?: boolean;
}

export interface ZCodeSessionListParams extends ZCodeSessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface ZCodeSessionReadParams extends ZCodeTaskTarget {
  deliveryKind?: ZCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface ZCodeSessionMessagesParams extends ZCodeTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZCodeSessionEventsParams extends ZCodeTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface ZCodeSessionSetModelParams extends ZCodeTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeSessionSetThoughtLevelParams extends ZCodeTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeSessionSetModeParams extends ZCodeTaskTarget {
  mode: ZCodeSessionMode;
  expectedRevision?: number;
}

export interface ZCodeSessionRespondProviderRuntimeHeadersParams extends ZCodeTaskTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface ZCodeSessionSubscribeParams extends ZCodeTaskTarget {
  deliveryKind: ZCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type ZCodeSessionServiceEvent =
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

export interface ZCodeSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZCodeSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface IZCodeSessionService {
  initializeWorkspace(params: ZCodeSessionWorkspaceTarget): Promise<ZCodeSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: ZCodeSessionWorkspaceTarget,
  ): Promise<ZCodeSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: ZCodeSessionReadWorkspacePresentationParams,
  ): Promise<ZCodeWorkspacePresentation>;
  createSession(params: ZCodeSessionCreateParams): Promise<ZCodeSessionStateSnapshot>;
  resumeSession(params: ZCodeSessionResumeParams): Promise<ZCodeSessionStateSnapshot>;
  listSessions(params: ZCodeSessionListParams): Promise<ZCodeSessionInfo[]>;
  readSession(params: ZCodeSessionReadParams): Promise<ZCodeSessionStateSnapshot>;
  readSessionMessages(params: ZCodeSessionMessagesParams): Promise<ZCodeMessageWithParts[]>;
  readSessionEvents(params: ZCodeSessionEventsParams): Promise<ZCodeSessionEvent[]>;
  promoteDeferredDraftSession(params: ZCodeTaskTarget): Promise<void>;
  closeSession(params: ZCodeTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: ZCodeTaskTarget): Promise<boolean>;
  setModel(params: ZCodeSessionSetModelParams): Promise<ZCodeSessionStateSnapshot>;
  setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams): Promise<ZCodeSessionStateSnapshot>;
  setMode(params: ZCodeSessionSetModeParams): Promise<ZCodeSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: ZCodeSessionRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  // M5 deletion wave 2: onDynamicSessionEvent (the legacy session/subscribe renderer surface)
  // is gone; the v4 UI consumes agentService conversation/sessions-index frames and
  // zero renderer callers remain (grep over packages/ui and packages/desktop).
}

export const IZCodeSessionService = createServiceDescriptor<IZCodeSessionService>(
  ServiceChannels.ZCodeSession,
);
