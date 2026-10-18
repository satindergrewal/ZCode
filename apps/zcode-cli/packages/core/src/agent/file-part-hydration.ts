import type {
  AttachmentRef,
  FilePart,
  ModelMessageContentBlock,
  ToolArtifactStorePort,
} from "@zcode/contracts";

export async function filePartToContentBlock(
  part: FilePart,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<ModelMessageContentBlock> {
  const source = attachmentRefFromFilePart(part);
  const dataUrl = await filePartDataUrl(part, artifactStore);
  if (isImageMime(part.mime) && dataUrl) {
    return {
      type: "image",
      mediaType: concreteMediaType(part.mime, dataUrl),
      dataUrl,
      source,
    };
  }

  if (part.mime.startsWith("video/") && dataUrl) {
    return {
      type: "video",
      mediaType: part.mime,
      dataUrl,
      source,
    };
  }

  // Adding video once generalized the existing PDF allowlist to all non-text MIME,
  // letting unsupported types such as audio become provider file inputs after cold resume.
  if (isPdfMime(part.mime) && dataUrl) {
    return {
      type: "file",
      mediaType: "application/pdf",
      name: part.filename,
      dataUrl,
      source,
    };
  }

  const previewText = part.metadata?.preview?.text;
  if (part.mime.startsWith("text/") && typeof previewText === "string") {
    return { type: "text", text: previewText };
  }

  const label =
    part.metadata?.storageKind === "local_ref"
      ? (part.source?.text.value ??
        (part.source?.type === "file" || part.source?.type === "symbol"
          ? part.source.path
          : undefined) ??
        part.metadata.originalUrl ??
        part.url)
      : (part.filename ?? part.url);
  return { type: "text", text: `[Attached ${part.mime}: ${label}]` };
}

type PersistedToolMediaLayoutEntry =
  | { type: "attachment"; attachmentIndex: number }
  | { type: "text"; text: string };

export function projectPersistedToolMediaContent(
  value: unknown,
  attachmentBlocks: ModelMessageContentBlock[],
): ModelMessageContentBlock[] | undefined {
  const layout = parsePersistedToolMediaLayout(value);
  if (!layout) return undefined;
  const content: ModelMessageContentBlock[] = [];
  for (const entry of layout) {
    if (entry.type === "text") {
      content.push({ type: "text", text: entry.text });
      continue;
    }
    const block = attachmentBlocks[entry.attachmentIndex];
    if (!block) return undefined;
    content.push(block);
  }
  return content;
}

function parsePersistedToolMediaLayout(
  value: unknown,
): PersistedToolMediaLayoutEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const layout: PersistedToolMediaLayoutEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (entry.type === "text" && typeof entry.text === "string") {
      layout.push({ type: "text", text: entry.text });
      continue;
    }
    if (
      entry.type === "attachment" &&
      typeof entry.attachmentIndex === "number" &&
      Number.isInteger(entry.attachmentIndex) &&
      entry.attachmentIndex >= 0
    ) {
      layout.push({ type: "attachment", attachmentIndex: entry.attachmentIndex });
      continue;
    }
    return undefined;
  }
  return layout;
}

async function filePartDataUrl(
  part: FilePart,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<string | undefined> {
  if (isUsableDataUrl(part.url)) return part.url;
  const artifactUri = durableArtifactUriFromFilePart(part);
  if (!artifactStore || !artifactUri) return undefined;
  try {
    const artifact = await artifactStore.readToolResultArtifact({ uri: artifactUri });
    return isUsableDataUrl(artifact.content) ? artifact.content : undefined;
  } catch {
    return undefined;
  }
}

function attachmentRefFromFilePart(part: FilePart): AttachmentRef {
  const artifactUri =
    (part.source?.type === "file" || part.source?.type === "symbol") &&
    (isImageMime(part.mime) || part.mime.startsWith("video/") || isPdfMime(part.mime))
      ? durableArtifactUriFromFilePart(part)
      : undefined;
  return {
    id: part.id,
    // Cold-resume bodies come from the durable artifact; if the persisted original path is still used as the
    // current request path, deleting or modifying the file makes base64 and source path point at different content;
    // image/video with an artifact are always restored inline, with request projection rebuilding the path from that artifact.
    kind: artifactUri
      ? "inline"
      : part.source?.type === "resource"
        ? "resource"
        : part.source
          ? "local_file"
          : "inline",
    uri: artifactUri ?? (part.source?.type === "resource" ? part.source.uri : part.url),
    path:
      !artifactUri && (part.source?.type === "file" || part.source?.type === "symbol")
        ? part.source.path
        : undefined,
    mimeType: part.mime,
    sizeBytes: part.metadata?.sizeBytes,
    sha256: part.metadata?.sha256,
    placeholder: part.source?.text.value ?? part.filename,
  };
}

function durableArtifactUriFromFilePart(part: FilePart): string | undefined {
  const artifactUri = part.metadata?.artifactUri ?? part.url;
  return artifactUri.startsWith("zcode-artifact://") ? artifactUri : undefined;
}

function isImageMime(mime: string): boolean {
  return mime === "image/*" || mime.startsWith("image/");
}

function isPdfMime(mime: string): boolean {
  return mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

function isUsableDataUrl(value: string): boolean {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex >= 0 && value.slice(commaIndex + 1).length > 0;
}

function concreteMediaType(mime: string, dataUrl: string): string {
  if (mime !== "image/*") return mime;
  const match = /^data:([^;,]+)(?:;base64)?,/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? "image/png";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
