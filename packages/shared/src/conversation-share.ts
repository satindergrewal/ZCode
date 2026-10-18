import { z } from "zod";

import type { Locale } from "./protocol.js";
import {
  conversationArtifactTypeSchema,
  conversationRowSchema,
  type ConversationRow,
} from "./zcode-protocol-v4/rows.js";

/**
 * The share site splits paths by language: the Chinese site carries the /cn prefix, the English site is bare /share.
 * Web routes, publish-back rewrite, and import-back links share this one definition instead of writing the prefix three times.
 */
const CONVERSATION_SHARE_LOCALE_PATH_PREFIX: Readonly<Record<Locale, string>> = {
  "zh-CN": "/cn",
  "en-US": "",
};

const CONVERSATION_SHARE_PATHNAME_RE = /^\/(cn\/)?share\/([^/]+)\/?$/u;

/**
 * Parse a share-page pathname into the undecoded code segment and that path's language.
 * Only `/share/<code>` and `/cn/share/<code>` shapes are recognized; callers own code decoding and safety checks.
 */
export function parseConversationSharePathname(
  pathname: string,
): { rawCode: string; locale: Locale } | null {
  const match = CONVERSATION_SHARE_PATHNAME_RE.exec(pathname);
  if (!match) return null;
  return { rawCode: match[2]!, locale: match[1] ? "zh-CN" : "en-US" };
}

/**
 * Rewrite a share link onto the target-language site.
 *
 * Rewrites only on exact pathname matches of known share shapes, replacing just the language prefix, never the code segment
 * (avoiding decode/encode round-trips altering the code). Any other shape returns as-is--if the server later changes
 * URL shapes or domains, this quietly does nothing instead of rewriting wrongly.
 */
export function localizeConversationShareUrl(shareUrl: string, locale: Locale): string {
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    return shareUrl;
  }
  const parsed = parseConversationSharePathname(url.pathname);
  if (!parsed) return shareUrl;
  url.pathname = `${CONVERSATION_SHARE_LOCALE_PATH_PREFIX[locale]}/share/${parsed.rawCode}`;
  return url.toString();
}

export const conversationShareAccessModeSchema = z.enum([
  "private",
  "public_readonly",
  "public_importable",
]);
export type ConversationShareAccessMode = z.infer<typeof conversationShareAccessModeSchema>;

/**
 * Share payload version this build produces and understands.
 *
 * Bump only for an "unskippable" breaking change in row semantics (new row kinds / enum values do not count--
 * decodeConversationShareRows degrades those per row). One bump blinds every existing client and every deployed
 * landing-page mirror to new shares, so check the installed-version distribution before bumping.
 */
export const CONVERSATION_SHARE_SCHEMA_VERSION = 1;

/**
 * Inbound schema_version is always taken as a number first, then judged by isConversationShareSchemaVersionSupported.
 * z.literal would squeeze "version too new" and "wrong response shape" into the same invalid_contract,
 * showing users "invalid share format" instead of "please upgrade ZCode".
 */
const conversationShareSchemaVersionSchema = z.number().int().positive();

/** When the version exceeds local knowledge, never guess semantics: callers must turn it into an upgrade prompt, not a generic contract error. */
export function isConversationShareSchemaVersionSupported(version: number): boolean {
  return version <= CONVERSATION_SHARE_SCHEMA_VERSION;
}

/**
 * Decode public-projection rows, skipping and counting unrecognized ones.
 *
 * The transport layer deliberately does not understand row semantics (rows are unknown[] on the wire): a whole share must not
 * fail to open because one row uses a new kind, enum value, or timelineMarker type. One mechanism covers all three, hence
 * no .catch(fallback) on any enum--misguessing enum semantics is far more dangerous than dropping a row.
 *
 * The render chain is tolerant anyway (buildConversationTurnRenderUnits files unknown kinds under assistantWork;
 * ConversationShareReadonlyTimeline's switch just skips unknowns), so this only needs to not throw.
 * The count goes to the caller for a "some content needs a newer ZCode" soft hint; never silent.
 */
export function decodeConversationShareRows(rows: readonly unknown[]): {
  rows: ConversationRow[];
  unsupportedCount: number;
  unsupportedKinds: string[];
} {
  const decoded: ConversationRow[] = [];
  const unsupportedKinds: string[] = [];
  let unsupportedCount = 0;
  for (const row of rows) {
    const parsed = conversationRowSchema.safeParse(row);
    if (parsed.success) {
      decoded.push(parsed.data);
      continue;
    }
    unsupportedCount += 1;
    const kind = (row as { kind?: unknown } | null)?.kind;
    const label = typeof kind === "string" && kind.trim() ? kind.trim() : "unknown";
    if (!unsupportedKinds.includes(label)) unsupportedKinds.push(label);
  }
  return { rows: decoded, unsupportedCount, unsupportedKinds };
}

export const conversationShareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const conversationShareArtifactDescriptorFields = {
  artifact_id: z.string().trim().min(1),
  logical_artifact_key: z.string().trim().min(1),
  producer_product_turn_id: z.string().trim().min(1),
  artifact_version: z.number().int().positive(),
  state: z.literal("current"),
  ref: z.string().regex(/^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u),
  artifact_type: conversationArtifactTypeSchema,
  display_name: z.string().trim().min(1),
  original_path: z.string().min(1).optional(),
  extension: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
} as const;

/**
 * Outbound descriptor (upload / confirm): strict, to catch our own bugs.
 *
 * Outbound strict, inbound lenient is the universal discipline of this contract: an extra field on what we send is our bug,
 * an extra field on what the server returns is its freedom.
 */
export const conversationShareArtifactDescriptorSchema = z
  .object(conversationShareArtifactDescriptorFields)
  .strict();
export type ConversationShareArtifactDescriptor = z.infer<
  typeof conversationShareArtifactDescriptorSchema
>;

/** Inbound descriptor (preview / continuation echo): the server may add fields. */
export const conversationShareInboundArtifactDescriptorSchema = z.object(
  conversationShareArtifactDescriptorFields,
);

const conversationShareAllowedArtifactShapeSchema = z.object({
  // Deliberately not an artifact-type enum: capabilities is the server's discovery list, and a new result kind
  // must not fail the whole response validation, killing publishes (including ones with no result artifacts).
  // Unknown types are dropped at narrow time--clients cannot produce them, so they join no allow decision.
  type: z.string().trim().min(1),
  extensions: z.array(z.string().trim().min(1)),
  mime_types: z.array(z.string().trim().min(1)),
});

const conversationShareCapabilitiesBaseFields = {
  ttl_ms: z.number().int().positive(),
  max_rows: z.number().int().positive(),
  max_payload_bytes: z.number().int().positive(),
  max_artifact_count: z.number().int().nonnegative(),
  max_artifact_bytes: z.number().int().positive(),
  max_total_artifact_bytes: z.number().int().positive(),
};

/**
 * Wire response shape: non-strict, with forward-compatible type / access-mode values.
 *
 * Same for access_modes and allowed_artifacts: a new access mode must not kill legacy clients' capability
 * discovery (i.e. the whole publish entry). Unknown values drop at narrow time--clients cannot pick modes they do not know.
 */
export const conversationShareCapabilitiesWireSchema = z.object({
  ...conversationShareCapabilitiesBaseFields,
  schema_version: conversationShareSchemaVersionSchema,
  access_modes: z.array(z.string().trim().min(1)),
  allowed_artifacts: z.array(conversationShareAllowedArtifactShapeSchema),
});
export type ConversationShareCapabilitiesWire = z.infer<
  typeof conversationShareCapabilitiesWireSchema
>;

/** Post-narrow internal shape: values narrowed to locally known enums; strictness may resume. */
export const conversationShareCapabilitiesDataSchema = z
  .object({
    ...conversationShareCapabilitiesBaseFields,
    schema_version: conversationShareSchemaVersionSchema,
    access_modes: z.array(conversationShareAccessModeSchema),
    allowed_artifacts: z.array(
      z
        .object({
          type: conversationArtifactTypeSchema,
          extensions: z.array(z.string().trim().min(1)),
          mime_types: z.array(z.string().trim().min(1)),
        })
        .strict(),
    ),
  })
  .strict();
export type ConversationShareCapabilities = z.infer<typeof conversationShareCapabilitiesDataSchema>;

/**
 * Drop result kinds and access modes the client does not know, reporting dropped values to the caller for logs.
 *
 * Dropping is lossless only for values the client truly cannot produce or pick. Once a locally uploadable extension becomes
 * a preview candidate (see conversation-preview-artifacts' PREVIEW_FILE_TYPES) without its kind in
 * conversationArtifactTypeSchema, this trims a server-allowed type and then uses the trimmed allowlist to tell
 * users "type unsupported"--md was once misjudged exactly so. video/audio are explicit internal-preview-warning-only
 * exceptions and must not join the uploadable artifact enum.
 */
export function narrowConversationShareCapabilities(wire: ConversationShareCapabilitiesWire): {
  capabilities: ConversationShareCapabilities;
  unsupportedArtifactTypes: string[];
  unsupportedAccessModes: string[];
} {
  const supported: ConversationShareCapabilities["allowed_artifacts"] = [];
  const unsupportedArtifactTypes: string[] = [];
  for (const entry of wire.allowed_artifacts) {
    const type = conversationArtifactTypeSchema.safeParse(entry.type);
    if (type.success) supported.push({ ...entry, type: type.data });
    else if (!unsupportedArtifactTypes.includes(entry.type))
      unsupportedArtifactTypes.push(entry.type);
  }
  const accessModes: ConversationShareAccessMode[] = [];
  const unsupportedAccessModes: string[] = [];
  for (const mode of wire.access_modes) {
    const parsed = conversationShareAccessModeSchema.safeParse(mode);
    if (parsed.success) accessModes.push(parsed.data);
    else if (!unsupportedAccessModes.includes(mode)) unsupportedAccessModes.push(mode);
  }
  return {
    capabilities: { ...wire, access_modes: accessModes, allowed_artifacts: supported },
    unsupportedArtifactTypes,
    unsupportedAccessModes,
  };
}

export const conversationShareConfirmDataSchema = z.object({
  share_code: z.string().trim().min(1),
  share_url: z.string().url(),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
});
export type ConversationShareRecord = z.infer<typeof conversationShareConfirmDataSchema>;

// Outbound requests stay strict: schema_version is pinned to the local constant; an extra field is our own bug.
export const conversationSharePreparationRequestSchema = z
  .object({
    client_request_id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    access_mode: conversationShareAccessModeSchema,
    payload_sha256: conversationShareSha256Schema,
    artifact_count: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationSharePreparationRequest = z.infer<
  typeof conversationSharePreparationRequestSchema
>;

const conversationSharePreparationBaseFields = {
  preparation_id: z.string().trim().min(1),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
} as const;

export const conversationSharePreparationDataSchema = z.discriminatedUnion("status", [
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("preparing"),
  }),
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("confirmed"),
    share: conversationShareConfirmDataSchema,
  }),
]);
export type ConversationSharePreparation = z.infer<typeof conversationSharePreparationDataSchema>;

export const conversationShareArtifactUploadDataSchema = z.object({
  artifact_id: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
  status: z.literal("uploaded"),
  safety_status: z.string().trim().min(1),
});
export type ConversationShareArtifactUpload = z.infer<
  typeof conversationShareArtifactUploadDataSchema
>;

const conversationShareIntegrityFields = {
  projection_sha256: conversationShareSha256Schema,
  artifact_set_sha256: conversationShareSha256Schema,
} as const;

/** Inbound integrity: non-strict; a future extra server digest must not kill the response. */
export const conversationShareIntegritySchema = z.object(conversationShareIntegrityFields);
export type ConversationShareIntegrity = z.infer<typeof conversationShareIntegritySchema>;

/**
 * Outbound integrity: strict. confirm submits exactly two digests (payload_sha256 excluded);
 * an extra field is a local bug and must explode here, not ship.
 */
const conversationShareOutboundIntegritySchema = z
  .object(conversationShareIntegrityFields)
  .strict();

// Outbound request: rows use the canonical row schema, strict throughout--what we send must be fully understood.
export const conversationShareConfirmRequestSchema = z
  .object({
    selected_product_turn_ids: z.array(z.string().trim().min(1)).min(1),
    projection: z
      .object({
        rows: z.array(conversationRowSchema).min(1),
      })
      .strict(),
    integrity: conversationShareOutboundIntegritySchema,
    disclosure_confirmation: z
      .object({
        version: z.literal(1),
        accepted_at: z.number().int().nonnegative(),
        acknowledged_no_secret_detection: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type ConversationShareConfirmRequest = z.infer<typeof conversationShareConfirmRequestSchema>;

const conversationSharePublicMetadataSchema = z.object({
  title: z.string(),
  access_mode: conversationShareAccessModeSchema,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

export const conversationSharePreviewArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    url: z.string().url(),
    url_expires_at: z.number().int().nonnegative(),
  });

/**
 * Inbound wire shape: rows are unknown[], degraded per row by decodeConversationShareRows.
 *
 * The transport layer's row-agnosticism is deliberate--otherwise one new-kind row would blank legacy clients' whole share.
 * The public type ConversationSharePreview is the decoded shape, not inferred from this schema.
 */
export const conversationSharePreviewDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  share: conversationSharePublicMetadataSchema,
  rows: z.array(z.unknown()),
  artifacts: z.array(conversationSharePreviewArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationSharePreviewWire = z.infer<typeof conversationSharePreviewDataSchema>;
export type ConversationSharePreview = Omit<ConversationSharePreviewWire, "rows"> & {
  rows: ConversationRow[];
  /// Rows unrecognized locally and skipped; >0 obliges the UI's "some content needs a newer ZCode" soft hint.
  unsupportedRowCount: number;
};

export const conversationShareContinuationRequestSchema = z
  .object({
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    client_request_id: z.string().trim().min(1),
  })
  .strict();
export type ConversationShareContinuationRequest = z.infer<
  typeof conversationShareContinuationRequestSchema
>;

export const conversationShareContinuationArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    download_url: z.string().url(),
    download_url_expires_at: z.number().int().nonnegative(),
  });

export const conversationShareContinuationDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  import_grant_id: z.string().trim().min(1),
  import_grant_expires_at: z.number().int().nonnegative(),
  share: conversationSharePublicMetadataSchema.extend({
    share_id: z.string().trim().min(1),
  }),
  rows: z.array(z.unknown()),
  artifacts: z.array(conversationShareContinuationArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationShareContinuationWire = z.infer<
  typeof conversationShareContinuationDataSchema
>;
export type ConversationShareContinuation = Omit<ConversationShareContinuationWire, "rows"> & {
  rows: ConversationRow[];
  /// Raw unparsed rows: preserved verbatim in read-only archived copies, so unknown fields are not permanently erased locally.
  rawRows: readonly unknown[];
  /// Rows unrecognized locally and skipped; >0 obliges the UI's "some content needs a newer ZCode" soft hint.
  unsupportedRowCount: number;
};

/** Business error codes known locally; no enum validation on the wire--unknown codes keep the server msg and land as unknown. */
export const conversationShareKnownErrorCodeSchema = z.union([
  z.literal(3001),
  z.literal(3002),
  z.literal(3200),
  z.literal(3201),
  z.literal(3203),
  z.literal(3204),
  z.literal(3205),
  z.literal(3206),
  z.literal(3207),
  z.literal(3208),
  z.literal(3209),
  z.literal(3210),
  z.literal(3211),
  z.literal(3212),
  z.literal(3213),
  z.literal(3214),
  z.literal(3215),
]);
export type ConversationShareApiErrorCode = z.infer<typeof conversationShareKnownErrorCodeSchema>;

/**
 * The error envelope sets no enum on code: when the backend ships a new business code, legacy clients should still get the server msg
 * instead of a whole-envelope parse failure degrading to a context-free "HTTP 4xx".
 */
export const conversationShareErrorEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
});
export type ConversationShareErrorEnvelope = z.infer<typeof conversationShareErrorEnvelopeSchema>;

export function createConversationShareSuccessEnvelopeSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
) {
  return z.object({
    code: z.literal(0),
    // msg was once z.literal(""): a backend "ok" someday would classify every success as a contract error.
    msg: z.string(),
    data: dataSchema,
  });
}
