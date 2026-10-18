/**
 * The two host readers for user-facing artifacts.
 *
 * artifact here means deliverables published for users (files/markdown/preset boards), not
 * RunSettlement.artifact (the script's top-level return). Both meanings coexist.
 *
 * Why outside JournalStorePort: the same argument as listRun, verbatim. The engine walks
 * its own ordinal chain via listNodes and is never responsible for this run's artifacts or a board's items;
 * adding them to the domain port would make every journal implementation (the in-memory one included)
 * implement something the engine does not do. Consumers capability-probe
 * (typeof journal.listArtifactRows === function); the signature single-source is DwfRunIntrospectionQueries.
 *
 * Why outside dwf-journal.ts: both queries need only a db handle (no shared state with
 * run/actor/node/event IO) and each carries a full source/ordering rationale.
 * Same split rationale as dwf-journal-codecs.ts.
 */

import type { DatabaseSync } from "node:sqlite";
import type { NodeRecord } from "@zcode/dynamic-workflow";
import { decodeNode, type DwfNodeRow } from "./dwf-journal-codecs.js";
import { listArtifactFieldItems } from "./dwf-journal-fields.js";
import { pageEventRows } from "./dwf-journal-pages.js";

/**
 * The paging bag of {@link listArtifactItems} (cursor = journal sequence). Bound rules in
 // dwf-journal-pages.ts: stop at `limit` rows, or when one more would exceed `maxBytes`; the first row always ships.
 *
 * Both bounds are **required**, honored exactly by the store with no ceiling of its own: page-size defaults and clamping belong to the gateway; an unbounded
 // fetch is the one shape that must not exist here. `hasMore` is decided here (rows beyond the tail), never guessed by
 // the caller via "fetch one extra".
 */
export interface DwfArtifactItemsQuery {
  /**
   * Only items with sequence strictly greater; the cursor is last-read sequence, not an offset,
   * exactly listEvents' semantics, the very cursor the board hook already uses.
   */
  afterSequence?: number;
  limit: number;
  maxBytes: number;
  /**
   * Only these field paths (dwf-journal-fields.ts), each value at most `maxValueBytes`; given, entries carry
   // `fields` not `item`, and `maxBytes` counts the fetched values. Absent = the whole item.
   */
  fields?: { paths: readonly string[]; maxValueBytes: number };
}

/**
 * One report item fed to a preset artifact, located by journal sequence.
 *
 * Why keyed by sequence, not (siteId, ordinal): the UI's incremental cursor is the journal's
 * sequence (afterSequence, same shape as run-event queries), absent on dwf_node. Site coordinates still come back,
 * both stable React keys across refetches.
 */
export interface DwfArtifactItem {
  /** The reported item's original value (any JSON; `REPORT_CAPS` bounded it at write). Absent in fields-only mode. */
  item?: unknown;
  /** Fields-only mode: path -> value; unreachable paths absent. */
  fields?: Record<string, unknown>;
  ordinal: number;
  sequence: number;
  siteId: string;
}

/**
 * This run's artifact rows (kind=artifact), in insertion order (order by id).
 *
 * One row = one version (re-publishing an id is a new row, history kept), so group by artifactId and
 * take each row's result (ArtifactVersionRecord). The order is insertion order, not
 * order by artifact_id, ordinal: version order is publication order, and same-id adjacency is
 * coincidence; relying on it lets one interleaving publisher display versions out of order.
 *
 * Failed publishes appear too (status failed + error): readers must be able to say this publish failed;
 * filtering them out would erase a user-visible failure from every surface.
 */
export function listArtifactRows(db: DatabaseSync, runId: string): NodeRecord[] {
  const rows = db
    .prepare("select * from dwf_node where run_id = ? and kind = 'artifact' order by id")
    .all(runId) as unknown as DwfNodeRow[];
  return rows.map(decodeNode);
}

/**
 * How many tag reports mark each preset artifact (the board's data volume, `itemCount`). The `group by` pushes into SQLite;
 // and `dwf_node_artifact_idx (run_id, artifact_id)` is exactly that shape — not one row read. Hosts used to load the whole
 // node table (plus every report item) and count in JS: a run reporting 65,536 items decoded all of them
 // per listing query (docs/execution-engine.md, "Reading the journal").
 */
export function countTaggedReports(db: DatabaseSync, runId: string): ReadonlyMap<string, number> {
  const rows = db
    .prepare(
      `
      select artifact_id, count(*) as total from dwf_node
      where run_id = ? and kind = 'report' and artifact_id is not null
      group by artifact_id
      `,
    )
    .all(runId) as unknown as { artifact_id: string; total: number | bigint }[];
  return new Map(rows.map((row) => [row.artifact_id, Number(row.total)]));
}

/**
 * Report items fed to a preset artifact, paged by ascending journal sequence (the board reader).
 *
 * The source is dwf_event, not dwf_node, though both hold the same labeled reports. The reason is the cursor:
 * the UI pulls incrementally by the event log's sequence, which dwf_node lacks, offering only a
 * (siteId, ordinal) pair, forging a total order there would mint a second cursor semantics for the same data.
 * Hence the pushdown json_extract(payload_json, '$.artifactId') = ?, the exact shape of
 * dwf_event_artifact_idx (0029's expression index).
 *
 * type=report joins the predicate: the type column is pushdown redundancy (also in payload). Without it,
 * any other event carrying artifactId (today only artifact-published, holding nested
 * artifact.id not a top-level artifactId, but tomorrow who knows) leaks into the board feed.
 *
 * Unlabeled reports are excluded naturally: no artifactId key in payload, json_extract
 * yields NULL and SQL =? never matches NULL.
 */
export function listArtifactItems(
  db: DatabaseSync,
  runId: string,
  artifactId: string,
  query: DwfArtifactItemsQuery,
): { items: DwfArtifactItem[]; hasMore: boolean } {
  if (query.fields !== undefined) {
    return listArtifactFieldItems(db, runId, artifactId, {
      ...(query.afterSequence === undefined ? {} : { afterSequence: query.afterSequence }),
      fields: query.fields.paths,
      limit: query.limit,
      maxBytes: query.maxBytes,
      maxValueBytes: query.fields.maxValueBytes,
    });
  }
  const { rows, hasMore } = pageEventRows(db, runId, query, {
    sql: " and type = 'report' and json_extract(payload_json, '$.artifactId') = ?",
    params: [artifactId],
  });
  const items = rows.map((row) => {
    // payload is the RunEvent stringified verbatim by appendEvent, so this narrow shape shares
    // its source with {type: report; instance; item; artifactId?}.
    const payload = JSON.parse(row.payload_json) as {
      instance: { ordinal: number; siteId: string };
      item: unknown;
    };
    return {
      sequence: row.sequence,
      siteId: payload.instance.siteId,
      ordinal: payload.instance.ordinal,
      item: payload.item,
    };
  });
  return { items, hasMore };
}
