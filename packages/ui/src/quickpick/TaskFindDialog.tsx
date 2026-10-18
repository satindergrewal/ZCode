import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileDiffIcon,
  MessageCircleIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  getConversationFindState,
  resolveConversationFindNavigationSelection,
  resolveConversationFindNavigationDirection,
} from "@/quickpick/conversationFindSearch.js";

type TaskFindScope = "conversation" | "changes";

export type TaskFindDialogProps = {
  open: boolean;
  focusRequestId: number;
  placement?: "window" | "chat";
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  conversationMatchCount: number;
  conversationMatchIndex: number;
  fileChangeMatchCount: number;
  fileChangeMatchIndex: number;
  onOpenChange: (open: boolean) => void;
  onConversationFindChange: (query: string, activeIndex: number) => void;
  onConversationFindNavigate: (query: string, activeIndex: number) => void;
  onFileChangeFindChange: (query: string, activeIndex: number) => void;
  onFileChangeFindNavigate: (query: string, activeIndex: number) => void;
  onOpenFileChanges: () => void;
};

export function TaskFindDialog({
  open,
  focusRequestId,
  placement = "window",
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  conversationMatchCount,
  conversationMatchIndex,
  fileChangeMatchCount,
  fileChangeMatchIndex,
  onOpenChange,
  onConversationFindChange,
  onConversationFindNavigate,
  onFileChangeFindChange,
  onFileChangeFindNavigate,
  onOpenFileChanges,
}: TaskFindDialogProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const titleId = useId();
  const descriptionId = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TaskFindScope>("conversation");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const conversationState = useMemo(
    () =>
      getConversationFindState(query.trim() ? conversationMatchCount : 0, conversationMatchIndex),
    [conversationMatchCount, conversationMatchIndex, query],
  );
  const fileChangeState = useMemo(
    () => getConversationFindState(query.trim() ? fileChangeMatchCount : 0, fileChangeMatchIndex),
    [fileChangeMatchCount, fileChangeMatchIndex, query],
  );
  const activeFindState = scope === "conversation" ? conversationState : fileChangeState;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setScope("conversation");
      onConversationFindChange("", -1);
      onFileChangeFindChange("", -1);
      return;
    }

    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [onConversationFindChange, onFileChangeFindChange, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // With the find bar already open, Cmd/Ctrl+F does not change `open`, so the usual focus effect
    // will not rerun. Listen for explicit focus requests so repeat shortcuts always bring focus
    // back to the search input.
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [focusRequestId, open]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    onOpenFileChanges();
  }, [onOpenFileChanges, open, scope]);

  useEffect(() => {
    if (!open || placement !== "chat") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      // After sinking into the chat area, this is no longer a Radix Dialog owning Esc. The window
      // bubble listener handles only Esc not consumed by an active layer, never stealing close
      // semantics from nested menus/popovers.
      event.preventDefault();
      onOpenChange(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open, placement]);

  useEffect(() => {
    if (!open || scope !== "conversation") {
      return;
    }

    onFileChangeFindChange("", -1);
    onConversationFindChange(query, conversationState.currentIndex);
  }, [
    conversationState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    // After switching to the file-changes scope, stale conversation highlights must not linger in
    // the chat. The two scopes use separate highlight roots; clear the other side explicitly so
    // both never appear active at once.
    onConversationFindChange("", -1);
    onFileChangeFindChange(query, fileChangeState.currentIndex);
  }, [
    fileChangeState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  const moveSelection = useCallback(
    (direction: "previous" | "next") => {
      if (activeFindState.total === 0) {
        // The button is disabled at zero matches, but the keyboard still reaches this handler.
        // Reject empty navigation uniformly so request ids do not increment and button/keyboard
        // semantics never diverge.
        return;
      }

      const selection = resolveConversationFindNavigationSelection(
        query,
        activeFindState,
        direction,
      );
      if (scope === "conversation") {
        onConversationFindNavigate(selection.query, selection.activeIndex);
        return;
      }

      onFileChangeFindNavigate(selection.query, selection.activeIndex);
    },
    [activeFindState, onConversationFindNavigate, onFileChangeFindNavigate, query, scope],
  );

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      const nextIndex = nextQuery.trim() ? 0 : -1;
      if (scope === "conversation") {
        // A new query must scroll from the first match. Reusing the old activeIndex can jump
        // straight to result N, unlike system find behavior.
        onConversationFindChange(nextQuery, nextIndex);
        return;
      }

      onFileChangeFindChange(nextQuery, nextIndex);
    },
    [onConversationFindChange, onFileChangeFindChange, scope],
  );

  const handleScopeChange = useCallback(
    (nextScope: TaskFindScope) => {
      setScope(nextScope);
      if (nextScope === "changes") {
        onOpenFileChanges();
        onConversationFindChange("", -1);
        onFileChangeFindChange(query, query.trim() ? 0 : -1);
        return;
      }

      onFileChangeFindChange("", -1);
      onConversationFindChange(query, query.trim() ? 0 : -1);
    },
    [onConversationFindChange, onFileChangeFindChange, onOpenFileChanges, query],
  );

  const handleToggleScope = useCallback(() => {
    handleScopeChange(scope === "conversation" ? "changes" : "conversation");
  }, [handleScopeChange, scope]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const direction = resolveConversationFindNavigationDirection(event.key, event.shiftKey);
      if (direction) {
        event.preventDefault();
        moveSelection(direction);
      }
    },
    [moveSelection],
  );

  const placeholderId = `quickPick.find.placeholder.${scope}`;
  const ScopeIcon = scope === "conversation" ? MessageCircleIcon : FileDiffIcon;
  const nextScopeLabelId =
    scope === "conversation" ? "quickPick.find.scope.changes" : "quickPick.find.scope.conversation";
  const previousLabel = intl.formatMessage({ id: "quickPick.find.previous" });
  const nextLabel = intl.formatMessage({ id: "quickPick.find.next" });
  const nextScopeLabel = intl.formatMessage({ id: nextScopeLabelId });
  const scopeTooltipLabel = intl.formatMessage({
    id: "quickPick.find.scope.tooltip",
  });
  const closeLabel = intl.formatMessage({ id: "common.close" });
  const renderFindIconButton = ({
    label,
    tooltipLabel = label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    tooltipLabel?: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <ControlHintTooltip title={tooltipLabel} side="bottom">
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </span>
    </ControlHintTooltip>
  );
  const findContent = (
    <div className="flex h-9 items-center gap-1.5 py-0 pr-2 pl-2">
      <SearchIcon className="size-3.5 shrink-0 text-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={intl.formatMessage({ id: placeholderId })}
        className="min-w-0 flex-1 bg-transparent text-ui-base font-medium text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <div className="w-8 shrink-0 text-center text-ui-xs font-medium text-foreground-subtle tabular-nums">
        {activeFindState.total > 0
          ? `${activeFindState.currentIndex + 1}/${activeFindState.total}`
          : "0/0"}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: previousLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("previous"),
          children: <ArrowUpIcon className="size-3.5" />,
        })}
        {renderFindIconButton({
          label: nextLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("next"),
          children: <ArrowDownIcon className="size-3.5" />,
        })}
        {(!isOfficeMode || scope === "changes") &&
          renderFindIconButton({
            label: nextScopeLabel,
            tooltipLabel: scopeTooltipLabel,
            onClick: handleToggleScope,
            children: <ScopeIcon className="size-3.5" />,
          })}
      </div>
      <div className="ml-0.5 flex shrink-0 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: closeLabel,
          onClick: () => onOpenChange(false),
          children: <XIcon className="size-3.5" />,
        })}
      </div>
    </div>
  );
  const contentPositionClassName = cn(
    // The old find bar was too large, blocking content in small windows and dense use. Tighten
    // width/padding to reduce intrusion while staying legible.
    "left-auto !w-[min(360px,calc(100vw-0.75rem))] !max-w-[calc(100vw-0.75rem)] translate-x-0 translate-y-0",
    // Linux draws its own window controls/titlebar; a find layer pinned at top-3 covers the
    // titlebar hit area, blocking window switch/drag while open. Reserve a 48px titlebar plus a
    // 120px right-hand button safe area on Linux; other platforms keep their own offsets.
    isWindowsDesktop
      ? "top-12 right-36"
      : isMacDesktop
        ? "top-14 right-3"
        : isLinuxDesktop
          ? "top-12 right-[120px]"
          : "top-3 right-3",
  );

  if (placement === "chat") {
    if (!open) {
      return null;
    }

    return (
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="absolute top-3 left-1/2 z-30 w-[min(360px,calc(100%-1rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-popover-border bg-popover p-0 text-ui-base/relaxed text-foreground shadow-md outline-none [app-region:no-drag] max-md:top-2"
      >
        <div className="sr-only">
          <h2 id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</h2>
          <p id={descriptionId}>{intl.formatMessage({ id: "quickPick.find.description" })}</p>
        </div>
        {findContent}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogHeader className="sr-only">
        <DialogTitle id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</DialogTitle>
        <DialogDescription id={descriptionId}>
          {intl.formatMessage({ id: "quickPick.find.description" })}
        </DialogDescription>
      </DialogHeader>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        onInteractOutside={(event) => {
          // Without a modal overlay users click the chat to see match context. Radix Dialog treats
          // outside clicks as close and would lose find state; keep the layer, exit via Esc/button.
          event.preventDefault();
        }}
        className={cn(
          // The Cmd/Ctrl+F layer must not pin top-right: on desktop it overlaps header controls.
          // Reserve per-platform safe areas: drop below the header everywhere, and shift right on
          // Windows to clear the native window buttons.
          contentPositionClassName,
          "overflow-hidden border-popover-border bg-popover p-0 shadow-md",
        )}
      >
        {findContent}
      </DialogContent>
    </Dialog>
  );
}
