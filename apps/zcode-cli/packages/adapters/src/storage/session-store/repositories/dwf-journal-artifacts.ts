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
import { decodeNode, type DwfEventRow, type DwfNodeRow } from "./dwf-journal-codecs.js";

/** Pagination bag of listArtifactItems (cursor = journal sequence). */
export interface DwfArtifactItemsQuery {
  /**
   * Only items with sequence strictly greater; the cursor is last-read sequence, not an offset,
   * exactly listEvents' semantics, the very cursor the board hook already uses.
   */
  afterSequence?: number;
  /**
   * Page size, required. The storage layer never guesses defaults: an unbounded query is the one shape forbidden here.
   *
   * But do not add a private ceiling (Math.min(500, limit)). Callers legally pass limit+1
   * to detect hasMore (the extra row stays out of the page); a hard cap silently eats the probe so hasMore
   * is permanently absent at exactly limit == cap. Same argument as DwfListRunsQuery.limit's probe row.
   */
  limit: number;
}

/**
 * One report item fed to a preset artifact, located by journal sequence.
 *
 * Why keyed by sequence, not (siteId, ordinal): the UI's incremental cursor is the journal's
 * sequence (afterSequence, same shape as run-event queries), absent on dwf_node. Site coordinates still come back,
 * both stable React keys across refetches.
 */
export interface DwfArtifactItem {
  /** The reported item as-is (any JSON; REPORT_CAPS bounded it at write time). */
  item: unknown;
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
): DwfArtifactItem[] {
  // limit <= 0 is an empty page (listEvents' limit -1 idiom does not apply: the board
  // reader is always bounded). Floor here, no ceiling: see DwfArtifactItemsQuery.limit.
  if (query.limit <= 0) return [];
  const after = query.afterSequence;
  const cursor = after === undefined ? "" : " and sequence > ?";
  const rows = db
    .prepare(
      `
      select sequence, payload_json from dwf_event
      where run_id = ?
        and type = 'report'
        and json_extract(payload_json, '$.artifactId') = ?${cursor}
      order by sequence
      limit ?
      `,
    )
    .all(
      runId,
      artifactId,
      ...(after === undefined ? [] : [after]),
      query.limit,
    ) as unknown as Pick<DwfEventRow, "payload_json" | "sequence">[];
  return rows.map((row) => {
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
}
