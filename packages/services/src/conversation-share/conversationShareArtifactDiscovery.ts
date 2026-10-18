/* oxlint-disable eslint(max-lines) -- input attachment staging and preview artifact discovery share one immutable snapshot boundary. */
import { createHash } from "node:crypto";

import {
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
  type ConversationPreviewFileChange,
  type ConversationShareCapabilities,
} from "@zcode/shared";
import type {
  ArtifactRow,
  ConversationArtifactType,
  ConversationRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type {
  ConversationShareFailureIssue,
  PublishTextConversationInput,
} from "./conversationShare.js";
import { ConversationShareServiceError } from "./conversationShare.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import type { ConversationSharePublicArtifact } from "./conversationSharePublicProjection.js";

interface MaterializedShareArtifact {
  sourceRef: string;
  canonicalPath: string;
  bytes: Uint8Array;
}

interface DiscoveredShareArtifact extends MaterializedShareArtifact {
  row: ArtifactRow;
}

interface ConversationShareArtifactSnapshot {
  rows: ConversationRow[];
  bytesBySourceRef: Map<string, Uint8Array>;
  additionalArtifacts: ConversationSharePublicArtifact[];
  issues: ConversationShareFailureIssue[];
  /** Non-blocking: skipped preview artifacts; publishing continues. */
  warnings: ConversationShareFailureIssue[];
}

export interface ConversationSharePreviewPreflightSnapshot {
  revision: number;
  logEpoch: string;
  capabilitiesFingerprint: string;
  candidateFingerprint: string;
  visibleSourceRefs: readonly string[];
}

export function getConversationSharePreviewCandidateFingerprint(
  candidates: readonly ConversationPreviewArtifactCandidate[],
): string {
  return JSON.stringify(
    candidates.map((candidate) => ({
      sourceRef: candidate.sourceRef,
      displayName: candidate.displayName,
      previewKind: candidate.previewKind,
      artifactType: candidate.artifactType,
      mimeType: candidate.mimeType,
      productTurnId: candidate.productTurnId,
      requiresFileChanges: candidate.requiresFileChanges,
    })),
  );
}

function throwDiscoveryError(message: string): never {
  throw new ConversationShareServiceError("invalid_conversation", message);
}

function fileNameOf(path: string): string {
  return path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
}

function extensionOf(path: string): string | null {
  const fileName = fileNameOf(path);
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : null;
}

function matchAllowedArtifact(
  capabilities: ConversationShareCapabilities,
  candidate: Pick<ConversationPreviewArtifactCandidate, "mimeType" | "previewKind" | "sourceRef">,
): { artifactType: ConversationArtifactType; mimeType: string } | null {
  // Video/audio are preview-card candidates only; ConversationArtifactType has no media enum, so
  // even an unexpected media entry in server capabilities must not re-enter the uploadable manifest.
  if (candidate.previewKind === "video" || candidate.previewKind === "audio") {
    return null;
  }
  const extension = extensionOf(candidate.sourceRef);
  if (!extension) return null;
  const allowed = capabilities.allowed_artifacts.find(
    (allowedCandidate) =>
      allowedCandidate.extensions.some(
        (candidateExtension) => candidateExtension.replace(/^\./u, "").toLowerCase() === extension,
      ) &&
      allowedCandidate.mime_types.some(
        (candidateMimeType) => candidateMimeType.toLowerCase() === candidate.mimeType,
      ),
  );
  if (!allowed) return null;
  return { artifactType: allowed.type, mimeType: candidate.mimeType };
}

async function materializeRegisteredArtifacts(options: {
  workspacePath: string;
  maxArtifactBytes: number;
  artifacts: ConversationSharePublicArtifact[];
  artifactSource: ConversationShareArtifactSource;
}): Promise<MaterializedShareArtifact[]> {
  const materialized: MaterializedShareArtifact[] = [];
  for (const artifact of options.artifacts) {
    const { bytes, canonicalPath } = await options.artifactSource.read({
      workspacePath: options.workspacePath,
      ref: artifact.sourceRef,
      maxBytes: options.maxArtifactBytes,
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Rows are recorded at tool completion and the user may edit the same path before publishing;
    // re-verify current bytes or the projection/manifest describe the old file while multipart
    // uploads the new one.
    if (
      bytes.byteLength !== artifact.descriptor.size_bytes ||
      sha256 !== artifact.descriptor.sha256
    ) {
      throwDiscoveryError("Conversation artifact changed after it was registered");
    }
    materialized.push({ sourceRef: artifact.sourceRef, canonicalPath, bytes });
  }
  return materialized;
}

async function discoverPreviewArtifacts(options: {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "conversationFileChangesV4" | "conversationAttachmentReadV4"
  >;
  artifactSource: ConversationShareArtifactSource;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  capabilities: ConversationShareCapabilities;
  revision: number;
  logEpoch: string;
  existingCanonicalPaths: Set<string>;
  issues: ConversationShareFailureIssue[];
  warnings: ConversationShareFailureIssue[];
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
  preflightPreviewSnapshots?: ReadonlyMap<string, ConversationSharePreviewPreflightSnapshot>;
  currentCapabilitiesFingerprint?: string;
}): Promise<DiscoveredShareArtifact[]> {
  const headersByProductTurnId = new Map<string, TurnHeaderRow>();
  for (const row of options.selectedRows) {
    if (
      row.kind === "turnHeader" &&
      row.productTurnId &&
      (row.state === "completedSuccess" || row.state === "completedInterrupted")
    ) {
      headersByProductTurnId.set(row.productTurnId, row);
    }
  }
  const turnOrdinalByProductTurnId = new Map<string, number>(options.turnOrdinalByProductTurnId);
  for (const row of options.selectedRows) {
    if (
      row.kind !== "turnHeader" ||
      !row.productTurnId ||
      turnOrdinalByProductTurnId.has(row.productTurnId)
    ) {
      continue;
    }
    turnOrdinalByProductTurnId.set(row.productTurnId, turnOrdinalByProductTurnId.size + 1);
  }
  const assistantTextByProductTurnId = new Map<string, string[]>();
  for (const row of options.selectedRows) {
    if (row.kind !== "assistantText" || !row.productTurnId) continue;
    const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
    texts.push(row.text);
    assistantTextByProductTurnId.set(row.productTurnId, texts);
  }
  const discovered: DiscoveredShareArtifact[] = [];
  const maxSourceRowId = options.selectedRows.reduce(
    (maximum, row) => Math.max(maximum, row.rowId),
    0,
  );

  for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
    const header = headersByProductTurnId.get(productTurnId);
    if (!header) continue;
    const assistantText = textParts.join("\n\n");
    const references = extractConversationPreviewFileReferences(
      assistantText,
      options.input.workspacePath,
    );
    const needsFileChanges = references.some(
      (reference) => reference.kind === "markdown" || reference.kind === "html",
    );
    let fileChanges: ConversationPreviewFileChange[] | undefined;
    if (needsFileChanges && header.fileChanges?.state !== "reverted") {
      if (!header.entityId || !header.productTurnId) {
        throwDiscoveryError("Conversation file changes are missing a stable turn identity");
      }
      let result: Awaited<ReturnType<IZCodeAgentService["conversationFileChangesV4"]>>;
      try {
        result = await options.zcodeAgentService.conversationFileChangesV4({
          workspacePath: options.input.workspacePath,
          ...(options.input.workspaceIdentity
            ? { workspaceIdentity: options.input.workspaceIdentity }
            : {}),
          ...(options.input.remoteSessionId
            ? { remoteSessionId: options.input.remoteSessionId }
            : {}),
          sessionId: options.input.sessionId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: options.revision,
          baseLogEpoch: options.logEpoch,
        });
      } catch (error) {
        // rows/range and fileChanges are two read-only RPCs; if the projection advances in between,
        // continuing stitches together different revisions. Fail explicitly on a stale watermark
        // before prepare.
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("proto.staleRevision") || message.includes("proto.staleLogEpoch")) {
          throwDiscoveryError("Conversation changed while preparing share");
        }
        throw error;
      }
      fileChanges = result.items.map((item) => ({
        path: item.path,
        state: result.state === "reverted" ? "reverted" : "active",
      }));
    }

    const candidates = buildConversationPreviewArtifactCandidates({
      assistantText,
      productTurnId,
      workspacePath: options.input.workspacePath,
      fileChanges,
    });
    const preflightSnapshot = options.preflightPreviewSnapshots?.get(productTurnId);
    const preflightMatches =
      preflightSnapshot !== undefined &&
      preflightSnapshot.revision === options.revision &&
      preflightSnapshot.logEpoch === options.logEpoch &&
      preflightSnapshot.capabilitiesFingerprint === options.currentCapabilitiesFingerprint &&
      preflightSnapshot.candidateFingerprint ===
        getConversationSharePreviewCandidateFingerprint(candidates);
    const candidatesForPublish = preflightMatches
      ? candidates.filter((candidate) =>
          preflightSnapshot.visibleSourceRefs.includes(candidate.sourceRef),
        )
      : candidates;
    const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
    const previewCanonicalPaths = new Set<string>();
    const fallbackReadCache = new Map<string, { bytes: Uint8Array; canonicalPath: string }>();
    for (const candidate of candidatesForPublish) {
      // Mirror the UI preview card: stat first to see if the card still exists, then judge share capability.
      // Surface a warning when re-confirmation fails at publish time, or the share succeeds while
      // silently dropping cards visible at selection.
      const visibleCandidateSource = {
        workspacePath: options.input.workspacePath,
        ref: candidate.sourceRef,
      } as const;
      try {
        if (options.artifactSource.stat) {
          const stat = await options.artifactSource.stat(visibleCandidateSource);
          if (previewCanonicalPaths.has(stat.canonicalPath)) continue;
          previewCanonicalPaths.add(stat.canonicalPath);
        } else {
          // artifactSource.stat is optional; not every test double or legacy runtime implements it.
          // Fall back to read for existence, staying backward compatible: inline references still
          // discover artifacts.
          const materialized = await options.artifactSource.read({
            ...visibleCandidateSource,
            maxBytes: options.capabilities.max_artifact_bytes,
          });
          if (previewCanonicalPaths.has(materialized.canonicalPath)) continue;
          previewCanonicalPaths.add(materialized.canonicalPath);
          fallbackReadCache.set(candidate.sourceRef, materialized);
        }
      } catch (error) {
        if (
          error instanceof ConversationShareServiceError &&
          error.reasonCode === "artifact_read_failed"
        ) {
          options.warnings.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            artifactDisplayName: candidate.displayName,
            artifactType: candidate.artifactType,
            extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
            mimeType: candidate.mimeType,
            availability: error.diagnostics?.errno === "ENOENT" ? "not_found" : "unknown",
          });
          continue;
        }
        throw error;
      }
      if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
        visibleCandidates.push(candidate);
      }
    }

    for (const candidate of visibleCandidates) {
      const match = matchAllowedArtifact(options.capabilities, candidate);
      if (!match) {
        // A type missing from capabilities skips only that candidate and shares the rest; selection
        // preflight and success state share this structured notice, so one unsupported file never
        // fails the whole publish.
        options.warnings.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
          mimeType: candidate.mimeType,
          allowedFormats: options.capabilities.allowed_artifacts.flatMap((allowed) =>
            allowed.extensions.map(
              (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
            ),
          ),
          allowedArtifacts: options.capabilities.allowed_artifacts.map((allowed) => ({
            type: allowed.type,
            extensions: allowed.extensions,
            mimeTypes: allowed.mime_types,
          })),
        });
        continue;
      }
      // Read even after stat passes: the file may change or vanish between selection and publish.
      let materialized;
      const cached = fallbackReadCache.get(candidate.sourceRef);
      try {
        if (cached) {
          materialized = cached;
        } else {
          materialized = await options.artifactSource.read({
            workspacePath: options.input.workspacePath,
            ref: candidate.sourceRef,
            maxBytes: options.capabilities.max_artifact_bytes,
          });
        }
      } catch (error) {
        if (
          !(error instanceof ConversationShareServiceError) ||
          error.reasonCode !== "artifact_read_failed"
        ) {
          // limit_exceeded / unsafe_structure still block: real constraints the user must resolve.
          throw error;
        }
        options.warnings.push({
          code: "artifact_read_failed",
          scope: "artifact",
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: candidate.displayName.split(".").at(-1)?.toLowerCase(),
          mimeType: candidate.mimeType,
          availability: error.diagnostics?.errno === "ENOENT" ? "not_found" : "unknown",
        });
        continue;
      }
      if (options.existingCanonicalPaths.has(materialized.canonicalPath)) continue;
      options.existingCanonicalPaths.add(materialized.canonicalPath);
      const localKey = `preview:${productTurnId}:${candidate.sourceRef}`;
      discovered.push({
        sourceRef: candidate.sourceRef,
        canonicalPath: materialized.canonicalPath,
        bytes: materialized.bytes,
        row: {
          rowId: maxSourceRowId + discovered.length + 1,
          turnId: header.turnId,
          productTurnId: header.productTurnId,
          createdAt: header.endedAt ?? header.createdAt,
          createdAtSeq: header.createdAtSeq,
          kind: "artifact",
          artifactVersionId: localKey,
          logicalArtifactKey: localKey,
          displayName: candidate.displayName,
          artifactType: match.artifactType,
          mimeType: match.mimeType,
          sizeBytes: materialized.bytes.byteLength,
          sha256: createHash("sha256").update(materialized.bytes).digest("hex"),
          ref: candidate.sourceRef,
          state: "current",
        },
      });
    }
  }
  return discovered;
}

async function readInputAttachment(options: {
  zcodeAgentService: Pick<IZCodeAgentService, "conversationAttachmentReadV4">;
  input: PublishTextConversationInput;
  row: Extract<ConversationRow, { kind: "userInput" }>;
  attachmentIndex: number;
  maxBytes: number;
}): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const attachment = options.row.attachments?.[options.attachmentIndex];
  if (!attachment || !options.row.entityId) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment is missing a stable row identity",
    );
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let totalBytes: number | undefined;
  let mediaType = attachment.mime;
  while (true) {
    const result = await options.zcodeAgentService.conversationAttachmentReadV4({
      workspacePath: options.input.workspacePath,
      ...(options.input.workspaceIdentity
        ? { workspaceIdentity: options.input.workspaceIdentity }
        : {}),
      ...(options.input.remoteSessionId ? { remoteSessionId: options.input.remoteSessionId } : {}),
      sessionId: options.input.sessionId,
      ref: attachment.ref,
      target: { rowId: options.row.rowId, entityId: options.row.entityId },
      attachmentIndex: options.attachmentIndex,
      offset,
      limit: Math.min(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes, options.maxBytes),
    });
    const bytes = new Uint8Array(Buffer.from(result.dataBase64, "base64"));
    totalBytes ??= result.totalBytes;
    mediaType = result.mediaType || mediaType;
    if (totalBytes > options.maxBytes || (bytes.byteLength === 0 && result.nextOffset !== null)) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation input attachment exceeds the byte limit",
      );
    }
    chunks.push(bytes);
    offset += bytes.byteLength;
    if (result.nextOffset === null) break;
    if (result.nextOffset !== offset || result.nextOffset > totalBytes) {
      throw new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation input attachment returned invalid read progress",
      );
    }
  }
  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  if (
    totalBytes !== output.byteLength ||
    (attachment.bytes > 0 && attachment.bytes !== output.byteLength)
  ) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment changed before sharing",
    );
  }
  if (output.byteLength === 0) {
    throw new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation input attachment is empty",
    );
  }
  return { bytes: output, mediaType };
}

async function discoverInputAttachments(options: {
  zcodeAgentService: Pick<IZCodeAgentService, "conversationAttachmentReadV4">;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  capabilities: ConversationShareCapabilities;
  warnings: ConversationShareFailureIssue[];
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
}): Promise<{
  rows: ConversationRow[];
  artifacts: ConversationSharePublicArtifact[];
  bytesBySourceRef: Map<string, Uint8Array>;
}> {
  const rows = options.selectedRows.map((row) =>
    row.kind === "userInput"
      ? { ...row, attachments: row.attachments?.map((attachment) => ({ ...attachment })) }
      : row,
  );
  const artifacts: ConversationSharePublicArtifact[] = [];
  const bytesBySourceRef = new Map<string, Uint8Array>();
  let artifactIndex = 0;
  for (const row of rows) {
    if (row.kind !== "userInput" || !row.attachments || row.attachments.length === 0) continue;
    const nextAttachments = [];
    for (const [attachmentIndex, attachment] of row.attachments.entries()) {
      const extension = extensionOf(attachment.fileName) ?? "txt";
      const mimeType = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() || "text/plain";
      const allowed = options.capabilities.allowed_artifacts.find(
        (candidate) =>
          candidate.extensions.some(
            (value) => value.replace(/^\./u, "").toLowerCase() === extension,
          ) && candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
      );
      const turnOrdinal = row.productTurnId
        ? options.turnOrdinalByProductTurnId?.get(row.productTurnId)
        : undefined;
      if (!allowed) {
        options.warnings.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          rowId: row.rowId,
          ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
          artifactDisplayName: attachment.fileName,
          artifactType: extension === "txt" ? "text" : extension,
          extension,
          mimeType,
          allowedArtifacts: options.capabilities.allowed_artifacts.map((candidate) => ({
            type: candidate.type,
            extensions: candidate.extensions,
            mimeTypes: candidate.mime_types,
          })),
        });
        continue;
      }
      try {
        const materialized = await readInputAttachment({
          zcodeAgentService: options.zcodeAgentService,
          input: options.input,
          row,
          attachmentIndex,
          maxBytes: options.capabilities.max_artifact_bytes,
        });
        const sourceRef = `input:${row.rowId}:${attachmentIndex}`;
        const artifactId = `share-input-artifact-${++artifactIndex}`;
        const ref = `zcode-artifact://share/${artifactId}`;
        const sha256 = createHash("sha256").update(materialized.bytes).digest("hex");
        artifacts.push({
          sourceRef,
          descriptor: {
            artifact_id: artifactId,
            logical_artifact_key: `share-input-key-${artifactIndex}`,
            producer_product_turn_id: row.productTurnId ?? row.turnId,
            artifact_version: 1,
            state: "current",
            ref,
            artifact_type: allowed.type,
            display_name: attachment.fileName,
            extension,
            mime_type: mimeType,
            size_bytes: materialized.bytes.byteLength,
            sha256,
          },
        });
        bytesBySourceRef.set(sourceRef, materialized.bytes);
        nextAttachments.push({
          ...attachment,
          ref,
          previewRef: ref,
          bytes: materialized.bytes.byteLength,
        });
      } catch (error) {
        const faultCode = readZCodeAttachmentFaultCode(error);
        if (
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
        ) {
          throw new ConversationShareServiceError(
            "artifact_protocol_not_ready",
            "Conversation input attachment is not authorized",
            { reasonCode: "artifact_protocol_not_ready" },
          );
        }
        if (
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge ||
          faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge
        ) {
          // Size overflow is a definite block; never downgrade to an attachment-unavailable warning
          // and publish silently - receivers get no artifact and sharers cannot see the error class
          // (same-named preflight classification).
          throw new ConversationShareServiceError(
            "limit_exceeded",
            "Conversation input attachment exceeds the artifact size limit",
            {
              reasonCode: "artifact_size_limit",
              issues: [
                {
                  code: "artifact_size_limit",
                  scope: "artifact",
                  rowId: row.rowId,
                  ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
                  ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
                  artifactDisplayName: attachment.fileName,
                  artifactType: allowed.type,
                  extension,
                  mimeType,
                  limit: options.capabilities.max_artifact_bytes,
                },
              ],
            },
          );
        }
        options.warnings.push({
          code: "input_attachment_unavailable",
          scope: "artifact",
          rowId: row.rowId,
          ...(turnOrdinal === undefined ? {} : { turnOrdinal }),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachment.fileName,
          artifactType: allowed.type,
          extension,
          mimeType,
          availability:
            faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
            faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile ||
            (error instanceof ConversationShareServiceError &&
              error.diagnostics?.errno === "ENOENT")
              ? "not_found"
              : "unknown",
        });
      }
    }
    if (nextAttachments.length > 0) {
      row.attachments = nextAttachments;
    } else {
      delete row.attachments;
    }
  }
  return { rows, artifacts, bytesBySourceRef };
}

function insertDiscoveredArtifacts(
  selectedRows: ConversationRow[],
  artifacts: DiscoveredShareArtifact[],
): ConversationRow[] {
  if (artifacts.length === 0) return selectedRows;
  const artifactsByProductTurnId = new Map<string, ArtifactRow[]>();
  for (const artifact of artifacts) {
    const productTurnId = artifact.row.productTurnId ?? "";
    const productTurnArtifacts = artifactsByProductTurnId.get(productTurnId);
    if (productTurnArtifacts) productTurnArtifacts.push(artifact.row);
    else artifactsByProductTurnId.set(productTurnId, [artifact.row]);
  }
  const lastRowIndexByProductTurnId = new Map<string, number>();
  selectedRows.forEach((row, index) => {
    if (row.productTurnId) lastRowIndexByProductTurnId.set(row.productTurnId, index);
  });
  return selectedRows.flatMap((row, index) => {
    if (!row.productTurnId || lastRowIndexByProductTurnId.get(row.productTurnId) !== index) {
      return [row];
    }
    return [row, ...(artifactsByProductTurnId.get(row.productTurnId) ?? [])];
  });
}

export async function buildConversationShareArtifactSnapshot(options: {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    "conversationFileChangesV4" | "conversationAttachmentReadV4"
  >;
  artifactSource: ConversationShareArtifactSource;
  input: PublishTextConversationInput;
  selectedRows: ConversationRow[];
  registeredArtifacts: ConversationSharePublicArtifact[];
  capabilities: ConversationShareCapabilities;
  revision: number;
  logEpoch: string;
  turnOrdinalByProductTurnId?: ReadonlyMap<string, number>;
  preflightPreviewSnapshots?: ReadonlyMap<string, ConversationSharePreviewPreflightSnapshot>;
  currentCapabilitiesFingerprint?: string;
}): Promise<ConversationShareArtifactSnapshot> {
  const issues: ConversationShareFailureIssue[] = [];
  const warnings: ConversationShareFailureIssue[] = [];
  const inputAttachments = await discoverInputAttachments({
    zcodeAgentService: options.zcodeAgentService,
    input: options.input,
    selectedRows: options.selectedRows,
    capabilities: options.capabilities,
    warnings,
    turnOrdinalByProductTurnId: options.turnOrdinalByProductTurnId,
  });
  const selectedRows = inputAttachments.rows;
  const registered = await materializeRegisteredArtifacts({
    workspacePath: options.input.workspacePath,
    maxArtifactBytes: options.capabilities.max_artifact_bytes,
    artifacts: options.registeredArtifacts,
    artifactSource: options.artifactSource,
  });
  const discovered = await discoverPreviewArtifacts({
    ...options,
    selectedRows,
    issues,
    warnings,
    existingCanonicalPaths: new Set(registered.map((artifact) => artifact.canonicalPath)),
    turnOrdinalByProductTurnId: options.turnOrdinalByProductTurnId,
    preflightPreviewSnapshots: options.preflightPreviewSnapshots,
    currentCapabilitiesFingerprint: options.currentCapabilitiesFingerprint,
  });
  return {
    rows: insertDiscoveredArtifacts(selectedRows, discovered),
    bytesBySourceRef: new Map(
      [
        ...registered,
        ...discovered,
        ...[...inputAttachments.bytesBySourceRef.entries()].map(([sourceRef, bytes]) => ({
          sourceRef,
          bytes,
          canonicalPath: sourceRef,
        })),
      ].map((artifact) => [artifact.sourceRef, artifact.bytes]),
    ),
    additionalArtifacts: inputAttachments.artifacts,
    issues,
    warnings,
  };
}
