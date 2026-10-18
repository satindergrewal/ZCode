import { createHash } from "node:crypto";

import {
  conversationShareConfirmRequestSchema,
  type ConversationShareArtifactDescriptor,
  type ConversationShareConfirmRequest,
} from "@zcode/shared";

type ConversationShareConfirmRequestBase = Omit<ConversationShareConfirmRequest, "integrity"> & {
  artifacts: ConversationShareArtifactDescriptor[];
};

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Conversation share JSON contains invalid Unicode");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Conversation share JSON contains invalid Unicode");
    }
  }
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Conversation share JSON numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "string":
      assertValidUnicode(value);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalizeValue(entry)).join(",")}]`;
      }

      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => {
          assertValidUnicode(key);
          const entry = record[key];
          if (entry === undefined) {
            throw new TypeError("Conversation share JSON cannot contain undefined values");
          }
          return `${JSON.stringify(key)}:${canonicalizeValue(entry)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Conversation share JSON cannot contain ${typeof value}`);
  }
}

export function canonicalizeConversationShareJson(value: unknown): string {
  return canonicalizeValue(value);
}

export function sha256ConversationShareJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeConversationShareJson(value), "utf8")
    .digest("hex");
}

export function buildConversationShareConfirmRequest(
  input: ConversationShareConfirmRequestBase,
): ConversationShareConfirmRequest {
  const artifacts = [...input.artifacts].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id),
  );
  const projectionSha256 = sha256ConversationShareJson(input.projection.rows);
  const artifactSetSha256 = sha256ConversationShareJson(artifacts);
  const { artifacts: _artifacts, ...confirmRequest } = input;

  return conversationShareConfirmRequestSchema.parse({
    ...confirmRequest,
    integrity: {
      projection_sha256: projectionSha256,
      artifact_set_sha256: artifactSetSha256,
    },
  });
}

/**
 * Fields that exist only when the server issues signed URLs; excluded from the artifact set digest.
 *
 * This lists fields the server ADDS at read time, not a whitelist of fields this build knows -
 * opposite directions; only the former survives version skew:
 * - A newer publisher adds a descriptor field -> it lands in server storage and the server-side
 *   digest; legacy importers hash the verbatim value and include it too, so hashes match
 *   (the direction we must preserve).
 * - Projecting to known-fields-here would clip the new field and break the hash at once.
 *
 * Cost: when the server later adds fields to read responses (not echoes of uploads) they must be
 * added here or digests diverge. That is a server-side revision-contract violation (continuation
 * integrity is defined over the descriptor set) with an obvious symptom and a one-key fix.
 */
const ARTIFACT_URL_KEYS = ["download_url", "download_url_expires_at", "url", "url_expires_at"];

function artifactIdOf(value: unknown): string {
  const id = (value as { artifact_id?: unknown } | null)?.artifact_id;
  return typeof id === "string" ? id : "";
}

function stripArtifactUrls(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const stripped: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ARTIFACT_URL_KEYS) delete stripped[key];
  return stripped;
}

/**
 * Re-verify both digests over the server-verbatim rows/artifacts.
 *
 * The key is verbatim: this used to hash zod parse products, and zod strips unknown fields, so a
 * single optional field added by the publisher broke every legacy importer's hash, reporting
 * share-integrity-failed - an alarm that looks like tampering plus a retry button that can never
 * succeed.
 *
 // Once verification runs over raw bytes, integrity and schema awareness fully decouple: the schema
 // evolves additively, and a hash mismatch again means what it should - content really changed or
 // corrupted.
 */
export function verifyConversationShareIntegrity(input: {
  rawRows: unknown;
  rawArtifacts: unknown;
  integrity: { projection_sha256: string; artifact_set_sha256: string };
}): boolean {
  const artifacts = Array.isArray(input.rawArtifacts)
    ? [...(input.rawArtifacts as unknown[])]
        .sort((left, right) => artifactIdOf(left).localeCompare(artifactIdOf(right)))
        .map(stripArtifactUrls)
    : input.rawArtifacts;
  return (
    sha256ConversationShareJson(input.rawRows) === input.integrity.projection_sha256 &&
    sha256ConversationShareJson(artifacts) === input.integrity.artifact_set_sha256
  );
}
