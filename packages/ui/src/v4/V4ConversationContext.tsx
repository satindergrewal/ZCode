import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import type {
  CommandAck,
  CommandEnvelope,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";
import { ConversationTelemetryPaneAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

export interface V4ConversationContextValue {
  layer: SessionDataLayer;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** Workflow run event-log pagination (details-page audit surface); read-only, stateless, safe to re-send on timeout. */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** Workflow run enumeration (journal-backed rediscovery surface after restart). */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * User-facing artifacts of a workflow run (the durable read for cold recovery). Terminology: an artifact is output
   * published to the user by the script via `artifact.*`, not the run's top-level return value.
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** Preset dashboard entry pagination (cursor = journal sequence). */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** Content artifact bytes, one chunk at a time (<= 512 KiB); the caller's hook reassembles. */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** Listings of dwf script transcripts (files.* / git.* / world.run lines, no bodies). */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** Bounded body of a single workspace node (fetched on expand). */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /** High-level UI put semantics; the transport internally only speaks begin/chunk/commit/abort. */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): ReturnType<ConversationTransport["attachmentRead"]>;
  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]>;
  onRuntimeRestart(listener: () => void): () => void;
  /**
   * Present only when the transport exposes runtime liveness (see ConversationTransport.onRuntimeLifecycle).
   * unavailable arrives during workspace dispose and is the only generation-change signal draft prewarm can rely on.
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

// Export the context object itself: the static replay view assembles the value with a static transport
// and injects it via Provider directly, bypassing the V4ConversationProvider workspace resolution chain.
export const V4ConversationContext = createContext<V4ConversationContextValue | null>(null);

export interface V4ConversationProviderProps {
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
}

function ReadyV4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
  services,
  remoteSessionId,
}: V4ConversationProviderProps & {
  services: IServiceAccessor;
  remoteSessionId: string | null;
}) {
  const { zcodeAgentService } = services;
  const platform = usePlatform();
  const bundle = useMemo(() => {
    const transport = createAgentConversationTransport(zcodeAgentService, {
      workspacePath,
      workspaceIdentity,
      // The primary workspace resolver already recognized the remote endpoint, but this path used to drop
      // remoteSessionId, handing remote absolute paths to local zcode-media. Only local endpoints inject the converter.
      ...(remoteSessionId === null && platform.createLocalMediaPreviewUrl
        ? { createLocalMediaPreviewUrl: platform.createLocalMediaPreviewUrl }
        : {}),
    });
    const layer = new SessionDataLayer({ transport });
    return {
      layer,
      sendCommand: (envelope: CommandEnvelope) => transport.sendCommand(envelope),
      fileChanges: (params: V4ConversationFileChangesParams) => transport.fileChanges(params),
      fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
        transport.fileRewindPreview(params),
      workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
        transport.workflowRunEvents(params),
      workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
        transport.workflowRunArtifacts(params),
      workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
        transport.workflowRunArtifactData(params),
      workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
        transport.workflowRunArtifactRead(params),
      workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
        transport.workflowRunWorkspace(params),
      workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
        transport.workflowRunNodeResult(params),
      workflowRuns: (params: V4ConversationWorkflowRunsParams) => transport.workflowRuns(params),
      attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
        transport.attachmentPut(params, options),
      attachmentRead: (params) => transport.attachmentRead(params),
      attachmentReadRange: (params) => transport.attachmentReadRange(params),
      onRuntimeRestart: (listener: () => void) => transport.onRuntimeRestart(listener),
      ...(transport.onRuntimeLifecycle
        ? {
            onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
              transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
          }
        : {}),
    } satisfies V4ConversationContextValue;
  }, [
    platform.createLocalMediaPreviewUrl,
    remoteSessionId,
    workspacePath,
    workspaceIdentity,
    zcodeAgentService,
  ]);

  useEffect(() => {
    return () => {
      bundle.layer.dispose();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <V4ConversationContext.Provider value={bundle}>{children}</V4ConversationContext.Provider>
    </ServiceProvider>
  );
}

/** One host connection + one SessionDataLayer per workspace. */
export function V4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
}: V4ConversationProviderProps) {
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  if (!resolution.rpcReady) {
    return null;
  }

  return (
    <ReadyV4ConversationProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      services={resolution.services}
      remoteSessionId={resolution.remoteSessionId}
    >
      {children}
    </ReadyV4ConversationProvider>
  );
}

export function useV4Conversation(): V4ConversationContextValue {
  const ctx = useContext(V4ConversationContext);
  if (!ctx) {
    throw new Error("useV4Conversation must be used within V4ConversationProvider");
  }
  return ctx;
}

/**
 * Whether a session context is available. Lets components that MAY render without a session (static render, replay,
 * completion cards inside transcripts) decide whether to mount the data layer - mounting requires context; otherwise render cold.
 */
export function useHasV4Conversation(): boolean {
  return useContext(V4ConversationContext) !== null;
}

export interface V4PaneConversationProviderProps {
  /** pane 绑定的 primary workspace（连接路由键，docs/v4-split-pane-workbench.md）。 */
  scope: PaneWorkspaceScope;
  children: ReactNode;
}

/**
 * Per-pane data plane: the connection is leased from workspaceConnectionRegistry (panes on
 * the same endpoint+workspaceKey share one transport + SessionDataLayer, refcount + 30s
 * keep-warm), and the pane's own services are injected downward - attachment upload,
 * sessions-index guards, etc. use the pane accessor, never the shell's current workspace.
 *
 * 远程目标在 session store 尚未注册真实 services 时保持 remote-waiting，不挂载子数据层，
 * 因而不会拿断连代理创建连接或发起订阅；同时绝不回落 base services，也不为 pane
 * 另起独立 runtime（远控保护约束）。重连 ready 后 services 换新引用 → 注册表保持
 * 原 layer/transport 身份，并在 commit 阶段单向激活最新 proxy。
 */
export function V4PaneConversationProvider({ scope, children }: V4PaneConversationProviderProps) {
  const targetResolution = useWorkspaceServicesResolution(
    scope.workspacePath,
    scope.remoteSessionId ?? null,
    scope.workspaceIdentity ?? null,
  );
  const resolvedScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(targetResolution.remoteSessionId
        ? { remoteSessionId: targetResolution.remoteSessionId }
        : {}),
    }),
    [scope.workspaceIdentity, scope.workspacePath, targetResolution.remoteSessionId],
  );
  if (!targetResolution.rpcReady) {
    return null;
  }

  // A recovering remote pane may only have workspaceIdentity. If the resolver has not produced the real
  // remoteSessionId yet and we still pass the original scope to the registry, it builds one data layer per
  // __base__ and per remote endpoint; the final state may land in a non-visible store. Once ready, always use the resolved scope.
  return (
    <ReadyV4PaneConversationProvider scope={resolvedScope} services={targetResolution.services}>
      {children}
    </ReadyV4PaneConversationProvider>
  );
}

function ReadyV4PaneConversationProvider({
  scope,
  services,
  children,
}: Pick<V4PaneConversationProviderProps, "scope" | "children"> & {
  services: IServiceAccessor;
}) {
  const agentService = services.zcodeAgentService;
  const platform = usePlatform();

  // Same useMemo-based connection pattern as V4ConversationProvider (the renderer has no StrictMode,
  // so no double memo invoke); on dep change, acquire the new lease before the effect cleanup releases the old one -
  // for the same key refCount never reaches zero, and keep-warm absorbs flapping across keys.
  const bundle = useMemo(() => {
    const lease = acquireWorkspaceConnection(
      {
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
      },
      agentService,
      scope.remoteSessionId ? undefined : platform.createLocalMediaPreviewUrl,
    );
    return {
      lease,
      value: {
        layer: lease.layer,
        sendCommand: (envelope: CommandEnvelope) => lease.transport.sendCommand(envelope),
        fileChanges: (params: V4ConversationFileChangesParams) =>
          lease.transport.fileChanges(params),
        fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
          lease.transport.fileRewindPreview(params),
        workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
          lease.transport.workflowRunEvents(params),
        workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
          lease.transport.workflowRunArtifacts(params),
        workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
          lease.transport.workflowRunArtifactData(params),
        workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
          lease.transport.workflowRunArtifactRead(params),
        workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
          lease.transport.workflowRunWorkspace(params),
        workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
          lease.transport.workflowRunNodeResult(params),
        workflowRuns: (params: V4ConversationWorkflowRunsParams) =>
          lease.transport.workflowRuns(params),
        attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
          lease.transport.attachmentPut(params, options),
        attachmentRead: (params) => lease.transport.attachmentRead(params),
        attachmentReadRange: (params) => lease.transport.attachmentReadRange(params),
        onRuntimeRestart: (listener: () => void) => lease.transport.onRuntimeRestart(listener),
        ...(lease.transport.onRuntimeLifecycle
          ? {
              onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
                lease.transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
            }
          : {}),
      } satisfies V4ConversationContextValue,
    };
  }, [
    agentService,
    platform.createLocalMediaPreviewUrl,
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.remoteSessionId,
  ]);

  useLayoutEffect(() => {
    // acquire happens during render and only stabilizes the lease; store updates and re-subscriptions caused
    // by remote proxy generation changes must wait for commit, avoiding synchronous updates to the live pane while rendering.
    bundle.lease.activateRemoteService();
  }, [bundle]);

  useEffect(() => {
    return () => {
      bundle.lease.release();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <ConversationTelemetryPaneAttachment services={services} scope={scope}>
        <V4ConversationContext.Provider value={bundle.value}>
          {children}
        </V4ConversationContext.Provider>
      </ConversationTelemetryPaneAttachment>
    </ServiceProvider>
  );
}
