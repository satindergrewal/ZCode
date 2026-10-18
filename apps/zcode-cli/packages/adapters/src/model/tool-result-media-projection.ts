import type { ModelMessage as AiSdkModelMessage } from "ai";
import {
  getUnsupportedModelInputMediaKind,
  modelMessageContentToText,
  type ModelInputFormat,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { containsOfficialCuaImageRefCredentialText } from "@zcode/zcode-cua/frame-contract";
import { dataUrlToDataContent, unsupportedInputMediaText } from "./media-transform-policy.js";

type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];
type AiSdkUserContentParts = Extract<AiSdkUserContent, unknown[]>;

interface ToolResultMediaProjectionOptions {
  apiFormat?: string;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
  toolName: string;
}

const CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS = new Set(["openai-compatible", "gateway"]);
const TOOL_RESULT_MEDIA_INTRO_PREFIX = "Tool result media from";

export function shouldTextifyStructuredToolResults(
  options: Pick<ToolResultMediaProjectionOptions, "apiFormat" | "providerKind">,
): boolean {
  if (options.apiFormat !== undefined) {
    return options.apiFormat === "openai-chat-completions";
  }
  // Root cause: the openai kind uses the Responses API; family-wide OpenAI-like detection would
  // misproject it into Chat Completions tool text + synthetic user. Without an explicit format, fall back only for
  // providers actually using Chat-style results; an explicit apiFormat always wins.
  return (
    options.providerKind !== undefined &&
    CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS.has(options.providerKind)
  );
}

/**
 * Whether the tool result carries video media. The AI SDK tool result part has no video variant (beyond
 * image-data only file-data/pdf), so video-bearing tool results on every provider kind (anthropic included)
 * must go through textify + trailing user part projection, or video content is lost at the wire boundary.
 */
export function toolResultHasVideoMedia(content: ModelMessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "video");
}

/**
 * Pairing rule (producer predicate driven): a text block right after a media block whose content is producer-issued
 * media credentials (image_ref etc.) is that media's paired text.
 * When provider projection defers media into a separate user message (openai-like textify), the paired
 * text must be deferred in the same order: leaving it in tool text would split reference and
 * referenced media across two messages, easily mispaired with multiple frames.
 * Plain prose (explanations, summaries) is not a credential and never pairs; generic tool media semantics
 * stay untouched; credential detection is part of the producer frame contract, referenced via frame-contract.
 * Producer canonical order is image-first (raster first, image_ref right behind).
 * Pairing looks backward from the image to its authority, relying on no provider-specific truncation.
 */
type PairedTextOptions = Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">;

function isPairedTextBlock(
  content: ModelMessageContentBlock[],
  index: number,
  options: PairedTextOptions,
): boolean {
  const block = content[index];
  if (block?.type !== "text" || block.text.trim().length === 0) return false;
  // Only producer-issued media credentials pair; pairing arbitrary neighbors would change every tool's
  // generic media semantics (an adjacent caption on a screenshot is not media).
  if (!containsOfficialCuaImageRefCredentialText(block.text)) return false;
  // Skipping blank text to find an earlier image breaks the producer-mandated image -> image_ref
  // adjacency and could re-authorize a frame_ref split by an inserted block.
  const candidate = content[index - 1];
  return (
    candidate !== undefined &&
    contentBlockToUserMediaParts(candidate, {
      ...options,
      toolName: "",
    }).length > 0
  );
}

function pairedTextIndexes(
  content: ModelMessageContentBlock[],
  options: PairedTextOptions,
): Set<number> {
  // Under stripMedia media is never deferred (toToolResultMediaUserParts returns empty),
  // so omitting the pairing must not run first or the text vanishes from every message.
  if (options.stripMedia === true) return new Set();
  const paired = new Set<number>();
  for (let index = 0; index < content.length; index += 1) {
    if (isPairedTextBlock(content, index, options)) paired.add(index);
  }
  return paired;
}

export function toStructuredToolResultText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "inputFormat"> = {},
): string {
  if (typeof content === "string") return content;
  const paired = pairedTextIndexes(content, options);
  return modelMessageContentToText(
    content.map((block, index) => {
      // Paired text is deferred together with its media (see toToolResultMediaUserParts); omit it here
      // so the model never sees duplicate reference text in one request.
      if (paired.has(index)) return { type: "text", text: "" };
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      return unsupportedText ? { type: "text", text: unsupportedText } : block;
    }),
  );
}

export function toToolResultMediaUserParts(
  content: ModelMessageContent,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  if (typeof content === "string" || options.stripMedia) return [];
  const blocks = content;
  const paired = pairedTextIndexes(blocks, options);

  const parts: AiSdkUserContentParts = [
    {
      type: "text",
      text: `${TOOL_RESULT_MEDIA_INTRO_PREFIX} ${options.toolName}:`,
    },
  ];
  // The separator only divides two consecutive paired texts. The old parts.length > 1 check assumed
  // paired text always enqueued first (legacy text-first layout); with producer image-first the raster
  // enqueues first and that check would insert a stray empty text block between image and image_ref.
  let lastPushedWasPairedText = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.type === "text" && paired.has(index)) {
      // Paired text enters the deferred message with its adjacent media, order preserved.
      if (lastPushedWasPairedText) parts.push({ type: "text", text: "\n\n" });
      parts.push({ type: "text", text: block.text });
      lastPushedWasPairedText = true;
      continue;
    }
    const mediaParts = contentBlockToUserMediaParts(block, options);
    if (mediaParts.length === 0) continue;
    parts.push(...mediaParts);
    lastPushedWasPairedText = false;
  }
  return parts.length > 1 ? parts : [];
}

function contentBlockToUserMediaParts(
  block: ModelMessageContentBlock,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  switch (block.type) {
    case "image": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      return [{ type: "image", image: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      // Same as the user-message side: video/* file parts become video_url / video blocks via the patched provider package.
      return [{ type: "file", data: data.data, mediaType: block.mediaType }];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) return [];
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (!data) return [];
      return [
        {
          type: "file",
          data: data.data,
          filename: block.name,
          mediaType: block.mediaType,
        },
      ];
    }

    case "text":
    case "reasoning":
    case "resource_link":
      return [];
  }
}

/**
 * Generic fail-closed guard (frame references must never reach the model as reference-present/raster-missing):
 * a structured tool result carries frame-reference text (e.g. CUA image_ref JSON) whose media cannot be
 * delivered (unsupported by the model, or stripMedia): the whole result must hard-error. Placeholder
 * substitution would leave actionable references and induce actions against unseen frames. The rule depends
 * only on the reference-text + undeliverable-media shape, agnostic to the specific tool.
 */
export function undeliverableFrameReferenceText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">,
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  // Same inline scan detector as MCP normalization/hooks: wrapping image_ref in prose
  // must not bypass fail-closed (the boundary never trusts payload shape).
  const frameReferenceIndexes = content.flatMap((block, index) =>
    block.type === "text" && containsOfficialCuaImageRefCredentialText(block.text) ? [index] : [],
  );
  if (frameReferenceIndexes.length === 0) return undefined;
  const unavailable =
    "This tool returned a coordinate frame reference without a deliverable raster. " +
    "No image_ref or raster was exposed; do not use frame-bound coordinates. " +
    "Switch to an image-capable model and capture a new raster first.";
  if (options.stripMedia === true) return unavailable;
  // Every credential must be satisfied by the raster directly before it; unrelated images
  // in the result cannot vouch for an orphan ref.
  return frameReferenceIndexes.every((index) => isPairedTextBlock(content, index, options))
    ? undefined
    : unavailable;
}
