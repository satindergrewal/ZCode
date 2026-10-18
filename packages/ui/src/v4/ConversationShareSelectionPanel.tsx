import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveConversationShareSelectionPanelMotion } from "@/v4/conversationShareModeMotion.js";
import {
  CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY,
  CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY,
} from "@/v4/conversationShareSelectionPanelLayout.js";
import { resolveConversationShareScrollbarIndicatorMetrics } from "@/v4/conversationShareScrollbarMetrics.js";
import type { ConversationTurnNavigatorItem } from "@/v4/conversationTurnNavigatorHelpers.js";

export interface ConversationShareSelectionPanelProps {
  visible: boolean;
  items: readonly ConversationTurnNavigatorItem[];
  selectedRowIds: ReadonlySet<number>;
  onToggle: (rowId: number) => void;
  onInspect: (target: { unitIndex: number; rowId: number }) => void;
}

const PANEL_LAYOUT_STYLE: CSSProperties = {
  // A fixed height leaves dead space for few candidates and covers the composer as the bottom dock grows.
  // The panel sizes to content; max-height/top come dynamically from the shared conversation container.
  height: "auto",
  maxHeight: `var(${CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY}, calc(100% - 3rem))`,
  top: `var(${CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY}, 50%)`,
};

function ConversationShareSelectionPanelImpl({
  visible,
  items,
  selectedRowIds,
  onToggle,
  onInspect,
}: ConversationShareSelectionPanelProps) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = useReducedMotion() === true;
  const motionConfig = resolveConversationShareSelectionPanelMotion(prefersReducedMotion);
  const panelRef = useRef<HTMLElement>(null);
  const scrollShellRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const visualThumbRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    const content = scrollContentRef.current;
    if (!panel || !content) return;

    const syncNaturalHeight = () => {
      // 8px vertical padding; content scrollHeight always reflects the full candidate list,
      // so a max-height-clipped shell never misreads scrollable content as the viewport.
      const naturalHeight = content.scrollHeight + 16;
      if (naturalHeight > 16) panel.style.height = `${naturalHeight}px`;
    };
    syncNaturalHeight();

    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(syncNaturalHeight);
    resizeObserver.observe(content);
    return () => resizeObserver.disconnect();
  }, [items.length, visible]);

  useEffect(() => {
    if (!visible) return;

    const shell = scrollShellRef.current;
    const visualThumb = visualThumbRef.current;
    const viewport = shell?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!shell || !visualThumb || !viewport) return;

    let animationFrame = 0;
    const updateVisualThumb = () => {
      animationFrame = 0;
      const metrics = resolveConversationShareScrollbarIndicatorMetrics({
        trackSize: shell.clientHeight,
        viewportSize: viewport.clientHeight,
        contentSize: viewport.scrollHeight,
        scrollOffset: viewport.scrollTop,
      });

      visualThumb.style.display = metrics.visible ? "block" : "none";
      visualThumb.style.height = `${metrics.size}px`;
      visualThumb.style.transform = `translateY(${metrics.offset}px)`;
    };
    const scheduleVisualThumbUpdate = () => {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(updateVisualThumb);
    };

    viewport.addEventListener("scroll", scheduleVisualThumbUpdate, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleVisualThumbUpdate);
    resizeObserver?.observe(shell);
    resizeObserver?.observe(viewport);
    if (viewport.firstElementChild instanceof HTMLElement) {
      resizeObserver?.observe(viewport.firstElementChild);
    }
    scheduleVisualThumbUpdate();

    return () => {
      viewport.removeEventListener("scroll", scheduleVisualThumbUpdate);
      resizeObserver?.disconnect();
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
    };
  }, [items.length, visible]);

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        // The motion transform already centers via -50%; stacking a Tailwind translate
        // lifts it another half-height, escaping the conversation area under the WorkspaceHeader.
        <motion.aside
          ref={panelRef}
          key="conversation-share-selection-panel"
          aria-label={intl.formatMessage({ id: "conversationShare.partial.panelLabel" })}
          data-testid="conversation-share-selection-panel"
          data-conversation-share-left-navigation="true"
          data-conversation-share-mode-motion="selection-panel"
          className="group/share-selection-panel absolute left-4 z-30 flex h-auto w-[14.375rem] flex-col overflow-hidden rounded-xl bg-popover py-2 text-popover-foreground shadow-md ring-1 ring-inset ring-popover-border max-md:left-2 max-md:w-[min(14.375rem,calc(100vw-1rem))]"
          style={PANEL_LAYOUT_STYLE}
          initial={motionConfig.initial}
          animate={motionConfig.animate}
          exit={motionConfig.exit}
          transition={motionConfig.transition}
        >
          {/* Bugfix: Radix's table wrapper widens with long text; lock it to the viewport or padding/truncation/hover break. */}
          {/* Cause: auto mount/unmount on scroll prevents hover-controlled visibility; keep it mounted and toggle opacity only. */}
          <div ref={scrollShellRef} className="relative min-h-0 flex-1">
            <ScrollArea
              type="always"
              data-testid="conversation-share-selection-scroll-area"
              className="size-full min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full"
              // scale-y-50 shrinks only the drawn thumb; travel still uses the full length,
              // so the visible thumb stops mid-track at the end. Keep the raw thumb for hit-testing only;
              // the visual thumb maps full scroll progress across the whole track.
              scrollbarClassName="opacity-0 transition-opacity group-hover/share-selection-panel:opacity-100 group-focus-within/share-selection-panel:opacity-100 data-vertical:!w-2.5 data-vertical:!pr-1 data-vertical:!pl-0 [&_[data-slot=scroll-area-thumb]]:!min-w-1.5 [&_[data-slot=scroll-area-thumb]]:!bg-transparent [@media(hover:none)]:opacity-100"
            >
              <div ref={scrollContentRef} className="flex min-w-0 flex-col gap-2 px-2">
                {items.length > 0 ? (
                  items.map((item, index) => {
                    const selected = selectedRowIds.has(item.rowId);
                    return (
                      <div
                        key={item.key}
                        data-conversation-share-selection-item="true"
                        data-conversation-share-selection-state={
                          selected ? "selected" : "unselected"
                        }
                        className={cn(
                          "group flex items-center rounded-lg p-1 transition-colors hover:bg-menu-hover",
                          // The design gives the first item 12/4px spacing and the rest 8/6px; keep that optical difference.
                          index === 0 ? "gap-3" : "gap-2",
                        )}
                      >
                        <div className="relative flex size-6 shrink-0 items-center justify-center">
                          {/* Bugfix: only the 14px checkbox took clicks; a 32px out-of-flow label grows the target with no layout/visual change. */}
                          <label
                            data-conversation-share-checkbox-hit-area="true"
                            className="absolute flex size-8 cursor-pointer items-center justify-center"
                          >
                            <Checkbox
                              checked={selected}
                              disabled={item.isRunning}
                              aria-label={item.userPreview}
                              onCheckedChange={() => {
                                if (!item.isRunning) onToggle(item.rowId);
                              }}
                              // The shared Checkbox inherits the global icon stroke; the local-share design pins the check path at 1.33.
                              checkIconStrokeWidth={1.33}
                              className="size-3.5 border-foreground bg-transparent data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background"
                            />
                          </label>
                        </div>
                        <button
                          type="button"
                          disabled={item.isRunning}
                          aria-label={item.userPreview}
                          onClick={() =>
                            onInspect({ unitIndex: item.unitIndex, rowId: item.rowId })
                          }
                          className={cn(
                            "flex min-w-0 flex-1 flex-col rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                            index === 0 ? "gap-1" : "gap-1.5",
                          )}
                        >
                          <span
                            className={cn(
                              "block truncate text-ui-base font-medium leading-5 transition-colors",
                              selected ? "text-foreground" : "text-foreground-subtlest",
                            )}
                          >
                            {item.userPreview}
                          </span>
                          <span
                            className={cn(
                              "block truncate text-ui-sm leading-4 transition-colors",
                              selected ? "text-foreground-subtle" : "text-foreground-subtlest",
                            )}
                          >
                            {item.assistantPreview}
                          </span>
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <p className="px-2 py-4 text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "conversationShare.partial.empty" })}
                  </p>
                )}
              </div>
            </ScrollArea>
            <div
              ref={visualThumbRef}
              aria-hidden="true"
              data-testid="conversation-share-selection-scroll-thumb"
              className="pointer-events-none absolute right-1 top-0 z-10 hidden w-1.5 rounded-full bg-border opacity-0 transition-opacity group-hover/share-selection-panel:opacity-100 group-focus-within/share-selection-panel:opacity-100 [@media(hover:none)]:opacity-100"
            />
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export const ConversationShareSelectionPanel = memo(ConversationShareSelectionPanelImpl);
