import { useMemo, type ReactNode } from "react";
import type { ToolCallCreateWorkflowDisplay } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { cn } from "@/components/lib/utils.js";
import { DRAFT_FEEDBACK_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  formatWorkflowFeedbackTooltip,
  workflowDiagnosticLines,
} from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  WorkflowDiagnosticsSection,
  workflowFeedbackLedeMessageId,
} from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";

/**
 * What the compile-feedback row says in each ToolLayout slot.
 * Split from `create-workflow.tsx` (oxlint max-lines 400 gate; same precedent as `createWorkflowInput.ts`).
 *
 * Only the row's existing slots - kind word, name, details, status - no new conversation elements:
 * the previous notification redesign was judged "busy" on real devices precisely because it
 * introduced a new visual grammar.
 */
interface WorkflowDraftRowSlots {
  /** Details slot: "draft n". */
  secondaryText: ReactNode | undefined;
  /** Status word "n fixes needed - not run»; present only when the draft does not compile. */
  statusLabel: ReactNode | undefined;
  /** Hollow-ring lamp before the status word; present only when the draft does not compile. */
  statusIndicator: ReactNode | undefined;
  /** Hover tooltip: the status sentence plus per-issue diagnostics; present only on compile failure. */
  statusTooltip: string | undefined;
  /** In-flight rows (validating card header) show the draft ordinal in the details slot from the 2nd draft on. */
  inFlightOrdinalText: string | undefined;
}

interface WorkflowDraftRowInput {
  draft: WorkflowDraftPosition | undefined;
  compileErrors: boolean;
  /** In-flight rows (writing, awaiting confirmation): numbered from the 2nd draft; the 1st never promises a 2nd. */
  inFlight: boolean;
  errorCount: number;
  diagnostics: readonly { line: number; column: number; message: string }[];
  saved: boolean;
}

export function useWorkflowDraftRowSlots({
  draft,
  compileErrors,
  inFlight,
  errorCount,
  diagnostics,
  saved,
}: WorkflowDraftRowInput): WorkflowDraftRowSlots {
  const { intl } = useZCodeIntl();
  const ordinal = workflowDraftOrdinalShown(draft, { compileErrors, inFlight });
  const inFlightOrdinal = workflowDraftOrdinalShown(draft, { compileErrors: false, inFlight });
  const inFlightOrdinalText =
    inFlightOrdinal === undefined
      ? undefined
      : intl.formatMessage(
          { id: "chat.toolCall.workflow.draftOrdinal" },
          { ordinal: String(inFlightOrdinal) },
        );
  const superseded = draft?.superseded === true;
  const lede = intl.formatMessage({ id: workflowFeedbackLedeMessageId(saved) });
  const words = compileErrors
    ? `${intl.formatMessage({ id: "chat.toolCall.workflow.toFix" }, { count: errorCount })} · ${intl.formatMessage({ id: "chat.toolCall.workflow.notRun" })}`
    : undefined;

  // ToolLayout is memoized: nodes handed to it must be memoized by value, or every parent render re-renders the whole row.
  const secondaryText = useMemo(
    () => (ordinal === undefined ? undefined : <WorkflowDraftOrdinal ordinal={ordinal} />),
    [ordinal],
  );
  const statusLabel = useMemo(
    () =>
      words === undefined ? undefined : <span data-testid="workflow-draft-status">{words}</span>,
    [words],
  );
  const statusIndicator = useMemo(
    () => (compileErrors ? <WorkflowDraftLamp superseded={superseded} /> : undefined),
    [compileErrors, superseded],
  );
  const statusTooltip = useMemo(
    () => (compileErrors ? formatWorkflowFeedbackTooltip(lede, diagnostics) : undefined),
    [compileErrors, diagnostics, lede],
  );
  return { secondaryText, statusLabel, statusIndicator, statusTooltip, inFlightOrdinalText };
}

/**
 * Expanded content of the feedback row: the script (line numbers, warning color on lines named by
 * diagnostics) and the compile-feedback card; without display, falls back to plain-text output.
 * Awaiting-confirmation rows reuse the same block (no diagnostics then, script only).
 */
export function WorkflowFeedbackContent({
  display,
  fallbackOutputText,
  saved,
  scriptText,
}: {
  display: ToolCallCreateWorkflowDisplay | null;
  fallbackOutputText: string | null;
  saved: boolean;
  scriptText: string | undefined;
}) {
  // Memoized by content: an unchanged display is the same array, so the code block's injected styles are not rebuilt.
  const flaggedLines = useMemo(
    () => (display?.ok === false ? workflowDiagnosticLines(display.diagnostics) : undefined),
    [display],
  );
  return (
    <div className="mb-2 space-y-3">
      {scriptText ? (
        <div data-testid="workflow-script-codeblock">
          <CodeBlock
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            code={scriptText}
            language="typescript"
            showLineNumbers
            {...(flaggedLines === undefined ? {} : { markedLines: flaggedLines })}
          >
            <CodeBlockHeader className="pl-3 pr-2 pt-2" language="typescript" />
          </CodeBlock>
        </div>
      ) : null}
      {display && display.diagnostics.length > 0 ? (
        <WorkflowDiagnosticsSection
          count={display.errorCount}
          diagnostics={display.diagnostics}
          saved={saved}
          truncated={display.truncated}
        />
      ) : null}
      {!display && fallbackOutputText ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-panel px-3 py-2 font-mono text-ui-base text-foreground-subtle">
          {fallbackOutputText}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Whether the details slot shows the draft ordinal: non-compiling rows always do (when the host
 * provides the position); in-flight rows from the 2nd draft on. Run cards, launch summaries and the
 * confirmation dialog bypass this and never show an ordinal.
 */
export function workflowDraftOrdinalShown(
  draft: WorkflowDraftPosition | undefined,
  phase: { compileErrors: boolean; inFlight: boolean },
): number | undefined {
  if (draft === undefined) return undefined;
  if (phase.compileErrors) return draft.ordinal;
  return phase.inFlight && draft.ordinal >= 2 ? draft.ordinal : undefined;
}

export function WorkflowDraftOrdinal({ ordinal }: { ordinal: number }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="workflow-draft-ordinal">
      {intl.formatMessage(
        { id: "chat.toolCall.workflow.draftOrdinal" },
        { ordinal: String(ordinal) },
      )}
    </span>
  );
}

/**
 * Hollow-ring lamp: the shape says "nothing ran yet"; the color says whether attention is still
 * owed (warning color on the latest draft, fading to neutral once a newer draft exists).
 * `wf-lamp` transitions the color change instead of jumping.
 */
export function WorkflowDraftLamp({ superseded }: { superseded: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp size-2 shrink-0 rounded-full",
        superseded ? DRAFT_FEEDBACK_DOT.settled : DRAFT_FEEDBACK_DOT.open,
      )}
      data-draft-lamp={superseded ? "settled" : "open"}
      data-testid="workflow-draft-lamp"
    />
  );
}
