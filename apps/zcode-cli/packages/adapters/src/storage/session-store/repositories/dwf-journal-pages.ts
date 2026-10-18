/**
 // A dwf_event read paged by count **and** bytes (docs/execution-engine.md, "Reading the journal"):
 // The event-log page ({@link listEventPage}) and the board-entry page (dwf-journal-artifacts.ts's
 // `listArtifactItems`) share this one query.
 *
 // Page rule: rows ascending by sequence, stopping at `limit` rows or when one more would push the page's payload bytes past
 // `maxBytes`; the first row always ships (a lone over-bound payload is its own page, else paging would jam forever).
 // `hasMore` is decidable right here: whether a row follows the tail.
 *
 * Why one windowed query instead of summing row by row in JS: the window acts only on `octet_length(payload_json)`,
 // and SQLite reads octet_length from the row header without touching the payload (measured: summing 1.5 GB of report rows
 // took 0.7 ms; length() took 541 ms). So "which rows page in" is decided without reading any payload; the outer
 // `case` is lazy — only in-page rows actually read payloads — and the tail row (whose existence is `hasMore`),
 // possibly 1 MiB of item, is not read at all.
 */

import type { DatabaseSync } from "node:sqlite";
import type { StoredEvent } from "@zcode/dynamic-workflow";
import { decodeEvent } from "./dwf-journal-codecs.js";

/** The paging bag: cursor strictly greater-than, both bounds effective together. */
export interface DwfEventPageQuery {
  afterSequence?: number;
  limit: number;
  maxBytes: number;
}

/** One paged-in row (raw payload; decoding is the caller's job). */
export interface DwfEventPageRow {
  payload_json: string;
  sequence: number;
  time_created: number;
  type: string;
}

/**
 // Extra filters beyond `run_id = ?` (e.g. the board's `type = report and json_extract(...) = ?`).
 // `sql` starts with ` and `; binds in order of appearance.
 */
export interface DwfEventPageFilter {
  params: readonly (string | number)[];
  sql: string;
}

const NO_FILTER: DwfEventPageFilter = { params: [], sql: "" };

export function pageEventRows(
  db: DatabaseSync,
  runId: string,
  query: DwfEventPageQuery,
  filter: DwfEventPageFilter = NO_FILTER,
): { rows: DwfEventPageRow[]; hasMore: boolean } {
  // limit <= 0 is an empty page: paging is always bounded; no "-1 = all" spelling exists here.
  if (query.limit <= 0) return { rows: [], hasMore: false };
  const after = query.afterSequence;
  const cursor = after === undefined ? "" : " and sequence > ?";
  const found = db
    .prepare(
      `
      with sized as (
        select sequence, octet_length(payload_json) as bytes
        from dwf_event
        where run_id = ?${filter.sql}${cursor}
        order by sequence
        limit ?
      ),
      ranked as (
        select sequence,
               row_number() over (order by sequence) as rn,
               sum(bytes) over (order by sequence rows unbounded preceding) as through
        from sized
      )
      select r.sequence, e.type, e.time_created,
             case when r.rn = 1 or (r.rn <= ? and r.through <= ?) then e.payload_json end
               as payload_json
      from ranked r
      join dwf_event e on e.run_id = ? and e.sequence = r.sequence
      order by r.sequence
      `,
    )
    .all(
      runId,
      ...filter.params,
      ...(after === undefined ? [] : [after]),
      // One extra row: it does not page in; its existence is hasMore.
      query.limit + 1,
      query.limit,
      Math.max(0, query.maxBytes),
      runId,
    ) as unknown as Array<Omit<DwfEventPageRow, "payload_json"> & { payload_json: string | null }>;
  // `through` is monotonically non-decreasing, so paged-in rows are exactly a prefix: the first payload-less row ends the page.
  const end = found.findIndex((row) => row.payload_json === null);
  const inPage = end === -1 ? found : found.slice(0, end);
  return { rows: inPage as DwfEventPageRow[], hasMore: end !== -1 };
}

/**
 // One event-log page (the detail page's audit face, `workflowRunEvents`): all types, items verbatim, both bounds set by the gateway.
 // Lives outside the engine port (host probes for it), same reason as `listArtifactItems`: the engine never pages its own event log to find
 * one page for humans; the in-memory journal has no reason to sprint along.
 */
export function listEventPage(
  db: DatabaseSync,
  runId: string,
  query: DwfEventPageQuery,
): { events: StoredEvent[]; hasMore: boolean } {
  const { rows, hasMore } = pageEventRows(db, runId, query);
  return { events: rows.map(decodeEvent), hasMore };
}
