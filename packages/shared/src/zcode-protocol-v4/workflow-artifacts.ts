// ============================================================
// Protocol vocabulary for user-facing artifacts
// ============================================================
// Terminology (read first):
// This module's artifact is **output a script publishes to the user via `artifact.*`** -- a file, a markdown doc,
// or a preset board fed by the `report` stream. It is not the same thing as
// `serializeWorkflowArtifact` in sibling `workflow-artifact.ts` (singular): that artifact is the engine-internal name
// for the "script top-level return value" (`RunSettlement.artifact`), meant for the **model**. The file names differ by one s;
// tell them apart by this comment, not by the name.
//
// This module holds schemas plus the param/result shapes of three v4 queries. The **summary** element on the state key
// (`workflowRuns[].artifacts`) also lives here, not in workflow-runs.ts: it shares with the three queries
// the `kind` enum and the "no spec, no bytes, no items" trimming rule; splitting them would drift eventually.
//
// Layering: bytes never enter any schema (except `workflowRunArtifactRead`'s one-chunk-at-a-time base64).
// The journal is authoritative -- `workflowRuns.artifacts` is only a "has it changed" signal.

import { z } from "zod";

import { PROTOCOL_V4_LIMITS } from "./core.js";

/**
 * Member kinds of a user-facing artifact = the six members of the facade `artifact.*`.
 *
 * Two families: content members (`file` / `markdown`) carry bytes and version history; preset boards
 * (`chart` / `table` / `metrics` / `board`) carry no bytes -- every point is one tagged
 * `report` journal row (a board is a projection of the journal).
 *
 * Closed enum. Adding a value is a **breaking** skew (old readers reject the whole frame), same tier as `workflowRuns[].status`.
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

/** Display-side bounds for artifact fields. The numbers are the contract -- the engine-side twins live in `ARTIFACT_CAPS`. */
export const WORKFLOW_ARTIFACT_LIMITS = {
  maxIdLength: 64,
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  /** <= 16 versions per id (`ARTIFACT_CAPS.maxVersionsPerArtifact`). */
  maxVersions: 16,
  /** Entry cap per `workflowRunArtifactData` page; `limit` is clamped gateway-side. */
  maxItemsPerPage: 500,
  /** Default entries per page (used by the gateway when the caller omits limit). */
  defaultItemsPerPage: 200,
  /**
   * Byte cap for one `workflowRunArtifactData` page (serialized bytes in storage), passed to the storage layer by the gateway.
   * One quarter of the protocol per-frame cap (16 MiB): entry counts alone cannot bound bytes -- 500 x 32 KiB already hits the
   * frame cap, so a page might not be sendable at all. A page carries at least one entry, so the per-entry cap (`REPORT_CAPS`)
   * must sit far below the frame cap.
   */
  maxPageBytes: PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes / 4,
  /** Max field paths named per `workflowRunArtifactData` call (no board spec needs more). */
  maxFieldsPerRequest: 32,
  /** Max length of one field path. */
  maxFieldPathLength: 256,
  /**
   * Serialized-byte cap for one field value. Overflowing values degrade to a truncated string (first 1,000 chars plus '...'):
   * charts consume numbers only, and table/board cells only ever show short text.
   */
  maxFieldValueBytes: 4096,
} as const;

/**
 * Read a value out of one report item by dot path: "timing.after", "rounds.0.ms" (docs/execution-engine.md
 * "Reading the journal").
 *
 * This is a **protocol-level contract**, not just a renderer helper: on board fetches the CLI extracts the field in SQLite
 * by these same rules (adapters' dwf-journal-fields.ts), and the value the renderer receives must be identical to the one it
 * would pick from the whole item itself. Rules: split on `.`; in arrays the segment indexes via `Number(segment)` (only
 * non-negative in-range integers count); objects key by name; any dead end (null, scalar, out of range, missing key) is `undefined`.
 */
export function readWorkflowArtifactField(item: unknown, path: string): unknown {
  let cursor: unknown = item;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * The **metadata** of one artifact version (the zod mirror of `ArtifactVersionRecord` on journal `dwf_node.result_json`).
 * Bytes are not here -- `uri` points into the tool-artifact store; fetch bytes via
 * `workflowRunArtifactRead`.
 *
 * `publishedAt` is **required**: the driver stamps `Date.now()` on every record (the engine
 * has no clock of its own, so the pure-package TS type stays optional). Requiring it here makes "version without a time"
 * fail at the protocol boundary instead of handing the UI's version stepper an undefined to sort by.
 */
export const workflowRunArtifactVersionSchema = z
  .object({
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    /** Byte size of this version in the store (content members only). */
    bytes: z.number().int().nonnegative().optional(),
    /** The store's `zcode-artifact://...`; **CLI-side only** -- neither model nor renderer can read it. */
    uri: z.string().min(1).max(512).optional(),
    /** Workspace-relative original path (`file` only) -- the card's reveal-in-workspace action locates by it. */
    sourcePath: z.string().min(1).max(1024).optional(),
    /** Preset board spec (canonical). Each of the four UI renderers interprets its own shape; the protocol does not restate it. */
    spec: z.unknown().optional(),
    /** Publication time (epoch ms). */
    publishedAt: z.number().int().nonnegative(),
    /** This version is the run's deliverable; stamped by the engine, sticky by id. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactVersion = z.infer<typeof workflowRunArtifactVersionSchema>;

/**
 * **All** versions of one artifact plus the count of tag-matched reports. Element of the `workflowRunArtifacts` query,
 * and the durable read for cold recovery and hub detail views.
 *
 * Top-level `title` / `description` / `contentType` / `sourcePath` / `spec` carry the **latest version's** values:
 * readers who only care "what is it now" need not walk `versions`. Same shape as contracts'
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
    /** Latest version number (= `version` of the last `versions` entry). */
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** Ascending by version. Failed publishes are **not** here: failed rows claim no id / kind / version. */
    versions: z.array(workflowRunArtifactVersionSchema).max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** Count of `report` entries tagged with this id (a preset board's data volume; always 0 for content artifacts). */
    itemCount: z.number().int().nonnegative(),
    /** The run's deliverable (at most one); the list leads with it. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifact = z.infer<typeof workflowRunArtifactSchema>;

/**
 * Element of `workflowRuns[].artifacts`: **latest version's metadata only**.
 *
 * Deliberately no `versions` / `spec` / `sourcePath` / `uri`, let alone bytes or entries: this is a high-frequency state key,
 * and its readers only need "which artifacts, which version now, did it change". For content, the queries
 * (`workflowRunArtifacts` for full metadata, `workflowRunArtifactData` for board entries,
 * `workflowRunArtifactRead` for bytes) pull on demand -- the journal stays authoritative.
 *
 * `itemCount`'s job here is the **refresh signal**: the board hook re-fetches with an `afterSequence` delta whenever it changes.
 * Raw tagged-report values in this high-frequency key would ship that many bytes per frame, for every run entry.
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
    /** The run's deliverable (at most one). UI uses it for ordering and shape; absent means none. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactSummary = z.infer<typeof workflowRunArtifactSummarySchema>;

// -- v4 query 1: workflowRunArtifacts (artifact inventory) --
// Same family as workflowRunEvents: read-only, stateless, safe to resend on timeout; deliberately not a v4 command.
// Also **no** atSeq / atLogEpoch: it reads the journal, unrelated to the conversation log, so there is no staleness to guard
// (full argument in the comment after the workflowRunEvents result schema in transport.ts).
// New methods are skew-safe by construction -- old desktops never call them.
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
    /** In first-appearance order (= ordinal of this id's first artifact row in the journal). */
    artifacts: z.array(workflowRunArtifactSchema),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactsResultSchema
>;

// -- v4 query 2: workflowRunArtifactData (preset board fetch surface) --
// Deliberately **not** reusing workflowRunEvents: that would scan the whole journal to filter one id's entries.
// cursor = journal sequence (same cursor semantics as the event log; `afterSequence` is strictly greater).
export const v4ConversationWorkflowRunArtifactDataParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    /** Only entries with sequence strictly greater; absent means from the start. */
    afterSequence: z.number().int().nonnegative().optional(),
    /** Default 200, clamped [1, 500] -- both enforced gateway-side (storage may not invent page sizes or clamp again). */
    limit: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage).optional(),
    /**
     * Fetch only these field paths ({@link readWorkflowArtifactField} rules) instead of the whole item: a board reads
     * just the fields its spec names; a 1 MiB item must not ship whole for one number. When present, each result row
     * carries `fields` and no `item`. Absent = whole item (legacy renderer shape).
     *
     * Skew: old CLI strict schemas reject the unknown key and the whole request with it; renderers use that to retry without it.
     */
    fields: z
      .array(z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxFieldPathLength))
      .min(1)
      .max(WORKFLOW_ARTIFACT_LIMITS.maxFieldsPerRequest)
      .optional(),
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
          /** Journal sequence -- echoed back as `afterSequence` it becomes the next page's cursor. */
          sequence: z.number().int().nonnegative(),
          /** The report stop that produced this entry (e.g. `report#1`). */
          siteId: z.string().min(1).max(64),
          ordinal: z.number().int().nonnegative(),
          /**
           * The entry's raw value, **no preview serialization**: the board's pure functions fetch by field path
           * (`ChartSpec.x.field` looks like "timing.after"); pretty JSON text cannot be path-read.
           * Bounded per entry by the writer-side `REPORT_CAPS.maxItemSerializedBytes`, per page by
           * `WORKFLOW_ARTIFACT_LIMITS.maxPageBytes`. Absent when the request carries `fields`.
           */
          item: z.unknown(),
          /**
           * With `fields` in the request: path -> value. Dead-end paths are missing from the map (= `undefined`); values above
           * `maxFieldValueBytes` degrade to a truncated string.
           */
          fields: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ),
    /** More entries after this page (a page may end early on the entry or byte cap; storage decides). */
    hasMore: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataResultSchema
>;

// -- v4 query 3: workflowRunArtifactRead (content-artifact bytes) --
// **Verbatim per `v4AttachmentRead*`**: <= 512 KiB per chunk (PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
// same constant, none minted anew), so the existing host->CLI <= 1 MiB per request proof carries over unchanged.
//
// Deliberately not reusing attachmentRead itself: that authorizes via the conversation's user row, while artifacts hang on no
// message row. The authorization chain is CLI-side: sessionId must be the run's parentSessionId AND
// (artifactId, version) must have a completed row in the journal => only then is the row's uri read from the store.
// An id coming from the renderer **never** becomes a path directly -- same discipline as attachmentRead.
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
    /** base64 (no data: prefix); <= attachmentChunkMaxBytes once decoded. */
    dataBase64: z.string(),
    /**
     * The version's contentType, from the journal record (driver derives it from its extension table; `opts.contentType`
     * may override) -- the **exact-match** contract by which the UI dispatches renderers. Deliberately not narrowed to
     * image/video/pdf mediaTypes like attachmentRead: an artifact's legal types are the driver's 17-entry extension table plus
     * `application/octet-stream`; narrowing would make markdown and office files unreadable in full.
     */
    mediaType: z.string().min(1).max(128),
    /** Total bytes of this version (<= ARTIFACT_CAPS.maxFileBytes = attachmentMaxBytes). */
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    /** Offset of the next chunk; null at end of stream. */
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
 * Decoded byte length of a base64 string; null on invalid input.
 *
 * Verbatim copy of the same-named private helper in transport.ts, not an import: that file does not export it, and
 * importing it would cycle -- transport.ts -> snapshot.ts -> workflow-runs.ts -> here. Ten lines of pure arithmetic
 * copied cheaply beat a new shared module -- if the copies drift, both sides' superRefine tests go red.
 */
function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
