/**
 // The `JournalStorePort` read face's SQL (docs/execution-engine.md, "Reading the journal"): kinds / types
 // filters, `withResult` / `withPersona` column pruning, `countNodes`, `reportItems` stripping — all pushed into SQLite.
 *
 // Split reason: dwf-journal.ts hit oxlint's max-lines cap (400); each read carries its own "why fetched
 // this way" argument, shares no state with writes, and needs only a db handle.
 *
 // Column pruning uses `null as <col>` instead of dropping the column: the decoder (dwf-journal-codecs.ts) maps NULL to an absent
 // key, so "not read" and "read as NULL" are row-shape identical and the decoder need not know this read's column set.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ActorRecord,
  GetNodeOptions,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import {
  decodeActor,
  decodeEvent,
  decodeNode,
  type DwfActorRow,
  type DwfEventRow,
  type DwfNodeRow,
} from "./dwf-journal-codecs.js";

/** SQLite's "no limit" spelling: default and explicit limit share one statement shape. */
const UNBOUNDED = -1;

const NODE_COLUMNS_BEFORE_RESULT =
  "id, run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash, " +
  "input_json, status";
const NODE_COLUMNS_AFTER_RESULT =
  "error_json, stats_json, message_boundary, artifact_id, time_created, time_updated";

function nodeColumns(withResult: boolean): string {
  const result = withResult ? "result_json" : "null as result_json";
  return `${NODE_COLUMNS_BEFORE_RESULT}, ${result}, ${NODE_COLUMNS_AFTER_RESULT}`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function limitParam(limit: number | undefined): number {
  return limit === undefined ? UNBOUNDED : Math.max(0, limit);
}

export function getNodeRow(
  db: DatabaseSync,
  runId: string,
  siteId: string,
  ordinal: number,
  opts: GetNodeOptions | undefined,
): NodeRecord | undefined {
  const row = db
    .prepare(
      `select ${nodeColumns(opts?.withResult ?? true)} from dwf_node
       where run_id = ? and site_id = ? and ordinal = ?`,
    )
    .get(runId, siteId, ordinal) as DwfNodeRow | undefined;
  return row ? decodeNode(row) : undefined;
}

export function listNodeRows(
  db: DatabaseSync,
  runId: string,
  opts: ListNodesOptions,
): NodeRecord[] {
  const kinds = opts.kinds;
  if (kinds !== "all" && kinds.length === 0) return [];
  const kindFilter = kinds === "all" ? "" : ` and kind in (${placeholders(kinds.length)})`;
  const kindParams = kinds === "all" ? [] : kinds;
  if (opts.maxResultBytes !== undefined) {
    return listNodeRowsWithinBytes(db, runId, opts, kindFilter, kindParams, opts.maxResultBytes);
  }
  const rows = db
    .prepare(
      `select ${nodeColumns(opts.withResult)} from dwf_node
       where run_id = ?${kindFilter}
       order by id limit ?`,
    )
    .all(runId, ...kindParams, limitParam(opts.limit)) as unknown as DwfNodeRow[];
  return rows.map(decodeNode);
}

/**
 // The `maxResultBytes` read: window a prefix sum over `octet_length(result_json)` to pick the page's rows,
 // then fetch whole rows only for those. octet_length reads the header-stored length, never the result itself, so out-of-page rows
 // (a 1 MiB report included) are not read at all — the same query shape as event paging (dwf-journal-pages.ts).
 */
function listNodeRowsWithinBytes(
  db: DatabaseSync,
  runId: string,
  opts: ListNodesOptions,
  kindFilter: string,
  kindParams: readonly string[],
  maxResultBytes: number,
): NodeRecord[] {
  const columns = nodeColumns(opts.withResult)
    .split(", ")
    .map((column) => (column.startsWith("null as ") ? column : `n.${column}`))
    .join(", ");
  const rows = db
    .prepare(
      `with sized as (
         select id, coalesce(octet_length(result_json), 0) as bytes from dwf_node
         where run_id = ?${kindFilter}
         order by id limit ?
       ),
       ranked as (
         select id,
                row_number() over (order by id) as rn,
                sum(bytes) over (order by id rows unbounded preceding) as through
         from sized
       )
       select ${columns} from ranked r join dwf_node n on n.id = r.id
       where r.rn = 1 or r.through <= ?
       order by r.id`,
    )
    .all(
      runId,
      ...kindParams,
      limitParam(opts.limit),
      Math.max(0, maxResultBytes),
    ) as unknown as DwfNodeRow[];
  return rows.map(decodeNode);
}

export function countNodeRows(db: DatabaseSync, runId: string, kind: NodeKind): number {
  const row = db
    .prepare("select count(*) as total from dwf_node where run_id = ? and kind = ?")
    .get(runId, kind) as { total: number | bigint } | undefined;
  return Number(row?.total ?? 0);
}

/**
 // Sum of `result_json` bytes across the kind's rows. octet_length reads the header-stored length: measured
 // 1.5 GB of results sums in 0.7 ms while length() counts chars for 541 ms. The resume report's run-level byte
 // count rests on this, not one item read.
 */
export function sumResultBytes(db: DatabaseSync, runId: string, kind: NodeKind): number {
  const row = db
    .prepare(
      "select coalesce(sum(octet_length(result_json)), 0) as total from dwf_node where run_id = ? and kind = ?",
    )
    .get(runId, kind) as { total: number | bigint } | undefined;
  return Number(row?.total ?? 0);
}

export function listActorRows(
  db: DatabaseSync,
  runId: string,
  opts: ListActorsOptions,
): ActorRecord[] {
  const persona = opts.withPersona ? "persona_json" : "null as persona_json";
  const nameFilter = opts.name === undefined ? "" : " and name = ?";
  const rows = db
    .prepare(
      `select id, run_id, site_id, ordinal, name, ${persona}, resolved_model, session_id,
              time_created, time_updated
       from dwf_actor where run_id = ?${nameFilter} order by id`,
    )
    .all(runId, ...(opts.name === undefined ? [] : [opts.name])) as unknown as DwfActorRow[];
  return rows.map(decodeActor);
}

/**
 // Event read. `types` / cursor / `limit` push down into WHERE and LIMIT; `reportItems: {limit: N}` first takes the run's
 // Nth report sequence as the cutover (one query on the (run_id, sequence) unique index, <= N rows),
 // then the main query hands post-cutover report payloads to `json_remove(payload_json, $.item)`.
 *
 * Why two queries, not one row_number() window: a window function must first materialize the subquery's rows (payload included)
 // into a temp table to number them — a 65,536-report run copies ~2 GiB of payload into temp store, exactly the
 // pay-per-total-byte cost this read exists to avoid. The cutover keeps the main query streaming, and CASE is lazy, so unstripped rows
 // are never parsed.
 */
export function listEventRows(
  db: DatabaseSync,
  runId: string,
  opts: ListEventsOptions,
): StoredEvent[] {
  const types = opts.types;
  if (types !== "all" && types.length === 0) return [];
  const cutoff = reportCutoff(db, runId, opts);
  const payload =
    cutoff === undefined
      ? "payload_json"
      : "case when type = 'report' and sequence > ? then json_remove(payload_json, '$.item') " +
        "else payload_json end as payload_json";
  const typeFilter = types === "all" ? "" : ` and type in (${placeholders(types.length)})`;
  const after = opts.afterSequence;
  const cursorFilter = after === undefined ? "" : " and sequence > ?";
  const rows = db
    .prepare(
      `select sequence, type, time_created, ${payload} from dwf_event
       where run_id = ?${typeFilter}${cursorFilter}
       order by sequence limit ?`,
    )
    .all(
      ...(cutoff === undefined ? [] : [cutoff]),
      runId,
      ...(types === "all" ? [] : types),
      ...(after === undefined ? [] : [after]),
      limitParam(opts.limit),
    ) as unknown as DwfEventRow[];
  return rows.map(decodeEvent);
}

/**
 // The report items' cutover sequence: report events beyond it drop their item. `undefined` = none
 // (`reportItems: all`, or fewer than N reports). N = 0 makes the cutover -1: nothing survives.
 *
 // The rank counts over the **whole run**, independent of types / cursor / limit (port contract).
 */
function reportCutoff(
  db: DatabaseSync,
  runId: string,
  opts: ListEventsOptions,
): number | undefined {
  if (opts.reportItems === "all") return undefined;
  // When this read contains no report events at all, the cutover is moot; skip that query.
  if (opts.types !== "all" && !opts.types.includes("report")) return undefined;
  const keep = Math.max(0, opts.reportItems.limit);
  if (keep === 0) return -1;
  const row = db
    .prepare(
      `select sequence from dwf_event where run_id = ? and type = 'report'
       order by sequence limit 1 offset ?`,
    )
    .get(runId, keep - 1) as { sequence: number } | undefined;
  return row?.sequence;
}
