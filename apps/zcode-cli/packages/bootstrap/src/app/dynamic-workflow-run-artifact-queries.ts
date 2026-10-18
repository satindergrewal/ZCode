// ============================================================
// Journal read surface for user-facing artifacts (the shared fetch base of DynamicWorkflowRunPort's three artifact methods)
// ============================================================
//
// Terminology: "artifact" here is output the script published to the **user** via `artifact.*`, not the engine-internal
// `RunSettlement.artifact` (the script's top-level return value).

import type { DwfArtifactItem, DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunArtifactItem } from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";

/**
  * The journal with artifact reads. The signature's **single source of truth** is adapters' {@link DwfRunIntrospectionQueries}
  * (`import type`, zero runtime deps) -- the same argument as `DynamicWorkflowIntrospectableJournal`:
  * these two queries are not on the engine's {@link JournalStorePort} (the engine never enumerates artifacts nor joins events),
  * so they can only be attached via capability probing.
 */
interface ArtifactReadableJournal
  extends JournalStorePort, Pick<DwfRunIntrospectionQueries, "listArtifactItems" | "listArtifactRows"> {}

/**
  * Whether the journal carries the artifact reads. **Deliberately a sibling of `supportsRunIntrospection`, not a sixth method on it.**
 *
  * Those four (listRuns / getRunRow / countNodesByStatus / listRecentLogEvents) are one capability:
  * list needs one, detail the other three; missing any should degrade the whole set. The artifact reads are a **later**, second capability,
  * independent of the first -- a journal with only those four (an old adapter's dist, a test double implementing just introspection) must
  * keep `ListWorkflowRuns` / `GetWorkflowRun` working, merely without artifacts. Merging the probes would
  * silently remove two already-working tools on such journals, with symptoms far from the cause.
 */
export function supportsArtifactReads(journal: JournalStorePort): journal is ArtifactReadableJournal {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  return (
    typeof candidate.listArtifactItems === "function" &&
    typeof candidate.listArtifactRows === "function"
  );
}

/**
  * The `report` entries fed to one preset artifact, ascending by journal sequence.
 *
  * The store honors limit **exactly** and never clamps by itself -- so the "fetch one extra to decide hasMore"
  * is the caller's (the gateway's) limit+1; this passes it through untouched. An out-of-range cursor yields an empty page, not an error:
  * reaching the tail is the normal end of paging, not an exception.
 */
export function listArtifactItemsFrom(
  journal: JournalStorePort,
  runId: string,
  artifactId: string,
  page: { afterSequence?: number; limit: number },
): DynamicWorkflowRunArtifactItem[] {
  if (!supportsArtifactReads(journal)) return [];
  const rows = journal.listArtifactItems(runId, artifactId, {
    ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
    limit: page.limit,
  });
  return rows.map(toArtifactItem);
}

/**
  * One store row -> one port entry, fields 1:1; deliberately **no preview serialization**: dashboard pure functions fetch by field
  * path (`ChartSpec.x.field`, e.g. "timing.after"); handed a pretty JSON text, they could not.
  * Items are already bounded on the wire by `REPORT_CAPS.maxItemSerializedBytes` (32KB); no second layer.
 */
function toArtifactItem(row: DwfArtifactItem): DynamicWorkflowRunArtifactItem {
  return {
    sequence: row.sequence,
    siteId: row.siteId,
    ordinal: row.ordinal,
    item: row.item,
  };
}

/**
  * The artifact id claimed by one artifact node row.
 *
  * Prefer the `dwf_node.artifact_id` column (added by a later migration, indexed); the record's `id` is only a fallback.
  * The engine writes both in the same putNode and they are always equal, but legacy rows with a NULL column must still read.
 */
export function artifactRowId(row: NodeRecord): string | undefined {
  if (typeof row.artifactId === "string" && row.artifactId.length > 0) return row.artifactId;
  const record = row.result;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const id = (record as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
