// ============================================================
// Dynamic Workflow Run cold replay: journal -> the same progress payload shape as live
// ============================================================
// The `workflowRuns` projection has one in-memory source,
// empty after restart; the dwf_event log holds every event the engine ever emitted -- the same bounded serialization fed live.
// This re-mints them, in journal order, into DynamicWorkflowRunProgressPayloads; cold materialization feeds those
// to the same reducer as memory events, so the projection is byte-identical across restart.
//
// A separate module, not observation.ts: the minting chain (toProgressPayload) lives in launch.ts, and launch.ts
// already imports observation.ts (the predicates) -- importing back would be a cycle.

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";

/**
  * One run's full progress payloads, ascending journal sequence.
 *
  * **The row decides settlement**: with the row terminal (completed / errored / stopped), the replay's final `run-settled`
  * is always minted from it -- replacing a tail `run-settled` if present, appending if the tail has none (process death; orphan
  * convergence rewrites the row but deliberately synthesizes no event -- the journal's contract is "what the engine emitted"). Same minting chain, same resumable
  * predicate (inside toProgressPayload); the reducer's run-settled branch normalizes everything -- no second
  * normalizer here. Minted payloads **exist only in this replay's return value**, never written to dwf_event.
 *
  * The terminal-vocabulary refactor (completed / errored / stopped) mapped only in
  * the row codec; dwf_event payloads are verbatim JSON -- a previously written `run-settled` carries the old words
  * `cancelled` / `failed`. The old impl skipped synthesis when a tail `run-settled` existed, feeding old words to the reducer,
  * which did not know them and left the run running: card lit, Cancel clickable, nothing to cancel. The row is the
  * only state authority (the codec already translated old rows), so settlement always derives from it; whatever
  * happens to the event vocabulary, cold replay no longer lies via old events. Under the new vocabulary both paths give byte-identical payloads (the engine's
  * run-settled carries exactly the row's four fields); the live=cold-replay contract stands.
 *
  * `concurrencyCeiling` is **required**, not optional: a host-derived field on the `run-started` payload, always
  * present live (computed at launch); omitting it here would make the replay's first payload lack one key vs live -- and
  * "byte-equal on both sides" is this module's only contract. Callers pass the same `resolveWorkflowConcurrencyCeiling`.
 */
export function replayRunProgress(
  row: DwfRunSessionListItem,
  journal: Pick<JournalStorePort, "listEvents">,
  concurrencyCeiling: number,
): DynamicWorkflowRunProgressPayload[] {
  return replayRunProgressFromEvents(row, journal.listEvents(row.runId, {}), concurrencyCeiling);
}

/**
  * The same minting chain, with events already fetched by the caller.
 *
  * It exists for one reason: `getRunDetail` must reduce the run state and derive the situation
  * snapshot by event instants in one call. Two `listEvents` calls,
  * one per side, pay twice for the same data -- on long runs the dearest read there is.
 *
  * The input must be **all of the run's events, sequence-ascending** (what `listEvents(runId, {})` returns);
  * the tail-settlement replacement relies on "the last one is the last".
 */
export function replayRunProgressFromEvents(
  row: DwfRunSessionListItem,
  stored: readonly StoredEvent[],
  concurrencyCeiling: number,
): DynamicWorkflowRunProgressPayload[] {
  const toolCallId = row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId };
    // Launch anchor: same minting chain as live, derived fields included --
    // byte-equal replay vs live payloads is this module's contract (test-pinned). The anchor is in this batch (the first
    // run-launched); no second journal query; pre-upgrade runs lack it, field absent.
  const launched = stored.find((entry) => entry.event.type === "run-launched")?.event;
  const launchInputId =
    launched?.type === "run-launched" ? { launchInputId: launched.inputId } : {};
    // Lineage pointers share the live source (launch reads input or journal row; here it is the row).
  const resumedFrom = row.resumedFrom === undefined ? {} : { resumedFrom: row.resumedFrom };
    // The subagent model shares the anchor's source: the same `run-launched` event (SQL-free; no column on dwf_run).
    // Live reads the same canonical string from launch args or that event, so both payloads stay byte-equal. Present only when set.
  const subagentModel =
    launched?.type === "run-launched" && launched.subagentModel !== undefined
      ? { subagentModel: launched.subagentModel }
      : {};
  const terminal = TERMINAL_RUN_STATUSES.has(row.status);
  const last = stored.at(-1);
    // Replace only the **tail** settlement: a resumed run still carries the previous generation's `run-settled` -- real history;
    // the following `run-started` flips it back to running (existing reducer semantics); untouched.
  const trailingSettle = terminal && last?.event.type === "run-settled" ? last : undefined;
  const replayable = trailingSettle === undefined ? stored : stored.slice(0, -1);
  const payloads = replayable.map((entry) =>
    toProgressPayload({
      event: entry.event,
      runId: row.runId,
      sequence: entry.sequence,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      concurrencyCeiling,
    }),
  );
  if (!terminal) return payloads;
  const settled: RunEvent = {
    type: "run-settled",
    status: row.status,
        // A stopped row always has a reason (the store backfills user when legacy rows lack it); other statuses carry none.
    ...(row.status === "stopped" ? { stopReason: row.stopReason ?? "user" } : {}),
    ...(row.status === "stopped" && row.supersededBy !== undefined
      ? { supersededBy: row.supersededBy }
      : {}),
    ...(row.failure === undefined ? {} : { error: row.failure }),
  };
  payloads.push(
    toProgressPayload({
      event: settled,
      runId: row.runId,
            // On replace keep the replaced entry's sequence (watermark equals live); on append, after the last.
      sequence: trailingSettle?.sequence ?? (last?.sequence ?? 0) + 1,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      concurrencyCeiling,
    }),
  );
  return payloads;
}
