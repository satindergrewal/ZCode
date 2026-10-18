import { ClipboardCheckIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const SUBMIT_RESULT_TOOL_ICON = (
  <ClipboardCheckIcon className="size-4 shrink-0 text-foreground-subtle" />
);

/** Inline preview cap for the collapsed header: the preview is roughly "what was submitted"; the full content lives in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

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

/**
 * Read-time normalization of the submitted content: strings get **one** lenient `JSON.parse`; the
 * parsed value is used only when it is an object/array.
 *
 * Read-side mirror of a production finding in the engine - `engine/scheduler.ts` records that real
 * models often serialize result into a JSON string and runs the same single lenient parse. No
 * multi-level recursive parse (the engine also parses once); on failure treat as a string, never
 * throw and destroy the card, never rewrite data.
 */
function normalizeSubmittedResult(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.trim().length === 0) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    // Literal strings of number/boolean/null stay verbatim: that is the model's sentence, not a structured payload.
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

/** Indented text for the JSON branch. Pathological payloads (cyclic refs) fall back to `String(...)`; the card must not crash on payload. */
function stringifyResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Collapsed-header one-line summary: collapse whitespace, truncate when too long. */
function toInlinePreview(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }

  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

export function SubmitResultToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  // Fix rationale as in send-message: the streaming first frame's input may still be `{}`; never
  // offer an expand entry for an empty panel. The gate is "result key present", not "result truthy" -
  // submitting null is a real submission too.
  const hasResult = input !== undefined && "result" in input;
  const normalizedResult = useMemo(
    () => (hasResult ? normalizeSubmittedResult(input?.result) : undefined),
    [hasResult, input?.result],
  );
  const isProse = typeof normalizedResult === "string";

  const isRejected = toolCall.status === "failed";
  // Rejected and stopped read identically on the card: the submission never completed. The spec defines four phases only; no fifth entry for denied.
  const isStopped = toolCall.status === "stopped" || toolCall.status === "denied";
  const isSubmitting =
    !isRejected &&
    !isStopped &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");
  const kindLabelId = isRejected
    ? "chat.toolCall.submitResult.rejected"
    : isStopped
      ? "chat.toolCall.submitResult.stopped"
      : isSubmitting
        ? "chat.toolCall.submitResult.submitting"
        : "chat.toolCall.submitResult.submitted";

  // Rejection text: error channel first, then the tool's own error field and plain-text output.
  // The accepted output is always "The result was accepted." - no information, never read.
  const rejectionText = isRejected
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : undefined;
  // Rejected state is a flat row without an expand entry; the rejection text lives in the failure
  // tooltip (hover to copy) - no per-field violation panel anymore. rejectionText exists only when
  // rejected, so the non-rejected expand gate only checks the result key.
  const hasDetails = !isRejected && hasResult;

  const resultLabel = intl.formatMessage({ id: "chat.toolCall.submitResult.resultHeading" });
  const inlinePreview = useMemo(
    () => (hasResult ? toInlinePreview(normalizedResult) : undefined),
    [hasResult, normalizedResult],
  );
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? "submit_result"}</span>
    ),
    [inlinePreview, toolCall.title],
  );

  const theme = context.theme;
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {hasResult ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{resultLabel}</h4>
            {isProse ? (
              // Prose stays prose: DESIGN.md reserves mono for paths/commands/code/identifiers/terminal data.
              // Deliberately no markdown rendering - the result string carries no markdown contract.
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
                {normalizedResult as string}
              </p>
            ) : (
              // Structured payloads go through CodeBlock (honors the user's code font size); container mirrors mcp.tsx verbatim.
              <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                <CodeBlock
                  appTheme={theme}
                  code={stringifyResult(normalizedResult)}
                  language="json"
                />
              </div>
            )}
          </section>
        ) : null}
      </div>
    ),
    [hasResult, isProse, normalizedResult, resultLabel, theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SUBMIT_RESULT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isRejected ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isRejected ? rejectionText : undefined}
        showFailureStatus={isRejected}
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
