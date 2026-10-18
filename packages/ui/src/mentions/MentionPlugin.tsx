/* eslint-disable max-lines */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import { PaletteIcon, WandSparkles } from "lucide-react";
import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useZCodeIntl } from "../i18n/IntlProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
} from "../lib/promptInputTriggers.js";
import { ContextMentionOptionContent } from "@/mentions/components/ContextMentionOptionContent.js";
import { PluginMentionOptionContent } from "@/mentions/components/PluginMentionOptionContent.js";
import {
  MentionPanel,
  type MentionPanelOption,
  type MentionPanelSection,
} from "./components/MentionPanel.js";
import {
  buildVisibleMentionGroups,
  hasMentionQuery,
  MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
  MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  type MentionResultGroup,
} from "./mentionSearch.js";
import {
  getMentionPanelGroupOrder,
  getSessionMentionWorkspaceScope,
  type MentionPanelGroupId,
} from "./mentionPanelRouting.js";
import { $createPromptMentionNode } from "./nodes/PromptMentionNode.js";
import { useFileMentionProvider } from "./providers/fileMentionProvider.js";
import { usePluginsMentionProvider } from "./providers/pluginsMentionProvider.js";
import { useSessionsMentionProvider } from "./providers/sessionsMentionProvider.js";
import { useSkillsMentionProvider } from "./providers/skillsMentionProvider.js";
import { useWhiteboardMentionProvider } from "./providers/whiteboardMentionProvider.js";
import type { MentionItem } from "./mentionTypes.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./activePromptInputToken.js";
import { getCurrentTextNodeSelection } from "./mentionHelpers.js";

interface MentionPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Existing session id; null/undefined = new draft. Decides the Plugins group catalog authority. */
  sessionId?: string | null;
  disabled?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
}

function getWrappedMentionIndex(currentIndex: number, delta: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  // The mention panel up/down navigation used to clamp at the first/last item.
  // It now wraps around, so Up jumps from the first to the last item and Down from the last back to the first.
  return (currentIndex + delta + itemCount) % itemCount;
}

/**
 * On top of wrap-around navigation, skip disabled entries (V1 same-name plugin conflicts).
 * When everything is disabled, stay put; the Enter/Tab commit guard rejects the insertion.
 */
function getNextEnabledMentionIndex(
  currentIndex: number,
  delta: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  let next = getWrappedMentionIndex(currentIndex, delta, items.length);
  for (let step = 0; step < items.length; step++) {
    if (!items[next]?.disabled) {
      return next;
    }
    next = getWrappedMentionIndex(next, delta >= 0 ? 1 : -1, items.length);
  }
  return currentIndex;
}

/**
 * When candidates first appear or async groups update, converge the selection onto a selectable entry.
 * Root cause: once conflict plugins stay visible, one may occupy flatItems[0]; with the default selection still 0,
 * the first Enter/Tab hits a disabled entry and falls back to the editor default instead of continuing keyboard navigation.
 */
function coerceEnabledMentionIndex(
  currentIndex: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  const boundedIndex = Math.min(Math.max(currentIndex, 0), items.length - 1);
  if (!items[boundedIndex]?.disabled) {
    return boundedIndex;
  }
  const firstEnabledIndex = items.findIndex((item) => !item.disabled);
  return firstEnabledIndex >= 0 ? firstEnabledIndex : boundedIndex;
}

/**
 * Whether to freeze @ panel recomputation during IME composition (uncommitted pinyin): intermediate letters would be
 * filtered as the query once, flickering the panel with wrong intermediate results; after commit Lexical dispatches another update and recomputes.
 * Android exception: Chrome + Gboard compose even Latin words (compositionend only at space),
 * so freezing would kill per-letter filtering in the mobile-web @ panel; Android keeps live recomputation.
 */
function shouldFreezeMentionRecalcWhileComposing(isComposing: boolean, userAgent: string): boolean {
  return isComposing && !/Android/i.test(userAgent);
}

export function MentionPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  container,
  disabled = false,
  onWhiteboardMentionSelected,
}: MentionPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl } = useZCodeIntl();
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const activeQuery = activeTrigger?.query ?? "";
  // Candidate filtering scans large workspaces on the render thread; with the editor and search sharing one query,
  // fast typing/deleting makes every keypress pay the search cost synchronously. The deferred value only delays candidate derivation,
  // not editor tokens, triggers or the final insertion, so typing stays instant while results converge to the latest query.
  const deferredActiveQuery = useDeferredValue(activeQuery);
  const hasActiveQuery = hasMentionQuery(activeQuery);
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  const isOpen =
    !disabled &&
    (activeTrigger?.trigger === "@" ||
      activeTrigger?.trigger === "$" ||
      activeTrigger?.trigger === "#");
  const isContextTrigger = activeTrigger?.trigger === "@";
  const isSessionTrigger = activeTrigger?.trigger === "#";
  const isSkillTrigger = activeTrigger?.trigger === "$";

  // Fix note: the @ panel used to have two levels, forcing a second confirmation after the query -
  // it felt like "search starts after Enter". Now a single-level grouped panel shows group results as soon as the query changes.
  const skillsResult = useSkillsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    provider,
    deferredActiveQuery,
    isOpen && isSkillTrigger,
    false,
    intl.formatMessage({ id: "chat.mention.skills.empty" }),
    intl.formatMessage({ id: "chat.mention.skills.title" }),
  );
  const fileDefaultPreviewLimit = !hasActiveQuery
    ? MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT
    : MENTION_DEFAULT_GROUP_PREVIEW_LIMIT;
  const fileResult = useFileMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.files.empty" }),
    intl.formatMessage({ id: "chat.mention.files.title" }),
    fileDefaultPreviewLimit,
  );
  const whiteboardResult = useWhiteboardMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger && Boolean(onWhiteboardMentionSelected),
    intl.formatMessage({ id: "chat.mention.whiteboards.empty" }),
    intl.formatMessage({ id: "chat.mention.whiteboards.title" }),
  );
  const sessionsResult = useSessionsMentionProvider(
    provider,
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && (isContextTrigger || isSessionTrigger),
    getSessionMentionWorkspaceScope(activeTrigger?.trigger),
    intl.formatMessage({ id: "chat.mention.sessions.empty" }),
    intl.formatMessage({ id: "chat.mention.sessions.title" }),
  );
  // Plugins group: a new draft (sessionId=null) reads the workspace
  // current catalog; an existing session reads the session-owned frozen catalog; conflicts are flagged disabled by the provider.
  const pluginsResult = usePluginsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.plugins.empty" }),
    intl.formatMessage({ id: "chat.mention.plugins.title" }),
  );

  const panelGroups = useMemo<MentionResultGroup<MentionItem>[]>(() => {
    const groupsById = {
      files: {
        id: "files",
        title: fileResult.title,
        items: fileResult.items,
        loading: fileResult.loading,
        errorText: fileResult.error?.message ?? null,
        emptyText: fileResult.emptyText,
      },
      plugins: {
        id: "plugins",
        title: pluginsResult.title,
        items: pluginsResult.items,
        loading: pluginsResult.loading,
        errorText: pluginsResult.error?.message ?? null,
        emptyText: pluginsResult.emptyText,
      },
      sessions: {
        id: "sessions",
        title: sessionsResult.title,
        items: sessionsResult.items,
        loading: sessionsResult.loading,
        errorText: sessionsResult.error?.message ?? null,
        emptyText: sessionsResult.emptyText,
      },
      skills: {
        id: "skills",
        title: skillsResult.title,
        items: skillsResult.items,
        loading: skillsResult.loading,
        errorText: skillsResult.error?.message ?? null,
        emptyText: skillsResult.emptyText,
      },
      whiteboards: {
        id: "whiteboards",
        title: whiteboardResult.title,
        items: whiteboardResult.items,
        loading: whiteboardResult.loading,
        errorText: whiteboardResult.error?.message ?? null,
        emptyText: whiteboardResult.emptyText,
      },
    } satisfies Record<MentionPanelGroupId, MentionResultGroup<MentionItem>>;

    // Product constraint: @ is fixed to Plugins -> Files -> Conversations -> Canvas; the legacy # / $ panels keep
    // their single-group providers. Only the discovery order changes; each candidate canonical markdown is unchanged.
    return buildVisibleMentionGroups(
      getMentionPanelGroupOrder(activeTrigger?.trigger).map((groupId) => groupsById[groupId]),
    );
  }, [
    fileResult.emptyText,
    fileResult.error,
    fileResult.items,
    fileResult.loading,
    fileResult.title,
    activeTrigger?.trigger,
    pluginsResult.emptyText,
    pluginsResult.error,
    pluginsResult.items,
    pluginsResult.loading,
    pluginsResult.title,
    sessionsResult.emptyText,
    sessionsResult.error,
    sessionsResult.items,
    sessionsResult.loading,
    sessionsResult.title,
    whiteboardResult.emptyText,
    whiteboardResult.error,
    whiteboardResult.items,
    whiteboardResult.loading,
    whiteboardResult.title,
    skillsResult.emptyText,
    skillsResult.error,
    skillsResult.items,
    skillsResult.loading,
    skillsResult.title,
  ]);

  const flatItems = useMemo(() => panelGroups.flatMap((group) => group.items), [panelGroups]);

  const panelSections = useMemo<MentionPanelSection[]>(
    () =>
      panelGroups.map((group) => ({
        id: group.id,
        title: group.title,
        options: group.items.map<MentionPanelOption>((item) => ({
          id: item.id,
          label: item.displayLabel ?? item.label,
          description: item.description,
          // Conflict plugins and other disabled entries: visible in the panel but not selectable, reason shown inline (V1 fail closed).
          disabled: item.disabled,
          disabledReason: item.disabledReason,
          // The @ panel used to assemble file rows from label/description itself, so icon, file name and path display
          // diverged from the mention token in the editor. Reuse fileDisplay so panel and token share one file presentation.
          content:
            item.category === "files" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "skills" ? (
              <span className="min-w-0 flex flex-1 items-center gap-2">
                {/* Skill candidates need the same primary/secondary info density as command entries:
                    keep icon + name as the primary copy and compress the description into the right-side muted slot instead of a second line. */}
                <WandSparkles className="size-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                  {item.label}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {item.description}
                </span>
              </span>
            ) : item.category === "whiteboards" ? (
              <span className="min-w-0 flex flex-1 items-center gap-2">
                <PaletteIcon className="size-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                  {item.label}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.mention.whiteboards.strokeCount" },
                    { count: item.description },
                  )}
                </span>
              </span>
            ) : item.category === "sessions" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "plugins" ? (
              <PluginMentionOptionContent item={item} />
            ) : undefined,
        })),
        loading: group.loading,
        loadingText: intl.formatMessage({
          id: "chat.mention.category.loading",
        }),
        errorText: group.errorText,
        emptyText: group.emptyText,
      })),
    [intl, panelGroups, workspacePath],
  );

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex((current) => coerceEnabledMentionIndex(current, flatItems));
  }, [flatItems]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (
        shouldFreezeMentionRecalcWhileComposing(
          editor.isComposing(),
          typeof navigator === "undefined" ? "" : navigator.userAgent,
        )
      ) {
        return;
      }
      editorState.read(() => {
        if (disabled) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const nextActiveToken = reconcileActivePromptInputTokenSnapshot(
          activeTokenRef.current,
          selectionState,
          dirtyElements.size === 0 && dirtyLeaves.size === 0,
        );
        if (
          !nextActiveToken ||
          (nextActiveToken.trigger !== "@" &&
            nextActiveToken.trigger !== "$" &&
            nextActiveToken.trigger !== "#")
        ) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextActiveToken;

        const nextSignature = getPromptInputTriggerSignature(nextActiveToken);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveToken.trigger &&
            current.query === nextActiveToken.query
          ) {
            return current;
          }

          return {
            query: nextActiveToken.query,
            trigger: nextActiveToken.trigger,
          };
        });
      });
    });
  }, [disabled, editor]);

  const insertMentionItem = useCallback(
    (item: MentionItem) => {
      if (item.category === "whiteboards" && onWhiteboardMentionSelected) {
        editor.update(() => {
          const selectionState = getCurrentTextNodeSelection();
          if (!selectionState) {
            return;
          }

          const snapshotRange = getActivePromptInputTokenReplacementRange(
            activeTokenRef.current,
            selectionState,
          );
          const activeMentionTrigger = snapshotRange
            ? activeTokenRef.current
            : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
          if (
            !activeMentionTrigger ||
            (activeMentionTrigger.trigger !== "@" && activeMentionTrigger.trigger !== "$")
          ) {
            return;
          }

          const tokenStart =
            snapshotRange?.start ??
            selectionState.cursorOffset - activeMentionTrigger.query.length - 1;
          const tokenEnd =
            snapshotRange?.end ??
            selectionState.cursorOffset +
              getActivePromptInputTokenTailLength(
                activeMentionTrigger,
                selectionState.textAfterCursor,
                [item.label, item.value, item.markdown],
              );
          selectionState.selection.setTextNodeRange(
            selectionState.node,
            tokenStart,
            selectionState.node,
            tokenEnd,
          );
          selectionState.selection.insertText("");
        });

        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        void onWhiteboardMentionSelected(item.value);
        requestAnimationFrame(() => {
          editor.focus();
        });
        return;
      }

      editor.update(() => {
        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeMentionTrigger = snapshotRange
          ? activeTokenRef.current
          : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
        if (
          !activeMentionTrigger ||
          (activeMentionTrigger.trigger !== "@" &&
            activeMentionTrigger.trigger !== "$" &&
            activeMentionTrigger.trigger !== "#")
        ) {
          return;
        }

        const tokenStart =
          snapshotRange?.start ??
          selectionState.cursorOffset - activeMentionTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeMentionTrigger,
              selectionState.textAfterCursor,
              [item.label, item.value, item.markdown],
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([
          $createPromptMentionNode({
            id: item.id,
            category: item.category,
            label: item.label,
            value: item.value,
            markdown: item.markdown,
            description: item.description,
            data: item.data,
          }),
          trailingWhitespace,
        ]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setActiveTrigger(null);
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [editor, onWhiteboardMentionSelected],
  );

  const selectOption = useCallback(
    (index: number) => {
      const nextItem = flatItems[index];
      if (!nextItem) {
        return false;
      }
      // Disabled entries (same-name plugin conflicts) must not be inserted: Enter/Tab and mouse clicks are rejected here uniformly.
      if (nextItem.disabled) {
        return false;
      }

      insertMentionItem(nextItem);
      return true;
    },
    [flatItems, insertMentionItem],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, 1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, -1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    // Debug note: blur auto-close is commented out to observe the panel behavior across focus changes.
    // Only the close-on-blur path is removed; Esc / selection / invalid-trigger close paths remain.
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, flatItems, isOpen, selectOption, selectedIndex]);

  const panelTitle = intl.formatMessage({ id: "chat.mention.title" });
  const panelDescription = hasActiveQuery
    ? ""
    : activeTrigger?.trigger === "#"
      ? intl.formatMessage({ id: "chat.mention.sessions.searchHint" })
      : activeTrigger?.trigger === "$"
        ? intl.formatMessage({ id: "chat.mention.skills.searchHint" })
        : intl.formatMessage({ id: "chat.mention.searchHint" });
  const panelEmptyText = hasActiveQuery
    ? intl.formatMessage({ id: "chat.mention.emptyResults" })
    : "";

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger={activeTrigger?.trigger ?? "@"}
      sections={panelSections}
      emptyText={panelEmptyText}
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectOption}
    />,
    container,
  );
}
