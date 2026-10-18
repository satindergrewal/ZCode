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
import type {
  JournalStorePort,
  ListEventsOptions,
  RunEvent,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import { WORKFLOW_RUNS_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { coldCompiledHoles } from "./dynamic-workflow-run-holes.js";
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
 * `defaultConcurrency` is **required**, not optional: a host-derived field on the `run-started` payload (wire key still
 * `concurrencyCeiling`), always present live (computed at launch); missing it here would leave the cold replay's first payload one key
 * short of live — and "both sides byte-identical" is this module's only contract. The caller passes the same
 * `resolveWorkflowDefaultConcurrency`。
 */
export function replayRunProgress(
  row: DwfRunSessionListItem,
  journal: Pick<JournalStorePort, "listEvents">,
  defaultConcurrency: number,
): DynamicWorkflowRunProgressPayload[] {
  return replayRunProgressFromEvents(
    row,
    journal.listEvents(row.runId, COLD_REPLAY_EVENT_READ),
    defaultConcurrency,
  );
}

/**
 * The cold-replay (and GetWorkflowRun) event read shape: all events, but report events after this run's 64th without
 * `item`（docs/dynamic-workflow/presentation.md「Cold replay」、docs/execution-engine.md
 * 「Reading the journal」）。
 *
 * Why the reduction equals the full read byte for byte: the reducer upserts report entries per instance and rejects new instances past 64;
 * `run-started` clears nothing, and each report instance emits one event (replay hits skip silently) — so the first 64
 * report events are exactly those the reducer previews; every later one it reads only the instance (sets `truncated`)
 * and tags (board counts). Why: this used to read everything; a run reporting 65,536 items decoded ~2 GiB of items
 * into memory at session open, none of them displayed.
 */
export const COLD_REPLAY_EVENT_READ: ListEventsOptions = {
  types: "all",
  reportItems: { limit: WORKFLOW_RUNS_LIMITS.maxReports },
};

/**
 * The same minting chain, with events already fetched by the caller.
 *
 * It exists for one reason: `getRunDetail` must reduce the run state and derive the situation
 * snapshot by event instants in one call. Two `listEvents` calls,
 * one per side, pay twice for the same data -- on long runs the dearest read there is.
 *
 * What must be fed in: **all of the run's events, sequence-ascending** (i.e. the return of
 * `listEvents(runId, COLD_REPLAY_EVENT_READ)`); tail settlement's replacement logic relies on "last means last".
 */
export function replayRunProgressFromEvents(
  row: DwfRunSessionListItem,
  stored: readonly StoredEvent[],
  defaultConcurrency: number,
): DynamicWorkflowRunProgressPayload[] {
  const toolCallId = row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId };
  // Hole types (the `hole-reached` derived field): live reads compile artifacts off the registry entry; there is no entry here, so the row's (valid)
  // script has its site table rebuilt — paying that compile **only when this batch really contains a hole arrival**; most
  // runs have none, so cold replay stays byte-identical to before. Rows without script (old rows) fill nothing.
  const holeTypeOf = coldHoleTypeOf(row.scriptText, stored);
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
  // The script-named model bindings: same event, same argument (actor-created derived `model` maps through them), so both sides' payloads
  // remain byte-identical.
  const modelBindings =
    launched?.type === "run-launched" && launched.modelBindings !== undefined
      ? { modelBindings: launched.modelBindings }
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
      ...modelBindings,
      concurrencyCeiling: defaultConcurrency,
      ...(holeTypeOf === undefined ? {} : { holeTypeOf }),
      ...(entry.event.type === "hole-reached" && entry.timeCreated !== undefined
        ? { reachedAt: entry.timeCreated }
        : {}),
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
      ...modelBindings,
      concurrencyCeiling: defaultConcurrency,
    }),
  );
  return payloads;
}

/**
 * Cold-replay hole-type lookup (the `hole-reached` derived field): the fact table is rebuilt by {@link coldCompiledHoles} only
 * when needed; without it `type` is not filled and the UI falls back to the payload.
 */
function coldHoleTypeOf(
  scriptText: string | undefined,
  stored: readonly StoredEvent[],
): ((siteId: string) => string | undefined) | undefined {
  const holes = coldCompiledHoles(scriptText, stored);
  return holes === undefined
    ? undefined
    : (siteId) => holes.find((hole) => hole.siteId === siteId)?.type;
}
