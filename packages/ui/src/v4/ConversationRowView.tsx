import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { expandTopicInputMessages } from "@/v4/topicInputMessages.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
/* oxlint-disable eslint(max-lines) -- v4 per-row render dispatch lives here (one memoized leaf per row kind + timelineMarker dividers); splitting it would break the row-kind mapping. */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArchiveIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  Clock,
  CopyIcon,
  FileClockIcon,
  FileIcon,
  GitBranchIcon,
  GoalIcon,
  PencilIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrendingUpDownIcon,
  XIcon,
} from "lucide-react";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_ATTACHMENT_REMOVE,
  TID_V4_EDIT_CANCEL,
  TID_V4_EDIT_INPUT,
  TID_V4_EDIT_SUBMIT,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FEEDBACK_LIKE,
  TID_V4_FORK,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  parseAutomationRunId,
  testId,
} from "@zcode/shared";
import type {
  AttachmentRef,
  ArtifactRow,
  AssistantTextRow,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { PdfViewerRangeSource } from "@/components/ui/pdf-viewer.js";
import { MessageAction, MessageActions } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import {
  readWorkflowName,
  readWorkflowRetuneCall,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { WorkflowRetuneRow } from "@/ToolCallBlocks/renderers/WorkflowRetuneRow.js";
import { workflowRunDefaultConcurrency } from "@/components/workflow-timeline/workflowRunSettings.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import {
  readWorkflowHoleTarget,
  workflowFillCounts,
} from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import { PluginUiModelContextChip, formatPluginDisplayName } from "@/plugin-ui/index.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import {
  FileDisplayIcon,
  FileDisplayInline,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { formatMessageTimeLabel } from "@/v4/messageTimeLabel.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";

function RowShell({
  rowId,
  children,
  className = "",
}: {
  rowId: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-row-id={rowId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

const ArtifactRowView = memo(function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {row.artifactType.toUpperCase()} · {row.sizeBytes} bytes
          </p>
        </div>
      </div>
    </RowShell>
  );
});

/** Copy-row-text: ghost icon button + 1200ms check state (mirrors the old message copy).
 *  label/tooltip must come from the caller as i18n strings; never hardcode a language. */
const CopyRowAction = memo(function CopyRowAction({
  text,
  rowId,
  label,
  tooltip = label,
}: {
  text: string;
  rowId: number;
  label: string;
  tooltip?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!text || !navigator.clipboard) return;
    void runUserActionAsync({
      input: { featureId: "conversation.history.feedback", action: "copy", trigger: "button" },
      operation: () => navigator.clipboard.writeText(text),
      completed: { resultSource: "platform_result" },
      failureStage: "clipboard_write",
    }).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <MessageAction
      aria-label={label}
      label={label}
      tooltip={tooltip}
      data-testid={`v4-copy-${rowId}`}
      disabled={text.length === 0}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
});

type UserInputEditHandler = (
  target: ConversationRowTarget,
  newText: string,
  attachments?: readonly AttachmentRef[],
  workspaceMode?: "preserve" | "rewind",
  conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;

type AssistantMessageFeedback = "like" | "dislike";

function getAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export type AssistantFeedbackHandler = (
  target: ConversationRowTarget,
  feedback: AssistantMessageFeedback | null,
) => Promise<boolean | void> | boolean | void;

export function readAssistantFeedback(row: AssistantTextRow): AssistantMessageFeedback | null {
  // feedback is an additive V4 row field; null by default for rows from older CLIs.
  const feedback = row.feedback;
  return feedback === "like" || feedback === "dislike" ? feedback : null;
}

export interface EditWorkspaceRewindAvailability {
  enabled: boolean;
  reason: "available" | "noFiles" | "reverted" | "running" | "unavailable";
}

export interface ConversationRowViewProps {
  row: ConversationRow;
  /** Render context (theme/codePreviewSettings/workspacePath); the host guarantees stable references. */
  context: ConversationRowRenderContext;
  /** Fork entry for completed assistant rows (forkAssistant command). */
  onFork?: (target: ConversationRowTarget) => void;
  /** Assistant-entity feedback CAS; the UI updates optimistically and rolls back when the command fails. */
  onFeedbackChange?: AssistantFeedbackHandler;
  // Protocol compatibility: callers may still provide the retryTurn capability, but the product UI renders no plain retry entry.
  onRetry?: (target: ConversationRowTarget) => void;
  /** Edit entry for user rows (editUserQuery command replaces the turn with the inline edit text). */
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  /** When nested in a tool group, drop the Reasoning block duplicate left rule and indent. */
  reasoningContentVariant?: "default" | "nested";
  /** Renderer-only submission state; never written into protocol rows nor passed off as drained history. */
  userInputStatus?: string;
  /**
   // One turn is one reply to the user: non-final text segments render no
   // actions (no copy, no fork); entries exist only on the turn-final segment.
   */
  hideAssistantActions?: boolean;
  /** TurnGroup defers turn-level actions until after the file summary. */
  deferAssistantActions?: boolean;
  /** Turn-final copy content = all text segments of the turn merged (not just the last one). */
  assistantCopyText?: string;
  /** Assistant preview cards are computed by TurnGroup for the turn-final terminal assistant text only. */
  assistantPreviewCards?: AssistantPreviewCard[];
  /** One-shot auto-open identity, issued only when this renderer observes running -> complete. */
  assistantPreviewCardsAutoOpenKey?: string;
  /** Assistant code-comment cards are computed by TurnGroup for the turn-final terminal assistant text only. */
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  /** TurnGroup alone decides whether the turn body hides the raw code-comment protocol text. */
  assistantCodeCommentProjectionEnabled?: boolean;
}

// Each row kind is its own memoized leaf: under virtualization a parent re-render re-renders
// only rows whose props changed. Hookful row kinds (assistantText/toolCall) keep their hooks
// inside their components, avoiding conditional hooks in the dispatch switch.

/**
 * Attachment rendering: the row stores only AttachmentRef; image mounts read thumbnails in chunks by session/ref, and clicks reuse the loaded URL in the shared preview.
 * Non-images and failed images stay non-interactive, avoiding fake hand cursors over dead controls.
 */
const UserInputAttachmentList = memo(function UserInputAttachmentList({
  attachments,
  attachmentIndices,
  entityId,
  attachmentKind = "all",
  directItems = false,
  onRemove,
  rowId,
  sessionId,
  readAttachment,
  readAttachmentRange,
}: {
  attachments: readonly AttachmentRef[] | undefined;
  /** A deleted attachment in edit mode keeps its original index in the persisted FilePart list. */
  attachmentIndices?: readonly number[];
  entityId?: string;
  attachmentKind?: "all" | "media" | "file";
  directItems?: boolean;
  onRemove?: (index: number) => void;
  rowId: number;
  sessionId?: string;
  readAttachment?: NonNullable<ConversationRowRenderContext["readAttachment"]>;
  readAttachmentRange?: NonNullable<ConversationRowRenderContext["readAttachmentRange"]>;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failedRefs, setFailedRefs] = useState<ReadonlySet<string>>(() => new Set());
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Visible message rows prefetch image/video Blobs: images render directly, videos show the first frame in a chromeless player;
  // the video URL is also reused by the gallery so a click never re-reads the large file.
  const [videoPreview, setVideoPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [videoPreviewRef, setVideoPreviewRef] = useState<string | null>(null);
  const [videoPreviewLoading, setVideoPreviewLoading] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState(false);
  const [textPreview, setTextPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState(false);
  const textReadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => textReadAbort.current?.abort(), []);
  const closeTextPreview = () => {
    textReadAbort.current?.abort();
    textReadAbort.current = null;
    setTextPreview(null);
  };
  const openTextPreview = async (attachment: AttachmentRef, index: number) => {
    if (!sessionId || !readAttachment) return;
    textReadAbort.current?.abort();
    const controller = new AbortController();
    textReadAbort.current = controller;
    setTextPreview({ filename: attachment.fileName, mediaType: "text/plain" });
    setTextLoading(true);
    setTextError(false);
    try {
      const result = await readAttachment({
        sessionId,
        ref: attachment.ref,
        mediaType: attachment.mime,
        ...(entityId ? { target: { rowId, entityId }, attachmentIndex: index } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!("bytes" in result)) throw new Error("Text attachment bytes unavailable");
      setTextPreview({
        filename: attachment.fileName,
        mediaType: "text/plain",
        textContent: new TextDecoder().decode(result.bytes),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setTextError(true);
        logger.warn("Text attachment preview failed", error);
      }
    } finally {
      if (!controller.signal.aborted) setTextLoading(false);
    }
  };
  const [pdfPreview, setPdfPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState(false);
  const [pdfPreviewRef, setPdfPreviewRef] = useState<string | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const pdfPreviewAbortRef = useRef<AbortController | null>(null);
  const videoPreviewUrlRef = useRef<string | null>(null);
  const videoPreviewRequestRef = useRef(0);
  const videoPreviewAbortRef = useRef<AbortController | null>(null);
  const thumbnailUrlsRef = useRef<Map<string, string>>(new Map());
  const thumbnailObjectUrlsRef = useRef<Set<string>>(new Set());
  const previewOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const previewVideoOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const previewPdfOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openPdf",
  });
  const previewUnavailableLabel = intl.formatMessage({
    id: "chat.attachments.preview.unavailable",
  });

  useEffect(() => {
    if (attachmentKind === "file" || !attachments || !sessionId || !readAttachment) {
      return;
    }
    let cancelled = false;
    // Dropping the read result does not stop the underlying chunked transfer; an unmounted row could still pull the whole video.
    // The prefetch lifecycle must run through the transport via AbortSignal, releasing file IO and IPC resources promptly.
    const controller = new AbortController();
    const mediaAttachments = attachments.flatMap((attachment, index) =>
      attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/")
        ? [{ attachment, index }]
        : [],
    );

    // The V4 virtualized list mounts only visible rows -- no full-history scans. Videos keep the stable row target so
    // repeated sends of the same path take the thumbnail from the current message's durable artifact.
    void Promise.all(
      mediaAttachments.map(async ({ attachment, index }) => {
        const ref = attachment.previewRef ?? attachment.ref;
        const isVideo = attachment.mime.startsWith("video/");
        try {
          const result = await readAttachment({
            sessionId,
            ref,
            signal: controller.signal,
            ...(isVideo ? { mediaType: attachment.mime } : {}),
            ...(isVideo && entityId
              ? {
                  target: { rowId, entityId },
                  attachmentIndex: attachmentIndices?.[index] ?? index,
                }
              : {}),
          });
          if (cancelled) return;
          const isLocalUrl = "url" in result;
          const url = isLocalUrl
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                  type: result.mediaType,
                }),
              );
          if (!isLocalUrl) thumbnailObjectUrlsRef.current.add(url);
          if (cancelled) {
            if (!isLocalUrl) {
              thumbnailObjectUrlsRef.current.delete(url);
              URL.revokeObjectURL(url);
            }
            return;
          }
          thumbnailUrlsRef.current.set(ref, url);
          setThumbnailUrls(new Map(thumbnailUrlsRef.current));
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          if (!isVideo) setFailedRefs((current) => new Set(current).add(ref));
          logger.warn(
            `[v4-attachment-preview] failed to read sent ${isVideo ? "video" : "image"} thumbnail`,
            error,
          );
        }
      }),
    );

    return () => {
      controller.abort();
      cancelled = true;
      // Desktop local videos return a custom-protocol URL, not a renderer-created Blob;
      // release only the object URL this effect created -- never manage local media URLs as Blob lifecycles.
      for (const url of thumbnailObjectUrlsRef.current) URL.revokeObjectURL(url);
      thumbnailObjectUrlsRef.current.clear();
      thumbnailUrlsRef.current.clear();
    };
  }, [attachmentIndices, attachmentKind, attachments, entityId, readAttachment, rowId, sessionId]);

  // -- Sent-video preview reads: staging semantics preserved verbatim --
  const releaseVideoPreviewUrl = useCallback(() => {
    if (!videoPreviewUrlRef.current) return;
    URL.revokeObjectURL(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
  }, []);

  const cancelVideoPreviewRead = useCallback(() => {
    videoPreviewRequestRef.current += 1;
    videoPreviewAbortRef.current?.abort();
    videoPreviewAbortRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cancelVideoPreviewRead();
      releaseVideoPreviewUrl();
    },
    [cancelVideoPreviewRead, releaseVideoPreviewUrl],
  );

  const closeVideoPreview = useCallback(() => {
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
  }, [cancelVideoPreviewRead, releaseVideoPreviewUrl]);

  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    pdfPreviewAbortRef.current?.abort();
    pdfPreviewAbortRef.current = null;
    if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
    setPdfPreview(null);
    setPdfPreviewRef(null);
    setPdfPreviewLoading(false);
    setPdfPreviewError(false);
  }, []);

  useEffect(
    () => () => {
      closePdfPreview();
    },
    [closePdfPreview],
  );

  const openVideoPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number, galleryIndex: number) => {
      if (!sessionId || !readAttachment) return;
      const ref = attachment.previewRef ?? attachment.ref;
      cancelVideoPreviewRead();
      const thumbnailUrl = thumbnailUrlsRef.current.get(ref);
      if (thumbnailUrl) {
        releaseVideoPreviewUrl();
        setPreviewIndex(galleryIndex);
        setPreviewOpen(true);
        setVideoPreviewRef(ref);
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        });
        setVideoPreviewLoading(false);
        setVideoPreviewError(false);
        return;
      }
      const requestId = videoPreviewRequestRef.current;
      const abortController = new AbortController();
      videoPreviewAbortRef.current = abortController;
      releaseVideoPreviewUrl();
      setPreviewIndex(galleryIndex);
      setPreviewOpen(true);
      setVideoPreviewRef(ref);
      setVideoPreview({
        filename: attachment.fileName,
        mediaType: attachment.mime,
      });
      setVideoPreviewLoading(true);
      setVideoPreviewError(false);
      try {
        const result = await readAttachment({
          sessionId,
          ref,
          mediaType: attachment.mime,
          // With an entityId, read precisely via the stable row target; otherwise fall back to ref matching.
          ...(entityId ? { target: { rowId, entityId }, attachmentIndex } : {}),
          signal: abortController.signal,
        });
        if (videoPreviewRequestRef.current !== requestId) return;
        const isLocalUrl = "url" in result;
        const url = isLocalUrl
          ? result.url
          : URL.createObjectURL(
              new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
            );
        if (videoPreviewRequestRef.current !== requestId) {
          if (!isLocalUrl) URL.revokeObjectURL(url);
          return;
        }
        videoPreviewUrlRef.current = isLocalUrl ? null : url;
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (videoPreviewRequestRef.current !== requestId) return;
        // A single read failure used to disable the attachment entry for good, wrongly binding dialog-openability to one read.
        // The failure belongs to that preview only; keep the entry so each open re-reads and shows errors inside the dialog.
        setVideoPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent media", error);
      } finally {
        if (videoPreviewRequestRef.current === requestId) {
          videoPreviewAbortRef.current = null;
          setVideoPreviewLoading(false);
        }
      }
    },
    [cancelVideoPreviewRead, entityId, readAttachment, releaseVideoPreviewUrl, rowId, sessionId],
  );

  const openPdfPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number) => {
      if (!sessionId || (!readAttachment && !readAttachmentRange)) return;
      const ref = attachment.previewRef ?? attachment.ref;
      pdfPreviewRequestRef.current += 1;
      const requestId = pdfPreviewRequestRef.current;
      pdfPreviewAbortRef.current?.abort();
      const abortController = new AbortController();
      pdfPreviewAbortRef.current = abortController;
      if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
      setPdfPreviewRef(ref);
      setPdfPreview({ filename: attachment.fileName, mediaType: "application/pdf" });
      setPdfPreviewLoading(true);
      setPdfPreviewError(false);
      try {
        const target = entityId ? { target: { rowId, entityId }, attachmentIndex } : {};
        if (readAttachmentRange) {
          const firstRange = await readAttachmentRange({
            sessionId,
            ref,
            ...target,
            offset: 0,
            limit: 256 * 1024,
            signal: abortController.signal,
          });
          const source: PdfViewerRangeSource = {
            totalBytes: firstRange.totalBytes,
            initialData: firstRange.bytes,
            requestRange: async (offset, limit) => {
              const range = await readAttachmentRange({
                sessionId,
                ref,
                ...target,
                offset,
                limit,
                signal: abortController.signal,
              });
              return range.bytes;
            },
          };
          if (pdfPreviewRequestRef.current !== requestId) return;
          setPdfPreview({
            filename: attachment.fileName,
            mediaType: firstRange.mediaType,
            pdfSource: source,
          });
          return;
        }
        if (!readAttachment) return;
        const result = await readAttachment({
          sessionId,
          ref,
          ...target,
          signal: abortController.signal,
        });
        if (pdfPreviewRequestRef.current !== requestId) return;
        const url =
          "url" in result
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
              );
        if (!("url" in result)) pdfPreviewUrlRef.current = url;
        setPdfPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent PDF", error);
      } finally {
        if (pdfPreviewRequestRef.current === requestId) {
          pdfPreviewAbortRef.current = null;
          setPdfPreviewLoading(false);
        }
      }
    },
    [entityId, readAttachment, readAttachmentRange, rowId, sessionId],
  );

  const visibleAttachments = (attachments ?? [])
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => {
      if (attachmentKind === "all") return true;
      const isMedia = attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/");
      return attachmentKind === "media" ? isMedia : !isMedia;
    });
  if (attachmentKind === "all") {
    // The inline editor reused the read-only message's generic attachment list: neither ordered media-before-files like the
    // composer, nor used the sent-message pills. Reordering only changes render order;
    // indexes still point into the original array, so a deletion cannot submit the wrong attachment.
    visibleAttachments.sort(
      ({ attachment: left }, { attachment: right }) =>
        Number(right.mime.startsWith("image/") || right.mime.startsWith("video/")) -
        Number(left.mime.startsWith("image/") || left.mime.startsWith("video/")),
    );
  }
  if (visibleAttachments.length === 0) return null;
  const previewEntries = (attachments ?? []).flatMap((attachment, index) => {
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    if (!isImage && !isVideo) return [];
    const ref = attachment.previewRef ?? attachment.ref;
    const src = thumbnailUrls.get(ref);
    if (isImage && !src) return [];
    return [
      {
        attachment,
        index,
        persistedAttachmentIndex: attachmentIndices?.[index] ?? index,
      },
    ];
  });
  const previewItems = previewEntries.map(({ attachment }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isVideo = attachment.mime.startsWith("video/");
    return {
      alt: attachment.fileName,
      filename: attachment.fileName,
      mediaType: attachment.mime,
      src: isVideo && videoPreviewRef === ref ? videoPreview?.url : thumbnailUrls.get(ref),
      loading: isVideo && videoPreviewRef === ref && videoPreviewLoading,
      error: isVideo && videoPreviewRef === ref && videoPreviewError,
    };
  });
  const selectPreviewItem = (galleryIndex: number) => {
    const entry = previewEntries[galleryIndex];
    if (!entry) return;
    if (entry.attachment.mime.startsWith("video/")) {
      void openVideoPreview(entry.attachment, entry.persistedAttachmentIndex, galleryIndex);
      return;
    }
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
    setPreviewIndex(galleryIndex);
    setPreviewOpen(true);
  };
  const items = visibleAttachments.map(({ attachment, index }) => {
    const isTextMaterial =
      attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text";
    const ref = attachment.previewRef ?? attachment.ref;
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    const isPdf = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    const isMedia = isImage || isVideo;
    const isEditingAttachment = attachmentKind === "all";
    const isThumbnail = attachmentKind === "media" || (isEditingAttachment && isMedia);
    const fileDisplayDescriptor = resolveFileDisplayDescriptor(attachment.fileName);
    const isUnavailable = failedRefs.has(ref);
    const thumbnailUrl = thumbnailUrls.get(ref) ?? "";
    const previewItemIndex = previewEntries.findIndex((entry) => entry.index === index);
    // Images and videos share the message media gallery; the video is read when it first becomes the active item.
    const canOpen =
      (isTextMaterial && Boolean(sessionId && readAttachment)) ||
      (isImage && !isUnavailable && previewItemIndex >= 0) ||
      (isVideo && Boolean(sessionId && readAttachment)) ||
      (isPdf && Boolean(sessionId && (readAttachment || readAttachmentRange)));
    return (
      <Attachment
        key={`${attachment.ref}-${index}`}
        variant={isThumbnail ? "grid" : "inline"}
        data-v4-user-edit-attachment-kind={
          isEditingAttachment
            ? isImage
              ? "image"
              : isVideo
                ? "video"
                : isPdf
                  ? "pdf"
                  : "file"
            : undefined
        }
        data-v4-user-input-attachment-pill={isThumbnail ? undefined : "true"}
        data-v4-user-input-media-attachment={isThumbnail ? "true" : undefined}
        className={cn(
          isThumbnail &&
            (isEditingAttachment
              ? "relative size-12 overflow-hidden rounded-lg bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-[''] hover:bg-surface-hover"
              : "relative size-20 overflow-hidden rounded-xl bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-border after:content-[''] hover:bg-surface-hover"),
          !isThumbnail &&
            (isEditingAttachment
              ? "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
              : "rounded-full border-0 bg-surface px-3 py-1.5 hover:bg-surface-hover"),
        )}
        onRemove={onRemove ? () => onRemove(index) : undefined}
        onOpen={
          canOpen
            ? () =>
                isTextMaterial
                  ? void openTextPreview(attachment, attachmentIndices?.[index] ?? index)
                  : isPdf
                    ? void openPdfPreview(attachment, attachmentIndices?.[index] ?? index)
                    : selectPreviewItem(previewItemIndex)
            : undefined
        }
        openLabel={
          canOpen
            ? isTextMaterial
              ? intl.formatMessage({ id: "chat.attachments.preview.openText" })
              : isVideo
                ? previewVideoOpenLabel
                : isPdf
                  ? previewPdfOpenLabel
                  : previewOpenLabel
            : undefined
        }
        title={isUnavailable ? previewUnavailableLabel : undefined}
        data={{
          id: `${rowId}-${index}`,
          type: "file",
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        }}
      >
        {isThumbnail ? (
          <div className="relative size-full">
            <AttachmentPreview className="size-full rounded-none" />
          </div>
        ) : isEditingAttachment ? (
          <>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
              <FileDisplayIcon
                src={fileDisplayDescriptor.fileIconSrc}
                size={16}
                className="size-4 shrink-0"
              />
            </div>
            <div className="min-w-0 max-w-40 flex-1">
              <span
                className="block truncate text-ui-base font-medium text-foreground"
                title={attachment.fileName}
              >
                {attachment.fileName}
              </span>
              <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                {getAttachmentTypeLabel(attachment.fileName, attachment.mime)}
              </span>
            </div>
          </>
        ) : attachment.sourceKind === "topic-history" ? (
          <span className="truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              { id: "chat.attachments.topicHistory" },
              { count: attachment.messageCount ?? 0 },
            )}
          </span>
        ) : (
          <FileDisplayInline
            path={attachment.fileName}
            options={{
              className: "inline-flex min-w-0 max-w-40 items-center gap-1.5",
              iconSize: 16,
              fileNameClassName: "truncate text-ui-base font-medium text-foreground",
            }}
          />
        )}
        {onRemove && isEditingAttachment ? (
          <AttachmentRemove
            placement="corner"
            size="icon"
            variant="default"
            aria-label={intl.formatMessage({ id: "chat.attachments.remove" })}
            label={intl.formatMessage({ id: "chat.attachments.remove" })}
            data-testid={testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${rowId}-${index}`)}
            className="absolute top-0.5 right-0.5 z-10 size-3.5 rounded-full p-0 text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <XIcon className="size-2.5" />
          </AttachmentRemove>
        ) : null}
      </Attachment>
    );
  });
  return (
    <>
      {directItems ? (
        items
      ) : (
        <Attachments
          variant="inline"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(rowId))}
          className="max-w-full gap-2"
        >
          {items}
        </Attachments>
      )}
      <ChatMediaAttachmentPreviewDialog
        attachment={textPreview}
        open={textPreview !== null}
        onOpenChange={(open) => {
          if (!open) closeTextPreview();
        }}
        loading={textLoading}
        error={textError}
      />
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onActiveIndexChange={selectPreviewItem}
        onOpenChange={(open) => {
          if (open) {
            setPreviewOpen(true);
            return;
          }
          setPreviewOpen(false);
          closeVideoPreview();
        }}
        open={previewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfPreview}
        open={pdfPreviewRef !== null}
        loading={pdfPreviewLoading}
        error={pdfPreviewError}
        onOpenChange={(open) => {
          if (!open) closePdfPreview();
        }}
      />
    </>
  );
});

const SingleUserInputRowView = memo(function SingleUserInputRowView({
  row,
  context,
  onEdit,
  editWorkspaceRewindAvailability,
  status,
}: {
  row: UserInputRow;
  context: ConversationRowRenderContext;
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  status?: string;
}) {
  const { intl } = useZCodeIntl();
  // Engine-epilogue collapsing: the body ends at epilogueStart;
  // later engine text folds into the bubble-bottom disclosure. Prompt-context parsing reads the body only -- no user references in the epilogue.
  const { body: bodyText, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
  const parsedPrompt = useMemo(
    () => ({
      ...parseComposerPromptContexts(bodyText, {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }),
      ...(row.conversationQuotes ? { conversationSelections: row.conversationQuotes } : {}),
    }),
    [context.workspaceIdentity, context.workspacePath, bodyText, row.conversationQuotes],
  );
  // Only strips the share-URL tail block of historical messages from the visible body.
  // That block is no longer produced (see the promptText note in ConversationComposer); the parser stays so messages sent
  // between the wiring fix and this removal do not render raw markup as body text.
  const parsedShareContext = useMemo(
    () => parseConversationShareContext(parsedPrompt.visibleContent),
    [parsedPrompt.visibleContent],
  );
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState(row.text);
  const [editAttachments, setEditAttachments] = useState<AttachmentRef[]>(() => [
    ...(row.attachments ?? []),
  ]);
  // After removing an attachment in edit mode, the persisted FilePart list keeps them all; the index array maps the visible list
  // back to original indexes, so attachmentIndex-based reads (video preview etc.) hit the right chunk.
  const [editAttachmentIndices, setEditAttachmentIndices] = useState<number[]>(() =>
    (row.attachments ?? []).map((_, index) => index),
  );
  const [editPromptContexts, setEditPromptContexts] = useState(() => parsedPrompt);
  const [conflictPreview, setConflictPreview] =
    useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const editContextCount = countComposerPromptContexts(editPromptContexts);
  const canSubmit = draft.trim().length > 0 || editAttachments.length > 0 || editContextCount > 0;
  const submitLabel = intl.formatMessage({ id: "chat.send" });
  const cancelLabel = intl.formatMessage({ id: "common.cancel" });
  const rewindWorkspaceLabel = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles",
  });
  const rewindWorkspaceTooltipTitle = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles.tooltip",
  });
  const rewindWorkspaceTooltipDescription =
    editWorkspaceRewindAvailability?.reason === "available"
      ? undefined
      : intl.formatMessage({
          id: `chat.edit.resetConversationAndFiles.${editWorkspaceRewindAvailability?.reason ?? "noFiles"}`,
        });
  const visibleText = parsedShareContext.visibleContent;
  const codeCommentContexts = parsedPrompt.codeComments;
  const webElementContexts = parsedPrompt.webElements;
  const pptxElementReferences = parsedPrompt.pptxElements;
  const conversationSelections = parsedPrompt.conversationSelections;
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  const hasMediaAttachments =
    row.attachments?.some(
      (attachment) => attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasFileAttachments =
    row.attachments?.some(
      (attachment) =>
        !attachment.mime.startsWith("image/") && !attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasVisibleText = visibleText.trim().length > 0;
  const pluginUiContexts = parsedPrompt.pluginUiContexts;
  // A nudge turn is engine text end to end: empty body, yet the bubble still renders with only that disclosure inside.
  const hasBubble = hasVisibleText || epilogue !== undefined;
  const hasContextReferences =
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    conversationSelections.length > 0 ||
    pluginUiContexts.length > 0;
  const hasAttachmentArea = hasAttachments || hasContextReferences;
  const hasAttachmentPills =
    hasFileAttachments ||
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    (!row.botGroupSource && conversationSelections.length > 0);
  // Root cause: the old check accepted only schedule runIds, leaving manual runs (Run-now clicks) without
  // a source badge. Both legit automation runId shapes render; plain conversation inputs still skip via parse failure.
  const isScheduledAutomationPrompt = parseAutomationRunId(row.sourceCommandId ?? "") !== null;
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath: context.workspacePath,
    workspaceIdentity: context.workspaceIdentity,
    remoteSessionId: context.workspaceRemoteSessionId,
    onOpenCodeViewer: context.onOpenCodeViewer,
  });

  useEffect(() => {
    if (!editing) {
      setDraft(parsedShareContext.visibleContent);
      setEditAttachments([...(row.attachments ?? [])]);
      setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
      setEditPromptContexts(parsedPrompt);
      return;
    }
    const focusEditor = () => inputApiRef.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(focusEditor);
      return;
    }
    focusEditor();
  }, [editing, parsedPrompt, row.attachments]);

  useEffect(() => {
    if (!onEdit) {
      setEditing(false);
      setSubmitting(false);
    }
  }, [onEdit]);

  const handleOpenEdit = useCallback(() => {
    // The v4 migration wrongly wired user-query editing to the main composer submission;
    // with an empty composer the click just warned. This restores the old inline editing.
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(true);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  const handleCancelEdit = useCallback(() => {
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(false);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  const handleRemoveEditAttachment = useCallback((index: number) => {
    setEditAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setEditAttachmentIndices((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleSubmitEdit = useCallback(
    async (nextText: string, workspaceMode: "preserve" | "rewind" = "preserve") => {
      if (!onEdit) return;
      if (!nextText.trim() && editAttachments.length === 0 && editContextCount === 0) return;
      setSubmitting(true);
      try {
        const result = await onEdit(
          { rowId: row.rowId, entityId: row.entityId! },
          serializeComposerPromptContexts(nextText, {
            ...editPromptContexts,
            conversationSelections: [],
          }),
          // Omitting an empty array lets the CLI restore canonical originals per its attachments default, so
          // edit must always submit the full current list -- an explicit [] is the only remove-all.
          editAttachments,
          workspaceMode,
          ...(parsedPrompt.conversationSelections.length || row.conversationQuotes
            ? [[...editPromptContexts.conversationSelections]]
            : []),
        );
        if (
          typeof result === "object" &&
          result !== null &&
          result.result?.type === "editUserQuery" &&
          result.result.disposition === "blocked" &&
          result.result.preview
        ) {
          setConflictPreview(result.result.preview);
          setConflictOpen(true);
          return;
        }
        if (result !== false) {
          setEditing(false);
          setConflictOpen(false);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      editAttachments,
      editContextCount,
      editPromptContexts,
      onEdit,
      row.entityId,
      row.rowId,
      row.conversationQuotes,
      parsedPrompt.conversationSelections.length,
    ],
  );
  const rewindWorkspaceDisabled = submitting || editWorkspaceRewindAvailability?.enabled !== true;
  const rewindWorkspaceButton = (
    <Button
      type="button"
      variant="outline"
      size="icon-md"
      disabled={rewindWorkspaceDisabled}
      data-testid={testId(TID_V4_EDIT_REWIND_WORKSPACE, String(row.rowId))}
      aria-label={rewindWorkspaceLabel}
      onClick={() => {
        void handleSubmitEdit(draft, "rewind");
      }}
    >
      <FileClockIcon className="size-4" />
    </Button>
  );

  if (editing) {
    return (
      <RowShell rowId={row.rowId} className="flex flex-col items-end">
        <ChatPromptEditor
          workspacePath={context.workspacePath}
          taskId={context.sessionId ?? null}
          initialValue={parsedPrompt.visibleContent}
          submitting={submitting}
          submitDisabled={!canSubmit || submitting}
          allowSubmitWhenEmpty={editAttachments.length > 0 || editContextCount > 0}
          submitLabel={submitLabel}
          cancelLabel={cancelLabel}
          showMentionButton
          showSlashButton
          enableWorkspaceFileDrop
          topContent={
            editAttachments.length > 0 || editContextCount > 0 ? (
              <div className="flex max-w-full flex-col items-start gap-2">
                {editAttachments.length > 0 ? (
                  <UserInputAttachmentList
                    attachments={editAttachments}
                    attachmentIndices={editAttachmentIndices}
                    entityId={row.entityId}
                    rowId={row.rowId}
                    onRemove={handleRemoveEditAttachment}
                    sessionId={context.sessionId ?? undefined}
                    readAttachment={context.readAttachment}
                    readAttachmentRange={context.readAttachmentRange}
                  />
                ) : null}
                {editContextCount > 0 ? (
                  <div
                    className="flex max-w-full flex-wrap items-center gap-2"
                    data-v4-user-edit-context-attachments-row="true"
                  >
                    <CodeCommentAttachmentChip
                      comments={editPromptContexts.codeComments}
                      onRemove={(comment) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: current.codeComments.filter((item) => item !== comment),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: [],
                        }))
                      }
                    />
                    <WebElementContextAttachmentChip
                      contexts={editPromptContexts.webElements}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: current.webElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: [],
                        }))
                      }
                    />
                    <PptxElementReferenceChip
                      references={editPromptContexts.pptxElements}
                      onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: current.pptxElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: [],
                        }))
                      }
                    />
                    <ConversationSelectionReferenceChip
                      references={editPromptContexts.conversationSelections}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: current.conversationSelections.filter(
                            (item) => !("id" in item) || item.id !== id,
                          ),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: [],
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null
          }
          inputApiRef={inputApiRef}
          inputTestId={testId(TID_V4_EDIT_INPUT, String(row.rowId))}
          submitTestId={testId(TID_V4_EDIT_SUBMIT, String(row.rowId))}
          cancelTestId={testId(TID_V4_EDIT_CANCEL, String(row.rowId))}
          betweenCancelAndSubmitAction={
            <ControlHintTooltip
              title={rewindWorkspaceTooltipTitle}
              description={rewindWorkspaceTooltipDescription}
            >
              {rewindWorkspaceDisabled ? (
                // A disabled button gets pointer-events-none, so a TooltipTrigger on the button
                // sees no hover. Wrap it: the span carries hover while the button stays disabled.
                <span className="inline-flex" data-disabled-tooltip-trigger="true">
                  {rewindWorkspaceButton}
                </span>
              ) : (
                rewindWorkspaceButton
              )}
            </ControlHintTooltip>
          }
          className="w-full max-w-xl"
          shellClassName="min-h-32"
          onChange={setDraft}
          onSubmit={(nextText) => {
            void handleSubmitEdit(nextText, "preserve");
          }}
          onCancel={handleCancelEdit}
        />
        <ConversationFileRewindDialog
          variant="editConflict"
          open={conflictOpen}
          onOpenChange={setConflictOpen}
          preview={conflictPreview}
          previewLoading={false}
          applying={submitting}
          error={null}
          onApply={() => {}}
          onConversationOnly={() => {
            void handleSubmitEdit(draft, "preserve");
          }}
        />
      </RowShell>
    );
  }

  return (
    <RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
      {isScheduledAutomationPrompt ? (
        <div
          data-v4-user-input-automation-origin="schedule"
          className="mb-1 flex max-w-xl items-center gap-1 text-ui-sm text-foreground-subtle"
        >
          <Clock data-cron-task-icon="true" aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{intl.formatMessage({ id: "chat.message.sentByScheduledTask" })}</span>
        </div>
      ) : null}
      {row.botGroupSource ? (
        // The group badge used to sit between materials and body, splitting one input; it now always precedes the materials.
        <div data-v4-user-input-source="true" className="mb-2 flex min-w-0 max-w-full">
          <BotGroupSourceLabel source={row.botGroupSource} />
        </div>
      ) : null}

      {hasAttachmentArea ? (
        <div
          data-v4-user-input-attachments="true"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(row.rowId))}
          className="mb-2 flex max-w-xl flex-col items-end gap-2"
        >
          {row.botGroupSource && conversationSelections.length > 0 ? (
            <div data-v4-user-input-quotes="true" className="flex max-w-full justify-end">
              <ConversationSelectionReferenceChip
                references={conversationSelections}
                contentAlign="end"
              />
            </div>
          ) : null}
          {hasMediaAttachments ? (
            <div
              data-v4-user-input-media-attachments="true"
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              <UserInputAttachmentList
                attachments={row.attachments}
                entityId={row.entityId}
                attachmentKind="media"
                directItems
                rowId={row.rowId}
                sessionId={context.sessionId ?? undefined}
                readAttachment={context.readAttachment}
                readAttachmentRange={context.readAttachmentRange}
              />
            </div>
          ) : null}
          {hasAttachmentPills ? (
            <div
              data-v4-user-input-attachment-pills="true"
              // Non-media files and context references share this layer so wrapping keeps the
              // files->comments->pages->PPT->conversation-references order with uniform right alignment.
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              {hasFileAttachments ? (
                <UserInputAttachmentList
                  attachments={row.attachments}
                  entityId={row.entityId}
                  attachmentKind="file"
                  directItems
                  rowId={row.rowId}
                  sessionId={context.sessionId ?? undefined}
                  readAttachment={context.readAttachment}
                  readAttachmentRange={context.readAttachmentRange}
                />
              ) : null}
              <CodeCommentAttachmentChip comments={codeCommentContexts} contentAlign="end" />
              <WebElementContextAttachmentChip contexts={webElementContexts} contentAlign="end" />
              <PptxElementReferenceChip
                references={pptxElementReferences}
                contentAlign="end"
                onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
              />
              {!row.botGroupSource ? (
                <ConversationSelectionReferenceChip
                  references={conversationSelections}
                  contentAlign="end"
                />
              ) : null}
              <PluginUiModelContextChip contexts={pluginUiContexts} contentAlign="end" />
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBubble ? (
        // Attachments/context references belong to the message row, not the bubble, or attachment-only messages leave an empty bubble.
        // One row renders in both the main conversation and the subagent pane; a fixed width would ignore the actual host.
        // The bubble keeps flex-item auto width; hosts >=624px cap at 36rem with 48px headroom.
        <ConversationUserInputBubble
          text={visibleText}
          contentParts={row.botGroupSource?.contentParts}
          rowId={row.rowId}
          epilogue={epilogue}
          attachments={row.attachments}
          contextAttachmentCount={countComposerPromptContexts(parsedPrompt)}
        />
      ) : null}
      {row.source?.kind === "genUi" && (
        <div
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          data-v4-user-input-source="genUi"
        >
          {intl.formatMessage({ id: "genUi.from" }, { name: row.source.title || "Gen UI" })}
        </div>
      )}
      {row.source?.kind === "pluginUi" ? (
        // Plugin-UI relay: the source badge comes from the CLI-persisted intent.source, never inferred in the renderer.
        <div
          data-v4-user-input-source={row.source.pluginId}
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
        >
          {intl.formatMessage(
            { id: "pluginUi.fromPlugin" },
            { name: formatPluginDisplayName(row.source.pluginId) },
          )}
        </div>
      ) : null}
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
      {/* Bugfix: mobile remote control has no hover, and the v4 port dropped the old UserMessage always-visible branch,
          leaving copy/edit undiscoverable; remote shows them outright, desktop keeps the hover/focus quieting. */}
      <MessageActions
        className={cn(
          "mt-1",
          context.compactForRemoteControl
            ? "opacity-100"
            : "opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100",
        )}
      >
        <CopyRowAction
          text={row.text}
          rowId={row.rowId}
          label={intl.formatMessage({ id: "chat.message.copy" })}
        />
        {onEdit && row.entityId ? (
          <MessageAction
            label={intl.formatMessage({ id: "chat.message.edit" })}
            tooltip={intl.formatMessage({ id: "chat.message.edit" })}
            data-testid={testId(TID_V4_EDIT, String(row.rowId))}
            onClick={handleOpenEdit}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null}
      </MessageActions>
    </RowShell>
  );
});

const UserInputRowView = memo(function UserInputRowView(
  props: ComponentProps<typeof SingleUserInputRowView>,
) {
  const rows = useMemo(() => expandTopicInputMessages(props.row), [props.row]);
  if (rows.length === 1) return <SingleUserInputRowView {...props} row={rows[0]!} />;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-v4-topic-messages="true">
      {rows.map((row) => (
        <div
          key={row.botGroupSource!.messageId}
          data-topic-message-id={row.botGroupSource!.messageId}
        >
          {/* Several originals share one received input; a partial edit must not be mistaken for replacing the batch. */}
          <SingleUserInputRowView {...props} row={row} onEdit={undefined} />
        </div>
      ))}
    </div>
  );
});

// Array defaults for memoized components must be module-level constants: an inline [] is a new reference per render and defeats memo.
const EMPTY_SOURCE_COMMAND_IDS: readonly string[] = [];

export const ConversationAssistantTextActions = memo(function ConversationAssistantTextActions({
  rowId,
  entityId,
  text,
  createdAt,
  compactForRemoteControl = false,
  feedback = null,
  hookInvocations,
  sessionId,
  turnId,
  sourceCommandIds = EMPTY_SOURCE_COMMAND_IDS,
  onFork,
  onFeedbackChange,
  className,
}: {
  rowId: number;
  entityId?: string;
  text: string;
  createdAt: number;
  compactForRemoteControl?: boolean;
  feedback?: AssistantMessageFeedback | null;
  hookInvocations?: readonly HookInvocationRow[];
  sessionId?: string | null;
  turnId?: string;
  sourceCommandIds?: readonly string[];
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [localFeedback, setLocalFeedback] = useState<AssistantMessageFeedback | null>(feedback);
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const likeLabel = intl.formatMessage({
    id: localFeedback === "like" ? "chat.message.liked" : "chat.message.like",
  });
  const dislikeLabel = intl.formatMessage({
    id: localFeedback === "dislike" ? "chat.message.disliked" : "chat.message.dislike",
  });
  const forkLabel = intl.formatMessage({ id: "chat.message.fork" });
  const timeLabel = formatMessageTimeLabel(createdAt, locale, intl);
  const resolveTooltip = (label: string): string | undefined =>
    compactForRemoteControl ? undefined : label;

  useEffect(() => {
    setLocalFeedback(feedback);
  }, [feedback]);

  const handleFeedback = useCallback(
    (nextFeedback: AssistantMessageFeedback) => {
      const previousFeedback = localFeedback;
      const resolvedFeedback = previousFeedback === nextFeedback ? null : nextFeedback;
      setLocalFeedback(resolvedFeedback);
      logger.info("[ConversationRowView] user feedback on assistant message", {
        messageId: entityId ?? null,
        reaction: resolvedFeedback ?? "none",
      });
      if (entityId) {
        void Promise.resolve(onFeedbackChange?.({ rowId, entityId }, resolvedFeedback)).then(
          (result) => {
            if (result === false) setLocalFeedback(previousFeedback);
          },
          (error: unknown) => {
            setLocalFeedback(previousFeedback);
            // The first V4 cut mutated renderer state only, showing feedback that does not exist after a command failure.
            // Failures roll back to the pre-click projected value; later authoritative rows correct it.
            logger.warn("[ConversationRowView] failed to persist assistant feedback", {
              error: error instanceof Error ? error.message : String(error),
              messageId: entityId,
            });
          },
        );
      }
      if (platform && entityId) {
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "assistant_message_feedback",
            eventRegion: "chat",
            eventType: "ck",
            eventExtraDetail: { reaction: resolvedFeedback ?? "none" },
            ...(sessionId ? { talkId: sessionId } : {}),
            messageId: entityId,
          },
          "ConversationRowView",
        );
      }
    },
    [entityId, localFeedback, onFeedbackChange, platform, rowId, sessionId],
  );
  const handleFork = useCallback(() => {
    if (entityId) {
      runUserAction({
        input: { featureId: "conversation.history.branch", action: "fork", trigger: "button" },
        operation: () => onFork?.({ rowId, entityId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "fork",
      });
    }
  }, [entityId, onFork, rowId]);
  return (
    <MessageActions className={cn(className, "has-[[data-bot-group-delivery]]:opacity-100")}>
      <CopyRowAction
        text={text}
        rowId={rowId}
        label={copyLabel}
        tooltip={resolveTooltip(copyLabel)}
      />
      {entityId && onFeedbackChange ? (
        <>
          <MessageAction
            aria-label={likeLabel}
            aria-pressed={localFeedback === "like"}
            label={likeLabel}
            tooltip={resolveTooltip(likeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_LIKE, String(rowId))}
            className={localFeedback === "like" ? "!bg-success/10" : undefined}
            onClick={() => handleFeedback("like")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "like" && "zcode-reaction-burst",
              )}
            >
              <ThumbsUpIcon className="size-3.5" />
            </span>
          </MessageAction>
          <MessageAction
            aria-label={dislikeLabel}
            aria-pressed={localFeedback === "dislike"}
            label={dislikeLabel}
            tooltip={resolveTooltip(dislikeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_DISLIKE, String(rowId))}
            className={localFeedback === "dislike" ? "!bg-warning/10" : undefined}
            onClick={() => handleFeedback("dislike")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "dislike" && "zcode-reaction-burst",
              )}
            >
              <ThumbsDownIcon className="size-3.5" />
            </span>
          </MessageAction>
        </>
      ) : null}
      {onFork && entityId ? (
        <MessageAction
          aria-label={forkLabel}
          label={forkLabel}
          tooltip={resolveTooltip(forkLabel)}
          data-testid={testId(TID_V4_FORK, String(rowId))}
          onClick={handleFork}
        >
          <TrendingUpDownIcon className="size-3.5" />
        </MessageAction>
      ) : null}
      {turnId && hookInvocations ? (
        <ConversationHookDetailsAction rows={hookInvocations} turnId={turnId} />
      ) : null}
      {/* Bugfix: after the old conversation surface went away, the V4 action bar lost the message created-time;
          it is a read-only derivation of row.createdAt with no new renderer state. */}
      {timeLabel ? (
        <span className="select-none text-ui-sm text-foreground-subtlest">{timeLabel}</span>
      ) : null}
      {turnId ? (
        <ConnectedBotGroupDeliveryAction turnId={turnId} sourceCommandIds={sourceCommandIds} />
      ) : null}
    </MessageActions>
  );
});

const AssistantTextRowView = memo(function AssistantTextRowView({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  hideActions,
  deferActions,
  copyText,
  previewCards,
  previewCardsAutoOpenKey,
  codeCommentCards,
  codeCommentProjectionEnabled,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  hideActions?: boolean;
  deferActions?: boolean;
  copyText?: string;
  previewCards?: AssistantPreviewCard[];
  previewCardsAutoOpenKey?: string;
  codeCommentCards?: AssistantCodeCommentCard[];
  codeCommentProjectionEnabled?: boolean;
}) {
  const streaming = row.state === "streaming";
  const isOfficeMode = useIsOfficeMode();
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const projectsCodeComments = codeCommentCardsEnabled && codeCommentProjectionEnabled === true;
  const visibleText = useMemo(
    () =>
      projectsCodeComments
        ? projectAssistantCodeComments(row.text, { streaming }).visibleText
        : row.text,
    [projectsCodeComments, row.text, streaming],
  );
  const visiblePreviewCards = previewCards && previewCards.length > 0 ? previewCards : null;
  return (
    <RowShell rowId={row.rowId} className="group/assistant-row">
      {/* M5(4) phase 2: assistant text renders via streamdown (MessageResponse) with real
          markdown/code blocks; streaming mode tolerates unclosed markdown. */}
      {/* Bugfix: MessageResponse consumes only its declared props and never forwards data-* to the real DOM,
          so a selectable marker on the assistant body in JSX was never found by the selection logic.
          The selectable semantics live on a stable DOM wrapper, shared by complete and streaming paths. */}
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <GenUiMessageResponse
          completed={row.state === "complete"}
          messageKey={`${row.rowId}:${row.entityId ?? ""}`}
          renderZCodeFileCitations
          streaming={streaming}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
          workspaceRemoteSessionId={context.workspaceRemoteSessionId}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          forceCodeWrap={isOfficeMode}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenExternalUrl={context.onOpenBrowserUrl}
          sessionId={context.sessionId ?? undefined}
          readAttachment={context.readAttachment}
        >
          {visibleText}
        </GenUiMessageResponse>
      </div>
      {codeCommentCardsEnabled && codeCommentCards && codeCommentCards.length > 0 ? (
        <div className="mt-3">
          <AssistantCodeCommentCards
            cards={codeCommentCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenCodeViewer={context.onOpenCodeViewer}
          />
        </div>
      ) : null}
      {visiblePreviewCards ? (
        <div className="mt-3">
          <AssistantPreviewCards
            cards={visiblePreviewCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            autoOpenPptxKey={previewCardsAutoOpenKey}
            onAutoOpenPptx={context.onAutoOpenAssistantPptx}
            compactForRemoteControl={context.compactForRemoteControl}
          />
        </div>
      ) : null}
      {/* The completed-state action row appears on hover (parity with old MessageActions): copy + fork (ghost icons).
          One turn is one reply to the user: actions render only on the turn's final segment (hideActions adjudicated by TurnGroup),
          and copy takes every text segment of the turn merged (copyText overrides). */}
      {row.state === "complete" && !hideActions && !deferActions ? (
        <ConversationAssistantTextActions
          rowId={row.rowId}
          entityId={row.entityId}
          text={copyText ?? row.text}
          createdAt={row.createdAt}
          compactForRemoteControl={context.compactForRemoteControl}
          feedback={readAssistantFeedback(row)}
          sessionId={context.sessionId}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          className={cn(
            "mt-1",
            context.compactForRemoteControl
              ? "opacity-100"
              : "opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100",
          )}
        />
      ) : null}
    </RowShell>
  );
});

const ReasoningRowView = memo(function ReasoningRowView({
  row,
  contentVariant,
}: {
  row: ReasoningRow;
  contentVariant?: "default" | "nested";
}) {
  const streaming = row.state === "streaming";
  // Visual parity with the old ThoughtBlock (old chatMessageParts): the ai-elements Reasoning
  // collapsible. Interaction change: streaming reasoning expanded by default kept squeezing tools and body;
  // both streaming and complete now start collapsed with the running copy only; users expand manually.
  // autoCollapseKey still ensures state boundaries never override user interactions that already happened.
  const durationSeconds =
    row.durationMs !== undefined ? Math.max(1, Math.ceil(row.durationMs / 1000)) : undefined;
  if (streaming && row.text.length === 0) {
    return null;
  }
  return (
    <RowShell rowId={row.rowId}>
      <Reasoning
        className="w-full"
        isStreaming={streaming}
        autoCollapseKey={streaming ? null : row.state}
        {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}
      >
        {/* Cause: the attachment refactor merge dropped the streamingText wiring, leaving the summary mounted but forever fed empty text. */}
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent variant={contentVariant}>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </RowShell>
  );
});

const TurnHeaderRowView = memo(function TurnHeaderRowView({ row }: { row: TurnHeaderRow }) {
  return (
    <RowShell
      rowId={row.rowId}
      className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
    >
      turn · {row.origin} · {row.state}
    </RowShell>
  );
});

/** Divider icon (parity with the old synthetic-timeline dividers: size-3.5 subtle). */
const MARKER_ARCHIVE_ICON = (
  <ArchiveIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_FORK_ICON = (
  <GitBranchIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_GOAL_ICON = (
  <GoalIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_MODEL_ICON = (
  <ArrowRightLeftIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);

/**
 * System-marker divider shell: hairlines both sides plus a centered icon+label pill, matching the old
 * ChatMessage synthetic-timeline dividers (same for fork/compaction/goal).
 * While running (compact/verify in flight) the icon hides and the label uses the animated-gradient-text shimmer (as before).
 */
function MarkerDividerRow({
  rowId,
  markerType,
  markerStatus,
  markerOrigin,
  markerSourceCommandId,
  icon,
  label,
  running = false,
  onClick,
}: {
  rowId: number;
  markerType: TimelineMarkerRow["marker"]["type"];
  markerStatus: string;
  markerOrigin?: string;
  markerSourceCommandId?: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  running?: boolean;
  // When provided, the whole row is clickable (fork -> parent session); otherwise a static divider.
  onClick?: () => void;
}) {
  const clickable = Boolean(onClick);
  const rowClassName =
    "flex w-full items-center gap-3 px-4 py-2 text-ui-base text-[var(--color-foreground-subtle)]";
  const inner = (
    <>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
      <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
        {running ? null : icon}
        <span
          className={`min-w-0 break-words${running ? " animated-gradient-text font-medium" : ""}${clickable ? " underline-offset-4 group-hover/marker:underline" : ""}`}
        >
          {label}
        </span>
      </span>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
    </>
  );
  if (onClick) {
    // Whole-row <button> (old fork-divider parity): brightens on hover, label underlined as the affordance.
    return (
      <button
        type="button"
        data-row-id={rowId}
        data-row-kind="timelineMarker"
        data-marker-type={markerType}
        data-status={markerStatus}
        data-origin={markerOrigin}
        data-source-command-id={markerSourceCommandId}
        data-testid={testId(TID_V4_ROW, String(rowId))}
        onClick={onClick}
        className={`group/marker ${rowClassName} text-left transition-colors hover:text-[var(--color-foreground)]`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      data-row-id={rowId}
      data-row-kind="timelineMarker"
      data-marker-type={markerType}
      data-status={markerStatus}
      data-origin={markerOrigin}
      data-source-command-id={markerSourceCommandId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={rowClassName}
    >
      {inner}
    </div>
  );
}

/**
 * timelineMarker row rendering: compact/forkNotice/goalVerify/modelChange draw as dividers.
 * modelChange visibility is an adjudication: the divider lands only on turns actually sent after the switch (including
 * model-only continuation turns); goalSet/forkCreated are no longer produced at the projection layer (hidden rows zeroed),
 * retryNotice/checkpointRestored have no UI, and the default branch renders nothing.
 */
const TimelineMarkerRowView = memo(function TimelineMarkerRowView({
  row,
  context,
}: {
  row: TimelineMarkerRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const marker = row.marker;
  const modelSelectionView = context.modelSelectionView ?? null;
  const view = useMemo((): {
    icon: React.ReactNode;
    label: React.ReactNode;
    running: boolean;
  } | null => {
    switch (marker.type) {
      case "compact": {
        const running = marker.status === "running";
        const automaticOptimization = isOfficeMode && marker.origin === "auto";
        const scope = automaticOptimization ? "chat.contextOptimization" : "chat.contextCompaction";
        const statusMessage =
          marker.status === "running"
            ? "started"
            : marker.status === "noop"
              ? "skipped"
              : marker.status === "cancelled"
                ? "interrupted"
                : marker.status === "failed"
                  ? "failed"
                  : marker.origin === "auto" && !automaticOptimization
                    ? "completedAuto"
                    : "completed";
        return {
          icon: MARKER_ARCHIVE_ICON,
          label: intl.formatMessage({ id: `${scope}.${statusMessage}` }),
          running,
        };
      }
      case "forkNotice":
        return {
          icon: MARKER_FORK_ICON,
          label: intl.formatMessage({ id: "chat.message.fork.derivedFrom" }),
          running: false,
        };
      case "modelChange": {
        // The marker carries the full provider/model tuple, but the old render read model only and
        // never subscribed to the provider snapshot -- same-named models looked identical and labels stayed stale after catalog hydration.
        // Keep the provider-id fallback and let existing markers refresh with the catalog.
        const fromProvider = resolveProviderLabel(marker.fromProvider, modelSelectionView);
        const toProvider = resolveProviderLabel(marker.toProvider, modelSelectionView);
        const to = formatModelChangeLabel(marker.toProvider, toProvider, marker.toModel, intl);
        if (marker.fromProvider === undefined || marker.fromModel === undefined) {
          return {
            // source-less means first use of a model, not a switch: no transition arrow.
            icon: null,
            label: intl.formatMessage({ id: "chat.modelChange.using" }, { model: to }),
            running: false,
          };
        }
        return {
          icon: MARKER_MODEL_ICON,
          label: intl.formatMessage(
            { id: "chat.modelChange.switched" },
            {
              from: formatModelChangeLabel(
                marker.fromProvider,
                fromProvider,
                marker.fromModel,
                intl,
              ),
              to,
            },
          ),
          running: false,
        };
      }
      case "goalVerify": {
        const running = marker.outcome === "running";
        // pass -> done; notSatisfied/failed -> not done (legacy failed_closed counted as not done).
        const statusId =
          marker.outcome === "running"
            ? "chat.goalVerification.checking"
            : marker.outcome === "pass"
              ? "chat.goalVerification.complete"
              : "chat.goalVerification.incomplete";
        return {
          icon: MARKER_GOAL_ICON,
          running,
          // innerText reads like "Iteration 1 - verifying goal", matching the goal-timeline standby e2e assertion.
          label: (
            <>
              <span>
                {intl.formatMessage(
                  { id: "chat.summaryPanel.goalIterationValue" },
                  { count: String(marker.iteration) },
                )}
              </span>
              <span aria-hidden="true"> · </span>
              {intl.formatMessage({ id: statusId })}
            </>
          ),
        };
      }
      default:
        return null;
    }
  }, [intl, isOfficeMode, marker, modelSelectionView]);

  // Fork jump to the parent (Tier 1): clickable only for forkNotice rows when the host provides onNavigateToRow;
  // switches to marker.parentSessionId (rowId reserved for Tier 2 precise scroll, currently a constant-0 placeholder).
  const onNavigate = context.onNavigateToRow;
  const handleClick = useMemo(() => {
    if (marker.type !== "forkNotice" || !onNavigate) {
      return undefined;
    }
    return () => onNavigate(marker.parentSessionId, marker.parentRowId);
  }, [marker, onNavigate]);

  if (!view) {
    return null;
  }
  return (
    <MarkerDividerRow
      rowId={row.rowId}
      markerType={marker.type}
      markerStatus={
        marker.type === "compact"
          ? marker.status
          : marker.type === "goalVerify"
            ? marker.outcome
            : marker.type === "forkNotice"
              ? "created"
              : "applied"
      }
      markerOrigin={marker.type === "compact" ? marker.origin : undefined}
      markerSourceCommandId={row.sourceCommandId}
      icon={view.icon}
      label={view.label}
      running={view.running}
      onClick={handleClick}
    />
  );
});

const ToolCallRowView = memo(function ToolCallRowView({
  row,
  context,
}: {
  row: ToolCallRow;
  context: ConversationRowRenderContext;
}) {
  // toolCall rows reattach ToolCallBlocks (execute/read/edit/...; the renderer routes by
  // tool identity). The adapter memoizes on row reference: only a fresh object from row.delta/upserted rebuilds.
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  // Workflow-run detail gating: run identity comes from the workflowRuns projection (its schema names toolCallId the
  // tool-card-to-detail join key), never from tool output -- a v4 row's output is one line of prose.
  // The matched summary also picks the card shape: with a run, a compact clickable card; without, an expandable one.
  const workflowRun =
    context.workflowRunByToolCallId?.get(row.toolCallId) ??
    // ResumeWorkflowRun rows join by runId: the display payload carries runId (= backgroundTaskId) while the projection's
    // run.toolCallId stays on the original CreateWorkflow row across resumes -- a resume row never matches by toolCallId.
    // On match, onOpenWorkflowRun narrows through the same path; the tab keys on runId, idempotent.
    (row.display?.kind === "resume_workflow_run"
      ? context.workflowRunByRunId?.get(row.display.runId)
      : undefined);
  // The fill row that joined a run (docs/dynamic-workflow/presentation.md, The fill row): fill-complete · {name} ·
  // {k} phases · {m} subagents. Joins the projection via the args' `run_id` (the fill row's toolCallId is not the origin's); only successful
  // parsed rows count -- unparsable fills go to the compile-feedback row below and nothing joined the run. A new phase grows under the card (the turn-end summary
  // takes this row's graph).
  // The name comes from display's `fill` block (the row args have none -- the transcript stores only the model's own args).
  const fillTarget = isFillWorkflowHoleToolCall(row)
    ? readWorkflowHoleTarget(
        row.input,
        row.display?.kind === "create_workflow" ? row.display.fill : undefined,
      )
    : undefined;
  const fillRun =
    fillTarget?.runId === undefined ? undefined : context.workflowRunByRunId?.get(fillTarget.runId);
  if (
    fillTarget !== undefined &&
    fillTarget.holeId !== undefined &&
    fillRun !== undefined &&
    row.status === "success" &&
    row.display?.kind === "create_workflow" &&
    row.display.ok
  ) {
    const sessionId = context.sessionId;
    const counts = workflowFillCounts(row.display.causalityGraph, fillTarget.holeId);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={fillRun}
          fill={{
            name: fillTarget.name ?? fillTarget.holeId,
            ...counts,
          }}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, fillRun),
                    runId: fillRun.runId,
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // Cause: the started tool card and the turn-end summary drew the same live progress twice; the former is now a plain summary entry.
  // Only successfully-joined origin rows swap; compile diagnostics, Resume, and other tools keep their renderings.
  if (
    workflowRun &&
    context.workflowRunByToolCallId?.has(row.toolCallId) &&
    row.status !== "error"
  ) {
    const workflowName = readWorkflowName(row.input);
    const sessionId = context.sessionId;
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={workflowRun}
          amend={isAmendWorkflowToolCall(row)}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                    ...(workflowName === undefined ? {} : { workflowName }),
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // An in-place revision (docs/dynamic-workflow/concurrency.md): cap-only change with the run in flight makes this call
  // skip compilation and mint no run; the result is one line. Every criterion uses already-shipped fields -- args shape, **no** display,
  undefined;
  // and success-non-error; tool structured output does not pass through v4, and all three create_workflow display schemas are `.strict()` over frozen
  // field sets -- one extra key makes older ends drop the whole tool result -- so this path adds no protocol field. A real revision (run settled)
  // fails both tests and is handled by the branch above via its toolCallJoinable run.
  const retune = isAmendWorkflowToolCall(row) ? readWorkflowRetuneCall(row.input) : undefined;
  if (
    retune !== undefined &&
    row.status === "success" &&
    (row.output?.display ?? row.display) === undefined &&
    !context.workflowRunByToolCallId?.has(row.toolCallId)
  ) {
    const sessionId = context.sessionId;
    // The adjusted run's projection, for exactly two things: the default cap (copy reads equals-default as restored-to-default) and
    // the origin-row id for the open request. It stays out of the `workflowRun` above: that variable answers is-this-row-a
    // run-origin, and this one is not.
    const retuned = context.workflowRunByRunId?.get(retune.runId);
    const defaultConcurrency =
      retuned?.run === undefined ? undefined : workflowRunDefaultConcurrency(retuned.run);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowRetuneRow
          requested={retune.requested}
          runId={retune.runId}
          {...(defaultConcurrency === undefined ? {} : { defaultConcurrency })}
          {...(context.onOpenWorkflowRun && sessionId
            ? {
                onOpen: () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, retuned),
                    runId: retune.runId,
                  }),
              }
            : {})}
        />
      </RowShell>
    );
  }
  // Tool rows drop vertical padding (z-code-2 parity: no per-tool padding); spacing between
  // consecutive tools comes from the ConversationAssistantWorkItems gap-4 group container.
  return (
    <RowShell rowId={row.rowId} className="py-0">
      <div data-conversation-selectable="true">
        <ToolCallBlock
          toolCallNode={toolCallNode}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          showTodoToolCalls={context.messageStreamShowTodos === true}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onOpenPlanDetail={
            context.onOpenPlanDetail && context.sessionId
              ? (request) =>
                  context.onOpenPlanDetail?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                  })
              : undefined
          }
          onOpenWorkflowRun={
            context.onOpenWorkflowRun && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowRun?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    // The open request keys on the origin (CreateWorkflow) row id, not the clicked row -- on a resume row they differ, and the
                    // detail page uses it to find the causality graph/script.
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onOpenWorkflowActor={
            context.onOpenWorkflowActor && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowActor?.({ ...request, parentSessionId: context.sessionId! })
              : undefined
          }
          // Script pill -> script transcript: same keys as onOpenWorkflowRun (origin row id + runId).
          onOpenWorkflowWorkspace={
            context.onOpenWorkflowWorkspace && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowWorkspace?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onResumeWorkflowRun={
            context.onResumeWorkflowRun && workflowRun?.resumable
              ? (request) => context.onResumeWorkflowRun?.(workflowRun.runId, request.workflowName)
              : undefined
          }
          // Artifact pill -> artifact tab: same open path as the notification-row chips (no version pin; opens latest).
          onOpenWorkflowArtifact={
            context.onOpenWorkflowArtifact && context.sessionId && workflowRun
              ? (artifactId) => {
                  // The live projection's artifact summary carries the latest `contentType` (the host opens html artifacts straight into a browser
                  // tab); the `sourcePath` summary deliberately omits it -- the host journals it itself when absent.
                  const artifact = workflowRun.run?.artifacts?.find(
                    (candidate) => candidate.id === artifactId,
                  );
                  context.onOpenWorkflowArtifact?.({
                    parentSessionId: context.sessionId!,
                    runId: workflowRun.runId,
                    artifactId,
                    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                    ...(artifact?.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                  });
                }
              : undefined
          }
          workflowRun={workflowRun}
          workflowDraft={context.workflowDraftByToolCallId?.get(row.toolCallId)}
        />
      </div>
    </RowShell>
  );
});

const SubagentRowView = memo(function SubagentRowView({ row }: { row: SubagentRow }) {
  // Subagent rows already render paired with their Agent/Task tool rows; a bare row keeps
  // only the fallback summary, never a second child-session card or drill-down path.
  const summary = (
    <>
      {row.subagentType} · {row.status}
      {row.summaryText ? ` — ${row.summaryText}` : ""}
    </>
  );
  return (
    <RowShell rowId={row.rowId}>
      <div className="text-ui-sm text-[var(--color-foreground-subtle)]">{summary}</div>
    </RowShell>
  );
});

/**
 * v4 row render dispatch. memoized: virtualized row-by-row; on parent projection changes only
 * rows whose props truly changed re-render (provided onFork/onRetry/onEdit are stable and the
 * useCallback/useMemo）。
 */
function ConversationRowViewImpl({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  switch (row.kind) {
    case "userInput":
      return (
        <UserInputRowView
          row={row}
          context={context}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          status={userInputStatus}
        />
      );
    case "assistantText":
      return (
        <AssistantTextRowView
          row={row}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          hideActions={hideAssistantActions}
          deferActions={deferAssistantActions}
          copyText={assistantCopyText}
          previewCards={assistantPreviewCards}
          previewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          codeCommentCards={assistantCodeCommentCards}
          codeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      );
    case "reasoning":
      // Turning off show-reasoning hides only later reasoning in each turn; the first reasoning
      // is the turn's minimal thinking cue and must stay, keyed by the turn-order-derived rowId.
      return isConversationReasoningRowVisible(row.rowId, context) ? (
        <ReasoningRowView row={row} contentVariant={reasoningContentVariant} />
      ) : null;
    case "turnHeader":
      return <TurnHeaderRowView row={row} />;
    case "timelineMarker":
      return <TimelineMarkerRowView row={row} context={context} />;
    case "toolCall":
      // Returning null inside ToolCallBlock leaves an empty RowShell and stray spacing;
      // trim at the row-dispatch level under the same tool-identity rule, so no Todo DOM exists when the setting is off.
      if (
        context.messageStreamShowTodos !== true &&
        resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "todo"
      ) {
        return null;
      }
      return <ToolCallRowView row={row} context={context} />;
    case "subagent":
      return <SubagentRowView row={row} />;
    case "artifact":
      return <ArtifactRowView row={row} />;
    default:
      return null;
  }
}

export const ConversationRowView = memo(ConversationRowViewImpl);
