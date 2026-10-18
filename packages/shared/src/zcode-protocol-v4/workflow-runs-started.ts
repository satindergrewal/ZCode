// ============================================================
// The `run-started` branch of the workflowRuns reduction
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate): the main reduction keeps only the switch dispatch, the same
// precedent as `concurrency-changed` / `phase-entered`. This event carries the most to say--resume's
// re-arm semantics, lineage pointers, the run's own concurrency caps--and the three interrelate: a second
// `run-started` for the same runId must clear the previous life's settlement residue without resetting process-learned shared caps to the ceiling.

import { reduceRunStartedConcurrency } from "./workflow-runs-concurrency.js";
import { workflowRunTablesForNewLife } from "./workflow-runs-eviction.js";
import { readRunIdField } from "./workflow-runs-lineage.js";
import { WORKFLOW_RUNS_LIMITS, type WorkflowRunState } from "./workflow-runs.js";

/**
 * The payload's subagent model (canonical `providerId/modelId[$reasoningLevel]`).
 * Over-cap drops the whole event rather than truncating: a shortened model id is a lie; better to show nothing.
 */
function readSubagentModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= WORKFLOW_RUNS_LIMITS.maxSubagentModelLength
    ? text
    : undefined;
}

/**
 * `run-started` -> run back to running, usage zeroed, previous life's settlement residue stripped.
 *
 * Resume repair:
 * The same runId may run-started again (in-process cancel -> resume). Expanding as-is would hang the previous life's
 * settlement residue (error / resultPreview) on a running run--the journal-side clearing
 (updateRunStatus clears settlement on non-terminal) corresponds on the projection side to exactly these strips.
 * Parked escalations are also "previous life's residue", with even less reason to live: those questions
 * hang off the previous life's parked deferreds, already rejected with cancelAsk at cancel. In the new life the
 * corresponding ask re-runs, the actor re-asks, and gets a **new qid**--keeping the old ones just parks a question
 * that will never be answered and that nobody waits on anymore.
 * `resumable` is likewise previous-life settlement fact: once resume runs, it is no longer resumable.
 *
 * Usage is replaced by a zero object wholesale, so **the rejected-instance counters (`nodesUnlisted` / `nodesUnlistedSettled`)
 * zero out with it**--exactly their semantics: re-arm re-emits the whole script prefix (cached
 * settles of finished instances, queued of new ones); not zeroing would sum two lives' "never-entered steps". See workflow-runs-caps.ts.
 * For the same reason clear `unlistedByPhase` (where the previous life's cap was spent), and **an overflowed run empties both tables**--
 * rule and rationale in workflow-runs-eviction.ts' workflowRunTablesForNewLife.
 *
 * `concurrency` is **not** stripped: not previous-life residue but the fact of what concurrency this run runs under
 (both caps), and the shared-bucket side is even process-level present state. Rules in workflow-runs-concurrency.ts.
 * `subagentModel` a fortiori: it is the user-set condition for this run; resume re-arms with the same value.
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
  // The lineage pointer arrives with `run-started` (CLI-derived from launch args or the journal row); re-arm carries the same value, just carry it.
  const resumedFrom = readRunIdField(payload.resumedFrom) ?? rebased.resumedFrom;
  // Subagent model: kin of `limit`, a "this run's own condition" arriving only
  // with this event. Unreadable falls back to the known value--legacy CLIs omit the key, and erasing an already-shown model is the worst
  // degradation: the run looks re-modeled when only a field went missing. Absent means the whole key is absent (not undefined).
  const subagentModel = readSubagentModel(payload.subagentModel) ?? rebased.subagentModel;
  return reduceRunStartedConcurrency(
    {
      ...rebased,
      ...(resumedFrom === undefined ? {} : { resumedFrom }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      ...workflowRunTablesForNewLife(run),
    },
    payload,
  );
}
