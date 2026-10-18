// ============================================================
// The workflowRuns reduction's `run-started` branch
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate): the main reduction keeps only the switch dispatch, same
// precedent as `concurrency-changed` / `phase-entered`. This event carries the most -- resume re-arming,
// lineage pointers, the run's own concurrency bound -- and the three interact: a second
// `run-started` for one runId must clear the previous life's settlement residue yet not wipe a learned shared cap back to default.

import { reduceRunStartedConcurrency } from "./workflow-runs-concurrency.js";
import { workflowRunTablesForNewLife } from "./workflow-runs-eviction.js";
import { withoutWaitingHoles } from "./workflow-runs-holes.js";
import { readRunIdField } from "./workflow-runs-lineage.js";
import { WORKFLOW_RUNS_LIMITS, type WorkflowRunState } from "./workflow-runs.js";

/**
 * The subagent model on the payload (spec string `providerId/modelId[$reasoningLevel]`).
 * Over-bound drops the value rather than truncating: a cut model id is a lie; display nothing instead.
 */
function readSubagentModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= WORKFLOW_RUNS_LIMITS.maxSubagentModelLength
    ? text
    : undefined;
}

/**
 * `run-started` => the run returns to running, usage zeroes, the previous life's settlement residue strips.
 *
 * Resume fix:
 * The same runId can run-started again (in-process cancel -> resume). Naive spread leaves the previous
 * life's settlement residue (error / resultPreview) hanging on a running run -- the journal-side
 * clear semantics (updateRunStatus clears settlement on non-terminal) corresponds to exactly these strips.
 * The parked escalation question is previous-life residue too, with even less reason to live: those
 * questions hung on the previous life's parked deferred, rejected with cancelAsk at cancel. The new
 * life re-runs the ask, the actor asks again, and gets a **new qid** -- keeping the old one just parks
 * a question nobody awaits anymore in the sidebar.
 * `resumable` is previous-life settlement fact too: once resume runs, it is no longer resumable.
 *
 * Usage is replaced by a zero object, so the two rejected-instance counters (`nodesUnlisted` / `nodesUnlistedSettled`)
 * zero out with it -- exactly their semantics: re-arming resends the script prefix (cached
 * settles for finished instances, queued for new ones); not clearing would sum two lives off-table steps. See workflow-runs-caps.ts.
 * Same rationale clears `unlistedByPhase` (where the previous life's bounds landed), and **an overflowed run clears both tables**
 * -- rules and reasons in workflow-runs-eviction.ts's workflowRunTablesForNewLife.
 *
 * `concurrency` is **not** stripped: not previous-life residue but the fact of the concurrency this run runs at
 * (both bounds), and the shared-bucket side is even process-wide present state. Rules in workflow-runs-concurrency.ts.
 * `subagentModel` likewise, harder: it is the user's condition for this run; resume re-arms with the same value.
 */
export function reduceRunStarted(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const {
    error: staleError,
    resultPreview: staleResultPreview,
    pendingQuestions: staleQuestions,
    resumable: staleResumable,
    stopReason: staleStopReason,
    unlistedByPhase: staleUnlisted,
    ...rebased
  } = run;
  void [
    staleError,
    staleResultPreview,
    staleQuestions,
    staleResumable,
    staleStopReason,
    staleUnlisted,
  ];
  // Lineage pointers arrive with `run-started` (CLI-derived from launch args or the journal row); re-arm carries the same, move it.
  const resumedFrom = readRunIdField(payload.resumedFrom) ?? rebased.resumedFrom;
  // Subagent model: a this-run condition in the same family as `limit`, arriving only with
  // this event. Unreadable falls back to the known value -- legacy CLIs omit the key, and erasing a displayed model is
  // the worst degradation: the run looks re-modelled when only a field went missing. Absent = whole key absent (not undefined).
  const subagentModel = readSubagentModel(payload.subagentModel) ?? rebased.subagentModel;
  // Parked holes and parked questions are previous-life residue too (workflow-runs-holes.ts): a resume re-run of that stop
  // emits a fresh `hole-reached`; a filled hole is code joined into the run and survives across lives.
  return reduceRunStartedConcurrency(
    {
      ...withoutWaitingHoles(rebased as WorkflowRunState),
      ...(resumedFrom === undefined ? {} : { resumedFrom }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      ...workflowRunTablesForNewLife(run),
    },
    payload,
  );
}
