// ============================================================
// The user-facing-artifact part of the workflowRuns reduction
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate), same precedent as workflow-runs-concurrency.ts:
// the main reduction keeps only the switch dispatch; the artifact's three rules live here. Same discipline: pure, clockless, no I/O.
//
// Terminology: this module's artifact is what the script published to the **user** via
// `artifact.*`. The `serializeWorkflowArtifact` invoked for `resultPreview` in the main reduction
// (workflow-artifact.ts, singular) is **another meaning**--
// the engine-internal name for the script's top-level return, for the model. Unrelated.
//
// The three rules each own a key--the single most important sentence here:
//   artifact-published => upsert by **artifact id**. Re-publishing the same id is a new version and must overwrite the same card;
//                        two versions of one id come from two distinct **site instances**, so the (siteId, ordinal) key of
//                        nodes/actors/reports does not apply here.
//   artifact-failed    => no state change (one return line in the main reduction). Failure rows claim no id / kind /
//                        version; nothing to upsert.
//   report(artifactId) => that id's itemCount +1. The dedupe key returns to (siteId, ordinal)--it is a
//                        report; its identity is the report's.

import {
  WORKFLOW_ARTIFACT_LIMITS,
  type WorkflowRunArtifactKind,
  type WorkflowRunArtifactSummary,
} from "./workflow-artifacts.js";

/** The six member kinds of an artifact. The reduction validates no schema, so this closed table does the reading. */
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<WorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/**
 * The `ArtifactVersionRecord` of an `artifact-published` payload -> the snapshot's **latest-version metadata**.
 *
 * `versions` / `spec` / `description` / `uri` / `sourcePath` / `publishedAt` are trimmed: the snapshot is a
 * high-frequency state key whose readers need only "which artifacts, which version, changed?". Full metadata via the
 * `workflowRunArtifacts` query, bytes via `workflowRunArtifactRead`--the journal stays authoritative.
 *
 * Missing any of `id` / `kind` / `version` = nothing to show (return undefined, watermark only): a card with unknown kind
 * can pick neither icon nor renderer. Other fields ride when present; else the whole key stays absent.
 */
export function workflowArtifactSummary(value: unknown): WorkflowRunArtifactSummary | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const kind = nonEmptyString(value.kind);
  const version = value.version;
  if (id === undefined || kind === undefined || !ARTIFACT_KINDS.has(kind)) return undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const title = nonEmptyString(value.title);
  const contentType = nonEmptyString(value.contentType);
  const bytes = value.bytes;
  return {
    id: id.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: kind as WorkflowRunArtifactKind,
    ...(title === undefined
      ? {}
      : { title: title.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxTitleLength) }),
    version: Math.min(version, WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    ...(contentType === undefined ? {} : { contentType: contentType.slice(0, 128) }),
    ...(typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? { bytes } : {}),
    ...(value.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * Upsert into the bounded artifact table by **artifact id**, **keeping the existing entry's `itemCount`**.
 *
 * Preserving the count is this function's only material difference from `upsertBoundedByInstance`, and its reason to exist: a new version's
 * record carries no `itemCount` (counted from tagged reports, not a publish-time fact), and whole-replace would zero
 * a dashboard mid-feeding--refresh signal to zero, no more incremental fetches ever.
 *
 * Cap semantics match the other three tables: reject new, update existing.
 */
export function upsertBoundedByArtifactId(
  list: readonly WorkflowRunArtifactSummary[],
  entry: WorkflowRunArtifactSummary,
  limit: number,
): { list: WorkflowRunArtifactSummary[]; truncated: boolean } {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    const previous = list[index]!;
    const next = [...list];
    next[index] = {
      ...entry,
      ...(previous.itemCount === undefined ? {} : { itemCount: previous.itemCount }),
    };
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}

/**
 * A tagged `report` landing on an artifact: that id's `itemCount` +1.
 *
 * Unknown id => **ignore the count** (table as-is; the entry still enters `reports` normally). Impossible in
 * practice--a `report(item, tag)` tag must be declared a preset artifact or the engine failRuns--so this is pure
 * defense: on disorder or partial payloads, rather one count less than a spec-less, unrenderable card invented from nothing.
 *
 * **The count's error direction is chosen.** The dedupe key (siteId, ordinal) comes from the `reports` table, which stops
 * admitting new entries past 64--past the cap, a replayed tagged report cannot know it is a replay and over-counts once.
 * The direction is chosen because `itemCount` is only a **refresh signal**: over-counting triggers one extra
 * afterSequence query returning zero rows, harmless; under-counting (e.g. "stop counting at cap") would freeze the line
 * at the 64th point--the very reason this feature exists. At cap `truncated` is set, telling readers `reports`
 * and `itemCount` are approximations; the **authoritative** count lives in the journal, paged via `workflowRunArtifactData`.
 */
export function countTaggedReport(
  list: readonly WorkflowRunArtifactSummary[] | undefined,
  artifactId: string,
): WorkflowRunArtifactSummary[] | undefined {
  if (list === undefined) return undefined;
  const index = list.findIndex((item) => item.id === artifactId);
  // Returning undefined = **leave this key alone**: the caller skips artifacts whole, so idempotent replays get a
  // byte-identical run object and the top-level JSON compare returns null.
  if (index < 0) return undefined;
  const previous = list[index]!;
  const next = [...list];
  next[index] = { ...previous, itemCount: (previous.itemCount ?? 0) + 1 };
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
