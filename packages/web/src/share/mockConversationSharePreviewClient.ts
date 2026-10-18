import type { ConversationShareAccessMode, ConversationSharePreview } from "@zcode/shared";
import { ConversationSharePreviewClientError } from "./conversationSharePreviewClient.js";

function previewFor(accessMode: ConversationShareAccessMode): ConversationSharePreview {
  const createdAt = Date.now() - 60_000;
  return {
    schema_version: 1,
    unsupportedRowCount: 0,
    share: {
      title: accessMode === "private" ? "Private share" : "Conversation share preview",
      access_mode: accessMode,
      created_at: createdAt,
      expires_at: createdAt + 24 * 60 * 60 * 1_000,
    },
    rows: [
      {
        rowId: 1,
        turnId: "share-turn-1",
        productTurnId: "share-product-turn-1",
        createdAt,
        createdAtSeq: 1,
        kind: "userInput",
        origin: "realUser",
        text: "Introduce this share page.",
      },
      {
        rowId: 2,
        turnId: "share-turn-1",
        productTurnId: "share-product-turn-1",
        createdAt: createdAt + 1_000,
        createdAtSeq: 2,
        kind: "assistantText",
        text: "This is a public ZCode conversation share.",
        state: "complete",
      },
      // Give the dev mock an artifact card: its visuals must match AssistantPreviewCards in
      // the body, and without sample data that is guesswork.
      {
        rowId: 3,
        turnId: "share-turn-1",
        productTurnId: "share-product-turn-1",
        createdAt: createdAt + 2_000,
        createdAtSeq: 3,
        kind: "artifact",
        artifactVersionId: "mock-artifact-1",
        logicalArtifactKey: "mock-report",
        displayName: "MorningReport_2026-08-28_Standup.pdf",
        artifactType: "pdf",
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "c".repeat(64),
        ref: "zcode-artifact://share/mock-artifact-1",
        state: "current",
      },
    ],
    artifacts: [
      {
        artifact_id: "mock-artifact-1",
        logical_artifact_key: "mock-report",
        producer_product_turn_id: "share-product-turn-1",
        artifact_version: 1,
        state: "current",
        ref: "zcode-artifact://share/mock-artifact-1",
        artifact_type: "pdf",
        display_name: "MorningReport_2026-08-28_Standup.pdf",
        extension: "pdf",
        mime_type: "application/pdf",
        size_bytes: 172_974,
        sha256: "c".repeat(64),
        url: "https://example.invalid/mock-artifact-1.pdf",
        url_expires_at: createdAt + 24 * 60 * 60 * 1_000,
      },
    ],
    integrity: {
      projection_sha256: "a".repeat(64),
      artifact_set_sha256: "b".repeat(64),
    },
  };
}

export class MockConversationSharePreviewClient {
  async getPreview(shareCode: string, accessToken?: string): Promise<ConversationSharePreview> {
    if (shareCode === "mock-expired") {
      throw new ConversationSharePreviewClientError({
        kind: "expired",
        message: "Share expired",
        status: 410,
        code: 3212,
      });
    }
    if (shareCode === "mock-not-found") {
      throw new ConversationSharePreviewClientError({
        kind: "not_found",
        message: "Share not found",
        status: 404,
        code: 3211,
      });
    }
    if (shareCode === "mock-private" && accessToken !== "mock-owner-token") {
      throw new ConversationSharePreviewClientError({
        kind: "not_found",
        message: "Share not found",
        status: 404,
        code: 3211,
      });
    }
    // Two manual acceptance entry points for cross-version compat (the real path classifies
    // these in conversationSharePreviewClient).
    if (shareCode === "mock-outdated-client") {
      throw new ConversationSharePreviewClientError({
        kind: "unsupported_schema_version",
        message: "Share requires a newer ZCode",
        status: 200,
      });
    }
    // Known rows render normally; one row this build cannot parse is skipped -- the soft
    // notice should appear at the top.
    if (shareCode === "mock-partial-unsupported") {
      return { ...previewFor("public_importable"), unsupportedRowCount: 1 };
    }
    if (shareCode === "mock-readonly") return previewFor("public_readonly");
    if (shareCode === "mock-private") return previewFor("private");
    return previewFor("public_importable");
  }
}
