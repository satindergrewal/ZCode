/* oxlint-disable eslint(max-lines) -- the composer concentrates all input-area wiring (attachments/drafts/history/mention); splitting it would break that cohesion. */
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
/**
 * v4 conversation composer (composer parity).
 *
 * Shell: ChatPromptEditor (Lexical editor + action menu + drag feedback + sticky base visuals),
 * plus the attachment preview grid/image preview/error area.
 *
 * Core: brand-new v4 wiring --
 * - routing/state always read the v4 projection snapshot.inputRouting / control / config / usage;
 * - send-button state machine matches the old UI: canSend (text or attachments + routing allows) / pending spinner /
 *   running+empty draft -> Stop (v4 stop command) / paused queue (choice) -> post-send clear/keep confirm;
 * - the full attachment pipeline lives in useComposerAttachments (sent via v4 sendText attachments);
 * - mentions (@ file/board, # session, $ skill) and the full slash catalog wire up inside LexicalChatInput;
 * - per-session draft persistence (composerDraftStore) + prompt history (promptHistoryStorage);
 * - the toolbar (model/reasoning/mode/context usage) lives in V4ComposerToolbar.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { HighspeedComposerBackground } from "@/highspeed/HighspeedActivationVisual.js";
import { useHighspeedComposerEntrance } from "@/highspeed/useHighspeedComposerEntrance.js";
import {
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_CHAT_ATTACHMENT_MENU_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_STOP,
  testId,
  type HighspeedCardSnapshot,
  type PlanIdentitySnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import type {
  AttachmentRef,
  ConversationSnapshot,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ArrowUpIcon,
  ClipboardPenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  ChatErrorBanner,
  resolveChatErrorBannerDisplayMessage,
  shouldSuppressChatErrorBanner,
} from "@/ChatErrorBanner.js";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { runUserAction, startUserAction } from "@/lib/userActionTelemetry.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isPdfChatComposerAttachment,
  isMediaChatComposerAttachment,
  isVideoChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { resolveChatPlaceholderKey } from "@/lib/chatPlaceholder.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  readWorkspaceFileDragPayload,
  isWorkspaceFileAddToChatEvent,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { resolveProviderBaseURL } from "@/lib/registryProviderView.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import { consumeV4ComposerDraftWorkspaceTransferRequest } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import { removeCodeCommentPreview } from "@/v4/composer/codeCommentPreviewSync.js";
import {
  countComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import {
  PluginUiModelContextChip,
  usePluginUiContextImages,
  usePluginUiModelContexts,
} from "@/plugin-ui/index.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModeSwitch,
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
import {
  resolveV4ComposerConfigPickerState,
  type V4ComposerConfigPicker,
} from "@/v4/composer/configPickerState.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { buildV4ConversationPromptTelemetryExtraDetail } from "@/v4/telemetry/conversationPromptTelemetry.js";
import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";

const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

export interface ConversationComposerSendOptions {
  /** Config captured on send click; null means the selection is incomplete - the Host must not backfill it from the Session. */
  submission?: ComposerSubmissionConfig | null;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  /** Paused-queue id observed while the send confirm dialog is open; the CLI uses it to gate cross-device add/remove races. */
  expectedHeldQueueItemIds?: readonly string[];
  /** Attachment command surface: serialized attachments (the host converts to AttachmentRef and sends via v4 sendText/createSession). */
  attachments?: AttachmentRef[];
  /** Context attachments carried inside the prompt text; used to stop local commands such as /goal from consuming them by mistake. */
  contextAttachmentCount?: number;
  conversationQuotes?: import("@zcode/shared").ConversationSelectionText[];
  /** Renderer-only: after an accepted ACK, SessionPane binds the real commandId/sessionId. */
  telemetrySeed?: ConversationPromptTelemetrySeed;
  /** One-shot delivery override for this busy input; never mutates session preferences. */
  requestedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
  /** Plugin-UI relay: persisted with sendText; the user message card shows from-plugin-X. */
  source?: import("@zcode/shared/zcode-protocol-v4").ConversationInputSource;
}

export type ConversationComposerSendResult = "sent" | "blocked" | "confirmationRequired";
function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export interface ExternalTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

export function restorePersistedComposerDraftIntoInput({
  draft,
  inputApi,
  onEditorStateError,
}: {
  draft: Pick<V4ComposerDraft, "editorStateJson" | "mention" | "text">;
  inputApi: Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "setEditorStateJson" | "setMention" | "setText"
  >;
  onEditorStateError?: (error: unknown) => void;
}): string {
  if (draft.editorStateJson) {
    try {
      inputApi.setEditorStateJson(draft.editorStateJson);
      return inputApi.getMarkdown();
    } catch (error) {
      onEditorStateError?.(error);
    }
  }
  if (draft.mention && draft.text.startsWith(draft.mention.markdown)) {
    // The workspace plugin detail unmounts the chat composer. Structured mentions must restore from the shared draft source of truth,
    // not one-shot insert events, or a remount degrades them to plain canonical text.
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}

export function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: Pick<
    LexicalChatInputHandle,
    | "getMarkdown"
    | "prependMentionIfMissing"
    | "setMention"
    | "setText"
    | "setTextWithPluginMentions"
  > | null;
  request: ExternalTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Cause: replaying the prompt saved at click time after install would clobber edits made during the install.
    // Node-level prep keeps the editor's mentions/paragraph structure, then reads the canonical draft back from the editor.
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // Root cause: store trials used to pass canonical text only, so Lexical could not know the leading link was a structured plugin mention.
    // The request also carries display-only node data; sending and the draft source of truth still use request.text verbatim.
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // Recommended tasks may combine several plugins in the body; rebuild them as real mention nodes at their original positions.
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

export interface ComposerRestoreRequest {
  requestId: number;
  sessionId: string;
  workspaceKey: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;
}

export function applyComposerRestoreRequestToComposer({
  appliedRequestId,
  currentSessionId,
  currentWorkspaceKey,
  hasDraftContent,
  inputApi,
  request,
  requestFocus,
  restoreSessionOwnedAttachments,
  restoreDraftConfig,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  currentSessionId: string | null;
  currentWorkspaceKey: string;
  hasDraftContent: boolean;
  inputApi: Pick<LexicalChatInputHandle, "setText"> | null;
  request: ComposerRestoreRequest | null | undefined;
  requestFocus: () => void;
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  restoreDraftConfig?: (config: NonNullable<ComposerRestoreRequest["config"]>) => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (
    request.sessionId !== currentSessionId ||
    request.workspaceKey !== currentWorkspaceKey ||
    hasDraftContent ||
    !inputApi
  ) {
    return appliedRequestId;
  }
  if (!restoreSessionOwnedAttachments(request.attachments)) {
    return appliedRequestId;
  }
  inputApi.setText(request.text);
  updateText(request.text);
  if (request.config) restoreDraftConfig?.(request.config);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

function arePromptHistoryEntriesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export interface ConversationComposerProps {
  snapshot: ConversationSnapshot | null;
  /** Draft scope (sessionId; null while drafting -> the "__draft__" scope). */
  sessionId?: string | null;
  /** Skill catalog authority; the prewarmSessionId once draft prewarm completes. Never changes task/draft identity. */
  skillCatalogSessionId?: string | null;
  /** Draft state has no snapshot, but the first send can still createSession. */
  draftMode?: boolean;
  /** The renderer draft config intent; overrides a late prewarm projection only in draftMode. */
  draftConfig?: Partial<SessionConfigState>;
  /** The full Draft owner injected by SessionPane; on the production path the editor never overwrites the persisted record directly. */
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** Whether the Composer can form a complete Submission; false when model or reasoning is empty. */
  submissionReady?: boolean;
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null;
  /** Freezes the model dimension for send telemetry only; merges the draft initialization config with explicit intent. */
  telemetryDraftConfig?: Partial<SessionConfigState>;
  /**
   * Empty-state contextHeader (m5-composer-parity): workspace switcher + Git branch
   // switcher rendered above the editor (same slot as the old ChatViewComposer
   // contextHeaderContent). Provided by the host in draft state only; empty once a session exists.
   */
  contextHeader?: ReactNode;
  /** Centered draft layout (old shouldUseCenteredDraftChatLayout): narrower max-w-2xl, no sticky. */
  centered?: boolean;
  /**
   // v4 bottom-dock blocking interaction id. While present the composer is hidden, not unmounted, preserving draft, attachments, and the editor instance.
   */
  blockingRequestId?: string | null;
  disabled?: boolean;
  /** The Highspeed card available to the current task; affects static badge and model lock only. */
  highspeedCard?: HighspeedCardSnapshot | null;
  /**
   * One-shot activation request registered by a fresh send-path draw hit (the cardId).
   * The animation plays only when the hit is the current card; the composer locks the entrance and consumes it via callback. Switch-back/restore/remount never replay it.
   */
  highspeedActivationCardId?: string | null;
  onHighspeedActivationApplied?: (cardId: string) => void;
  /**
   * Whether to focus the input on new-task/session switch/mount (default on).
   * In multi-pane splits the host passes SessionPane.focused: only the focused pane focuses; background panes never steal focus.
   */
  autoFocusEnabled?: boolean;
  /** Whether this composer runs inside the mobile web remote-control shell. */
  isWebRemoteControl?: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Selection facts atomically read by SessionPane from the target Host; the Composer never resolves the Host itself. */
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  /** Explicit retry entry after the first Model Selection read fails. */
  modelSelectionReload?: () => void;
  /** In draft state, the prewarm session carries attachment transactions. */
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** When the transport exposes runtime liveness, prefer this over onRuntimeRestart. */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  provider?: ZCodeProvider;
  /** Real visibility jointly decided by the host pane and workspace scrim; used for visible-only telemetry. */
  telemetryVisible?: boolean;
  /** Reads the plan identity at send click; the double-confirm reuses the same frozen seed. */
  readPlanIdentitySnapshot?: () => PlanIdentitySnapshot;
  onSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult | void>;
  /** Hands the current input text to the parent (editUserQuery uses the composer text as newText). */
  onTextChange?: (text: string) => void;
  /** Full composer-occupancy snapshot read by queue-withdraw admission; attachments include in-upload state. */
  onDraftStateChange?: (state: { hasContent: boolean; busy: boolean }) => void;
  onStop: () => void;
  /** Model picked from the catalog (providerId/modelId); thought/revision are backfilled by the host from the latest projection. */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
  ) => void;
  /** Selected reasoning depth; carries the model visible at action time so a late async echo never attributes the thought to another model. */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** Opens the current session Status panel, straight to the Running detail. */
  onOpenRunningBackgroundWorks?: () => void;
  /**
   * Where a background-works click lands: `"workflow-run"` = the single running run goes straight to its detail page (host-decided);
   * default `"panel"` = expand the status pill. Only the tooltip changes here; the behavior lives in onOpenRunningBackgroundWorks.
   */
  backgroundWorkOpenTarget?: "panel" | "workflow-run";
  runningSubagentCount?: number;
  /** On prepare/configOptions failure, custom-provider choices enter the workspace recovery chain. */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  /** /compact entry of the context-usage panel (the host issues the v4 compact command). */
  onSendCompressionCommand?: (command: string) => void;
  /** Session-level v4 error (snapshot.control.lastError), shown above the input. */
  error?: ZCodeUiError | null;
  onDismissError?: () => void;
  /** Recovery action for the no-models banner; SessionPane injects the shell navigation - the component never touches tabs directly. */
  onOpenModelSettings?: () => void;
  onOpenModelUpgrade?: () => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   // Whether to listen for the global add-to-chat event (workspace file tree / canvas button).
   // In split view only the primary pane listens, so one click never inserts twice.
   */
  listenAddToChatEvents?: boolean;
  /**
   * One-shot external text-prefill requests (Example Prompt etc.).
   * requestId lets the same text trigger a refill twice in a row.
   */
  externalTextInsertRequest?: ExternalTextInsertRequest | null;
  onExternalTextInsertApplied?: (requestId: number) => void;
  /**
   // Queue edit-withdraw restores the full future intent into the input after the delete ACK.
   // requestId + session/workspace binding keep it idempotent and never cross-write other tasks.
   */
  composerRestoreRequest?: ComposerRestoreRequest | null;
  onComposerRestoreApplied?: (requestId: number) => void;
  /** Side sessions expose no goal capability; the protocol layer still rejects direct calls. */
  suppressGoalCommands?: boolean;
  /** App-level local slash commands (e.g. `/side`), assembled by SessionPane behind its gates and passed through. */
  appSlashCommands?: readonly AppSlashCommand[];
  // Exposes the composer drop routing to the whole conversation pane / desktop draft title bar.
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
}

function formatAttachmentLineCount(attachment: ChatComposerAttachment, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}

function ConversationComposerImpl({
  snapshot,
  sessionId = null,
  skillCatalogSessionId = sessionId,
  draftMode = false,
  draftConfig,
  composerDraft,
  updateComposerContent,
  replaceComposerDraft,
  submissionReady = true,
  createSubmissionFromComposer,
  telemetryDraftConfig,
  contextHeader,
  centered = false,
  blockingRequestId = null,
  disabled = false,
  highspeedCard = null,
  highspeedActivationCardId = null,
  onHighspeedActivationApplied,
  autoFocusEnabled = true,
  isWebRemoteControl = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  attachmentSessionId = null,
  attachmentPut,
  onRuntimeRestart,
  onRuntimeLifecycle,
  provider,
  telemetryVisible = true,
  readPlanIdentitySnapshot,
  onSendText,
  onTextChange,
  onDraftStateChange,
  onStop,
  onSelectModel,
  onSelectThought,
  onSwitchMode,
  onOpenRunningBackgroundWorks,
  backgroundWorkOpenTarget = "panel",
  runningSubagentCount = 0,
  onRecoverCustomModelSelection,
  onSendCompressionCommand,
  error,
  onDismissError,
  onOpenModelSettings,
  onOpenModelUpgrade,
  onOpenCodeViewer,
  listenAddToChatEvents = true,
  externalTextInsertRequest = null,
  onExternalTextInsertApplied,
  composerRestoreRequest = null,
  onComposerRestoreApplied,
  suppressGoalCommands = false,
  appSlashCommands,
  onDropTargetControllerChange,
}: ConversationComposerProps) {
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const draftScopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [presentedHighspeedCardId, setPresentedHighspeedCardId] = useState<string | null>(null);
  const [highspeedSweepActive, setHighspeedSweepActive] = useState(false);
  const highspeedCardId = highspeedCard?.cardId ?? null;
  const highspeedEntrance = useHighspeedComposerEntrance({
    cardId: highspeedCardId,
    activationCardId: highspeedActivationCardId,
    onActivationApplied: onHighspeedActivationApplied,
  });
  const highspeedEntranceAnimated = highspeedEntrance === "activation";
  // Restore entrances (task switch-back, snapshot restore, remount) skip the handoff: the card shows model+countdown as soon as it appears.
  const highspeedPresented =
    highspeedCardId !== null &&
    (!highspeedEntranceAnimated || presentedHighspeedCardId === highspeedCardId);
  const handleHighspeedModelTransitionStart = useCallback(() => {
    // Records only cards whose visual handoff completed; never touches card validity or send state.
    setPresentedHighspeedCardId(highspeedCardId);
  }, [highspeedCardId]);
  useEffect(() => {
    // The sweep is part of the activation animation: once, after a fresh draw-hit handoff.
    if (!highspeedPresented || !highspeedEntranceAnimated) {
      setHighspeedSweepActive(false);
      return;
    }
    const timer = window.setTimeout(() => setHighspeedSweepActive(true), 1_900);
    return () => window.clearTimeout(timer);
  }, [highspeedEntranceAnimated, highspeedPresented]);
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({
    scopeKey: configPickerScopeKey,
    activePicker: null,
  }));
  // A fixed-key SessionPane reuses the composer across tasks/drafts, so a stale picker owner
  // rides into the new scope. Zero it before committing the new scope portal to avoid a one-frame menu flash;
  // the old Radix layer's late close event is dropped by the scope guard below.
  if (configPickerState.scopeKey !== configPickerScopeKey) {
    setConfigPickerState({
      scopeKey: configPickerScopeKey,
      activePicker: null,
    });
  }
  const activeConfigPicker =
    configPickerState.scopeKey === configPickerScopeKey ? configPickerState.activePicker : null;
  const handleConfigPickerOpenChange = useCallback(
    (picker: V4ComposerConfigPicker, open: boolean) => {
      // Once composer content restores pointer-events for the nav rail, the three Radix modal
      // pickers' independent open states race within one pointerdown and the old layer cannot dismiss reliably.
      // A close callback may land after a sibling's open; it may clean up only itself, never the takeover.
      setConfigPickerState((current) => {
        if (current.scopeKey !== configPickerScopeKey) {
          return current;
        }
        return {
          scopeKey: current.scopeKey,
          activePicker: resolveV4ComposerConfigPickerState(current.activePicker, picker, open),
        };
      });
    },
    [configPickerScopeKey],
  );
  const [heldQueueConfirmation, setHeldQueueConfirmation] = useState<{
    queueItemIds: readonly string[];
    telemetrySeed: ConversationPromptTelemetrySeed;
    requestedDelivery?: "startNow" | "queue" | "guide";
  } | null>(null);
  const [sendTooltipOpen, setSendTooltipOpen] = useState(false);
  // The submit path reads the latest text/pending via refs so the callback identity never changes per keystroke.
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  const pendingRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // This wire broke once: the composer read a parallel sharedContextImport prop that SessionPane never passed
  // (zero `sharedContextImport=` hits repo-wide), so the first message never carried sharedContextRefs.
  // It now derives from the always-present snapshot; rationale and bounds in resolveAttachableShareContext.
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const reportedErrorKeysRef = useRef(new Set<string>());
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  // Bugfix: after M3 removed the old ChatView, M5 restored only the desktop false-hardcode and never re-wired the registered
  // mobile-remote path, so Enter mis-sent. Old semantics restored: on mobile viewports Enter newlines and the button sends;
  // desktop keeps Enter-to-send via resolveChatEnterSubmits' viewport gate.
  const enterSubmits = resolveChatEnterSubmits({
    isMobileTextInputViewport,
    preferEnterNewline: isWebRemoteControl,
  });
  // Fix: the old ChatView's iOS focus-zoom guard never migrated to the v4 composer, so the mobile web-remote
  // input re-triggered Safari page zoom.
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // Bugfix: with the full capability text in an absolutely-positioned placeholder, three lines overflowed the
  // 40px editor and covered the toolbar. Mobile uses short copy capped at two lines; desktop keeps the full hint.
  const compactMobilePlaceholder = isWebRemoteControl && isMobileTextInputViewport;
  const sendShortcut = resolveChatEnterShortcut({ enterSubmits });
  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      contentRevisionRef.current += 1;
      advanceComposerDraftRevision(workspacePath, workspaceIdentity);
      setText(next);
      onTextChange?.(next);
    },
    [onTextChange, workspaceIdentity, workspacePath],
  );

  // -- Attachment pipeline (pick/paste/drag/canvas/pre-upload/gates) --
  const attachmentsApi = useComposerAttachments({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
  });
  // Parity with old useChatComposer: a window-level dragover lights up the whole chat area and desktop draft header
  // before the pointer enters, and workspace-payload copy wins over system attachments.
  const { externalFileDragging, workspaceFileDragging } = usePromptEditorDragState({
    enableExternalFileDrop: true,
    enableWorkspaceFileDrop: true,
  });
  const handleConversationDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragOverComposer(event);
    },
    [attachmentsApi.handleDragOverComposer],
  );
  const handleConversationDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragLeaveComposer(event);
    },
    [attachmentsApi.handleDragLeaveComposer],
  );
  const handleConversationDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const workspaceFilePayload = readWorkspaceFileDragPayload(event.dataTransfer);
      if (workspaceFilePayload) {
        // File-tree payloads are not OS File[]: insert the mention only, never the upload queue.
        event.preventDefault();
        attachmentsApi.handleDropComposer(event);
        appendWorkspaceFileMentionToComposer({
          inputApiRef,
          currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: updateText,
        });
        return;
      }
      attachmentsApi.handleDropComposer(event);
    },
    [attachmentsApi.handleDropComposer, updateText, workspaceIdentity, workspacePath],
  );
  const conversationDragKind = workspaceFileDragging
    ? "workspace"
    : externalFileDragging
      ? "attachment"
      : (attachmentsApi.composerDragKind ??
        (attachmentsApi.isDraggingOverComposer ? "attachment" : null));
  const dropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: conversationDragKind !== null,
      kind: conversationDragKind,
      onDragOver: handleConversationDragOver,
      onDragLeave: handleConversationDragLeave,
      onDrop: handleConversationDrop,
    }),
    [
      conversationDragKind,
      handleConversationDragLeave,
      handleConversationDragOver,
      handleConversationDrop,
    ],
  );
  useEffect(() => {
    onDropTargetControllerChange?.(dropTargetController);
    return () => onDropTargetControllerChange?.(null);
  }, [dropTargetController, onDropTargetControllerChange]);
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const hasAttachments = attachmentsApi.hasAttachments;
  const {
    contexts: webElementContexts,
    hasContexts: hasWebElementContexts,
    removeContext: removeWebElementContext,
    clearContexts: clearWebElementContexts,
  } = useWebElementContexts({
    workspacePath,
    workspaceIdentity,
    // While a queue recall awaits its ACK the composer is disabled; the global add-to-chat must then also be blocked from
    // writing webpage context, or a new draft inside the ACK window survives the authoritative delete.
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  // Context attached by the plugin UI via ui/update-model-context; received per sessionId, cleared on send.
  const {
    contexts: pluginUiContexts,
    hasContexts: hasPluginUiContexts,
    removeContext: removePluginUiContext,
    clearContexts: clearPluginUiContexts,
  } = usePluginUiModelContexts({ sessionId, workspacePath, workspaceIdentity });
  // image blocks in that context become this composer's image attachments, sent next turn.
  usePluginUiContextImages(pluginUiContexts, attachmentsApi);
  const {
    references: pptxElementReferences,
    hasReferences: hasPptxElementReferences,
    removeReference: removePptxElementReference,
    clearReferences: clearPptxElementReferences,
  } = usePptxElementReferences({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  });
  const {
    references: conversationSelectionReferences,
    limitReason: conversationSelectionLimitReason,
    removeReference: removeConversationSelectionReference,
    clearReferences: clearConversationSelectionReferences,
  } = useConversationSelectionReferences({ sessionId, workspaceKey });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  // -- Per-session draft persistence (survives session switches/reloads; mention pills preserved via editorStateJson) --
  const draftScopeRef = useRef(draftScopeId);
  const draftTargetRef = useRef({
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const ownerDraftRef = useRef({
    draft: composerDraft,
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const draftPersistTimerRef = useRef<number | null>(null);
  const suppressDraftPersistRef = useRef(false);

  const snapshotDraftOfEditor = useCallback((): {
    text: string;
    editorStateJson?: string;
  } => {
    const currentText = textRef.current;
    let editorStateJson: string | undefined;
    try {
      const editorState = inputApiRef.current?.getEditorState();
      editorStateJson = editorState ? JSON.stringify(editorState.toJSON()) : undefined;
    } catch (error) {
      logger.warn(`[v4-composer] failed to serialize draft editorState: ${String(error)}`);
    }
    return currentText.trim()
      ? { text: currentText, ...(editorStateJson ? { editorStateJson } : {}) }
      : { text: "" };
  }, []);

  const persistDraftNow = useCallback(
    (scopeId: string) => {
      if (suppressDraftPersistRef.current) return;
      const content = snapshotDraftOfEditor();
      if (scopeId === draftScopeRef.current) {
        updateComposerContent(content);
        return;
      }
    },
    [snapshotDraftOfEditor, updateComposerContent, workspaceIdentity, workspacePath],
  );

  const scheduleDraftPersist = useCallback(() => {
    if (typeof window === "undefined") return;
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      persistDraftNow(draftScopeRef.current);
    }, 350);
  }, [persistDraftNow]);

  // -- Autofocus (new task/session switch/mount hand the caret back to the input) --
  // Triggers: the draftFocusVersion startDraft bumps (covering Cmd/Ctrl+N and every new-task entry),
  // sessionId->draftScopeId changes (session/draft switch), and mount. All three set the focus intent; because switching to a
  // connection-requiring session briefly disables the composer, the intent parks until editable, then fires once.
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const pendingFocusRef = useRef(false);
  // Whether this focus was programmatic (see flushPendingFocus); lets send_input_focus skip non-user actions.
  const programmaticFocusRef = useRef(false);
  // The send button and Enter share one form submit; button onClick fires before submit,
  // which distinguishes send_click's send_trigger; reset to the default right after reading.
  const sendTriggerRef = useRef<"button" | "shortcut">("shortcut");
  // Modifier-clicks land before form submit; store only that beat's delivery-flip intent, cleared once submit consumes it.
  const reversePointerDeliveryRef = useRef(false);
  const appliedComposerRestoreRequestRef = useRef<number | null>(null);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // Decision inputs read via ref so autoFocusEnabled/disabled/viewport never enter the scope effect deps
  // and trigger spurious draft re-restores (a disabled flip must not replay the draft).
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  });
  focusOptsRef.current = {
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  };
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;
    // Programmatic focus and a real click raise the same DOM focus event; the flag set here
    // is consumed by handleEditorFocus so refocuses are never misreported as send_input_focus.
    programmaticFocusRef.current = true;
    // The Lexical root may be a frame late; focus is queued to the next frame (as with the draft backfill).
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => inputApiRef.current?.focus());
    } else {
      inputApiRef.current.focus();
    }
  }, []);
  const requestComposerFocus = useCallback(() => {
    if (resolveComposerAutoFocus(focusOptsRef.current) === "skip") return;
    pendingFocusRef.current = true;
    flushPendingFocus();
  }, [flushPendingFocus]);

  const handleCodeCommentRemoved = useCallback(
    (comment: Parameters<typeof removeCodeCommentPreview>[0]) => {
      removeCodeCommentPreview(comment, services?.broadcastService);
    },
    [services?.broadcastService],
  );
  const {
    contexts: codeCommentContexts,
    hasContexts: hasCodeCommentContexts,
    removeContext: removeCodeCommentContext,
    clearContexts: clearCodeCommentContexts,
    getContexts: getCodeCommentContexts,
  } = useCodeCommentContexts({
    // The composer is disabled while queue-withdraw waits for its ACK; same write gate as web context.
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    onContextRemoved: handleCodeCommentRemoved,
    requestFocus: requestComposerFocus,
    scopeKey: `${workspaceKey}\0${draftScopeId}`,
  });

  useEffect(() => {
    if (!composerRestoreRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyComposerRestoreRequestToComposer({
        appliedRequestId: appliedComposerRestoreRequestRef.current,
        currentSessionId: sessionId,
        currentWorkspaceKey: workspaceKey,
        hasDraftContent:
          textRef.current.length > 0 ||
          attachmentsApi.attachments.length > 0 ||
          codeCommentContexts.length > 0 ||
          webElementContexts.length > 0 ||
          pptxElementReferences.length > 0 ||
          conversationSelectionReferences.length > 0 ||
          pluginUiContexts.length > 0,
        inputApi: inputApiRef.current,
        request: composerRestoreRequest,
        requestFocus: requestComposerFocus,
        restoreSessionOwnedAttachments: attachmentsApi.restoreSessionOwnedAttachments,
        // A withdrawn item carries its own Submission config; keep the draft owner, restore once, and preserve the already-handled consent flags.
        restoreDraftConfig: (config) =>
          replaceComposerDraft({
            ...ownerDraftRef.current.draft,
            ...config,
            text: composerRestoreRequest.text,
            editorStateJson: undefined,
            mention: undefined,
          }),
        scheduleDraftPersist,
        updateText,
      });
      const appliedNow =
        nextAppliedRequestId === composerRestoreRequest.requestId &&
        appliedComposerRestoreRequestRef.current !== composerRestoreRequest.requestId;
      appliedComposerRestoreRequestRef.current = nextAppliedRequestId;
      if (appliedNow) onComposerRestoreApplied?.(composerRestoreRequest.requestId);
      return nextAppliedRequestId === composerRestoreRequest.requestId;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    attachmentsApi.attachments.length,
    attachmentsApi.restoreSessionOwnedAttachments,
    codeCommentContexts.length,
    composerRestoreRequest,
    conversationSelectionReferences.length,
    onComposerRestoreApplied,
    replaceComposerDraft,
    requestComposerFocus,
    scheduleDraftPersist,
    sessionId,
    updateText,
    webElementContexts.length,
    pptxElementReferences.length,
    pluginUiContexts.length,
    workspaceKey,
  ]);

  // Scope switch: persist the old scope draft first, then restore the new one (editorStateJson first, plain-text fallback).
  useEffect(() => {
    const previousTarget = draftTargetRef.current;
    const targetChanged =
      previousTarget.scopeId !== draftScopeId ||
      previousTarget.workspacePath !== workspacePath ||
      previousTarget.workspaceIdentity !== workspaceIdentity;
    let transferredDraft: ReturnType<typeof snapshotDraftOfEditor> | null = null;
    if (targetChanged && !suppressDraftPersistRef.current) {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      const previousDraft = snapshotDraftOfEditor();
      const shouldTransferDraft =
        previousTarget.scopeId === V4_DRAFT_SCOPE_ROOT &&
        draftScopeId === V4_DRAFT_SCOPE_ROOT &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // Unbinding a project only changes the draft cwd; body text, mention editor state, and in-component attachments all stay.
        replaceComposerDraft({ ...ownerDraftRef.current.draft, ...previousDraft });
        transferredDraft = previousDraft;
      }
    }
    draftScopeRef.current = draftScopeId;
    draftTargetRef.current = {
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };

    const draft = transferredDraft ?? composerDraft;
    const restoreDraftInto = (api: LexicalChatInputHandle) => {
      if (!draft) {
        if (textRef.current) {
          api.clear();
          updateText("");
        }
        return;
      }
      updateText(
        restorePersistedComposerDraftIntoInput({
          draft,
          inputApi: api,
          onEditorStateError: (error) => {
            logger.warn(
              `[v4-composer] draft editorState restore failed; falling back to plain text: ${String(error)}`,
            );
          },
        }),
      );
    };
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (!api) return;
      restoreDraftInto(api);
      // After a draft restore, hand the caret back to the input (session/draft switch/mount); honored once the connecting session is editable.
      requestComposerFocus();
    };
    // The Lexical root may be a frame late; draft restore is queued to the next frame (same timing as the old initialValue backfill).
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => cancelAnimationFrame(frame);
    }
    applyDraft();
    return undefined;
    // Dependencies narrowed to scope/workspace: draft restores happen only on scope or workspace switches.
  }, [
    draftScopeId,
    persistDraftNow,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateText,
    updateComposerContent,
    workspaceIdentity,
    workspacePath,
    replaceComposerDraft,
  ]);

  useEffect(() => {
    ownerDraftRef.current = {
      draft: composerDraft,
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };
  }, [composerDraft, draftScopeId, workspaceIdentity, workspacePath]);

  // External prefill and scope restore can land in the same pass. If prefill runs first, the restore overwrites the just-clicked
  // Example Prompt with the stale draft -- so apply after the scope restore and acknowledge the one-shot insert there.
  useEffect(() => {
    if (!externalTextInsertRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedExternalTextInsertRequestRef.current,
        inputApi: inputApiRef.current,
        request: externalTextInsertRequest,
        requestFocus: requestComposerFocus,
        scheduleDraftPersist,
        updateText,
      });
      const applied = nextAppliedRequestId === externalTextInsertRequest.requestId;
      appliedExternalTextInsertRequestRef.current = nextAppliedRequestId;
      if (applied) {
        onExternalTextInsertApplied?.(externalTextInsertRequest.requestId);
      }
      return applied;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    requestComposerFocus,
    scheduleDraftPersist,
    updateText,
  ]);

  // New task (including repeated Cmd/Ctrl+N while already drafting, scope unchanged): the startDraft nonce bump refocuses.
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // Switching to a connecting session sets disabled=true and defers the focus intent; honored once disabled flips back to false.
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // Persist the current draft before refresh/window close.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => persistDraftNow(draftScopeRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
    };
  }, [persistDraftNow]);

  // -- Prompt history (per-workspace localStorage; up/down navigation consumed by PromptHistoryPlugin) --
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  const canStop = Boolean(snapshot?.control.canStop);
  const modifiedEnterReversesDelivery = modifiedEnterSubmits && canStop;
  const hasText = text.trim().length > 0;
  const hasDraftToSubmit =
    hasText ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  const hasComposerDraftContent =
    text.length > 0 ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  useEffect(() => {
    onDraftStateChange?.({
      hasContent: hasComposerDraftContent,
      busy: pending,
    });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // choice keeps the normal send button; after submit SessionPane decides via slash semantics whether to confirm.
  // The v4 rewrite treated guide as non-submittable, killing both the button and Enter;
  // guide is a CLI-authorized busy-input route; steer-vs-queue is adjudicated at the command layer.
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  const attachmentsReady = !attachmentsApi.hasUnreadyAttachments;
  const canSend =
    !disabled &&
    !pending &&
    hasDraftToSubmit &&
    routingAllowsSend &&
    attachmentsReady &&
    submissionReady;
  // Old-UI state machine: streaming + empty draft -> Stop; with a draft -> send (enqueue).
  const showStopControl = canStop && !hasDraftToSubmit;

  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

  const submit = useCallback(
    async (
      heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
      expectedHeldQueueItemIds?: readonly string[],
      existingTelemetrySeed?: ConversationPromptTelemetrySeed,
      requestedDelivery?: "startNow" | "queue" | "guide",
    ) => {
      const trimmed = textRef.current.trim();
      const submittedQueueItemIds =
        snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
      const hasPendingAttachments = attachmentsApi.attachments.length > 0;
      const currentCodeCommentContexts = getCodeCommentContexts();
      const hasPendingCodeCommentContexts = currentCodeCommentContexts.length > 0;
      const currentWebElementContexts = webElementContexts;
      const hasPendingWebElementContexts = currentWebElementContexts.length > 0;
      const currentPluginUiContexts = pluginUiContexts;
      const hasPendingPluginUiContexts = currentPluginUiContexts.length > 0;
      const currentPptxElementReferences = pptxElementReferences;
      const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
      const currentConversationSelections = conversationSelectionReferences;
      const hasPendingConversationSelections = currentConversationSelections.length > 0;
      const submittedShareContext = pendingShareContext;
      // After a draft first-send is accepted the same composer promotes in place from __draft__ to the session scope;
      // reading the mutable ref during success cleanup would wipe the new scope and leave the first input in
      // __draft__, restored on the next new task. Freeze the actually-submitted scope at send start.
      const submittedDraft = snapshotDraftOfEditor();
      let cleanupRevision = contentRevisionRef.current;
      const submission = createSubmissionFromComposer?.() ?? null;
      const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
      if (
        (!trimmed &&
          !hasPendingAttachments &&
          !hasPendingCodeCommentContexts &&
          !hasPendingWebElementContexts &&
          !hasPendingPptxElementReferences &&
          !hasPendingConversationSelections &&
          !hasPendingPluginUiContexts &&
          !submittedShareContext) ||
        pendingRef.current ||
        !submissionReady ||
        (createSubmissionFromComposer !== undefined && submission === null) ||
        attachmentsApi.hasUnreadyAttachments
      ) {
        return;
      }
      const sendAction = startUserAction({
        featureId: "conversation.composer.message",
        action: "send",
        trigger: sendTriggerRef.current === "button" ? "button" : "shortcut",
        workspaceKind: workspaceIdentity?.trim() ? "remote" : "local",
      });
      pendingRef.current = true;
      setPending(true);
      // Root cause: draft intent stores explicit user changes only; the inherited model lives in the frozen init config.
      // Reading draftConfig alone before the prewarm snapshot lands wrongly settles send_btn on empty/glm.
      const telemetryConfig = telemetryDraftConfig ?? snapshotRef.current?.config ?? draftConfig;
      let telemetrySeed: ConversationPromptTelemetrySeed;
      if (existingTelemetrySeed) {
        // The queue double-confirm reuses the first click's seed: no duplicate send_click and
        // no send-trigger reset, keeping send_click/send_result strictly 1:1.
        telemetrySeed = existingTelemetrySeed;
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, false);
      } else {
        const freshSeed: ConversationPromptTelemetrySeed = {
          sendTime: Date.now(),
          localTtft: !workspaceIdentity?.trim()
            ? getLocalTtftObserver()?.start(
                workspacePath,
                (snapshotRef.current !== null &&
                  snapshotRef.current.inputRouting.mode !== "startNow") ||
                  false,
                trimmed.startsWith("/"),
              )
            : undefined,
          extraDetail: buildV4ConversationPromptTelemetryExtraDetail({
            askMode: telemetryConfig?.mode,
            modelName: telemetryConfig?.model,
            configProvider: telemetryConfig?.provider,
            agentProvider: provider,
            providerBaseURL: resolveProviderBaseURL(telemetryConfig?.provider, modelSelectionView),
            planIdentitySnapshot: readPlanIdentitySnapshot?.(),
          }),
        };
        const sendTrigger = sendTriggerRef.current;
        sendTriggerRef.current = "shortcut";
        // recordSendClick backfills sendClickId -- its return value must seed the rest, or the
        // settlement lacks the correlation key and send_result is misfiled as a background task.
        telemetrySeed =
          conversationTelemetry?.recordSendClick({
            sessionId: sessionId ?? null,
            seed: freshSeed,
            trigger: sendTrigger,
          }) ?? freshSeed;
      }
      let promptHistoryBeforeSend: readonly string[] | null = null;
      let promptHistoryAfterAppend: readonly string[] | null = null;
      let promptHistoryWasPersisted = false;
      let draftSubmissionClaimed = false;
      let editorClearedOptimistically = false;
      const claimSubmittedDraft = () => {
        if (draftPersistTimerRef.current !== null) {
          window.clearTimeout(draftPersistTimerRef.current);
          draftPersistTimerRef.current = null;
        }
        // First-send promotion can switch scope or rebuild the Composer before onSendText returns.
        // Letting the stale scope effect persist would have the new Composer restore already-sent body text as a draft.
        // Claim and hide the draft before committing; restore on the failure path -- never mask the race with await time.
        suppressDraftPersistRef.current = true;
        updateComposerContent({ text: "" });
        draftSubmissionClaimed = true;
      };
      const restoreSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        // If the user edited while waiting, the current full text is the newer truth; a stale failure reply must not overwrite it.
        if (contentRevisionRef.current === cleanupRevision) {
          updateComposerContent(submittedDraft);
        }
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
        if (editorClearedOptimistically && contentRevisionRef.current === cleanupRevision) {
          if (submittedDraft.editorStateJson) {
            inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
          } else {
            inputApiRef.current?.setText(submittedDraft.text);
          }
          updateText(submittedDraft.text);
          editorClearedOptimistically = false;
        }
      };
      const finalizeSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
      };
      const rollbackPromptHistory = () => {
        if (!promptHistoryWasPersisted || !promptHistoryBeforeSend || !promptHistoryAfterAppend) {
          return;
        }
        const currentPromptHistory = readPromptHistoryEntries(workspacePath);
        if (arePromptHistoryEntriesEqual(currentPromptHistory, promptHistoryAfterAppend)) {
          persistPromptHistoryEntries(workspacePath, promptHistoryBeforeSend);
          setPromptHistory(promptHistoryBeforeSend);
          return;
        }
        setPromptHistory(currentPromptHistory);
      };
      try {
        // Second gate: consume only finished pre-uploaded refs; never fall back to uploading inside the send click.
        const readyAttachmentRefs = await attachmentsApi.prepareForSend();
        if (readyAttachmentRefs === null) {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // send_click is already reported; leaving it unsettled strands an unpaired sample and pollutes the success-rate denominator.
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "attachment_not_ready",
          });
          sendAction.fail({ failureStage: "attachment_not_ready" });
          return;
        }
        // External context bypasses protocol attachments; it serializes in the fixed tail order selection -> code comment -> web -> PPTX
        // so historical user rows parse losslessly in reverse and hide the internal prompt blocks.
        //
        // Share handover does not serialize here: the share-URL block is renderer-internal only (nothing in the CLI/shared
        // layer parses it) whose only job was a since-cut chip, at the cost of stuffing a
        // share URL into the model-bound body. The model side arrives via the hidden shared_context message through
        // inputIntent.sharedContextRefs -- unrelated to the body.
        const promptText = serializeComposerPromptContexts(trimmed, {
          codeComments: currentCodeCommentContexts,
          conversationSelections: [],
          webElements: currentWebElementContexts,
          pptxElements: currentPptxElementReferences,
          pluginUiContexts: currentPluginUiContexts,
        });
        const contextAttachmentCount =
          countComposerPromptContexts({
            codeComments: currentCodeCommentContexts,
            conversationSelections: currentConversationSelections,
            webElements: currentWebElementContexts,
            pptxElements: currentPptxElementReferences,
            pluginUiContexts: currentPluginUiContexts,
          }) + (submittedShareContext ? 1 : 0);
        if (trimmed) {
          promptHistoryBeforeSend = readPromptHistoryEntries(workspacePath);
          promptHistoryAfterAppend = appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed);
          if (!arePromptHistoryEntriesEqual(promptHistoryBeforeSend, promptHistoryAfterAppend)) {
            // Once a prewarm first-send is accepted, SessionPane promotes to the new session immediately and the draft
            // composer may unmount before the await resumes -- never hide the disk write inside a React state updater.
            // Keep the old UI's localStorage history instead of the input_history database:
            // write through synchronously before the real send, and restore the pre-send snapshot on failure.
            persistPromptHistoryEntries(workspacePath, promptHistoryAfterAppend);
            promptHistoryWasPersisted = true;
            setPromptHistory(promptHistoryAfterAppend);
          }
        }
        claimSubmittedDraft();
        if (requestedDelivery === "startNow") {
          // Atomic preemption waits for the old turn to exit and the new TurnStarted ACK to commit;
          // if the editor also waited for the whole chain to clear, the shortcut would look dead.
          // Clear the visible body first; on rejection restore verbatim from the frozen editor state.
          inputApiRef.current?.clear();
          updateText("");
          cleanupRevision = contentRevisionRef.current;
          editorClearedOptimistically = true;
        }
        const sendResult = await onSendText(promptText, {
          submission,
          ...(currentConversationSelections.length
            ? {
                conversationQuotes: currentConversationSelections.map(
                  ({ text, path, senderName, senderId, messageId, sentAt }) => ({
                    text,
                    path,
                    senderName,
                    senderId,
                    messageId,
                    sentAt,
                  }),
                ),
              }
            : {}),
          telemetrySeed,
          ...(requestedDelivery ? { requestedDelivery } : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
          ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
          ...(submittedShareContext
            ? {
                sharedContextRefs: [
                  {
                    kind: "shared_context_import" as const,
                    context_id: submittedShareContext.contextId,
                  },
                ],
              }
            : {}),
        });
        if (sendResult === "blocked") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // The product guard is a plain rejection, not an exception path: roll back the history staged pre-send
          // without clearing editor/draft/attachments, so a mode switch can retry directly.
          rollbackPromptHistory();
          restoreSubmittedDraft();
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "blocked",
          });
          sendAction.reject({ resultSource: "authority_ack", admissionResult: "rejected" });
          return;
        }
        if (sendResult === "confirmationRequired") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, true);
          rollbackPromptHistory();
          restoreSubmittedDraft();
          const latestQueueItemIds =
            snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
          // The first submit freezes the current queue; after a cross-device stale, replace it from the latest projection and ask for confirmation again.
          setHeldQueueConfirmation({
            // Marks queueConfirmed: settlement reuses this seed, so send_cost_ms includes the time spent in the dialog.
            telemetrySeed: { ...telemetrySeed, queueConfirmed: true },
            ...(requestedDelivery ? { requestedDelivery } : {}),
            queueItemIds:
              latestQueueItemIds.length > 0 ? latestQueueItemIds : submittedQueueItemIds,
          });
          sendAction.noop();
          return;
        }
        setHeldQueueConfirmation(null);
        // Staged content is handed to the task only on send success; on failure it stays a retryable draft.
        await attachmentsApi.adoptSentAttachments(submittedAttachmentIds);
        // Bug: text typed while the send is in flight belongs to the next Submission; a stale ACK must not clear it.
        if (contentRevisionRef.current === cleanupRevision) {
          inputApiRef.current?.clear();
          updateText("");
        }
        attachmentsApi.clearAttachments(submittedAttachmentIds);
        // Like attachments, remove only the refs frozen for this send; refs added while waiting belong to the next message.
        currentCodeCommentContexts.forEach(removeCodeCommentContext);
        currentWebElementContexts.forEach((context) => removeWebElementContext(context.id));
        currentPluginUiContexts.forEach((context) => removePluginUiContext(context.id));
        currentPptxElementReferences.forEach((reference) =>
          removePptxElementReference(reference.id),
        );
        currentConversationSelections.forEach((reference) =>
          removeConversationSelectionReference(reference.id),
        );
        // Send succeeded: clear the scope draft captured for this submission; prompt history already wrote through pre-send,
        // so the first-send promote cannot lose it or wipe the post-promotion scope.
        finalizeSubmittedDraft();
        sendAction.complete({ resultSource: "authority_ack", admissionResult: "accepted" });
      } catch (error) {
        rollbackPromptHistory();
        restoreSubmittedDraft();
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        // On send failure the draft stays in the input (not cleared); only the reason is recorded.
        logger.warn(`[v4-composer] send failed: ${String(error)}`);
        // ACK-side failures are settled by SessionPane; reaching here means a composer-local pipeline error.
        conversationTelemetry?.settleSendResult({
          seed: telemetrySeed,
          sessionId: sessionId ?? null,
          status: "fail",
          reasonCode: "composer_error",
        });
        sendAction.fail({ failureStage: "composer_send" });
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [
      attachmentsApi,
      conversationSelectionReferences,
      conversationTelemetry,
      draftConfig,
      createSubmissionFromComposer,
      submissionReady,
      getCodeCommentContexts,
      telemetryDraftConfig,
      modelSelectionView,
      onSendText,
      pendingShareContext,
      provider,
      readPlanIdentitySnapshot,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeWebElementContext,
      removePluginUiContext,
      pluginUiContexts,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      updateComposerContent,
      webElementContexts,
      pptxElementReferences,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // Lexical onChange (stable from the first character; see LexicalChatInput.TextContentPlugin).
  const handleEditorChange = useCallback(
    (value: string) => {
      conversationTelemetry?.recordComposerTextChange(value);
      updateText(value);
      // Body text enters the same in-memory Draft as mode/model first; debounce only augments the latest Lexical JSON.
      updateComposerContent({ text: value });
      scheduleDraftPersist();
    },
    [conversationTelemetry, scheduleDraftPersist, updateComposerContent, updateText],
  );

  const handleEditorFocus = useCallback(() => {
    conversationTelemetry?.recordComposerFocus();
    // Programmatic focus is not a click into the input; the flag is one-shot, later manual focuses report as usual.
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    conversationTelemetry?.recordComposerFocusClick({
      sessionId: sessionId ?? null,
    });
  }, [conversationTelemetry, sessionId]);

  // Editor submit (Enter / send button share the form-submit path). Returning false: the editor never resets itself,
  // submit clears via inputApiRef.clear() on success - on failure the draft stays in the input.
  const handleEditorSubmit = useCallback(
    (value: string) => {
      textRef.current = value;
      const reverseDelivery = reversePointerDeliveryRef.current;
      reversePointerDeliveryRef.current = false;
      const followupMode = snapshotRef.current?.config.followupMode;
      void submit(
        undefined,
        undefined,
        undefined,
        reverseDelivery && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleModifiedEditorSubmit = useCallback(
    (value: string) => {
      const followupMode = snapshotRef.current?.config.followupMode;
      textRef.current = value;
      // Early in a turn, inputRouting may still be startNow; never use it
      // to infer idle. The modifier always expresses a one-shot reversed delivery; an idle CLI starts now anyway.
      void submit(
        undefined,
        undefined,
        undefined,
        followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleClearQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "clearQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleKeepQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "keepQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleStopClick = useCallback(() => {
    runUserAction({
      input: { featureId: "conversation.composer.message", action: "stop", trigger: "button" },
      operation: onStop,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "stop_generation",
    });
  }, [onStop]);

  // The send button is type=submit sharing handleEditorSubmit with Enter; DOM order guarantees click before
  // submit, so this only sets the flag; submit() reads and resets it.
  const handleSendButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      sendTriggerRef.current = "button";
      reversePointerDeliveryRef.current = shouldReverseFollowupDeliveryForPointer({
        enabled: modifiedEnterReversesDelivery,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isApplePlatform: appleKeyboardPlatform,
      });
    },
    [appleKeyboardPlatform, modifiedEnterReversesDelivery],
  );

  // -- Global add-to-conversation event (workspace file tree context menu/button) -> mention insert --
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleWorkspaceFileAddToChat = (event: Event) => {
      if (!isWorkspaceFileAddToChatEvent(event)) {
        return;
      }
      event.preventDefault();
      appendWorkspaceFileMentionToComposer({
        inputApiRef,
        currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
        payload: event.detail,
        workspacePath,
        workspaceIdentity,
        onTextChange: updateText,
      });
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    };
  }, [listenAddToChatEvents, updateText, workspaceIdentity, workspacePath]);

  // Dynamic placeholder (legacy chatViewPlaceholder semantics): no history -> newTask;
  // history + idle -> followUpAsk; history + running -> followUpQueue.
  const placeholder = intl.formatMessage({
    id: resolveChatPlaceholderKey({
      hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
      isTaskProcessing: canStop,
      compactNewTask: compactMobilePlaceholder,
    }),
  });
  const sendTooltipTitle = intl.formatMessage({
    id: mode === "enqueue" ? "chat.queue.enqueue" : "chat.send",
  });
  const modifierTooltip = resolveFollowupModifierTooltip({
    enabled: modifiedEnterReversesDelivery,
    canSend,
    modifierPressed: primaryModifierPressed,
    followupMode: snapshot?.config.followupMode,
    isApplePlatform: appleKeyboardPlatform,
  });
  const resolvedSendTooltipTitle = modifierTooltip
    ? intl.formatMessage({ id: modifierTooltip.titleId })
    : sendTooltipTitle;
  const resolvedSendTooltipShortcut = modifierTooltip?.shortcut ?? sendShortcut;
  const stopTooltipTitle = intl.formatMessage({ id: "chat.stop" });
  const visibleError = error && !shouldSuppressChatErrorBanner(error) ? error : null;

  useEffect(() => {
    if (!visibleError || !conversationTelemetry || !telemetryVisible) return;
    const telemetryKey = [
      visibleError.taskId ?? sessionId ?? "",
      visibleError.code ?? "",
      visibleError.traceId ?? "",
      visibleError.message,
    ].join(":");
    if (reportedErrorKeysRef.current.has(telemetryKey)) return;
    reportedErrorKeysRef.current.add(telemetryKey);
    // Errors surface only once actually rendered past suppression; once per key per composer mount.
    conversationTelemetry.reportVisibleChatError({
      errorKey: telemetryKey,
      displayMessage: resolveChatErrorBannerDisplayMessage(visibleError, intl),
      error: visibleError,
    });
  }, [conversationTelemetry, intl, sessionId, telemetryVisible, visibleError]);

  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      menuItemTestId: TID_CHAT_ATTACHMENT_MENU_ITEM,
      onSelect: () =>
        runUserAction({
          input: {
            featureId: "conversation.composer.attachment",
            action: "add",
            trigger: "button",
          },
          operation: attachmentsApi.openAttachmentPicker,
          completed: { resultSource: "local_commit" },
          failureStage: "attachment_picker",
        }),
      testId: TID_CHAT_ATTACHMENT_BUTTON,
    }),
    [intl, attachmentsApi.openAttachmentPicker],
  );

  // -- Attachment preview grid --
  const composerAttachments = attachmentsApi.attachments;
  const orderedComposerAttachments = useMemo(() => {
    // Media group (images/video) first, files after; within a group, insertion order.
    const media: (typeof composerAttachments)[number][] = [];
    const files: (typeof composerAttachments)[number][] = [];
    for (const attachment of composerAttachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [composerAttachments]);
  const composerMediaPreviewItems = useMemo(
    () =>
      composerAttachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [composerAttachments],
  );
  const topContentNode = useMemo(() => {
    if (
      composerAttachments.length === 0 &&
      codeCommentContexts.length === 0 &&
      webElementContexts.length === 0 &&
      pptxElementReferences.length === 0 &&
      conversationSelectionReferences.length === 0 &&
      pluginUiContexts.length === 0
    ) {
      return null;
    }
    return (
      <div className="flex max-w-full flex-col items-start gap-2">
        {composerAttachments.length > 0 ? (
          <Attachments
            variant="inline"
            className="flex max-w-full flex-wrap gap-2"
            data-composer-file-attachments-row="true"
          >
            {orderedComposerAttachments.map((attachment) => {
              const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
              const isMediaAttachment = isMediaChatComposerAttachment(attachment);
              const isVideoAttachment = isVideoChatComposerAttachment(attachment);
              const isPdfAttachment = isPdfChatComposerAttachment(attachment);
              const mediaType = attachment.objectUrl
                ? attachment.mimeType
                : attachment.mimeType.startsWith("image/")
                  ? "application/octet-stream"
                  : attachment.mimeType;
              const canPreviewImageAttachment =
                Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
              const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
              const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
              const fileDisplayDescriptor = resolveFileDisplayDescriptor(
                attachment.localPath ?? attachment.filename,
              );
              const uploadStatusLabel =
                attachment.uploadStatus === "uploading"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.uploading" },
                      { progress: String(attachment.uploadProgress) },
                    )
                  : attachment.uploadStatus === "failed"
                    ? intl.formatMessage(
                        { id: "chat.attachments.upload.failed" },
                        { message: attachment.uploadError ?? "unknown" },
                      )
                    : intl.formatMessage({
                        id: `chat.attachments.upload.${attachment.uploadStatus}`,
                      });
              const showUploadStatus =
                !attachment.localZeroCopy &&
                (attachment.uploadStatus !== "ready" || attachment.showComplete);
              return (
                <Attachment
                  key={attachment.id}
                  variant={isMediaAttachment ? "grid" : "inline"}
                  data-composer-attachment-kind={
                    isVideoAttachment
                      ? "video"
                      : isMediaAttachment
                        ? "image"
                        : isPdfAttachment
                          ? "pdf"
                          : "file"
                  }
                  data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
                  data-upload-status={attachment.uploadStatus}
                  className={
                    isMediaAttachment
                      ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                      : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
                  }
                  data={{
                    id: attachment.id,
                    type: "file",
                    filename: attachment.filename,
                    ...(isClipboardTextAttachment
                      ? {
                          description: intl.formatMessage(
                            {
                              id: "chat.attachments.clipboardText.description",
                            },
                            {
                              lineCount: formatAttachmentLineCount(attachment, locale),
                            },
                          ),
                          displayName: intl.formatMessage({
                            id: "chat.attachments.clipboardText",
                          }),
                          sourceKind: "clipboard-text" as const,
                        }
                      : {}),
                    mediaType,
                    url: attachment.objectUrl ?? "",
                  }}
                  onRemove={() => attachmentsApi.removeAttachment(attachment.id)}
                  // Attachments support non-image formats: PDF gets the dedicated PdfViewer,
                  // other files show a type icon and name, so docs never fail as broken images.
                  // Images and videos enter the pre-send gallery in insertion order,
                  // keeping each media group navigable in sequence.
                  onOpen={
                    canPreviewImageAttachment || canPreviewVideoAttachment
                      ? () => {
                          const previewIndex = composerMediaPreviewItems.findIndex(
                            (item) => item.src === attachment.objectUrl,
                          );
                          if (previewIndex < 0) return;
                          setAttachmentPreviewIndex(previewIndex);
                          setAttachmentPreviewOpen(true);
                        }
                      : canPreviewPdfAttachment
                        ? () => {
                            setPdfAttachmentPreview({
                              filename: attachment.filename,
                              mediaType: "application/pdf",
                              url: attachment.objectUrl,
                            });
                            setPdfAttachmentPreviewOpen(true);
                          }
                        : undefined
                  }
                  openLabel={
                    canPreviewVideoAttachment
                      ? videoAttachmentPreviewTitle
                      : canPreviewImageAttachment
                        ? attachmentPreviewTitle
                        : canPreviewPdfAttachment
                          ? intl.formatMessage({ id: "chat.attachments.preview.openPdf" })
                          : undefined
                  }
                >
                  <div
                    className={cn(
                      "relative shrink-0",
                      isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                    )}
                  >
                    <AttachmentPreview
                      className={cn(
                        isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md",
                      )}
                      fallbackIcon={
                        isClipboardTextAttachment ? (
                          <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                        ) : (
                          <FileDisplayIcon
                            src={fileDisplayDescriptor.fileIconSrc}
                            size={16}
                            className="size-4 shrink-0"
                          />
                        )
                      }
                    />
                    {showUploadStatus && isMediaAttachment ? (
                      <span
                        data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                        role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                        aria-label={uploadStatusLabel}
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                      >
                        <svg
                          aria-hidden="true"
                          className="absolute inset-0 size-full -rotate-90 text-brand"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="stroke-border"
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeWidth="2"
                          />
                          <circle
                            className={
                              attachment.uploadStatus === "failed"
                                ? "stroke-destructive"
                                : "stroke-current"
                            }
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeDasharray={`${attachment.uploadProgress} 100`}
                            strokeLinecap="round"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="relative">
                          {attachment.uploadStatus === "failed"
                            ? "!"
                            : `${attachment.uploadProgress}%`}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {!isMediaAttachment ? (
                    isClipboardTextAttachment ? (
                      <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                    ) : (
                      <div className="min-w-0 max-w-40 flex-1">
                        <span
                          className="block truncate text-ui-base font-medium text-foreground"
                          title={attachment.filename}
                        >
                          {attachment.sourceKind === "topic-history"
                            ? intl.formatMessage(
                                { id: "chat.attachments.topicHistory" },
                                { count: attachment.messageCount ?? 0 },
                              )
                            : attachment.filename}
                        </span>
                        <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                          {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                        </span>
                      </div>
                    )
                  ) : null}
                  {showUploadStatus && !isMediaAttachment ? (
                    <span
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                      role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      title={uploadStatusLabel}
                      className={cn(
                        "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                        attachment.uploadStatus === "failed" && "text-destructive",
                      )}
                    >
                      {attachment.uploadStatus === "uploading"
                        ? `${attachment.uploadProgress}%`
                        : uploadStatusLabel}
                    </span>
                  ) : null}
                  {attachment.uploadStatus === "failed" ? (
                    <button
                      type="button"
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                      aria-label={intl.formatMessage({
                        id: "chat.attachments.upload.retry",
                      })}
                      title={uploadStatusLabel}
                      className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        attachmentsApi.retryAttachment(attachment.id);
                      }}
                    >
                      <RotateCcwIcon className="size-3" />
                    </button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-composer-attachment-remove={attachment.id}
                    aria-label={intl.formatMessage({
                      id: "chat.attachments.remove",
                    })}
                    className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      attachmentsApi.removeAttachment(attachment.id);
                    }}
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Attachment>
              );
            })}
          </Attachments>
        ) : null}
        {codeCommentContexts.length > 0 ||
        webElementContexts.length > 0 ||
        pptxElementReferences.length > 0 ||
        conversationSelectionReferences.length > 0 ||
        pluginUiContexts.length > 0 ? (
          <div
            className="flex max-w-full flex-wrap items-center gap-2"
            data-composer-context-attachments-row="true"
          >
            <CodeCommentAttachmentChip
              comments={codeCommentContexts}
              onRemove={removeCodeCommentContext}
              onRemoveAll={clearCodeCommentContexts}
            />
            <WebElementContextAttachmentChip
              contexts={webElementContexts}
              onRemove={removeWebElementContext}
              onRemoveAll={clearWebElementContexts}
            />
            <PluginUiModelContextChip
              contexts={pluginUiContexts}
              onRemove={removePluginUiContext}
              onRemoveAll={clearPluginUiContexts}
            />
            <PptxElementReferenceChip
              references={pptxElementReferences}
              onOpen={onOpenCodeViewer ? openPptxElementReference : undefined}
              onRemove={removePptxElementReference}
              onRemoveAll={clearPptxElementReferences}
            />
            <ConversationSelectionReferenceChip
              references={conversationSelectionReferences}
              onRemove={removeConversationSelectionReference}
              onRemoveAll={clearConversationSelectionReferences}
            />
          </div>
        ) : null}
      </div>
    );
  }, [
    attachmentPreviewTitle,
    attachmentsApi,
    clearCodeCommentContexts,
    clearConversationSelectionReferences,
    clearWebElementContexts,
    clearPluginUiContexts,
    clearPptxElementReferences,
    codeCommentContexts,
    composerAttachments,
    composerMediaPreviewItems,
    orderedComposerAttachments,
    intl,
    locale,
    removeCodeCommentContext,
    removeConversationSelectionReference,
    removeWebElementContext,
    removePluginUiContext,
    removePptxElementReference,
    conversationSelectionReferences,
    pendingShareContext,
    webElementContexts,
    pluginUiContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
  ]);

  // Send/stop control cluster (parity with the legacy ChatViewComposer.submitControlNode:
  // left model/thought/usage cluster + right stop or send).
  // useMemo: the composer re-renders on every streaming snapshot; the cluster rebuilds only on semantic dep changes,
  // avoiding a Tooltip/Select subtree rebuild per token batch.
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModelTrace = useCallback(
    (nextProvider: string, nextModel: string, sourceModel: ModelSelectionSource | null) =>
      runUserAction({
        input: {
          featureId: "conversation.composer.config",
          action: "change_model",
          trigger: "select",
        },
        operation: () => onSelectModel(nextProvider, nextModel, sourceModel),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "model_change",
      }),
    [onSelectModel],
  );
  const submitControlNode = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1">
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
          <V4ComposerModelControls
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            modelSelectionView={modelSelectionView}
            modelSelectionState={modelSelectionState}
            modelSelectionReload={modelSelectionReload}
            sessionId={sessionId ?? null}
            phase={composerPhase}
            provider={provider}
            isWebRemoteControl={isWebRemoteControl}
            isMobileViewport={isMobileTextInputViewport}
            draftMode={draftMode}
            draftConfig={draftConfig}
            usage={composerUsage}
            disabled={disabled}
            modelLocked={highspeedCard !== null}
            highspeedPresented={highspeedPresented}
            highspeedEntranceAnimated={highspeedEntranceAnimated}
            highspeedSweepActive={highspeedSweepActive}
            highspeedExpiresAt={highspeedCard?.expiresAt}
            highspeedModel={highspeedCard?.model}
            activeConfigPicker={activeConfigPicker}
            onConfigPickerOpenChange={handleConfigPickerOpenChange}
            onSelectModel={handleSelectModelTrace}
            onSelectThought={onSelectThought}
            onSwitchMode={onSwitchMode}
            onRecoverCustomModelSelection={onRecoverCustomModelSelection}
            onSendCompressionCommand={onSendCompressionCommand}
          />
        </span>
        {showStopControl ? (
          <ControlHintTooltip title={stopTooltipTitle} shortcut="Esc">
            <Button
              type="button"
              variant="secondary"
              size="icon-md"
              onClick={handleStopClick}
              data-testid={TID_V4_STOP}
              aria-label={stopTooltipTitle}
            >
              <SquareIcon className="size-4 fill-current" />
              <span className="sr-only">{stopTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        ) : (
          <ControlHintTooltip
            title={resolvedSendTooltipTitle}
            shortcut={resolvedSendTooltipShortcut}
            open={Boolean(modifierTooltip) || sendTooltipOpen}
            onOpenChange={setSendTooltipOpen}
          >
            <Button
              type="submit"
              size="icon-md"
              disabled={!canSend}
              onClick={handleSendButtonClick}
              data-testid={TID_V4_COMPOSER_SEND}
              aria-label={resolvedSendTooltipTitle}
              className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
            >
              {pending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
              <span className="sr-only">{resolvedSendTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    ),
    [
      canSend,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      disabled,
      draftConfig,
      draftMode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      highspeedCard,
      highspeedEntranceAnimated,
      highspeedPresented,
      highspeedSweepActive,
      isWebRemoteControl,
      mode,
      handleSelectModelTrace,
      modelSelectionReload,
      modelSelectionState,
      modelSelectionView,
      onSelectThought,
      onRecoverCustomModelSelection,
      onSendCompressionCommand,
      onSwitchMode,
      pending,
      provider,
      modifierTooltip,
      resolvedSendTooltipShortcut,
      resolvedSendTooltipTitle,
      sendTooltipOpen,
      sendShortcut,
      sendTooltipTitle,
      sessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // Bottom-left: mode selection + CUA entry + current-session background works. followupMode is synced to the CLI from app settings,
  // with no composer-local toggle; the background entry consumes the same snapshot, never a second task state.
  const leadingActionsNode = useMemo(
    () => (
      <>
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          provider={provider}
          draftConfig={draftConfig}
          disabled={disabled}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={handleConfigPickerOpenChange}
          onSwitchMode={onSwitchMode}
        />
        {/* Cause: the attachment-gallery rebase overwrote leadingActions wholesale, dropping the staged CUA persistent entry.
            The entry itself still owns platform/remote/settings visibility; no duplicate judgment here. */}
        <V4ComposerCuaEntry
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          isWebRemoteControl={isWebRemoteControl}
          currentSessionBusy={canStop}
        />
        <ConversationBackgroundWorkTrigger
          backgroundWorks={snapshot?.backgroundWorks ?? []}
          runningSubagentCount={runningSubagentCount}
          onOpen={onOpenRunningBackgroundWorks}
          openTarget={backgroundWorkOpenTarget}
        />
      </>
    ),
    [
      activeConfigPicker,
      canStop,
      disabled,
      draftConfig,
      handleConfigPickerOpenChange,
      isWebRemoteControl,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      provider,
      remoteSessionId,
      runningSubagentCount,
      snapshot?.backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const isBlockedByInteraction = blockingRequestId !== null;

  // v4 pendingInteractions is a bottom-dock blocking state; the composer must stay mounted,
  // hidden only visually and from the a11y tree, so permission/Q&A cards never cost the draft or editor state.
  return (
    // The outer bottom dock owns sticky and main-column width; the composer organizes error surface and input shell.
    // centered (centered draft layout, m5): narrower max-w-2xl (the draft step of legacy
    // getChatViewComposerWidthClassName), positioned by the host centered container.
    // With a contextHeader (draft state), the inner input surface wears the legacy ChatViewComposer card:
    // rounded-2xl bg-surface shadow-xl/5; session state falls back to the opaque page background.
    // Though the error banner precedes the contextHeader, it must not share the input rounded surface,
    // or it reads as the input-card header; narrowing the surface to workspace header + editor keeps the DOM
    // order shared by desktop and phone web while restoring separate layers for error and input card.
    <div
      data-testid={TID_V4_COMPOSER}
      data-input-routing={mode}
      aria-hidden={isBlockedByInteraction ? true : undefined}
      style={isBlockedByInteraction ? { display: "none" } : undefined}
      className={cn(
        "chat-composer-region z-20 w-full shrink-0 @container/composer",
        centered && "max-w-2xl",
      )}
    >
      {/* Legacy ChatViewComposer-style hidden file input (web / no-native-picker fallback). */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // Attachment errors alone would miss the session-level lastError; after a task failure the reason belongs above the input too.
        // Reuses the legacy ChatErrorBanner shell, fed only the SessionPane-normalized current error.
        // The error banner sits outside the input surface, before the desktop/phone-shared contextHeader.
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            onDismiss={onDismissError}
            onOpenModelSettings={onOpenModelSettings}
            onOpenUpgrade={onOpenModelUpgrade}
          />
        </div>
      ) : null}
      <div
        data-highspeed-composer={highspeedCard ? "true" : undefined}
        data-highspeed-entrance={highspeedCard ? highspeedEntrance : undefined}
        className={cn(
          "chat-composer-input-surface relative w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
          highspeedCard && "highspeed-composer-surface",
          highspeedPresented && "highspeed-placeholder-presented",
        )}
      >
        {highspeedCard ? (
          <HighspeedComposerBackground
            key={highspeedCard.cardId}
            animated={highspeedEntranceAnimated}
            onModelTransitionStart={handleHighspeedModelTransitionStart}
          />
        ) : null}
        {contextHeader ? (
          // Legacy ChatViewComposer contextHeaderContent wrapper (workspace menu + Git branch).
          <div className="relative z-10 p-1.5 flex min-w-0 flex-wrap items-center gap-0">
            {contextHeader}
          </div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="relative z-10 mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={placeholder}
          disabled={disabled || mode === "reject"}
          submitting={pending}
          submitDisabled={pending || !routingAllowsSend || !attachmentsReady || !submissionReady}
          allowSubmitWhenEmpty={
            // The send button already counts code comments as sendable context, but this check missed the same state:
            // with empty text plus a code comment, Enter judged empty and forced the pointer.
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences ||
            hasPluginUiContexts
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ is the main entry for Plugin / file / conversation / canvas; # session and $ / ¥ / ￥ skills
          // remain compatible triggers in MentionPlugin but are not duplicated in the + menu.
          showMentionButton
          topContent={topContentNode}
          attachmentAction={attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          avoidIosInputFocusZoom={avoidIosInputFocusZoom}
          compactPlaceholder={compactMobilePlaceholder}
          // Cause: the command catalog must come verbatim from the CLI workspace slash catalog; the UI only
          // hides goal on secondary panes per product capability, never appending built-ins or aliases.
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={appSlashCommands}
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          className="p-0"
          shellClassName={
            highspeedCard
              ? "relative z-10 !rounded-none !border-0 !bg-transparent !transition-none hover:!border-transparent focus-within:!border-transparent focus-within:!bg-transparent"
              : undefined
          }
          onChange={handleEditorChange}
          onFocus={handleEditorFocus}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
        />
        {attachmentsApi.attachmentError ? (
          <p className="flex items-start gap-2 p-3 text-ui-base text-warning">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{attachmentsApi.attachmentError}</span>
          </p>
        ) : null}
      </div>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={composerMediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
      <Dialog
        open={heldQueueConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) {
            if (heldQueueConfirmation?.telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(
                heldQueueConfirmation.telemetrySeed.localTtft,
                "cancelled",
              );
            setHeldQueueConfirmation(null);
          }
        }}
      >
        <DialogContent
          data-testid={TID_V4_PAUSED_QUEUE_SEND_DIALOG}
          showCloseButton={false}
          className="max-w-xl gap-6 p-6 sm:p-8"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={pending}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute top-4 right-4"
            >
              <XIcon className="size-5" />
            </Button>
          </DialogClose>
          <DialogHeader className="gap-3 pr-8">
            <DialogTitle className="text-xl font-semibold sm:text-2xl">
              {intl.formatMessage({ id: "chat.queue.sendConfirm.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base sm:text-ui-lg">
              {intl.formatMessage(
                { id: "chat.queue.sendConfirm.description" },
                {
                  count: String(heldQueueConfirmation?.queueItemIds.length ?? 0),
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_V4_COMPOSER_CLEAR_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleClearQueueSend}
            >
              {intl.formatMessage({ id: "chat.queue.sendConfirm.clear" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_V4_COMPOSER_KEEP_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleKeepQueueSend}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {intl.formatMessage({ id: "chat.queue.sendConfirm.keep" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const ConversationComposer = memo(ConversationComposerImpl);
