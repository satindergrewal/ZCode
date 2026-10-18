// ============================================================
// The transcript row for an amend that takes effect in place (docs/dynamic-workflow/concurrency.md).
// ============================================================
// When only the concurrency cap changes and the run is in flight, `AmendWorkflow` compiles nothing and mints no run; it just changes that run's cap. So
// this row has no card to draw: the run's card lives in the round that started it, and a second card would read as a second run, while the old static card
// would claim validated / retuning run X / script unchanged -- none of which happened.
//
// It renders exactly the settings row the GUI config flow leaves behind (`WorkflowSettingsChangeRow`), verbatim -- one
// event must not have two readings. The only difference: it is **clickable** -- the tool row is where this model step landed, the way back to that run.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";

/**
 * The number in the input, to the settings-round metadata block. They are two notations of the same fact (GUI via round metadata, tool via
 * input); mapping both onto one shape keeps a single wording implementation.
 *
 * `requested` is the number **as the model sent it** (readWorkflowRetuneCall). It has no ceiling -- default concurrency D is a starting
 * point, not a cap; any value above D is the effective one. So D (the metadata `ceiling` key, named before "default concurrency") is
 * handed to the wording rule too: `workflowSettingsChangeSegments` treats `to === D` and absent `to` alike, both read
 * as "cap restored to default" (equal to default = this run has no own bound); other values read as-is. With D unknown (the run already
 * evicted from the projection, or an old CLI that never sent it) the requested value reads as-is.
 *
 * `from` stays empty: the input does not know the previous value and this row's wording only reads `to`. `predecessorRunId` stays empty too --
 * an in-place amend has no predecessor (workflow-row-meta.ts).
 */
function retuneAsAmendMeta(
  requested: number | null,
  defaultConcurrency: number | undefined,
): WorkflowSettingsAmendMeta {
  return {
    maxConcurrency: requested === null ? {} : { to: requested },
    ...(defaultConcurrency === undefined ? {} : { ceiling: defaultConcurrency }),
  };
}

export function WorkflowRetuneRow({
  defaultConcurrency,
  onOpen,
  requested,
  runId,
}: {
  /** Default concurrency D (the run's projection readout `run.concurrencyCeiling`); absent when unknown. */
  defaultConcurrency?: number;
  /** Open this run's detail page; when the host omits it (read-only surfaces, rollout off) the row is a plain record. */
  onOpen?: () => void;
  requested: number | null;
  runId: string;
}) {
  const row = (
    <WorkflowSettingsChangeRow amend={retuneAsAmendMeta(requested, defaultConcurrency)} />
  );
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
