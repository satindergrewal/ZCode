// ============================================================
// Protocol vocabulary for user-facing artifacts
// ============================================================
// Terminology:
// This module's artifact is the **output a script publishes to the user via `artifact.*`**--a file, a markdown doc,
// or a preset dashboard fed by the `report` stream. It is **not the same thing** as `serializeWorkflowArtifact` in the
// singular `workflow-artifact.ts` next door: that artifact is the engine-internal name for the "script top-level return"
// (`RunSettlement.artifact`), for the **model**. The two file names differ by one s; tell them apart by this comment, not the name.
// this comment, not the file names.
//
// This module holds only schemas + the params/result shapes of three v4 queries. The **summary** element on the state key
// (`workflowRuns[].artifacts`) also lives here, not in workflow-runs.ts: it shares the `kind` enum and the
// "no spec, no bytes, no items" trimming rule with the queries; splitting them would drift eventually.
//
// Layering: bytes never enter any schema (except `workflowRunArtifactRead`'s one-chunk base64).
// The journal is authoritative--`workflowRuns.artifacts` is only a "did it change" signal.

import { z } from "zod";

import { PROTOCOL_V4_LIMITS } from "./core.js";

/**
 * Member kinds of a user-facing artifact = the six members of facade `artifact.*`.
 *
 * Two families: content members (`file` / `markdown`) have bytes and version history; preset dashboards
 (`chart` / `table` / `metrics` / `board`) have no bytes--every point is one tagged
 * `report` journal row (the dashboard is a projection of the journal).
 *
 * Closed enum. Adding a value is a **breaking** skew (legacy readers reject the whole frame), same tier as `workflowRuns[].status`.
 */
export const workflowRunArtifactKindSchema = z.enum([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);
export type WorkflowRunArtifactKind = z.infer<typeof workflowRunArtifactKindSchema>;

/** Display caps of artifact fields. The numbers are the contract--the engine-side namesakes live in `ARTIFACT_CAPS`. */
export const WORKFLOW_ARTIFACT_LIMITS = {
  maxIdLength: 64,
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  /// <= 16 versions per id (`ARTIFACT_CAPS.maxVersionsPerArtifact`).
  maxVersions: 16,
  /// Entry cap of one `workflowRunArtifactData` page; `limit` clamping happens at the gateway.
  maxItemsPerPage: 500,
  /// Default page size (used by the gateway when the caller omits limit).
  defaultItemsPerPage: 200,
} as const;

/**
 * **Metadata** of one artifact version (the zod mirror of `ArtifactVersionRecord` on journal
 * `dwf_node.result_json`). No bytes here--`uri` points into the tool-artifact store; fetch bytes via
 * `workflowRunArtifactRead`。
 *
 * `publishedAt` is **mandatory**: the driver writes `Date.now()` on every record (the engine
 * itself is clockless, so the pure-package TS type stays optional). Mandatory here makes "version without a time" fail red at the
 * protocol boundary instead of handing the UI's version stepper an undefined to sort by.
 */
export const workflowRunArtifactVersionSchema = z
  .object({
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    /// Byte size of this version in the store (content members only).
    bytes: z.number().int().nonnegative().optional(),
    /// The store's `zcode-artifact://...`; **CLI-side use only**, neither model nor renderer can read it.
    uri: z.string().min(1).max(512).optional(),
    /// Workspace-relative original path (`file` only)---the card's "reveal in workspace" locates by it.
    sourcePath: z.string().min(1).max(1024).optional(),
    /// Preset-dashboard spec (canonical). Each of the UI's four renderers interprets it; the protocol does not restate it.
    spec: z.unknown().optional(),
    /// Publish time (epoch millis).
    publishedAt: z.number().int().nonnegative(),
    /// The run deliverable this version belongs to; stamped by the engine, sticky by id.
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactVersion = z.infer<typeof workflowRunArtifactVersionSchema>;

/**
 * **All** versions of one artifact + the count of tagged reports feeding it. Element of the `workflowRunArtifacts` query,
 * and the durable read for cold recovery and the hub detail page.
 *
 * Top-level `title` / `description` / `contentType` / `sourcePath` / `spec` take the **latest version's** values:
 * readers caring only about "what is it now" need not walk `versions`. Shape-mirror of contracts'
 * `DynamicWorkflowRunArtifact` (TS mirror there, wire validation here).
 */
export const workflowRunArtifactSchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    sourcePath: z.string().min(1).max(1024).optional(),
    spec: z.unknown().optional(),
    /// Latest version (= the last entry's version in `versions`).
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /// Ascending versions. Failed publishes are **not** here: failure rows claim no id / kind / version.
    versions: z.array(workflowRunArtifactVersionSchema).max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /// Count of `report` entries tagged with this id (the preset dashboard's data volume; always 0 for content artifacts).
    itemCount: z.number().int().nonnegative(),
    /// The run's deliverable (at most one); the list leads with it.
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifact = z.infer<typeof workflowRunArtifactSchema>;

/**
 * Element of `workflowRuns[].artifacts`: **latest version's metadata only**.
 *
 * Deliberately no `versions` / `spec` / `sourcePath` / `uri`, let alone bytes or entries: a high-frequency state key whose
 * readers only need "which artifacts, which version now, did it change". For content, the two queries--
 * `workflowRunArtifacts` (full metadata), `workflowRunArtifactData` (dashboard entries),
 * `workflowRunArtifactRead` (bytes)--fetch on demand; the journal stays authoritative.
 *
 * `itemCount`'s role here is the **refresh signal**: the dashboard hook refetches with `afterSequence` when it changes.
 * Putting raw tagged reports in the snapshot would let the 256 x 32KB worst case bloat the state frame to 2MB.
 */
export const workflowRunArtifactSummarySchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    contentType: z.string().min(1).max(128).optional(),
    bytes: z.number().int().nonnegative().optional(),
    itemCount: z.number().int().nonnegative().optional(),
    /// The run's deliverable (at most one). UI orders and shapes by it; absent = none.
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactSummary = z.infer<typeof workflowRunArtifactSummarySchema>;

// -- v4 query 1: workflowRunArtifacts (artifact list) --
// Kin of workflowRunEvents: read-only, stateless, resend-safe, deliberately not a v4 command.
// Likewise **no** atSeq / atLogEpoch: journal reads, unrelated to the conversation log, nothing stale to guard
 //(full argument in transport.ts, after the workflowRunEvents result schema).
// New method, skew-safe by construction--legacy desktops never call it.
export const v4ConversationWorkflowRunArtifactsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactsParamsSchema
>;

export const v4ConversationWorkflowRunArtifactsResultSchema = z
  .object({
    /// In first-occurrence order (= the ordinal of the id's first artifact row in the journal).
    artifacts: z.array(workflowRunArtifactSchema),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactsResultSchema
>;

// -- v4 query 2: workflowRunArtifactData (preset-dashboard data plane) --
// Deliberately **not** reusing workflowRunEvents: that would scan the whole journal to filter one id.
// cursor = journal sequence (same cursor semantics as the event log; `afterSequence` strictly greater).
export const v4ConversationWorkflowRunArtifactDataParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    /// Only entries with sequence strictly greater; absent = from the beginning.
    afterSequence: z.number().int().nonnegative().optional(),
    /// Default 200, clamped [1, 500]--both at the gateway (the storage layer may not invent page sizes or re-clamp).
    limit: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataParamsSchema
>;

export const v4ConversationWorkflowRunArtifactDataResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          /// journal sequence--echoed back as `afterSequence` it is the next page's cursor.
          sequence: z.number().int().nonnegative(),
          /// The report site that produced this entry (e.g. `report#1`).
          siteId: z.string().min(1).max(64),
          ordinal: z.number().int().nonnegative(),
          /**
           * Raw entry value, **no preview serialization**: dashboard pure functions fetch by field path
           * (`ChartSpec.x.field` looks like "timing.after"); a pretty-JSON text blob is unusable for that.
           * On the wire, `REPORT_CAPS.maxItemSerializedBytes` (32KB) plus event-payload bounding already
           * guarantee this twice over; no third bound is layered here.
           */
          item: z.unknown(),
        })
        .strict(),
    ),
    /// This page filled `limit` and more entries follow (the gateway fetches one extra to decide).
    hasMore: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataResultSchema
>;

// -- v4 query 3: workflowRunArtifactRead (content-artifact bytes) --
// **Verbatim from `v4AttachmentRead*`**: <= 512 KiB per chunk (PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
// the same constant, not a new one), so the existing host->CLI <= 1 MiB per-request proof carries over as-is.
//
// Deliberately not reusing attachmentRead itself: that authorizes by conversation user row, while artifacts hang off no
// message row. The authorization chain is CLI-side: sessionId must be the run's parentSessionId, and
// (artifactId, version) must have a completed row in the journal => only then is the row's uri read from the store.
// Any id from the renderer **never** becomes a path directly--the same discipline as attachmentRead.
export const v4ConversationWorkflowRunArtifactReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactReadParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadParamsSchema
>;

export const v4ConversationWorkflowRunArtifactReadResultSchema = z
  .object({
    /** base64 (no data: prefix); decoded <= attachmentChunkMaxBytes. */
    dataBase64: z.string(),
    /**
     * This version's contentType, from the journal record (driver-derived via the extension table, overridable via
     * opts.contentType)--the UI's **exact-match** contract for renderer dispatch. Unlike attachmentRead, mediaType is
     * deliberately not pinned to image/video/pdf: the legal artifact types are the driver's 17-entry extension table plus
     * `application/octet-stream`; pinning would make markdown and office files entirely unreadable.
     */
    mediaType: z.string().min(1).max(128),
    /** Total bytes of this version (<= ARTIFACT_CAPS.maxFileBytes = attachmentMaxBytes). */
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    /// Offset of the next chunk; null when this chunk reads to the end.
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "workflow artifact read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationWorkflowRunArtifactReadResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadResultSchema
>;

/**
 * Decoded byte count of a base64 string; null on invalid input.
 *
 * Verbatim twin of the same-named private helper in transport.ts, not an import: that file does not export it,
 * and duplicating six lines beats widening a transport file's public surface.
 * A copy is cheaper than a new shared module for it--should the two drift, both sides' superRefine tests go red.
 */
function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
