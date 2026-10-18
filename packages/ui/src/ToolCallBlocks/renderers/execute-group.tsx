import { SquareTerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";

const EXECUTE_GROUP_ICON = (
  <SquareTerminalIcon className="size-4 shrink-0 text-foreground-subtle" />
);

// Before a V4 row reaches the shared renderer, inputStreaming/pendingApproval are both normalized to pending.
const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

function formatCompletedSummary(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  childStatuses: string[],
) {
  const parts = [
    intl.formatMessage(
      {
        id:
          childStatuses.length === 1
            ? "chat.toolCall.executeGroup.command.one"
            : "chat.toolCall.executeGroup.command.other",
      },
      { count: childStatuses.length },
    ),
  ];
  const failedCount = childStatuses.filter((status) => status === "failed").length;
  const stoppedCount = childStatuses.filter((status) => status === "stopped").length;
  if (failedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.failed" }, { count: failedCount }),
    );
  }
  if (stoppedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.stopped" }, { count: stoppedCount }),
    );
  }
  return parts.join(", ");
}

export function ExecuteGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, isOfficeMode = false } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  const latestActiveChild = childToolCalls.findLast((child) =>
    ACTIVE_STATUSES.has(child.toolCall.status),
  );
  const latestChild = latestActiveChild ?? childToolCalls.at(-1);
  const latestCommand =
    !isOfficeMode && latestChild ? getExecuteSecondaryText(latestChild.toolCall.input) : undefined;
  const runningActionLabel = latestCommand
    ? intl.formatMessage({ id: "chat.toolCall.execute.running" })
    : undefined;
  const runningPrimaryText = useMemo(
    () =>
      runningActionLabel ? (
        <span className="shrink-0 text-foreground-subtle">{runningActionLabel}</span>
      ) : null,
    [runningActionLabel],
  );
  const runningSecondaryText = useMemo(
    () =>
      latestCommand ? (
        // Tailwind v4 preflight gives code a default mono font; without this, the running
        // command breaks execute/explore's collapsed-state sans convention.
        <code className="min-w-0 truncate font-sans">{latestCommand}</code>
      ) : undefined,
    [latestCommand],
  );
  const completedSummary = formatCompletedSummary(
    intl,
    childToolCalls.map((child) => child.toolCall.status),
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-2 border-border border-l pl-3.5">
        {childToolCalls.map((child) => (
          <ToolCallBlock
            key={child.toolCall.toolId}
            toolCallNode={child}
            workspacePath={context.workspacePath}
            showIcon={false}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenAutomationsMain={context.onOpenAutomationsMain}
            onLoadFullToolCallFields={context.onLoadFullToolCallFields}
          />
        ))}
      </div>
    ),
    [
      childToolCalls,
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.workspacePath,
    ],
  );

  // Scroll in new commands only while the Execute phase runs; when the phase ends, clear
  // the old queue immediately and show final stats.
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={EXECUTE_GROUP_ICON}
      canToggle={!isOfficeMode && (context.canToggle ?? true)}
      forceOpen={!isOfficeMode && (context.forceOpen ?? false)}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.executeGroup.label" })}
      expandedKindLabel={intl.formatMessage({
        id: "chat.toolCall.executeGroup.label",
      })}
      primaryText={isRunning && runningActionLabel ? runningPrimaryText : completedSummary}
      secondaryText={isRunning ? runningSecondaryText : undefined}
      summaryContentSeparator="·"
      expandedPrimaryText={completedSummary}
      // ToolLayout keeps secondaryText in the expanded state, leaving the current command
      // dangling after the count. Once the parent group is expanded, child tool summaries
      // carry the running command, so clear it here.
      expandedSecondaryText={null}
      animateSummaryContent={isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      summaryContentKey={
        isRunning && latestChild
          ? `execute:${toolCall.toolId}:${latestChild.toolCall.toolId}:${runningActionLabel ?? "running"}:${latestCommand ?? "command"}`
          : `execute:${toolCall.toolId}:done:${completedSummary}`
      }
      statusLabel={statusLabel}
      isRunning={isRunning}
      title={isOfficeMode ? undefined : isRunning && latestCommand ? latestCommand : toolCall.title}
      expandedTitle={toolCall.title}
      renderContent={renderContent}
    />
  );
}
