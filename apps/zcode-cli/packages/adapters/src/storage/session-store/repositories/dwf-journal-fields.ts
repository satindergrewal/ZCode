/**
 * The board's fields-only read (docs/execution-engine.md, "Reading the journal"): the spec-named field paths,
 // SQLite extracts the values from each tag report's item; the renderer receives those values, not the whole item.
 *
 // Path rules identical to `readWorkflowArtifactField` (packages/shared, the wire contract): split on `.`;
 // When the current value is an array the segment indexes via `Number(segment)`, an object keys by name, a miss reads absent. SQLite JSON paths
 // Every step must first decide "index or key" (`[n]` hits arrays only, `."key"` objects only), while the JS rule learns
 // The runtime learns the value's type only after seeing it — so an integer-like segment expands to both forms, the path to 2^k
 // candidates (k = integer-like segments), `coalesce` taking the first hit. Each step's container is array or object, so at most one hits,
 * `coalesce` order is irrelevant. `->` yields JSON text: JSON null is text `null` (present), a missed path is SQL
 // NULL (absent) — that is how the two separate.
 *
 * Value bound: a value serializing over `maxValueBytes` comes back truncated — the first 1,000 chars of a string,
 // or of an object/array's JSON text, plus an ellipsis. Truncation happens in SQLite, so a 1 MiB value never
 // crosses whole into JavaScript.
 */

import type { DatabaseSync } from "node:sqlite";

/** Paths with more than this many integer-like segments are skipped (2^6 = 64 candidates already exceeds any board spec's need). */
const MAX_INDEX_LIKE_SEGMENTS = 6;
/** Characters kept after truncation: even 4-byte chars fit in 4 KiB. */
const CLIPPED_CHARS = 1000;
/** Estimated per-row overhead besides field values (sequence, site coordinates), counted into the page's bytes. */
const ROW_OVERHEAD_BYTES = 64;

/** All SQLite JSON path candidates for one field path; empty past the expansion cap (the field reads as absent forever). */
export function fieldPathCandidates(path: string): string[] {
  const segments = path.split(".");
  const indexLike = segments.filter((segment) => arrayIndexOf(segment) !== undefined).length;
  if (indexLike > MAX_INDEX_LIKE_SEGMENTS) return [];
  let candidates = ["$.item"];
  for (const segment of segments) {
    // JSON.stringify emits quoted, escaped keys: SQLite path labels accept the same escaping.
    const asKey = `.${JSON.stringify(segment)}`;
    const index = arrayIndexOf(segment);
    candidates = candidates.flatMap((prefix) =>
      index === undefined ? [prefix + asKey] : [prefix + asKey, `${prefix}[${index}]`],
    );
  }
  return candidates;
}

/** `readWorkflowArtifactField`'s array-index test: `Number(segment)` a non-negative integer. */
function arrayIndexOf(segment: string): number | undefined {
  const index = Number(segment);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * One field's SQL expression (extraction + truncation) plus the binds it needs in order. The value computes once: inside a
 // correlated subquery, the outer `case` referencing its result column.
 */
function fieldExpression(path: string, maxValueBytes: number): { sql: string; params: string[] } {
  const candidates = fieldPathCandidates(path);
  if (candidates.length === 0) return { sql: "null", params: [] };
  const value = `coalesce(${candidates.map(() => "e.payload_json -> ?").join(", ")}, null)`;
  const sql = `(select case
      when v is null then null
      when octet_length(v) <= ${maxValueBytes} then v
      when json_type(v) = 'text' then json_quote(substr(v ->> '$', 1, ${CLIPPED_CHARS}) || '…')
      else json_quote(substr(v, 1, ${CLIPPED_CHARS}) || '…')
    end from (select ${value} as v))`;
  return { sql, params: candidates };
}

/** One fields-only page (cursor, both bounds, and `hasMore` per dwf-journal-pages.ts). */
export interface DwfArtifactFieldPageQuery {
  afterSequence?: number;
  fields: readonly string[];
  limit: number;
  maxBytes: number;
  maxValueBytes: number;
}

/** One fields-only entry. */
export interface DwfArtifactFieldItem {
  fields: Record<string, unknown>;
  ordinal: number;
  sequence: number;
  siteId: string;
}

/**
 * One page of fields-only board entries. Same window as whole-item paging (dwf-journal-pages.ts): take limit + 1 rows by count,
 // window a running sum over each row's field-value bytes; the page is the prefix `rn = 1 or (rn <= limit and
 // through <= maxBytes)`, and rows beyond mean `hasMore`. The window here acts on already-truncated values
 // (each at most `maxValueBytes`), so the temp table never holds a whole item.
 */
export function listArtifactFieldItems(
  db: DatabaseSync,
  runId: string,
  artifactId: string,
  query: DwfArtifactFieldPageQuery,
): { items: DwfArtifactFieldItem[]; hasMore: boolean } {
  if (query.limit <= 0) return { items: [], hasMore: false };
  const fields = query.fields.map((path) => fieldExpression(path, query.maxValueBytes));
  const columns = fields.map((field, index) => `${field.sql} as f${index}`).join(",\n");
  const bytes = fields.map((_field, index) => `coalesce(octet_length(f${index}), 0)`).join(" + ");
  const after = query.afterSequence;
  const cursor = after === undefined ? "" : " and e.sequence > ?";
  const rows = db
    .prepare(
      `
      with page as (
        select e.sequence,
               json_extract(e.payload_json, '$.instance.siteId') as site_id,
               json_extract(e.payload_json, '$.instance.ordinal') as ordinal${columns ? `,\n${columns}` : ""}
        from dwf_event e
        where e.run_id = ?
          and e.type = 'report'
          and json_extract(e.payload_json, '$.artifactId') = ?${cursor}
        order by e.sequence
        limit ?
      ),
      ranked as (
        select *,
               row_number() over (order by sequence) as rn,
               sum(${ROW_OVERHEAD_BYTES}${bytes ? ` + ${bytes}` : ""})
                 over (order by sequence rows unbounded preceding) as through
        from page
      )
      select * from ranked order by sequence
      `,
    )
    .all(
      ...fields.flatMap((field) => field.params),
      runId,
      artifactId,
      ...(after === undefined ? [] : [after]),
      query.limit + 1,
    ) as unknown as Array<Record<string, string | number | null>>;
  const maxBytes = Math.max(0, query.maxBytes);
  const end = rows.findIndex(
    (row) =>
      row.rn !== 1 && ((row.rn as number) > query.limit || (row.through as number) > maxBytes),
  );
  const inPage = end === -1 ? rows : rows.slice(0, end);
  const items = inPage.map((row) => {
    const values: Record<string, unknown> = {};
    query.fields.forEach((path, index) => {
      const text = row[`f${index}`];
      if (typeof text === "string") values[path] = JSON.parse(text);
    });
    return {
      sequence: row.sequence as number,
      siteId: String(row.site_id),
      ordinal: Number(row.ordinal),
      fields: values,
    };
  });
  return { items, hasMore: end !== -1 };
}
