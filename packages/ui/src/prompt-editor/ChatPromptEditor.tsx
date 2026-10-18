/* oxlint-disable eslint(max-lines) -- the input shell owns Lexical sync, drag-drop, and toolbar slots; no component split yet. */
// Input display shell: pure props, no store/protocol dependencies; the mention panel passes through enableMentionPanel.
import type {
  KeyboardEventHandler,
  DragEventHandler,
  FormEventHandler,
  MutableRefObject,
  ReactNode,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TID_CHAT_SEND_BUTTON } from "@zcode/shared";
import { ArrowUpIcon, Hand, XIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import {
  LexicalChatInput,
  type ChatComposerPasteEvent,
  type LexicalChatInputHandle,
} from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import {
  hasWorkspaceFileDragPayload,
  readWorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { ChatPromptActionMenu } from "@/prompt-editor/ChatPromptActionMenu.js";
import { useComposerToolbarFit } from "@/prompt-editor/useComposerToolbarFit.js";

function runAfterFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  callback();
}

export function ChatPromptEditor({
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  initialValue,
  syncInitialValueOnMount = true,
  placeholder,
  disabled = false,
  disabledReason,
  submitting = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  submitLabel,
  cancelLabel,
  showMentionButton = false,
  showSlashButton = false,
  enableWorkspaceFileDrop = false,
  enableExternalFileDrop = false,
  isDraggingOver = false,
  dragAttachmentHint,
  topContent,
  leadingActions,
  attachmentAction,
  betweenCancelAndSubmitAction,
  submitControl,
  inputTestId,
  submitTestId,
  cancelTestId,
  inputApiRef,
  onModeSwitchContainerChange,
  triggerPanelContainer,
  promptHistory,
  className,
  shellClassName,
  compactPlaceholder = false,
  onChange,
  onSubmit,
  onModifiedSubmit,
  onCancel,
  onFocus,
  onWhiteboardMentionSelected,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  excludedSlashCommandNames,
  appSlashCommands,
  enableMentionPanel,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** For the Composer Skill catalog only; may be a draft's prewarmed session. */
  skillCatalogSessionId?: string | null;
  initialValue?: string;
  syncInitialValueOnMount?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  submitLabel: string;
  cancelLabel?: string;
  showMentionButton?: boolean;
  showSlashButton?: boolean;
  enableWorkspaceFileDrop?: boolean;
  enableExternalFileDrop?: boolean;
  isDraggingOver?: boolean;
  dragAttachmentHint?: string;
  topContent?: ReactNode;
  leadingActions?: ReactNode;
  attachmentAction?: {
    label: string;
    onSelect: () => void;
    testId?: string;
    menuItemTestId?: string;
  };
  /** Inline-edit only: fixed second action between cancel and primary submit. */
  betweenCancelAndSubmitAction?: ReactNode;
  submitControl?: ReactNode;
  inputTestId?: string;
  submitTestId?: string;
  cancelTestId?: string;
  inputApiRef?: MutableRefObject<LexicalChatInputHandle | null>;
  onModeSwitchContainerChange?: (container: HTMLSpanElement | null) => void;
  triggerPanelContainer?: HTMLElement | null;
  promptHistory?: readonly string[];
  className?: string;
  shellClassName?: string;
  compactPlaceholder?: boolean;
  onChange?: (value: string) => void;
  // Adapter: false means the business layer rejected/deferred the submit; Lexical does not reset
  // (draft kept).
  onSubmit: (value: string) => boolean | void;
  onModifiedSubmit?: (value: string) => boolean | void;
  onCancel?: () => void;
  onFocus?: () => void;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  excludedSlashCommandNames?: readonly string[];
  /** App-local slash commands (pass-through to LexicalChatInput). */
  appSlashCommands?: readonly AppSlashCommand[];
  /** Mention panel switch (pass-through to LexicalChatInput). */
  enableMentionPanel?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const toolbarRef = useComposerToolbarFit();
  const internalInputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const resolvedInputApiRef = inputApiRef ?? internalInputApiRef;
  const [internalTriggerPanelContainer, setInternalTriggerPanelContainer] =
    useState<HTMLDivElement | null>(null);
  const resolvedTriggerPanelContainer = triggerPanelContainer ?? internalTriggerPanelContainer;
  const latestTextRef = useRef(initialValue ?? "");
  const hasSyncedInitialValueRef = useRef(false);
  const {
    externalFileDragging,
    internalDragging,
    setExternalFileDragging,
    setInternalDragging,
    setWorkspaceFileDragging,
    workspaceFileDragging,
  } = usePromptEditorDragState({
    enableExternalFileDrop,
    enableWorkspaceFileDrop,
  });
  const actionMenuTitle = intl.formatMessage({
    id: "chat.composer.actionMenu",
  });
  const workspaceFileDragHint = intl.formatMessage({
    id: "chat.composer.workspaceFileDragHint",
  });
  const hasActionMenu = Boolean(attachmentAction) || showMentionButton || showSlashButton;

  useEffect(() => {
    if (!syncInitialValueOnMount) {
      return;
    }
    if (initialValue === undefined) {
      return;
    }
    if (hasSyncedInitialValueRef.current) {
      return;
    }
    hasSyncedInitialValueRef.current = true;

    latestTextRef.current = initialValue;
    runAfterFrame(() => {
      // On draft restore the outer input state is already updated, but Lexical's internal text
      // does not follow props. Plain typing also updates the input prop, so compare the editor
      // text first and never programmatically rewrite per keystroke.
      if (resolvedInputApiRef.current?.getMarkdown() === initialValue) {
        return;
      }
      resolvedInputApiRef.current?.setText(initialValue);
    });
  }, [initialValue, resolvedInputApiRef, syncInitialValueOnMount]);

  const handleTextChange = useCallback(
    (value: string) => {
      latestTextRef.current = value;
      onChange?.(value);
    },
    [onChange],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      onSubmit(resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current);
    },
    [onSubmit, resolvedInputApiRef],
  );

  const handleKeyDown: KeyboardEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      if (event.key !== "Escape" || !onCancel || submitting) {
        return;
      }

      // Mounted via React Portal, the dialog's Esc-close still bubbles along the tree into the
      // inline-edit form. The dialog consumed the interaction; do not cancel the message edit too.
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        return;
      }

      // Interaction: message edit is a transient state; Esc equals Cancel for a fast keyboard exit.
      event.preventDefault();
      onCancel();
    },
    [onCancel, submitting],
  );

  const handleEditorSubmit = useCallback(
    // Adapter: pass the business return through (false = keep the editor, draft kept); swallowing
    // it would make Enter always clear.
    (value: string) => onSubmit(value),
    [onSubmit],
  );

  const handleDragOver: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const hasWorkspaceFilePayload =
        enableWorkspaceFileDrop && hasWorkspaceFileDragPayload(event.dataTransfer);
      if (hasWorkspaceFilePayload) {
        // During dragover browsers usually expose only dataTransfer.types, not getData content.
        // Deciding on the full payload made drop work while the hover state stayed dark.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setWorkspaceFileDragging(true);
        setInternalDragging(true);
        return;
      }
      if (enableExternalFileDrop && Array.from(event.dataTransfer.types).includes("Files")) {
        setExternalFileDragging(true);
      }

      onDragOver?.(event);
    },
    [enableExternalFileDrop, enableWorkspaceFileDrop, onDragOver],
  );

  const handleDragLeave: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      setInternalDragging(false);
      onDragLeave?.(event);
    },
    [onDragLeave],
  );

  const handleDrop: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const workspaceFilePayload = enableWorkspaceFileDrop
        ? readWorkspaceFileDragPayload(event.dataTransfer)
        : null;
      if (workspaceFilePayload) {
        // File-tree drags are not system files; no attachment branch. Convert to the same mention
        // as @ files so contenteditable never gets plain text.
        event.preventDefault();
        // This editor nests inside the ChatView drop target; stop propagation after consuming,
        // or the bottom main input receives the same mention again.
        event.stopPropagation();
        setInternalDragging(false);
        setWorkspaceFileDragging(false);
        const currentMarkdown = resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current;
        appendWorkspaceFileMentionToComposer({
          inputApiRef: resolvedInputApiRef,
          currentMarkdown,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: handleTextChange,
        });
        return;
      }

      setInternalDragging(false);
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      onDrop?.(event);
    },
    [
      enableWorkspaceFileDrop,
      handleTextChange,
      onDrop,
      resolvedInputApiRef,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // File-tree drops into the editor insert mentions, not attachments. Use workspace-file copy and
  // light the droppable state from dragstart, not only once over the input.
  const isWorkspaceFileDropActive = workspaceFileDragging || internalDragging;
  const isExternalFileDropActive = externalFileDragging || isDraggingOver;
  const draggingOverlayHint = isWorkspaceFileDropActive
    ? workspaceFileDragHint
    : isExternalFileDropActive
      ? dragAttachmentHint
      : undefined;

  return (
    <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className={cn("relative", className)}>
      {triggerPanelContainer ? null : (
        <div
          ref={setInternalTriggerPanelContainer}
          className="absolute inset-x-0 bottom-full z-20"
        />
      )}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused",
          (isWorkspaceFileDropActive || isExternalFileDropActive) &&
            "border-brand bg-input-focused ring-1 ring-brand/30",
          shellClassName,
        )}
      >
        {draggingOverlayHint ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>{draggingOverlayHint}</span>
            </div>
          </div>
        ) : null}

        {topContent}
        <LexicalChatInput
          placeholder={placeholder}
          disabled={disabled}
          submitDisabled={submitDisabled}
          allowSubmitWhenEmpty={allowSubmitWhenEmpty}
          enterSubmits={enterSubmits}
          onSubmit={handleEditorSubmit}
          onModifiedSubmit={onModifiedSubmit}
          onChange={handleTextChange}
          onFocus={onFocus}
          triggerPanelContainer={resolvedTriggerPanelContainer}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={taskId}
          skillCatalogSessionId={skillCatalogSessionId}
          inputTestId={inputTestId}
          editorApiRef={resolvedInputApiRef}
          promptHistory={promptHistory}
          compactPlaceholder={compactPlaceholder}
          onWhiteboardMentionSelected={onWhiteboardMentionSelected}
          onPaste={onPaste}
          excludedSlashCommandNames={excludedSlashCommandNames}
          appSlashCommands={appSlashCommands}
          enableMentionPanel={enableMentionPanel}
        />
        <div ref={toolbarRef} className="group/toolbar flex items-end gap-3">
          <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions>
            <div className="flex shrink-0 items-center gap-1" data-composer-leading-content>
              {hasActionMenu ? (
                <ChatPromptActionMenu
                  actionMenuTitle={actionMenuTitle}
                  excludedSlashCommandNames={excludedSlashCommandNames}
                  attachmentAction={attachmentAction}
                  disabled={disabled}
                  disabledReason={disabledReason}
                  inputApiRef={resolvedInputApiRef}
                  workspacePath={workspacePath}
                  workspaceIdentity={workspaceIdentity}
                  sessionId={taskId}
                  container={resolvedTriggerPanelContainer}
                  showPlugins={enableMentionPanel !== false}
                />
              ) : null}
              {/* Permission/mode selectors used to render as leadingActions before the action menu, inverting the mandated order.*/}
              {leadingActions}
              {onModeSwitchContainerChange ? (
                <span ref={onModeSwitchContainerChange} className="flex shrink-0 items-center" />
              ) : null}
            </div>
          </div>
          <div
            className="ml-auto flex shrink-0 items-center justify-end gap-1.5"
            data-composer-trailing-actions
          >
            {onCancel && cancelLabel ? (
              <ControlHintTooltip title={cancelLabel} shortcut="Esc">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  onClick={onCancel}
                  disabled={submitting}
                  data-testid={cancelTestId}
                  aria-label={cancelLabel}
                >
                  <XIcon className="size-4" />
                  <span className="sr-only">{cancelLabel}</span>
                </Button>
              </ControlHintTooltip>
            ) : null}
            {betweenCancelAndSubmitAction}
            {submitControl ?? (
              <ControlHintTooltip title={submitLabel} shortcut={enterSubmits ? "Enter" : undefined}>
                <Button
                  type="submit"
                  size="icon-md"
                  disabled={submitDisabled}
                  data-testid={submitTestId ?? TID_CHAT_SEND_BUTTON}
                  aria-label={submitLabel}
                  className="gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
                >
                  {submitting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
                  <span className="sr-only">{submitLabel}</span>
                </Button>
              </ControlHintTooltip>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
