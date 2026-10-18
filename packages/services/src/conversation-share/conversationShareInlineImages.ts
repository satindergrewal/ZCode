import { createHash } from "node:crypto";
import type { ConversationShareCapabilities } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationShareFailureIssue } from "./conversationShare.js";

/** Inline images become existing artifacts; preview and publish share one deterministic conversion with no new file-read path. */
export function materializeConversationShareInlineImages(
  sourceRows: readonly ConversationRow[],
  capabilities: ConversationShareCapabilities,
  turnOrdinals: ReadonlyMap<string, number>,
): {
  rows: ConversationRow[];
  bytesBySourceRef: Map<string, Uint8Array>;
  warnings: ConversationShareFailureIssue[];
} {
  const rows: ConversationRow[] = [];
  const bytesBySourceRef = new Map<string, Uint8Array>();
  const warnings: ConversationShareFailureIssue[] = [];
  let nextRowId = sourceRows.reduce((max, row) => Math.max(max, row.rowId), 0);
  for (const row of sourceRows) {
    if (row.kind !== "toolCall" || row.display?.kind !== "node_repl_images") {
      rows.push(row);
      continue;
    }
    const { display, ...toolRow } = row;
    rows.push(toolRow);
    for (const [index, image] of display.images?.entries() ?? []) {
      const mimeType = image.mimeType.toLowerCase();
      const allowed = capabilities.allowed_artifacts.find(
        (candidate) =>
          candidate.type === "image" &&
          candidate.mime_types.some((mime) => mime.toLowerCase() === mimeType),
      );
      const extensions: Record<string, string[]> = {
        "image/png": ["png"],
        "image/jpeg": ["jpg", "jpeg"],
        "image/webp": ["webp"],
        "image/gif": ["gif"],
        "image/svg+xml": ["svg"],
      };
      const extension = allowed?.extensions
        .map((value) => value.replace(/^\./u, "").toLowerCase())
        .find((value) => extensions[mimeType]?.includes(value));
      const displayName = `tool-image-${row.rowId}-${index + 1}.${extension ?? "image"}`;
      const issue = {
        scope: "artifact" as const,
        rowId: row.rowId,
        productTurnId: row.productTurnId,
        turnOrdinal: row.productTurnId ? turnOrdinals.get(row.productTurnId) : undefined,
        artifactDisplayName: displayName,
        artifactType: "image",
        mimeType,
      };
      if (!extension) {
        warnings.push({
          ...issue,
          code: "artifact_type_not_allowed",
          allowedArtifacts: capabilities.allowed_artifacts.map((candidate) => ({
            type: candidate.type,
            extensions: candidate.extensions,
            mimeTypes: candidate.mime_types,
          })),
        });
        continue;
      }
      const bytes = Buffer.from(image.base64, "base64");
      // Buffer.from tolerates malformed base64, so re-validate and never share a corrupted image.
      if (
        !bytes.length ||
        bytes.toString("base64").replace(/=+$/u, "") !== image.base64.replace(/=+$/u, "")
      ) {
        warnings.push({
          ...issue,
          code: "artifact_read_failed",
          availability: "unknown",
        });
        continue;
      }
      const ref = `inline-tool-image:${row.rowId}:${index}`;
      bytesBySourceRef.set(ref, bytes);
      rows.push({
        kind: "artifact",
        rowId: ++nextRowId,
        turnId: row.turnId,
        productTurnId: row.productTurnId,
        createdAt: row.createdAt,
        createdAtSeq: row.createdAtSeq,
        artifactVersionId: ref,
        logicalArtifactKey: ref,
        displayName,
        artifactType: "image",
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ref,
        state: "current",
      });
    }
  }
  return { rows, bytesBySourceRef, warnings };
}
