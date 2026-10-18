/* eslint-disable max-lines */
/**
 * LexicalChatInput, the Lexical-based chat composer.
 *
 * Lexical-based chat composer with slash commands and mention tags.
 * - Enter sends, Shift+Enter breaks the line
 * - IME-safe input
 * - Auto height (3 rows at rest, scrolls past that)
 * - Disabled state
 * - Trigger panels for `/` and `@` via SlashCommandPlugin / MentionPlugin
 *
 * A presentation shell only — no conversation orchestration — with three adapters:
 * 1. useChatViewActiveTaskProvider from @/v4/activeTaskProvider.js (config-side reads);
 * 2. ChatComposerPasteEvent narrowed to the struct type this file exports;
 * 3. the mention panel toggles via enableMentionPanel; slash commands always read the CLI workspace catalog.
 */
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { PromptClipboardPlugin } from "@/mentions/PromptClipboardPlugin.js";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
} from "@/shortcuts/composerShortcuts.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $getNodeByKey,
  $setSelection,
  $getRoot,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import { SlashCommandPlugin } from "./SlashCommandPlugin.js";
import type { AppSlashCommand } from "./slashCommandHelpers.js";
import { MentionPlugin } from "./mentions/MentionPlugin.js";
import { useChatViewActiveTaskProvider } from "@/v4/activeTaskProvider.js";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
  PromptMentionNode,
} from "./mentions/nodes/PromptMentionNode.js";
import { logger } from "./logger.js";
import { recordInputLag } from "./lib/uiPerfArmsTelemetry.js";
import { navigatePromptHistory } from "./lib/promptHistory.js";
import { resolveMobileInputTextSizeClassName } from "@/lib/mobileTextInput.js";
import type { MentionItemData } from "@/mentions/mentionTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

/** The old useChatComposer is gone; paste events narrow to this minimal structural type (ClipboardEvent-compatible). */
export interface ChatComposerPasteEvent {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export interface LexicalChatInputHandle {
  clear: () => void;
  focus: () => void;
  getEditorState: () => EditorState;
  getMarkdown: () => string;
  getText: () => string;
  appendText: (text: string) => void;
  appendFileMention: (
    label: string,
    value: string,
    markdown: string,
    data?: MentionItemData,
    trailingText?: string,
  ) => void;
  prependMentionIfMissing: (mention: ComposerMentionPrefill) => boolean;
  setMention: (mention: ComposerMentionPrefill, trailingText?: string) => void;
  insertMention: (mention: ComposerMentionPrefill, selectionState?: EditorState) => void;
  setText: (text: string) => void;
  setTextWithPluginMentions: (text: string) => void;
  setEditorStateJson: (editorStateJson: string) => void;
  setSkillMention: (skillName: string, markdown?: string, trailingText?: string) => void;
  setSlashCommandMention: (commandName: string, markdown?: string, trailingText?: string) => void;
}

interface LexicalEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  enterSubmits: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  text: string;
}

interface LexicalModifiedEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  modifiedEnterSubmits: boolean;
  shiftKey?: boolean;
  text: string;
}

export type LexicalSubmitResult = boolean | void;

interface LeadingChineseSlashAliasInputOptions {
  data: string | null;
  inputType: string;
  isAtEditorStart: boolean;
  isComposing?: boolean;
}

const CHINESE_SLASH_ALIAS = "、";
const STANDARD_SLASH_TRIGGER = "/";

import { HISTORY_NAVIGATION_UPDATE_TAG, PROGRAMMATIC_UPDATE_TAG } from "./lib/editorUpdateTags.js";

export function shouldSubmitLexicalEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  enterSubmits,
  isComposing = false,
  metaKey = false,
  shiftKey = false,
  text,
}: LexicalEnterSubmitOptions): boolean {
  if (!enterSubmits) {
    return false;
  }
  if (shiftKey || ctrlKey || metaKey || isComposing) {
    return false;
  }
  return Boolean(text.trim() || allowSubmitWhenEmpty);
}

export function shouldSubmitLexicalModifiedEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  isComposing = false,
  metaKey = false,
  modifiedEnterSubmits,
  shiftKey = false,
  text,
}: LexicalModifiedEnterSubmitOptions): boolean {
  return (
    modifiedEnterSubmits &&
    (ctrlKey || metaKey) &&
    !shiftKey &&
    !isComposing &&
    Boolean(text.trim() || allowSubmitWhenEmpty)
  );
}

export function shouldResetLexicalEditorAfterSubmit(result: LexicalSubmitResult): boolean {
  return result !== false;
}

export function shouldNormalizeLeadingChineseSlashAliasInput({
  data,
  inputType,
  isAtEditorStart,
  isComposing = false,
}: LeadingChineseSlashAliasInputOptions): boolean {
  return (
    data === CHINESE_SLASH_ALIAS && inputType === "insertText" && isAtEditorStart && !isComposing
  );
}

/** Extract editor content; mention nodes emit their markdown here */
function getEditorMarkdown(editorState: EditorState): string {
  let text = "";
  editorState.read(() => {
    text = $getPromptMarkdown();
  });
  return text;
}

function replaceEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();

      // Lexical getTextContent() joins paragraphs with \n\n; mirror that so newlines do not double.
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        if (line) {
          paragraph.append($createTextNode(line));
        }
        root.append(paragraph);
      }

      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

const INLINE_PLUGIN_MENTION_PATTERN =
  /\[@((?:\\.|[^\]])+)\]\(plugin:\/\/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)\)/g;

function replaceEditorTextWithPluginMentions(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        let cursor = 0;
        for (const match of line.matchAll(INLINE_PLUGIN_MENTION_PATTERN)) {
          const start = match.index ?? 0;
          if (start > cursor) paragraph.append($createTextNode(line.slice(cursor, start)));
          const markdown = match[0];
          const label = match[1]?.replaceAll("\\]", "]").replaceAll("\\[", "[") ?? "";
          const pluginId = match[2] ?? "";
          paragraph.append(
            $createPromptMentionNode({
              id: `plugin:${pluginId}`,
              category: "plugins",
              label,
              value: pluginId,
              markdown,
              data: { pluginId },
            }),
          );
          cursor = start + markdown.length;
        }
        if (cursor < line.length || paragraph.getChildrenSize() === 0) {
          paragraph.append($createTextNode(line.slice(cursor)));
        }
        root.append(paragraph);
      }
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

export function replaceEditorWithMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      // Keep the trailing space so typing continues seamlessly; selection correctness rests on the TextNode text/DOM contract.
      const trailing = $createTextNode(trailingText || " ");
      paragraph.append($createPromptMentionNode(mention), trailing);
      root.append(paragraph);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

/**
 * Insert a structured mention at the draft start, preserving existing Lexical nodes and paragraphs.
 *
 * Do not rebuild via getMarkdown to setMention: setMention is replace-style prefill and would
 * reinsert old mentions as plain TextNodes, downgrading live plugin/file/skill chips.
 */
export function prependEditorMentionIfMissing(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
): boolean {
  let inserted = false;
  editor.update(
    () => {
      const root = $getRoot();
      const alreadyPresent = root
        .getAllTextNodes()
        .some(
          (node) =>
            $isPromptMentionNode(node) &&
            node.getMention().category === mention.category &&
            node.getMention().value === mention.value,
        );
      if (alreadyPresent) return;

      const mentionNode = $createPromptMentionNode(mention);
      const separator = $createTextNode(" ");
      const firstBlock = root.getFirstChild();
      if ($isParagraphNode(firstBlock)) {
        const firstInline = firstBlock.getFirstChild();
        if (firstInline) {
          firstInline.insertBefore(mentionNode);
          mentionNode.insertAfter(separator);
        } else {
          firstBlock.append(mentionNode, separator);
        }
      } else {
        const paragraph = $createParagraphNode().append(mentionNode, separator);
        if (firstBlock) firstBlock.insertBefore(paragraph);
        else root.append(paragraph);
      }
      separator.selectEnd();
      inserted = true;
    },
    { discrete: true, tag: PROGRAMMATIC_UPDATE_TAG },
  );
  return inserted;
}

function replaceEditorStateJson(editor: LexicalEditor, editorStateJson: string) {
  const editorState = editor.parseEditorState(editorStateJson);
  editor.setEditorState(editorState, { tag: PROGRAMMATIC_UPDATE_TAG });
}

function resetEditor(editor: LexicalEditor) {
  replaceEditorText(editor, "");
}

function replaceEditorWithSkillMention(
  editor: LexicalEditor,
  skillName: string,
  markdown = `$${skillName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-skill:${skillName}`,
          category: "skills",
          // The prefill path inserted a skill node, but its stored markdown stayed fixed at `$slug`, so
          // entries like New Skill silently degraded on insert despite holding full translations. Pass the
          // original markdown through and show the frontmatter name directly; no further UI munging of the title.
          label: skillName,
          value: skillName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function replaceEditorWithSlashCommandMention(
  editor: LexicalEditor,
  commandName: string,
  markdown = `/${commandName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-slash:${commandName}`,
          category: "commands",
          label: commandName,
          value: commandName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function appendEditorFileMention(
  editor: LexicalEditor,
  label: string,
  value: string,
  markdown: string,
  data?: MentionItemData,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append(
        $createPromptMentionNode({
          id: `dropped-file:${value}`,
          category: "files",
          label,
          value,
          markdown,
          data,
        }),
        $createTextNode(trailingText),
      );
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function appendEditorPlainText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append($createTextNode(text));
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function getPromptMentionIdAfterDomSelection(rootElement: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  if (!rootElement.contains(anchorNode)) {
    return null;
  }

  if (anchorNode.nodeType === Node.ELEMENT_NODE) {
    const child = anchorNode.childNodes.item(selection.anchorOffset);
    return getPromptMentionIdFromBoundaryNode(child);
  }

  if (anchorNode.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  if (selection.anchorOffset !== (anchorNode.textContent ?? "").length) {
    return null;
  }

  return getPromptMentionIdFromBoundaryNode(anchorNode.nextSibling);
}

function getPromptMentionIdFromBoundaryNode(node: Node | null): string | null {
  if (!(node instanceof HTMLElement) || !node.matches("[data-mention-id]")) {
    return null;
  }
  return node.dataset.mentionId ?? null;
}

function selectAfterPromptMentionById(mentionId: string): boolean {
  const mentionNode = $getRoot()
    .getAllTextNodes()
    .find(
      (node): node is PromptMentionNode =>
        $isPromptMentionNode(node) && node.getMention().id === mentionId,
    );
  if (!mentionNode) {
    return false;
  }

  const nextSibling = mentionNode.getNextSibling();
  if ($isTextNode(nextSibling)) {
    const text = nextSibling.getTextContent();
    const offset = /^\s/.test(text) ? Math.min(1, text.length) : 0;
    nextSibling.select(offset, offset);
    return true;
  }

  mentionNode.selectNext(0, 0);
  return true;
}

/**
 * Keyboard behavior plugin: Enter sends, Shift+Enter breaks the line.
 *
 * Intercepts Enter at COMMAND_PRIORITY_HIGH,
 * suppressing Lexical's default paragraph insertion.
 */
function KeyboardPlugin({
  onSubmit,
  onModifiedSubmit,
  disabled,
  submitDisabled,
  allowSubmitWhenEmpty,
  enterSubmits,
}: {
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  // Scope-rebind layer: the composer command slice of the effective table; ref-passed so listeners never remount.
  const effectiveShortcutBindings = useEffectiveShortcutBindings();
  const composerEffectiveRef = useRef({
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  });
  composerEffectiveRef.current = {
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  };

  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;

        if (disabled) {
          event.preventDefault();
          return true;
        }

        // IME composing (e.g. CJK input): let it through
        if (event.isComposing) {
          return false;
        }

        const text = getEditorMarkdown(editor.getEditorState());

        // Scope-rebind layer: user bindings beat built-ins.
        // newline hit, let Lexical insert the paragraph; send hit, run the same gates as the main chain;
        // no hit, fall through to the main chain below (reverse delivery, modifier newline, viewport gates).
        const composerEffective = composerEffectiveRef.current;
        const scopedAction = resolveComposerKeyAction(event, composerEffective);
        if (scopedAction === "newline") {
          return false;
        }
        if (scopedAction === "send") {
          const modifiedScopedEnter = event.shiftKey || event.ctrlKey || event.metaKey;
          // With reverse delivery on, modified combos defer to the main chain (Ctrl+Enter means reverse delivery; delivery semantics beat keybindings)
          if (!(modifiedScopedEnter && onModifiedSubmit)) {
            // Same gates as the main chain's plain Enter: unmodified combos honor submitDisabled and the
            // mobile enterSubmits viewport gate; modified combos skip the viewport gate (as onModifiedSubmit does).
            if (submitDisabled || (!modifiedScopedEnter && !enterSubmits)) {
              return false;
            }
            event.preventDefault();
            if (
              shouldSubmitLexicalEnter({
                allowSubmitWhenEmpty,
                enterSubmits: modifiedScopedEnter ? true : enterSubmits,
                text,
              })
            ) {
              const submitResult = onSubmit(text);
              if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
                resetEditor(editor);
              }
            }
            return true;
          }
        }

        // Main-chain precheck: once composerSend is rebound away (no plain Enter in the effective table),
        // plain Enter no longer sends, so Lexical newlines (the expected post-rebind behavior).
        if (
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          shouldBareEnterFallThroughToNewline(composerEffective)
        ) {
          return false;
        }

        if (
          !submitDisabled &&
          onModifiedSubmit &&
          shouldSubmitLexicalModifiedEnter({
            allowSubmitWhenEmpty,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            modifiedEnterSubmits: true,
            shiftKey: event.shiftKey,
            text,
          })
        ) {
          event.preventDefault();
          const submitResult = onModifiedSubmit(text);
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
          return true;
        }

        // Shift+Enter, and Ctrl/Meta+Enter while reverse delivery is off, keep newline behavior.
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          return false;
        }

        // While a request is in flight the draft stays editable, but must not submit again. Mapping the
        // state to disabled killed typing and the mention panel together; dropping disabled alone let Enter
        // submit and wipe the draft. With submitDisabled, hand Enter back to Lexical as a newline.
        if (submitDisabled || !enterSubmits) {
          return false;
        }

        event.preventDefault();

        if (
          shouldSubmitLexicalEnter({
            allowSubmitWhenEmpty,
            enterSubmits,
            text,
          })
        ) {
          const submitResult = onSubmit(text);
          // The business layer may reject the submit and keep the draft. The key handler must not reset
          // unconditionally, or rejected submits would still swallow typed input.
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          return false;
        }

        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          return false;
        }

        const text = node.getTextContent();
        if (anchor.offset !== 1 || text !== " ") {
          return false;
        }

        const previousSibling = node.getPreviousSibling();
        if (!$isPromptMentionNode(previousSibling)) {
          return false;
        }

        // Mention insert pads a trailing space for continued typing; Backspace used to eat the space
        // first and the token next, reading as press-twice-to-delete. With the caret right after the pad,
        // remove space and token in one stroke.
        event?.preventDefault();
        previousSibling.remove();
        node.remove();
        node.getParent()?.selectEnd();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const handleRootKeyDownCapture = (event: KeyboardEvent) => {
      if (
        disabled ||
        event.key !== "ArrowRight" ||
        !event.altKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
      ) {
        return;
      }

      const rootElement = editor.getRootElement();
      if (!rootElement) {
        return;
      }

      const mentionId = getPromptMentionIdAfterDomSelection(rootElement);
      if (!mentionId) {
        return;
      }

      // macOS Option+ArrowRight word-jumps over DOM text and used to park the caret inside the mention's
      // filename; the next keystroke made Lexical treat the token as replaced text. At the token's left
      // bound, move selection explicitly past it, keeping mention edits atomic.
      event.preventDefault();
      event.stopImmediatePropagation();
      editor.update(
        () => {
          selectAfterPromptMentionById(mentionId);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    // Scope-rebind layer, non-Enter dispatch (one open policy): KEY_ENTER_COMMAND fires for Enter only.
    // Send/newline rebound to a non-Enter key (F9, say) dispatches from the root keydown capture, else the
    // rebind is dead and plain-Enter-falls-back-to-newline would lose keyboard send entirely. A non-Enter
    // physical key has no mobile soft-keyboard misfire, so send skips the enterSubmits viewport gate; no
    // overlap with reverse delivery (Ctrl/Meta+Enter only), no deferral needed.
    const handleNonEnterScopedKeydown = (event: KeyboardEvent) => {
      if (disabled || event.repeat || event.isComposing || event.key === "Enter") {
        return;
      }
      const scopedAction = resolveComposerKeyAction(event, composerEffectiveRef.current);
      if (!scopedAction) {
        return;
      }
      if (scopedAction === "newline") {
        event.preventDefault();
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertLineBreak();
          }
        });
        return;
      }
      if (submitDisabled) {
        return;
      }
      event.preventDefault();
      const text = getEditorMarkdown(editor.getEditorState());
      if (shouldSubmitLexicalEnter({ allowSubmitWhenEmpty, enterSubmits: true, text })) {
        const submitResult = onSubmit(text);
        if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
          resetEditor(editor);
        }
      }
    };

    const unregisterRootListener = editor.registerRootListener(
      (rootElement, previousRootElement) => {
        previousRootElement?.removeEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        previousRootElement?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
      },
    );

    return () => {
      unregisterEnter();
      unregisterBackspace();
      unregisterRootListener();
      editor.getRootElement()?.removeEventListener("keydown", handleRootKeyDownCapture, {
        capture: true,
      });
      editor.getRootElement()?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
        capture: true,
      });
    };
  }, [
    allowSubmitWhenEmpty,
    disabled,
    editor,
    enterSubmits,
    onModifiedSubmit,
    onSubmit,
    submitDisabled,
  ]);

  return null;
}

/**
 * Text-change plugin.
 *
 * Lexical's own OnChangePlugin skips the first character typed into an empty editor via its internal
 * \`prevEditorState.isEmpty()\`, so the parent's input state misses it and the send button desyncs. Listen
 * to update directly and sync only when the serialized markdown really changes; first characters land too.
 */
function TextContentPlugin({
  onChange,
  taskId,
}: {
  onChange?: (text: string) => void;
  taskId?: string | null;
}) {
  const [editor] = useLexicalComposerContext();
  // IME composing flag: do not trust editor.isComposing() inside the update listener; whether it already
  // reflects the composition is timing-dependent, and a false there misreads long CJK compositions as input
  // lag. Maintain it from compositionstart/compositionend instead, robust and explicit.
  const composingRef = useRef(false);

  useEffect(() => {
    const handleCompositionStart = () => {
      composingRef.current = true;
    };
    const handleCompositionEnd = () => {
      // compositionend fires as the composition closes, but the committing update listener usually runs
      // in the same synchronous task; clearing the flag at once would misread that heavy pass as input lag.
      // queueMicrotask the clear until after the current task, so the commit pass still short-circuits as
      // composing and timing resumes normally after.
      queueMicrotask(() => {
        composingRef.current = false;
      });
    };

    // The root remounts; registerRootListener rebinding across old and new roots is the correct hook.
    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("compositionstart", handleCompositionStart);
      previousRootElement?.removeEventListener("compositionend", handleCompositionEnd);
      rootElement?.addEventListener("compositionstart", handleCompositionStart);
      rootElement?.addEventListener("compositionend", handleCompositionEnd);
    });
  }, [editor]);

  useEffect(() => {
    if (!onChange) {
      return;
    }

    return editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState, prevEditorState, tags }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
          return;
        }

        // Input-lag timing: wraps the hot path, full serialization plus the synchronous onChange re-render.
        const startedAt = performance.now();

        const nextText = getEditorMarkdown(editorState);
        const previousText = getEditorMarkdown(prevEditorState);
        if (nextText === previousText) {
          return;
        }

        onChange(nextText);

        const lagMs = performance.now() - startedAt;
        // Programmatic edits and IME compositions are not input lag; recordInputLag short-circuits both.
        recordInputLag({
          lagMs,
          textLength: nextText.length,
          isProgrammatic: tags.has(PROGRAMMATIC_UPDATE_TAG),
          isComposing: composingRef.current,
          taskId: taskId ?? undefined,
        });
      },
    );
  }, [editor, onChange, taskId]);

  return null;
}

/** Editor editable-state plugin */
function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  return null;
}

function E2ELexicalInputBridgePlugin({ inputTestId }: { inputTestId?: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!inputTestId || typeof document === "undefined") {
      return;
    }

    const bridge = {
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
    };

    let attachedInput: HTMLElement | null = null;
    const detachBridge = (input: HTMLElement | null) => {
      if (
        input &&
        (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E === bridge
      ) {
        delete (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E;
      }
      input?.removeAttribute("data-e2e-lexical-bridge");
    };
    const attachBridge = (input: HTMLElement | null) => {
      if (attachedInput && attachedInput !== input) {
        detachBridge(attachedInput);
      }
      attachedInput = input;
      if (!input) {
        return;
      }

      // E2E must drive real Lexical state; poking the contenteditable DOM bypasses editor updates and
      // risks typing into the wrong composer, detaching test conclusions from product behavior.
      Object.defineProperty(input, "__zcodeLexicalInputE2E", {
        configurable: true,
        value: bridge,
      });
      input.setAttribute("data-e2e-lexical-bridge", "ready");
    };

    const resolveInput = (rootElement: HTMLElement | null) => {
      if (rootElement?.getAttribute("data-testid") === inputTestId) {
        return rootElement;
      }
      return document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    };

    let retryTimer: number | null = null;
    const tryAttachBridge = () => {
      const nextInput = resolveInput(editor.getRootElement());
      attachBridge(nextInput);
      if (nextInput && retryTimer !== null) {
        window.clearInterval(retryTimer);
        retryTimer = null;
      }
    };
    const unregisterRoot = editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement !== rootElement) {
        detachBridge(previousRootElement);
      }
      // The E2E bridge queried the DOM once per effect. A root mounting after the plugin, or remounted by
      // Lexical, left the bridge missing forever.
      attachBridge(resolveInput(rootElement));
    });

    tryAttachBridge();
    // In edit flows, initialValue restore, Lexical root registration and React commit order can span
    // frames. The short poll only attaches the test bridge; product behavior never depends on it.
    retryTimer = window.setInterval(tryAttachBridge, 100);

    return () => {
      unregisterRoot();
      if (retryTimer !== null) {
        window.clearInterval(retryTimer);
      }
      detachBridge(attachedInput);
    };
  }, [editor, inputTestId]);

  return null;
}

function PromptHistoryPlugin({
  entries,
  disabled,
}: {
  entries: readonly string[];
  disabled?: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const historyIndexRef = useRef<number | null>(null);
  const applyingHistoryRef = useRef(false);

  useEffect(() => {
    if (historyIndexRef.current !== null && entries[historyIndexRef.current] === undefined) {
      historyIndexRef.current = null;
    }
  }, [entries]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }

      if (applyingHistoryRef.current) {
        applyingHistoryRef.current = false;
        return;
      }

      const currentIndex = historyIndexRef.current;
      if (currentIndex === null) {
        return;
      }

      if (entries[currentIndex] === undefined) {
        historyIndexRef.current = null;
        return;
      }

      if (getEditorMarkdown(editorState) !== entries[currentIndex]) {
        historyIndexRef.current = null;
      }
    });
  }, [editor, entries]);

  const applyHistoryEntry = useCallback(
    (nextIndex: number | null, nextValue: string) => {
      historyIndexRef.current = nextIndex;
      applyingHistoryRef.current = true;
      // Use the dedicated HISTORY_NAVIGATION_UPDATE_TAG, not the generic PROGRAMMATIC_UPDATE_TAG, so
      // SlashCommandPlugin can tell history restore from a live slash query; otherwise restoring an entry
      // containing / reopens the panel and its COMMAND_PRIORITY_CRITICAL eats the following arrow keys.
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          for (const line of nextValue.split("\n\n")) {
            const paragraph = $createParagraphNode();
            if (line) {
              paragraph.append($createTextNode(line));
            }
            root.append(paragraph);
          }
          root.getLastChild()?.selectEnd();
        },
        { tag: HISTORY_NAVIGATION_UPDATE_TAG },
      );
    },
    [editor],
  );

  const handleHistoryNavigation = useCallback(
    (direction: "up" | "down") => (event: KeyboardEvent | null) => {
      if (!event) return false;

      if (
        disabled ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      ) {
        return false;
      }

      const text = getEditorMarkdown(editor.getEditorState());
      const currentIndex = historyIndexRef.current;

      // History navigation takes the arrows only for an empty input or while already browsing history,
      // never stealing the caret movement multi-line typing relies on.
      if (currentIndex === null && text.length > 0) {
        return false;
      }

      const result = navigatePromptHistory(entries, currentIndex, direction);
      if (!result.shouldHandle) {
        return false;
      }

      event.preventDefault();
      applyHistoryEntry(result.nextIndex, result.nextValue);
      return true;
    },
    [applyHistoryEntry, disabled, editor, entries],
  );

  useEffect(() => {
    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      handleHistoryNavigation("up"),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      handleHistoryNavigation("down"),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterUp();
      unregisterDown();
    };
  }, [editor, handleHistoryNavigation]);

  return null;
}

function isCollapsedSelectionAtEditorStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }

  const [startPoint] = selection.getStartEndPoints() ?? [];
  if (!startPoint || startPoint.offset !== 0) {
    return false;
  }

  const root = $getRoot();
  const startNode = startPoint.getNode();
  if (startPoint.type === "text") {
    const firstTextNode = root.getAllTextNodes()[0] ?? null;
    return firstTextNode?.is(startNode) ?? root.getTextContentSize() === 0;
  }

  if (startNode.is(root)) {
    return true;
  }

  const firstDescendant = root.getFirstDescendant();
  return firstDescendant?.is(startNode) ?? root.getTextContentSize() === 0;
}

function LeadingChineseSlashAliasPlugin({ disabled }: { disabled?: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (disabled) {
      return;
    }

    const handleBeforeInput = (event: InputEvent) => {
      let shouldNormalize = false;
      editor.getEditorState().read(() => {
        shouldNormalize = shouldNormalizeLeadingChineseSlashAliasInput({
          data: event.data,
          inputType: event.inputType,
          isAtEditorStart: isCollapsedSelectionAtEditorStart(),
          isComposing: event.isComposing,
        });
      });

      if (!shouldNormalize) {
        return;
      }

      // Under a CJK IME, a leading slash meant to open the command palette can land as the enumeration
      // comma. Intercept a hand-typed comma at the very start only, normalizing it to `/` immediately; the
      // comma never becomes a second slash-match syntax.
      event.preventDefault();
      editor.update(
        () => {
          if (!isCollapsedSelectionAtEditorStart()) {
            return;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertText(STANDARD_SLASH_TRIGGER);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("beforeinput", handleBeforeInput as EventListener);
      rootElement?.addEventListener("beforeinput", handleBeforeInput as EventListener);
    });
  }, [disabled, editor]);

  return null;
}

function PasteCapturePlugin({
  disabled,
  onPaste,
}: {
  disabled?: boolean;
  onPaste?: (event: ChatComposerPasteEvent) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPaste) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) {
        return;
      }

      const wasDefaultPrevented = event.defaultPrevented;
      onPaste(event);
      if (event.defaultPrevented && !wasDefaultPrevented) {
        // Once the long text became an attachment, block Lexical's follow-up paste command, or the body
        // inserts too and the content duplicates.
        event.stopImmediatePropagation();
      }
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("paste", handlePaste, {
        capture: true,
      });
      rootElement?.addEventListener("paste", handlePaste, { capture: true });
    });
  }, [disabled, editor, onPaste]);

  return null;
}

/** Exposes focus / clear / getText to the host */
export function insertEditorMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  selectionState?: EditorState,
) {
  const selection = selectionState?.read(() => $getSelection()?.clone() ?? null);
  editor.update(
    () => {
      // The overlay takes focus and Lexical loses the selection; restore the pre-menu caret so typing does
      // not overwrite the draft. The draft may have been replaced while open; with the old nodes gone,
      // restoring would throw, so skip it.
      if ($isRangeSelection(selection)) {
        if ($getNodeByKey(selection.anchor.key) && $getNodeByKey(selection.focus.key)) {
          $setSelection(selection);
        } else {
          $getRoot().selectEnd();
        }
      }
      let target = $getSelection();
      if (!$isRangeSelection(target)) target = $getRoot().selectEnd();
      const trailing = $createTextNode(" ");
      target.insertNodes([$createPromptMentionNode(mention), trailing]);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function EditorApiPlugin({
  editorApiRef,
}: {
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editorApiRef) {
      return;
    }

    editorApiRef.current = {
      clear: () => resetEditor(editor),
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getMarkdown: () => getEditorMarkdown(editor.getEditorState()),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      appendText: (text: string) => appendEditorPlainText(editor, text),
      appendFileMention: (
        label: string,
        value: string,
        markdown: string,
        data?: MentionItemData,
        trailingText = " ",
      ) => appendEditorFileMention(editor, label, value, markdown, data, trailingText),
      insertMention: (mention, selectionState) =>
        insertEditorMention(editor, mention, selectionState),
      prependMentionIfMissing: (mention) => prependEditorMentionIfMissing(editor, mention),
      setMention: (mention, trailingText) =>
        replaceEditorWithMention(editor, mention, trailingText),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
      setSkillMention: (skillName: string, markdown = `$${skillName}`, trailingText = " ") =>
        replaceEditorWithSkillMention(editor, skillName, markdown, trailingText),
      setSlashCommandMention: (
        commandName: string,
        markdown = `/${commandName}`,
        trailingText = " ",
      ) => replaceEditorWithSlashCommandMention(editor, commandName, markdown, trailingText),
    };

    return () => {
      editorApiRef.current = null;
    };
  }, [editor, editorApiRef]);

  return null;
}

interface LexicalChatInputProps {
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  onChange?: (text: string) => void;
  onFocus?: () => void;
  triggerPanelContainer?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** Affects the skill reference catalog only; drafts may use the prewarmed session runtime. */
  skillCatalogSessionId?: string | null;
  inputTestId?: string;
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
  promptHistory?: readonly string[];
  avoidIosInputFocusZoom?: boolean;
  compactPlaceholder?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  excludedSlashCommandNames?: readonly string[];
  /** App-local slash commands (e.g. /side): selecting runs a UI action, sends nothing. */
  appSlashCommands?: readonly AppSlashCommand[];
  /** Mention (@/#) panel switch. Explicitly off until the v4 data plane is ready; the entry point stays. */
  enableMentionPanel?: boolean;
}

const EDITOR_THEME = {
  paragraph: "m-0",
};

export function LexicalChatInput({
  placeholder,
  disabled = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  onSubmit,
  onModifiedSubmit,
  onChange,
  onFocus,
  triggerPanelContainer,
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  inputTestId,
  editorApiRef,
  promptHistory = [],
  avoidIosInputFocusZoom = false,
  compactPlaceholder = false,
  onWhiteboardMentionSelected,
  onPaste,
  excludedSlashCommandNames,
  appSlashCommands,
  enableMentionPanel = true,
}: LexicalChatInputProps) {
  const inputMountedAtRef = useRef(Date.now());
  const lastReadyLogKeyRef = useRef<string | null>(null);
  const activeTaskProvider = useChatViewActiveTaskProvider(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  useEffect(() => {
    const readyLogKey = [
      workspaceIdentity ?? workspacePath,
      taskId ?? "draft",
      activeTaskProvider,
      triggerPanelContainer ? "trigger-ready" : "trigger-missing",
    ].join("|");
    if (lastReadyLogKeyRef.current === readyLogKey) {
      return;
    }
    lastReadyLogKeyRef.current = readyLogKey;

    let frameId: number | null = null;
    const logReady = () => {
      logger.info("[LexicalChatInput] composer first frame complete", {
        durationMs: Date.now() - inputMountedAtRef.current,
        activeTaskProvider,
        disabled,
        hasPromptHistory: promptHistory.length > 0,
        submitDisabled,
        taskId,
        triggerPanelReady: Boolean(triggerPanelContainer),
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });
    };

    // Editor init, slash/mention plugins and the external portal live in different components; tick once
    // next frame so the mark aligns with the composer shell's first frame and the toolbar portal ready.
    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(logReady);
    } else {
      logReady();
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeTaskProvider,
    disabled,
    promptHistory.length,
    submitDisabled,
    taskId,
    triggerPanelContainer,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleSubmit = useCallback(
    (text: string) => {
      const submitResult = onSubmit(text);
      requestAnimationFrame(() => {
        editorApiRef?.current?.focus();
      });
      return submitResult;
    },
    [editorApiRef, onSubmit],
  );
  // Lexical's ContentEditable props are an exclusive union: aria-placeholder requires placeholder along
  // with it. A bare ternary JSX lost that pairing across branches and misreported the missing placeholder.
  const contentEditableProps: React.ComponentProps<typeof ContentEditable> = placeholder
    ? {
        "aria-placeholder": placeholder,
        placeholder: (
          <div
            className={`pointer-events-none absolute left-0 top-0 ${compactPlaceholder ? "line-clamp-2" : ""} ${resolveMobileInputTextSizeClassName(
              {
                avoidIosInputFocusZoom,
              },
            )} text-foreground-subtlest`}
          >
            {placeholder}
          </div>
        ),
      }
    : {
        placeholder: null,
      };

  const contentEditable = (
    <ContentEditable
      // Bugfix: mention nodes are inline-flex chips at fixed leading; body text inheriting the browser's
      // normal line-height computes baselines across differing line boxes as typing continues after a token.
      // Pin the body leading here, and allow 16px on phone remote so iOS focus zoom stands down.
      className={`min-h-10 max-h-40 overflow-y-auto ${resolveMobileInputTextSizeClassName({
        avoidIosInputFocusZoom,
      })} text-foreground outline-none`}
      data-testid={inputTestId}
      onFocus={onFocus}
      {...contentEditableProps}
    />
  );

  const initialConfig = useMemo(
    () => ({
      namespace: "ChatInput",
      theme: EDITOR_THEME,
      nodes: [PromptMentionNode],
      // A fresh initialConfig per render records composer subtree prop changes every time; the config is
      // static, so one stable reference keeps unrelated updates from bubbling through the composer.
      onError: (error: Error) => {
        logger.error("[LexicalChatInput] editor error:", error);
      },
    }),
    [],
  );

  return (
    <div className="relative flex-1">
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative">
          <PlainTextPlugin contentEditable={contentEditable} ErrorBoundary={LexicalErrorBoundary} />
          <HistoryPlugin />
          <PromptClipboardPlugin />
          <TextContentPlugin onChange={onChange} taskId={taskId} />
          <KeyboardPlugin
            onSubmit={handleSubmit}
            onModifiedSubmit={onModifiedSubmit}
            disabled={disabled}
            submitDisabled={submitDisabled}
            allowSubmitWhenEmpty={allowSubmitWhenEmpty}
            enterSubmits={enterSubmits}
          />
          <PromptHistoryPlugin entries={promptHistory} disabled={disabled} />
          <EditablePlugin editable={!disabled} />
          <E2ELexicalInputBridgePlugin inputTestId={inputTestId} />
          <EditorApiPlugin editorApiRef={editorApiRef} />
          <LeadingChineseSlashAliasPlugin disabled={disabled} />
          <PasteCapturePlugin disabled={disabled} onPaste={onPaste} />
        </div>
        <SlashCommandPlugin
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={skillCatalogSessionId ?? taskId}
          provider={activeTaskProvider}
          container={triggerPanelContainer}
          disabled={disabled}
          excludedCommandNames={excludedSlashCommandNames}
          appCommands={appSlashCommands}
        />
        {enableMentionPanel ? (
          <MentionPlugin
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={skillCatalogSessionId ?? taskId}
            provider={activeTaskProvider}
            container={triggerPanelContainer}
            disabled={disabled}
            onWhiteboardMentionSelected={onWhiteboardMentionSelected}
          />
        ) : null}
      </LexicalComposer>
    </div>
  );
}

/** A minimal error boundary */
function LexicalErrorBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
