// ============================================================
// The transcript row of an in-place effective retune
// ============================================================
// When only the concurrency limit changes and the run is still in flight, `AmendWorkflow` compiles
// nothing and mints no new run; it just changes that run's limit. So this row has no card to draw:
// the run's card lives in the round that started it, and a second card would read as a second run;
// the original static card would show compile-validation results, making a concurrency change look
// like a re-compiled, restarted workflow.
//
// What renders is exactly the settings row the GUI "configure" flow leaves behind
// (`WorkflowSettingsChangeRow`), verbatim - one event must not have two readings depending on the
// initiator. The only difference: this row is **clickable** - the tool row is where the model's
// step landed, and the user reaches that run from here.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";

/**
 * The input number -> the settings-round metadata block. Both notations describe the same fact
 * (GUI via round metadata, tool via input); mapping into one shape keeps the wording to a single
 * implementation.
 *
 * `requested` is the **model-emitted, unclamped** number (readWorkflowRetuneCall); the CLI clamps
 * it into `[1, ceiling]`. So the ceiling is handed to the wording rule too:
 * `workflowSettingsChangeSegments` treats `to >= ceiling` the same as missing `to`, reading
 * "limit restored to the machine default" - exactly the post-clamp truth (clamped to ceiling =
 * this run has no bound of its own). The row thus never shows a number above the machine limit.
 * When the ceiling is unknown (the run left the projection, or an older CLI never sent it), the
 * requested value is echoed as-is; it can only be too high, never too low - and "at most n" is an
 * upper-bound statement, so it cannot mislead toward "runs more than actual".
 *
 * `from` is not set: the input does not know the previous value, and the wording reads only `to`.
 * `predecessorRunId` is omitted too - in-place application has no predecessor (workflow-row-meta.ts).
 */
function retuneAsAmendMeta(
  requested: number | null,
  ceiling: number | undefined,
): WorkflowSettingsAmendMeta {
  return {
    maxConcurrency: requested === null ? {} : { to: requested },
    ...(ceiling === undefined ? {} : { ceiling }),
  };
}

export function WorkflowRetuneRow({
  ceiling,
  onOpen,
  requested,
  runId,
}: {
  /** Machine concurrency ceiling (the run's projection reading); absent when unknown. */
  ceiling?: number;
  /** Open the run's detail page; without it (read-only display or feature off) the row is a record only. */
  onOpen?: () => void;
  requested: number | null;
  runId: string;
}) {
  const row = <WorkflowSettingsChangeRow amend={retuneAsAmendMeta(requested, ceiling)} />;
  if (onOpen === undefined) {
    return (
      <div data-testid="workflow-retune-row" data-workflow-retune-run-id={runId}>
        {row}
      </div>
    );
  }
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer rounded-md px-1 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid="workflow-retune-row"
      data-workflow-retune-run-id={runId}
      onClick={onOpen}
      type="button"
    >
      {row}
    </button>
  );
}
