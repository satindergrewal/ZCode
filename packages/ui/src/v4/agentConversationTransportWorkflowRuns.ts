// The workflow-run query surface of createAgentConversationTransport. Split reason: the main file is bound to
// eslint max-lines(400) and the main file plus this increment would exceed it,
// so the two read-only dwf journal queries move here along query-surface boundaries (closure deps passed explicitly; behavior unchanged).
import type { IZCodeAgentService } from "@zcode/services";
import type {
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";

export function createWorkflowRunTransportMethods(input: {
  agentService: Pick<
    IZCodeAgentService,
    | "conversationWorkflowRunEventsV4"
    | "conversationWorkflowRunsV4"
    | "conversationWorkflowRunArtifactsV4"
    | "conversationWorkflowRunArtifactDataV4"
    | "conversationWorkflowRunArtifactReadV4"
    | "conversationWorkflowRunWorkspaceV4"
    | "conversationWorkflowRunNodeResultV4"
  >;
  ensureHandshake: () => Promise<unknown>;
  workspace: { workspacePath: string; workspaceIdentity?: string };
}) {
  const { agentService, ensureHandshake, workspace } = input;
  return {
    async workflowRunEvents(
      params: V4ConversationWorkflowRunEventsParams,
    ): Promise<V4ConversationWorkflowRunEventsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunEventsV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    async workflowRuns(
      params: V4ConversationWorkflowRunsParams,
    ): Promise<V4ConversationWorkflowRunsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunsV4({
        ...workspace,
        sessionId: params.sessionId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    // The three read surfaces of dwf user-facing artifacts.
    // Terminology: an artifact is output published to the user by the script, not the run top-level return.
    async workflowRunArtifacts(
      params: V4ConversationWorkflowRunArtifactsParams,
    ): Promise<V4ConversationWorkflowRunArtifactsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactsV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
      });
    },
    async workflowRunArtifactData(
      params: V4ConversationWorkflowRunArtifactDataParams,
    ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactDataV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    async workflowRunArtifactRead(
      params: V4ConversationWorkflowRunArtifactReadParams,
    ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactReadV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        version: params.version,
        offset: params.offset,
        limit: params.limit,
      });
    },
    // The two read surfaces of the dwf script transcript.
    async workflowRunWorkspace(
      params: V4ConversationWorkflowRunWorkspaceParams,
    ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunWorkspaceV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
      });
    },
    async workflowRunNodeResult(
      params: V4ConversationWorkflowRunNodeResultParams,
    ): Promise<V4ConversationWorkflowRunNodeResultResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunNodeResultV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        siteId: params.siteId,
        ordinal: params.ordinal,
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      });
    },
  };
}
