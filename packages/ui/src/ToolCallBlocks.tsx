import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { TID_CHAT_TOOL_CALL_BLOCK, testId } from "@zcode/shared";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { mapToolStatus } from "@/lib/mapToolStatus.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  getCompactToolCallStatusMessageId,
  isCompactToolCallRunningState,
} from "@/lib/toolCallSummary.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import * as PluginUi from "@/plugin-ui/index.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";

const NESTED_TOOLCALL_CONTAINER_CLASS =
  "ml-2 space-y-2 border-border border-l pl-3.5 border-border";
const MAX_TOOL_ENTRANCE_ANIMATION_KEYS = 800;
const TOOL_ENTRANCE_ANIMATION_CLEANUP_MS = 1000;
const toolEntranceAnimationKeys = new Map<string, number>();

function pruneToolEntranceAnimationKeys() {
  if (toolEntranceAnimationKeys.size <= MAX_TOOL_ENTRANCE_ANIMATION_KEYS) {
    return;
  }

  const staleKeys = Array.from(toolEntranceAnimationKeys.entries())
    .sort(([, left], [, right]) => left - right)
    .slice(0, toolEntranceAnimationKeys.size - MAX_TOOL_ENTRANCE_ANIMATION_KEYS)
    .map(([key]) => key);

  for (const key of staleKeys) {
    toolEntranceAnimationKeys.delete(key);
  }
}

function normalizeToolEntranceAnimationKey(key: string) {
  const normalizedKey = key.trim();
  return normalizedKey.length > 0 ? normalizedKey : null;
}

function hasPlayedToolEntranceAnimation(key: string) {
  const normalizedKey = normalizeToolEntranceAnimationKey(key);
  return normalizedKey === null || toolEntranceAnimationKeys.has(normalizedKey);
}

function recordToolEntranceAnimation(key: string) {
  const normalizedKey = normalizeToolEntranceAnimationKey(key);
  if (normalizedKey === null) {
    return;
  }

  toolEntranceAnimationKeys.set(normalizedKey, Date.now());
  pruneToolEntranceAnimationKeys();
}

function canPlayToolEntranceAnimation(key: string, active: boolean) {
  return active && !hasPlayedToolEntranceAnimation(key);
}

export function isAgentToolCall(toolCall: TaskChatToolCallTreeNode["toolCall"]): boolean {
  return resolveToolCallIdentity(toolCall).family === "agent";
}

function ToolCallBlockComponent({
  toolCallNode,
  depth = 0,
  workspacePath,
  theme,
  codePreviewSettings,
  showIcon = true,
  cuaAppIconClassName,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenPlanDetail,
  pluginUi: providedPluginUi,
  onOpenWorkflowRun,
  onResumeWorkflowRun,
  onOpenWorkflowActor,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  workflowRun,
  workflowDraft,
  onLoadFullToolCallFields,
  suppressSourceLabel = false,
  showTodoToolCalls = true,
  disableSummaryContentAnimation = false,
  animateDiffCountOnMount = false,
  agentSummaryAction,
  authoritativeAgentType,
  streamingEntranceActive = false,
  streamingEntranceKeyPrefix = "tool",
  cuaGroupEvents,
  renderCuaAssistantMessage,
  renderCuaReasoning,
}: {
  toolCallNode: TaskChatToolCallTreeNode;
  depth?: number;
  workspacePath: string;
  /** App theme (store decoupling): host-provided (v4 SessionPane and friends); falls back to "system". */
  theme?: ToolCallBlockRenderContext["theme"];
  /** Code preview preferences (store decoupling): host-provided with a stable reference. */
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  showIcon?: boolean;
  cuaAppIconClassName?: ToolCallBlockRenderContext["cuaAppIconClassName"];
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: (automationId?: string) => void;
  onOpenPlanDetail?: ToolCallBlockRenderContext["onOpenPlanDetail"];
  pluginUi?: ToolCallBlockRenderContext["pluginUi"];
  onOpenWorkflowRun?: ToolCallBlockRenderContext["onOpenWorkflowRun"];
  /** Card footer Resume; like workflowRun, not passed to child tool cards. */
  onResumeWorkflowRun?: ToolCallBlockRenderContext["onResumeWorkflowRun"];
  /** Pills to subagent transcript; likewise not passed to child tool cards. */
  onOpenWorkflowActor?: ToolCallBlockRenderContext["onOpenWorkflowActor"];
  /** Script pill to script transcript; likewise not passed to child tool cards. */
  onOpenWorkflowWorkspace?: ToolCallBlockRenderContext["onOpenWorkflowWorkspace"];
  /** Artifact pill to artifact tab; likewise not passed to child tool cards. */
  onOpenWorkflowArtifact?: ToolCallBlockRenderContext["onOpenWorkflowArtifact"];
  /**
   * The workflow run summary this tool call joined to (the host resolves it from the workflowRuns projection by toolCallId).
   * Deliberately **not** passed to child tool cards: the summary joins by toolCallId; handing the parent's run summary to
   * a child with a different toolCallId would paint someone else's run state.
   */
  workflowRun?: ToolCallBlockRenderContext["workflowRun"];
  /** Compile-feedback draft position (the host joins it from the row window by toolCallId); like workflowRun, not passed to child cards. */
  workflowDraft?: ToolCallBlockRenderContext["workflowDraft"];
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
  suppressSourceLabel?: boolean;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  animateDiffCountOnMount?: boolean;
  agentSummaryAction?: ToolCallBlockRenderContext["agentSummaryAction"];
  authoritativeAgentType?: ToolCallBlockRenderContext["authoritativeAgentType"];
  streamingEntranceActive?: boolean;
  streamingEntranceKeyPrefix?: string;
  cuaGroupEvents?: readonly ConversationCuaGroupEvent[];
  renderCuaAssistantMessage?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>,
  ) => ReactNode;
  renderCuaReasoning?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>,
  ) => ReactNode;
}) {
  const inheritedPluginUi = PluginUi.usePluginUiToolBinding(toolCallNode.toolCall.toolId);
  const pluginUi = providedPluginUi ?? inheritedPluginUi;
  const { toolCall, childToolCalls } = toolCallNode;
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const toolEntranceAnimationKey = `${streamingEntranceKeyPrefix}:${toolCall.toolId}`;
  // Without a fade-in, a tool appearing mid-stream would break the surrounding text's entrance rhythm.
  // Track already-shown tools by toolId; no replay on task switch or virtual-list remount.
  // The record write is deferred into an effect so React dev remounts do not swallow the first animation.
  const [shouldPlayEntranceAnimation, setShouldPlayEntranceAnimation] = useState(() =>
    canPlayToolEntranceAnimation(toolEntranceAnimationKey, streamingEntranceActive),
  );
  useEffect(() => {
    if (!streamingEntranceActive || shouldPlayEntranceAnimation) {
      return;
    }

    if (canPlayToolEntranceAnimation(toolEntranceAnimationKey, streamingEntranceActive)) {
      setShouldPlayEntranceAnimation(true);
    }
  }, [shouldPlayEntranceAnimation, streamingEntranceActive, toolEntranceAnimationKey]);

  useEffect(() => {
    if (!shouldPlayEntranceAnimation) {
      return;
    }

    const markAnimatedTimer = window.setTimeout(() => {
      recordToolEntranceAnimation(toolEntranceAnimationKey);
    }, 0);
    const cleanupTimer = window.setTimeout(() => {
      setShouldPlayEntranceAnimation(false);
    }, TOOL_ENTRANCE_ANIMATION_CLEANUP_MS);

    return () => {
      window.clearTimeout(markAnimatedTimer);
      window.clearTimeout(cleanupTimer);
    };
  }, [shouldPlayEntranceAnimation, toolEntranceAnimationKey]);
  // Note: the early return below must come after every hook call.
  // It used to `return null` before a useMemo; when a toolCall's
  // family flipped between todo and non-todo (or showTodoToolCalls changed),
  // this render ran a different number of hooks than the previous one and React threw
  // "Rendered fewer hooks than expected", white-screening the whole chat page.
  // Fix: keep the early return below all hooks so the hook order stays stable.
  const identity = resolveToolCallIdentity(toolCall);
  const toolState = mapToolStatus(toolCall.status);
  const displayModel = useMemo(
    () => buildToolDisplayModel(toolCall, workspacePath),
    [toolCall, workspacePath],
  );
  const rawFileSummaries = useMemo(
    () =>
      readRawToolCallFileSummaries(toolCall.raw, {
        toolName: toolCall.toolName,
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [
      toolCall.input,
      toolCall.kind,
      toolCall.output,
      toolCall.raw,
      toolCall.title,
      toolCall.toolName,
    ],
  );
  const isRunning = isCompactToolCallRunningState(toolState);
  const statusLabel = intl.formatMessage({
    id: getCompactToolCallStatusMessageId(toolState, toolCall.status),
  });
  const errorText = getToolCallErrorText(toolCall);
  const isCurrentAgentToolCall = isAgentToolCall(toolCall);
  const isSubAgentToolCall = !isCurrentAgentToolCall && (depth > 0 || toolCall.parentToolUseId);
  const sourceLabel =
    !suppressSourceLabel && isSubAgentToolCall
      ? intl.formatMessage({ id: "chat.toolCall.source.subAgent" })
      : undefined;
  // An earlier "avoid double preview" change nulled onOpenCodeViewer globally,
  // stripping edit/read file summaries of click-through -- visible file name, not clickable.
  // Pass it through again to keep the historic behavior; double-preview avoidance belongs behind a finer-grained toggle, not a blanket kill.
  const toolPreviewCodeViewer: ToolCallBlockRenderContext["onOpenCodeViewer"] = onOpenCodeViewer;

  const childToolList = useMemo(
    () =>
      childToolCalls.length > 0 ? (
        <div className={NESTED_TOOLCALL_CONTAINER_CLASS}>
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              depth={depth + 1}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              showIcon={showIcon}
              onOpenCodeViewer={toolPreviewCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenAutomationsMain={onOpenAutomationsMain}
              onOpenPlanDetail={onOpenPlanDetail}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onLoadFullToolCallFields={onLoadFullToolCallFields}
              suppressSourceLabel={suppressSourceLabel}
              showTodoToolCalls={showTodoToolCalls}
              disableSummaryContentAnimation={disableSummaryContentAnimation}
              animateDiffCountOnMount={animateDiffCountOnMount}
              streamingEntranceActive={streamingEntranceActive}
              streamingEntranceKeyPrefix={streamingEntranceKeyPrefix}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      depth,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      onOpenFileLink,
      showIcon,
      showTodoToolCalls,
      streamingEntranceActive,
      streamingEntranceKeyPrefix,
      suppressSourceLabel,
      theme,
      codePreviewSettings,
      toolPreviewCodeViewer,
      workspacePath,
    ],
  );

  const renderContext: ToolCallBlockRenderContext = useMemo(
    () => ({
      isOfficeMode,
      toolCallNode,
      workspacePath,
      theme,
      codePreviewSettings,
      displayModel,
      viewerSource: displayModel.viewerSource,
      rawFileSummaries,
      isRunning,
      statusLabel,
      sourceLabel,
      errorText,
      childToolList,
      showIcon,
      cuaAppIconClassName,
      showTodoToolCalls,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      agentSummaryAction,
      authoritativeAgentType,
      onOpenCodeViewer: toolPreviewCodeViewer,
      onOpenFileLink,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenPlanDetail,
      pluginUi,
      // onOpenWorkflowRun was only ever forwarded to child tool cards and never entered renderContext,
      // so the CreateWorkflow renderer never received it -- the open-detail entry was not buried,
      // it was never rendered. The run-state compact card hangs on this callback, so it must be here.
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      workflowRun,
      workflowDraft,
      onLoadFullToolCallFields,
    }),
    [
      isOfficeMode,
      agentSummaryAction,
      authoritativeAgentType,
      childToolList,
      codePreviewSettings,
      cuaAppIconClassName,
      displayModel,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      errorText,
      isRunning,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      pluginUi,
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      onOpenFileLink,
      rawFileSummaries,
      showIcon,
      showTodoToolCalls,
      sourceLabel,
      statusLabel,
      suppressSourceLabel,
      theme,
      toolCallNode,
      toolPreviewCodeViewer,
      workflowRun,
      workflowDraft,
      workspacePath,
    ],
  );

  const ToolCallRenderer = useMemo(() => resolveToolCallRenderer(renderContext), [renderContext]);
  // The early return must come after all hooks (see the crash rationale above).
  if (!showTodoToolCalls && identity.family === "todo") {
    return null;
  }
  return (
    <div
      className="w-full"
      data-testid={testId(TID_CHAT_TOOL_CALL_BLOCK, toolCall.toolId)}
      data-tool-call-id={toolCall.toolId}
      data-tool-name={toolCall.toolName ?? toolCall.kind ?? ""}
      data-status={toolCall.status}
      data-zcode-tool-stream-animate={shouldPlayEntranceAnimation ? "true" : undefined}
    >
      {toolCall.kind === "cuaGroup" ? (
        <CuaGroupToolCallBlock
          {...renderContext}
          events={cuaGroupEvents}
          renderAssistantMessage={renderCuaAssistantMessage}
          renderReasoning={renderCuaReasoning}
        />
      ) : (
        <ToolCallRenderer {...renderContext} />
      )}
    </div>
  );
}

export const ToolCallBlock = memo(ToolCallBlockComponent);
ToolCallBlock.displayName = "ToolCallBlock";
