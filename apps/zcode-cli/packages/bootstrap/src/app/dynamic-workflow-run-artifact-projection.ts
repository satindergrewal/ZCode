// ============================================================
// Dynamic Workflow Run: the merge projection of user-facing artifacts (journal rows -> port artifacts)
// ============================================================
// dynamic-workflow-run-observation.ts hit the oxlint max-lines cap (400), so the entire
// artifact merge ({@link artifactsOf} and its private decoders) moves here. The observation face re-exports it verbatim, so its four
// call sites (snapshot / getRunDetail / listArtifacts / the saved-workflows hub) change nothing.
//
// Terminology: "artifact" here is output the script published **for the user** via `artifact.*` (journal
// rows with `kind = "artifact"`), not the engine-internal `RunSettlement.artifact` (the script's top-level return,
// `output` / `result` on the port). One word, two meanings.

import type { DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactKind,
  DynamicWorkflowRunArtifactVersion,
} from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";

/**
  * On the terminal snapshot and `getRunDetail`: the `artifacts` -- **user-facing artifacts**.
 *
  * Terminology: the artifact is what the script published for the user via `artifact.*` (journal `kind = "artifact"`
  * rows), **not** the engine-internal `RunSettlement.artifact` (the top-level return, `output` /
  * `result` on the port). One word, two meanings.
 *
  * Same rules as the observation face's `reportsOf` -- the journal is version history's **durable home** (the memory-only
  * `workflowRuns.artifacts` projection carries latest-version metadata only and is empty after cold restore), and failed / cancelled runs
  * must still yield what they published (a run dying at step 12 still delivered the earlier chart).
 *
  * `listArtifactRows` is not on the engine's {@link JournalStorePort} (the engine never enumerates nor aggregates), so per
  * house rules it attaches via **capability probing**: absent means the whole field is absent, never a throw -- injected test stores and
  * impls without the introspection query must stay usable.
 *
  * Merge rules:
  *   - `completed` rows only. Failed publishes claim no id and no version; counting them into the
  *     version history would make "version 3" point at bytes that never existed.
  *   - one id's rows ascend by `version`; `title` / `contentType` / `sourcePath` / `spec` and friends promoted
  *     to the top level take the **latest** version's values, so readers who care only about "what is it now" need not dig versions.
  *   - `itemCount` = the `report` rows tagged with this id (a preset board's data volume, also the UI's refresh signal).
  *     Content artifacts are constant 0.
 *
  * `nodes` is a node list the caller already holds (the snapshot path feeds one `listNodes` to reports and here);
  * when absent, fetch once. Without them the whole field is absent -- an empty array would read "ran, produced nothing", while absence means
  * "this run has no notion of artifacts".
 */
export function artifactsOf(
  runId: string,
  journal: JournalStorePort,
  nodes?: readonly NodeRecord[],
): { artifacts?: readonly DynamicWorkflowRunArtifact[] } {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  if (typeof candidate.listArtifactRows !== "function") return {};
  const rows = candidate.listArtifactRows(runId);
  if (rows.length === 0) return {};

    // id -> version accumulator. Insertion order = first-appearance order = the port contract's `artifacts` order.
  const byId = new Map<
    string,
    { kind: DynamicWorkflowRunArtifactKind; versions: DynamicWorkflowRunArtifactVersion[] }
  >();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const record = row.result;
    if (record === null || typeof record !== "object") continue;
    const version = artifactVersionOf(record as Record<string, unknown>);
    if (version === undefined) continue;
    const id =
      typeof row.artifactId === "string" && row.artifactId.length > 0
        ? row.artifactId
        : stringField(record as Record<string, unknown>, "id");
    const kind = artifactKindOf((record as Record<string, unknown>).kind);
    if (id === undefined || kind === undefined) continue;
    const bucket = byId.get(id);
    if (bucket === undefined) byId.set(id, { kind, versions: [version] });
    else bucket.versions.push(version);
  }
  if (byId.size === 0) return {};

    // The tag count scans the node table only when a **real preset board** exists: content artifacts' `itemCount` is constant 0, and `listNodes`
    // is a full-table decode. The hub fetches 50 rows per page, one call here per row -- this short-circuit is the only brake on that path.
  const needsTally = [...byId.values()].some((bucket) => PRESET_ARTIFACT_KINDS.has(bucket.kind));
  const itemCounts = needsTally ? tagItemCounts(nodes ?? journal.listNodes(runId)) : undefined;
  const artifacts = [...byId].map(([id, bucket]) => {
    const versions = [...bucket.versions].sort((left, right) => left.version - right.version);
        // Latest version = the highest `version`. An empty bucket is impossible (at least one at construction).
    const latest = versions[versions.length - 1]!;
        // The flag sticks by id (the engine guarantees later versions carry it); any version having it counts -- legacy-CLI rows lack the key.
    const primary = versions.some((version) => version.primary === true);
    return {
      id,
      kind: bucket.kind,
      ...(latest.title === undefined ? {} : { title: latest.title }),
      ...(latest.description === undefined ? {} : { description: latest.description }),
      ...(latest.contentType === undefined ? {} : { contentType: latest.contentType }),
      ...(latest.sourcePath === undefined ? {} : { sourcePath: latest.sourcePath }),
      ...(latest.spec === undefined ? {} : { spec: latest.spec }),
      version: latest.version,
      versions,
      itemCount: itemCounts?.get(id) ?? 0,
      ...(primary ? { primary: true as const } : {}),
    } satisfies DynamicWorkflowRunArtifact;
  });
    // Deliverables lead; the rest keep first-publish order:
    // the order is decided once here; snapshot / GetWorkflowRun / hub / v4 queries all read it, and no cap can cut it.
    // `Array.prototype.sort` is stable since ES2019, so relative order among non-primaries never moves.
  artifacts.sort((left, right) => Number(right.primary === true) - Number(left.primary === true));
  return { artifacts };
}

/** Per-id count of tag report rows (`kind = "report"` AND `artifact_id = ?` -- a board's data volume). */
function tagItemCounts(nodes: readonly NodeRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind !== "report" || node.artifactId === undefined) continue;
    counts.set(node.artifactId, (counts.get(node.artifactId) ?? 0) + 1);
  }
  return counts;
}

const ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/** The four preset boards: only they are fed by tag `report` rows; content artifacts' `itemCount` is constant 0. */
const PRESET_ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "chart",
  "table",
  "metrics",
  "board",
]);

function artifactKindOf(value: unknown): DynamicWorkflowRunArtifactKind | undefined {
  return typeof value === "string" && ARTIFACT_KINDS.has(value)
    ? (value as DynamicWorkflowRunArtifactKind)
    : undefined;
}

/**
  * A `dwf_node.result_json` `ArtifactVersionRecord` -> the port's version item. The row shape comes from engine and
  * driver, but it crosses one JSON round-trip and maybe an older CLI, so every field narrows defensively: a non-positive-integer `version`
  * drops the row (a version without a number cannot be located in the UI nor read).
 */
function artifactVersionOf(
  record: Record<string, unknown>,
): DynamicWorkflowRunArtifactVersion | undefined {
  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const bytes = record.bytes;
    // The driver always writes `publishedAt`; only the engine's type calls it optional. Absent -> 0, not dropped:
    // an artifact without a timestamp is still viewable, and dropping it punches a hole in the version list.
  const publishedAt = typeof record.publishedAt === "number" ? record.publishedAt : 0;
  const title = stringField(record, "title");
  const description = stringField(record, "description");
  const contentType = stringField(record, "contentType");
  const uri = stringField(record, "uri");
  const sourcePath = stringField(record, "sourcePath");
  return {
    version,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(typeof bytes === "number" && Number.isFinite(bytes) ? { bytes } : {}),
    ...(uri === undefined ? {} : { uri }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    publishedAt,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
