import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** One TS diagnostic (shared shape for CreateWorkflow and EvalWorkflowSnippet displays). */
interface WorkflowDiagnosticEntry {
  line: number;
  column: number;
  code: number;
  message: string;
}

/**
 * Code range of the analyzer's own rules (9001 up).
 * Never write ">= 9000": TypeScript's own 18xxx codes (TS18048 etc.) are still TypeScript
 * codes; TS uses 9xxx only for declaration-emit diagnostics and the workflow compiler emits
 * no declarations, so on the card this range belongs to the analyzer alone.
 */
const ANALYZER_RULE_CODE_MIN = 9001;
const ANALYZER_RULE_CODE_MAX = 9099;

export function isWorkflowAnalyzerRuleCode(code: number): boolean {
  return code >= ANALYZER_RULE_CODE_MIN && code <= ANALYZER_RULE_CODE_MAX;
}

/**
 * Message id for the feedback card's lede: states what did not happen and what happens
 * next. A saved source failing to compile is the FILE's problem, so the sentence names the
 * file — same stance as the line handed to the model in the tool result. Card and per-line
 * tooltips read the same id and can never disagree.
 */
export function workflowFeedbackLedeMessageId(saved: boolean): string {
  return saved
    ? "chat.toolCall.workflow.feedback.lede.saved"
    : "chat.toolCall.workflow.feedback.lede";
}

/**
 * Compile-feedback card, shared by the CreateWorkflow and EvalWorkflowSnippet cards (same
 * compile pipeline, same diagnostic shape, same length cap — two implementations would be a
 * drift nursery).
 *
 * Not compiling is not a failure: nothing ran and feedback went back to the model. Hence a
 * neutral border and body foreground, never destructive — in this feature red belongs to
 * failed runs only; a wall of red would paint the least fatal event as the loudest thing on
 * screen. Renders nothing when there are no diagnostics.
 */
export function WorkflowDiagnosticsSection({
  diagnostics,
  truncated,
  count,
  saved = false,
}: {
  diagnostics: readonly WorkflowDiagnosticEntry[];
  truncated?: boolean;
  /** Count; pass display's `errorCount` (pre-truncation total) when present, else the row count. */
  count?: number;
  /** Script comes from a saved workflow file: the sentence names the file, not this call. */
  saved?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (diagnostics.length === 0) {
    return null;
  }

  const total = count ?? diagnostics.length;
  const countLabel = intl.formatMessage(
    {
      id:
        total === 1
          ? "chat.toolCall.workflow.feedback.countOne"
          : "chat.toolCall.workflow.feedback.count",
    },
    { count: total },
  );
  // Codes go to ICU as strings: numeric params get locale grouping ("9,003").
  const codeLabel = (code: number) =>
    isWorkflowAnalyzerRuleCode(code)
      ? intl.formatMessage({ id: "chat.toolCall.workflow.feedback.rule" }, { code: String(code) })
      : `TS${code}`;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-panel px-3 py-2"
      data-testid="workflow-compiler-feedback"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-ui-xs font-medium text-foreground-subtle">
        <span className="min-w-0 truncate" data-testid="workflow-compiler-feedback-title">
          {intl.formatMessage({ id: "chat.toolCall.workflow.feedback" })}
        </span>
        <span
          className="shrink-0 font-normal tabular-nums"
          data-testid="workflow-compiler-feedback-count"
        >
          {countLabel}
        </span>
      </div>
      <p
        className="text-ui-sm text-foreground-subtle"
        data-testid="workflow-compiler-feedback-lede"
      >
        {intl.formatMessage({ id: workflowFeedbackLedeMessageId(saved) })}
      </p>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.line}:${diagnostic.column}:${index}`}
          className="flex items-start gap-2 text-ui-base"
          data-testid="workflow-compiler-feedback-line"
        >
          <code className="shrink-0 rounded-sm bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            L{diagnostic.line}:C{diagnostic.column}
          </code>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
            {diagnostic.message}
          </span>
          <code className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
            {codeLabel(diagnostic.code)}
          </code>
        </div>
      ))}
      {truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
