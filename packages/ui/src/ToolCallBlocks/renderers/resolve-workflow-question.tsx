import { MessageCircleReply } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const RESOLVE_QUESTION_TOOL_ICON = (
  <MessageCircleReply className="size-4 shrink-0 text-foreground-subtle" />
);

/** Folded-header one-line summary cap: the summary is the gist; the full answer lives in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

/** Normalize input to an object on read: try a single lenient JSON.parse for strings (the submit-result reader convention). */
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Folded-header one-line summary: newlines collapse to spaces, overlong truncates. */
function toInlinePreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * The ResolveWorkflowQuestion tool card. The main agent answers by qid a blocking question
 * a subagent escalated from a running workflow; the answer becomes that escalate call result text.
 *
 * Folded row: kindLabel (answering/answered) + one-line answer summary. Expanded: question_id (mono qid line) + the full
 * answer + the tool output text (success ack, or one of the three structured rejections).
 *
 * Key: rejections (unknown qid / already answered / run not flying / no answer capability here) are structured failures
 * carrying status===failed, and only those get the failure styling; the success ack is a plain result.
 */
export function ResolveWorkflowQuestionToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  const questionId = readText(input?.question_id);
  const answer = readText(input?.answer);

  const isFailed = toolCall.status === "failed";
  const isAnswering =
    !isFailed &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  const kindLabel = intl.formatMessage({
    id: isAnswering
      ? "chat.toolCall.workflow.resolveQuestion.answering"
      : "chat.toolCall.workflow.resolveQuestion.answered",
  });
  const questionIdHeading = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.questionId",
  });
  const answerHeading = intl.formatMessage({ id: "chat.toolCall.workflow.resolveQuestion.answer" });
  const outcomeHeading = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.outcome",
  });
  const fallbackName = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.fallbackName",
  });

  // Result text: the success ack (plain result -> output), or a structured rejection (error channel first).
  const outcomeText = isFailed
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : isAnswering
      ? undefined
      : readText(toolCall.output);

  const inlinePreview = useMemo(() => toInlinePreview(answer), [answer]);
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? fallbackName}</span>
    ),
    [inlinePreview, toolCall.title, fallbackName],
  );

  const hasDetails = questionId !== undefined || answer !== undefined || outcomeText !== undefined;

  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {questionId !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{questionIdHeading}</h4>
            {/* The qid is an opaque identifier -> mono. */}
            <code className="block break-all rounded-lg border border-border bg-panel px-4 py-2 font-mono text-ui-sm text-foreground-subtle">
              {questionId}
            </code>
          </section>
        ) : null}
        {answer !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{answerHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {answer}
            </p>
          </section>
        ) : null}
        {outcomeText !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{outcomeHeading}</h4>
            <p
              className={
                isFailed
                  ? "whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-panel px-4 py-3 text-ui-base leading-5 text-foreground"
                  : "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground-subtle"
              }
            >
              {outcomeText}
            </p>
          </section>
        ) : null}
      </div>
    ),
    [questionId, answer, outcomeText, isFailed, questionIdHeading, answerHeading, outcomeHeading],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={RESOLVE_QUESTION_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isFailed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isFailed ? outcomeText : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
