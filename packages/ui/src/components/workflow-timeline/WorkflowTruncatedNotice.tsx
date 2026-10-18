import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Showing details for {shown}/{total} steps (docs/dynamic-workflow/presentation.md "The run card" and
 * "The run pane"): once a run brushes `WORKFLOW_RUNS_LIMITS.maxNodes` the instance table stops at the
 * UI, while the counts above it (steps, settled) already include the off-table ones. This line names
 * exactly that gap — the run did not stop; the per-step details did.
 *
 * Card and detail page share one implementation: the same run must say the same thing on both surfaces.
 *
 * Appears only when instances were truly turned away. `truncated` also gets set by smaller tables
 * brushing their limits (reports / artifacts / phases, workflow-runs.ts); there not a step is missing
 * and a showing-40-of-40 line would be noise.
 */
export function WorkflowTruncatedNotice({
  className,
  run,
  testId,
}: {
  className?: string;
  /** The run in the live projection; absent (culled from it) means nothing to say. */
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
      {/* No thousands separators: the adjacent summary segment (`{done}/{total} steps`) is bare numbers,
          and one 2,001 next to one 2001 in the same block jars more than a missing separator. */}
      {intl.formatMessage({ id: "chat.toolCall.workflow.run.truncated" }, { shown, total })}
    </p>
  );
}
