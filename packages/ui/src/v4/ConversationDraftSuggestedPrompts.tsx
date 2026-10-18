import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog.js";
/* Recommended-prompt entry for the new-task draft page.
   Recommendation configs come from the Client Scenes draft-suggestion scene. */
import type { CSSProperties } from "react";
import { X, Check, Info, LoaderCircle, SquareCode, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveDraftSuggestedPromptText,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";
import type { DraftSuggestedPluginActionPopoverState } from "@/v4/useDraftSuggestedPluginActionPopover.js";

export type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

const PLUGIN_SUCCESS_ROLL_TRANSITION = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
} as const;

function DraftSuggestedPromptIcon({ name }: { name?: string }) {
  return (
    <ClientSceneLucideIcon
      name={name}
      aria-hidden="true"
      className="size-4"
      strokeWidth={2}
      fallback={<SquareCode aria-hidden="true" className="size-4" strokeWidth={2} />}
    />
  );
}

interface ConversationDraftSuggestedPromptsProps {
  className?: string;
  layout?: "chips" | "list";
  /** Recommendation items, mapped from Client Scenes upstream. */
  items?: DraftSuggestedPromptItem[];
  /** Click callback; the full config goes upstream for prompt/plugin-catalog resolution. */
  onSelect?: (item: DraftSuggestedPromptItem) => void;
  disabled?: boolean;
  onRefresh?: () => void;
  onClose?: () => void;
  refreshDisabled?: boolean;
  pluginActionPopover?: DraftSuggestedPluginActionPopoverState | null;
}

function DraftSuggestedPluginActionPopoverContent({
  state,
}: {
  state: DraftSuggestedPluginActionPopoverState;
}) {
  const isConfirmation = state.phase === "confirmation";
  const reducedMotion = useReducedMotion();
  const statusIcon =
    state.phase === "progress" ? (
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin text-foreground-subtle motion-reduce:animate-none"
      />
    ) : state.phase === "success" ? (
      <Check
        aria-hidden="true"
        data-draft-suggested-plugin-success-icon="true"
        className="size-4 shrink-0 text-foreground"
      />
    ) : state.phase === "error" ? (
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
    ) : (
      <Info aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
    );
  const statusContent = (
    <>
      {statusIcon}
      <div
        data-draft-suggested-plugin-popover-message="true"
        className="min-w-0 flex-1 text-ui-base leading-4.5 text-foreground"
      >
        {state.message}
      </div>
    </>
  );

  return (
    <PopoverContent
      side="bottom"
      align="center"
      sideOffset={6}
      collisionPadding={16}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => event.preventDefault()}
      onFocusOutside={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => {
        const isPrimaryPointer = event.detail.originalEvent.button === 0;
        if (!isConfirmation || !state.onDismiss || !isPrimaryPointer) {
          event.preventDefault();
          return;
        }
        state.onDismiss();
      }}
      data-draft-suggested-plugin-popover={state.phase}
      data-draft-suggested-plugin-popover-offset="9"
      data-anchor-item-id={state.anchorItemId}
      className={cn(
        // The fixed 80px confirm state fits one title line; longer localized plugin names wrap and push the button out, clipping it.
        "h-auto w-60 max-w-[calc(100vw-2rem)] border-popover-border bg-popover p-3 shadow-md",
        isConfirmation ? "gap-3" : "gap-0",
      )}
    >
      {/* Plugin name, status, and button never share one row, nor expand above the anchor: the design's confirm/result structures. */}
      <div
        role={state.phase === "error" ? "alert" : "status"}
        aria-live={state.phase === "error" ? "assertive" : "polite"}
        data-draft-suggested-plugin-status-viewport="true"
        className="relative min-w-0 overflow-hidden"
      >
        {reducedMotion ? (
          <div
            data-draft-suggested-plugin-success-content={
              state.phase === "success" ? "true" : undefined
            }
            className="flex min-w-0 items-center gap-1.5"
          >
            {statusContent}
          </div>
        ) : (
          // The old CSS rotateX flipped only the success content in; it could not express
          // progress-replaced-by-success the way the model label does. The steady key spans
          // confirm/progress/failure/retry and triggers one out-and-in vertical roll on entering
          // success only.
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={state.phase === "success" ? "success" : "steady"}
              data-draft-suggested-plugin-success-content={
                state.phase === "success" ? "true" : undefined
              }
              className="flex min-w-0 items-center gap-1.5"
              initial={{ y: "0.75em", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-0.75em", opacity: 0 }}
              transition={PLUGIN_SUCCESS_ROLL_TRANSITION}
            >
              {statusContent}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      {isConfirmation && state.actionLabel && state.onAction ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="self-end"
          onClick={state.onAction}
        >
          {state.actionLabel}
        </Button>
      ) : null}
    </PopoverContent>
  );
}

export function ConversationDraftSuggestedPrompts({
  className,
  layout = "chips",
  items = [],
  onSelect,
  disabled = false,
  onRefresh,
  onClose,
  refreshDisabled = false,
  pluginActionPopover,
}: ConversationDraftSuggestedPromptsProps) {
  const { locale, intl } = useZCodeIntl();
  const [confirmClose, setConfirmClose] = useState(false);

  if (items.length === 0) return null;

  if (layout === "list") {
    return (
      <div
        data-v4-draft-suggested-prompts="true"
        className={cn("w-full min-w-0 px-2 py-4", className)}
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-2 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "occupationOnboarding.suggestionsHeading" })}</span>
          <div className="flex shrink-0 items-center gap-2">
            {onRefresh ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0 text-ui-sm text-foreground-subtle"
                disabled={disabled || refreshDisabled}
                onClick={onRefresh}
              >
                {intl.formatMessage({ id: "chat.officeSuggestions.refresh" })}
              </Button>
            ) : null}
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled || refreshDisabled}
                aria-label={intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
                onClick={() => setConfirmClose(true)}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeDescription" })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>
                {intl.formatMessage({ id: "common.confirm" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((item) => (
            <Popover
              key={item.id}
              open={pluginActionPopover?.anchorItemId === item.id}
              modal={false}
            >
              <li>
                <PopoverAnchor asChild>
                  <button
                    type="button"
                    data-draft-suggested-prompt={item.id}
                    disabled={!onSelect || disabled}
                    onClick={() => onSelect?.(item)}
                    className="flex w-full items-center gap-3 rounded-xl p-3 text-left text-ui-base text-foreground hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:opacity-50"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface p-px">
                      <img
                        src={item.iconUrl}
                        alt=""
                        draggable={false}
                        className={cn(
                          "shrink-0 rounded-sm object-contain",
                          // The GitHub asset ships with a white square plate; shrink one step further so the outer padding matches the other icons.
                          item.iconUrl?.includes("/github/icon.png") ? "size-4.5" : "size-full",
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      {resolveDraftSuggestedPromptText(item.label, locale)}
                    </span>
                  </button>
                </PopoverAnchor>
                {pluginActionPopover?.anchorItemId === item.id ? (
                  <DraftSuggestedPluginActionPopoverContent state={pluginActionPopover} />
                ) : null}
              </li>
            </Popover>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      data-v4-draft-suggested-prompts="true"
      className={cn(
        "w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <div
        data-v4-draft-suggested-prompts-group="true"
        className="mx-auto flex w-max items-center gap-4"
      >
        {items.map((item, index) => {
          const label = resolveDraftSuggestedPromptText(item.label, locale);
          const isPopoverAnchor = pluginActionPopover?.anchorItemId === item.id;
          return (
            <Popover key={item.id} open={isPopoverAnchor} modal={false}>
              {/* Wrapping Root/Anchor only while the Popover is open remounts the button and
                  replays the waterfall, so Radix keeps measuring a translated anchor. Every
                  recommendation keeps one structure from first render. */}
              <PopoverAnchor
                asChild
                data-slot="button"
                data-draft-suggested-plugin-popover-anchor={isPopoverAnchor ? "true" : undefined}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  data-draft-suggested-prompt={item.id}
                  aria-label={label}
                  title={label}
                  disabled={!onSelect || disabled}
                  onClick={onSelect ? () => onSelect(item) : undefined}
                  className="zcode-draft-prompt-waterfall h-8 min-w-0 justify-start gap-1.5 overflow-hidden rounded-lg px-3 text-left text-ui-caption font-normal leading-4.5 text-foreground"
                  style={
                    {
                      "--zcode-draft-prompt-waterfall-delay": `${index * 65}ms`,
                    } as CSSProperties
                  }
                >
                  <span
                    data-draft-suggested-prompt-icon="true"
                    className="flex size-4 shrink-0 items-center justify-center text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
                  >
                    <DraftSuggestedPromptIcon name={item.iconName} />
                  </span>
                  <span
                    data-draft-suggested-prompt-text="true"
                    className="min-w-0 max-w-64 truncate text-ui-base text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
                  >
                    {label}
                  </span>
                </Button>
              </PopoverAnchor>
              {isPopoverAnchor ? (
                <DraftSuggestedPluginActionPopoverContent state={pluginActionPopover} />
              ) : null}
            </Popover>
          );
        })}
      </div>
    </div>
  );
}
