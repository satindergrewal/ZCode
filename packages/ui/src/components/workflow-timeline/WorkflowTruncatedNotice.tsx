import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 // "Showing {shown}/{total} steps": once a run passes `WORKFLOW_RUNS_LIMITS.maxNodes`, the instance table freezes at the bound, while the
 * numbers above it (steps, settled) already include the off-table ones. This row names exactly that gap — **the run did not stop;
 * each step's detail did**.
 *
 * One implementation for card and detail page: the same run must say the same sentence on both surfaces.
 *
 * Appears only when instances were truly rejected from the table. `truncated` itself is also set by the small tables (reports / artifacts / phases)
 * hitting the bound (workflow-runs.ts); then no step is missing and repeating "showing 40/40 steps" is noise.
 */
export function WorkflowTruncatedNotice({
  className,
  run,
  testId,
}: {
  className?: string;
  //** The run in the live projection; absent (run evicted from projection) means nothing to say. */
  run: WorkflowRunState | undefined;
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  if (run?.truncated !== true) return null;
  const shown = run.nodes.length;
  const { total } = workflowRunStepCounts(run);
  if (shown >= total) return null;
  return (
    <p
      className={cn("min-w-0 text-ui-xs text-foreground-subtlest", className)}
      data-testid={testId}
    >
      {/* No thousands separators on the two numbers: the adjacent summary segment (`{done}/{total} steps`) is bare,
          and inside one block a "2,001" next to a "2001" jars more than any separator would. */}
      {intl.formatMessage({ id: "chat.toolCall.workflow.run.truncated" }, { shown, total })}
    </p>
  );
}
