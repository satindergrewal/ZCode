import { MessageCircleQuestion } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const ESCALATE_TOOL_ICON = (
  <MessageCircleQuestion className="size-4 shrink-0 text-foreground-subtle" />
);

/** Inline preview cap for the collapsed header: the preview is roughly "what was asked"; the full question lives in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

/** Normalize input to a record on read: strings get one lenient `JSON.parse` attempt (mirroring the submit-result reader). */
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

//** Collapsed-header one-line summary: collapse whitespace, truncate when too long. */
function toInlinePreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * The escalate tool card. A subagent escalates a **genuinely blocking** question to the main agent
 * and parks inside this call awaiting the answer; the nested read-only SessionPane mounted by the
 * main agent's side panel runs the same ToolCallBlocks pipeline, so both surfaces share this card.
 *
 * Collapsed row: kindLabel (asking/asked) + one-line question summary. Expanded: question
 * (+ context when present) + answer section.
 *
 * Key: a rejection for exhausted budget is **a normal tool result** (not an error tool_result; see
 * the handler comment), so the card must never render it as failed from output text - only
 * `status==="failed"` (wiring faults etc.) takes the failure styling. While parked (running) the
 * answer has not arrived and the in-progress label is the whole story; this card can park for a
 * long time, so the running state must look calm, not broken.
 */
export function EscalateToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  const question = readText(input?.question);
  const questionContext = readText(input?.context);

  const isFailed = toolCall.status === "failed";
  // Parked: still running / pending / in_progress and not failed - the answer has not come back.
  const isAsking =
    !isFailed &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  // Answer text = model-facing content: on answered it is the main agent's verbatim answer, on
  // refused the port's canned text. Both are normal results (the handler's formatModelContent
  // returns a message only), read from output alone.
  const answerText = isAsking ? undefined : readText(toolCall.output);

  const kindLabel = intl.formatMessage({
    id: isAsking
      ? "chat.toolCall.workflow.escalate.asking"
      : "chat.toolCall.workflow.escalate.asked",
  });
  const questionHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.question" });
  const contextHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.context" });
  const answerHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.answer" });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.fallbackName" });

  const inlinePreview = useMemo(() => toInlinePreview(question), [question]);
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? fallbackName}</span>
    ),
    [inlinePreview, toolCall.title, fallbackName],
  );

  // Expand gate: any of question / context / answer is expandable content. First-frame input may
  // still be `{}`; do not offer an expand entry for an empty panel (mirrors the submit-result
  // streaming gate).
  const hasDetails =
    question !== undefined || questionContext !== undefined || answerText !== undefined;

  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {question !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{questionHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {question}
            </p>
          </section>
        ) : null}
        {questionContext !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{contextHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground-subtle">
              {questionContext}
            </p>
          </section>
        ) : null}
        {answerText !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{answerHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {answerText}
            </p>
          </section>
        ) : null}
      </div>
    ),
    [question, questionContext, answerText, questionHeading, contextHeading, answerHeading],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ESCALATE_TOOL_ICON}
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
        statusTooltip={isFailed ? context.errorText : undefined}
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
