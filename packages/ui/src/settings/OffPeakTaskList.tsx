/* Off-peak task list (Figma Automations - Task list Idle-time task, node 4866-1735):
   a two-column card grid whose card mirrors the scheduled-task card (MR 1622 design): title + instruction summary +
   footer (moon + #N-in-queue position badge). Newest first; the hover menu collapses by state (D29/D30).
   No Est. on positions (D30-1). */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import {
  TID_OFFPEAK_ACTION_CONTINUE,
  TID_OFFPEAK_ACTION_DELETE,
  TID_OFFPEAK_ACTION_PAUSE,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_SESSION,
  TID_OFFPEAK_CARD_MENU,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  AutomationCancelActionIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  resolveFailedOffPeakQueueFooter,
  resolveOffPeakStatusFooter,
  shouldShowOffPeakModelSelectionIssue,
  type OffPeakStatusIconKind,
} from "@/settings/offPeakUiPresentation.js";

interface OffPeakTaskListProps {
  tasks: readonly ZCodeOffPeakTask[];
  busyOperationId: string | null;
  onOpen: (task: ZCodeOffPeakTask) => void;
  onPause: (task: ZCodeOffPeakTask) => void;
  onContinue: (task: ZCodeOffPeakTask) => void;
  onCancel: (task: ZCodeOffPeakTask) => void;
  onDelete: (task: ZCodeOffPeakTask) => void;
  onOpenSession: (task: ZCodeOffPeakTask) => void;
}

// Grouping by state makes tasks jump between running and terminal, breaking spatial memory;
// the list stays newest-by-creation only, so state changes never reorder it.
export function sortOffPeakTasksByCreatedAt(
  tasks: readonly ZCodeOffPeakTask[],
): ZCodeOffPeakTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

/** Same scroll threshold as the scheduled list (Figma spec: at most 8 cards visible). */
export const OFFPEAK_LIST_SCROLL_THRESHOLD = 8;

const OFFPEAK_MENU_HINT_MAX_WIDTH = 320;
const OFFPEAK_MENU_HINT_RIGHT_OFFSET = 16;

type OffPeakMenuHintSide = "right" | "top";

export function resolveOffPeakMenuHintSide(
  triggerRect: Pick<DOMRect, "right"> | null,
  viewportWidth: number,
): OffPeakMenuHintSide {
  if (!triggerRect) {
    return "top";
  }
  return viewportWidth - triggerRect.right >=
    OFFPEAK_MENU_HINT_MAX_WIDTH + OFFPEAK_MENU_HINT_RIGHT_OFFSET
    ? "right"
    : "top";
}

function OffPeakMenuHint({ children, title }: { children: ReactNode; title: string }) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<OffPeakMenuHintSide>("right");

  const updateSide = useCallback(() => {
    // The hint trigger lives inside the menu. On narrow windows Radix flips right to left,
    // and a left-side hint crosses the whole menu; without horizontal room, open above the menu instead.
    setSide(
      resolveOffPeakMenuHintSide(
        triggerRef.current?.getBoundingClientRect() ?? null,
        window.innerWidth,
      ),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    updateSide();
    window.addEventListener("resize", updateSide);
    return () => window.removeEventListener("resize", updateSide);
  }, [open, updateSide]);

  return (
    <ControlHintTooltip
      title={title}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          updateSide();
        }
        setOpen(nextOpen);
      }}
      triggerRef={triggerRef}
      side={side}
      align={side === "top" ? "end" : "center"}
      sideOffset={OFFPEAK_MENU_HINT_RIGHT_OFFSET}
      className="max-w-[min(20rem,calc(100vw-1rem))]"
    >
      {children}
    </ControlHintTooltip>
  );
}

const STATUS_ICON: Record<OffPeakStatusIconKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  moon: AutomationIdleTimeIcon,
  // The design's Paused is a round stop icon; the old double bars read as a media-pause control.
  pause: AutomationPausedIcon,
  spinner: Loader2,
  success: CircleCheck,
  warning: TriangleAlert,
  stopped: AutomationPausedIcon,
};

export function OffPeakTaskList({
  tasks,
  busyOperationId,
  onOpen,
  onPause,
  onContinue,
  onCancel,
  onDelete,
  onOpenSession,
}: OffPeakTaskListProps) {
  const { intl } = useZCodeIntl();
  const sorted = sortOffPeakTasksByCreatedAt(tasks);

  if (sorted.length === 0) {
    return (
      <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "offPeak.list.empty" })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid auto-rows-[132px] grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2",
        // Same rule as the scheduled list: at most 8 visible cards, the grid scrolls beyond, so the page never stretches forever.
        sorted.length > OFFPEAK_LIST_SCROLL_THRESHOLD &&
          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
      )}
    >
      {sorted.map((task) => {
        const footer =
          task.modelSelectionIssue && shouldShowOffPeakModelSelectionIssue(task.status)
            ? {
                icon: "warning" as const,
                className: "text-warning",
                labelId: "offPeak.modelSelection.repairRequired",
              }
            : resolveOffPeakStatusFooter(task);
        const FooterIcon = STATUS_ICON[footer.icon];
        const failedQueueFooter = resolveFailedOffPeakQueueFooter(task);
        const FailedQueueIcon = failedQueueFooter ? STATUS_ICON[failedQueueFooter.icon] : null;
        const busy = busyOperationId?.endsWith(task.offPeakTaskId) ?? false;
        const hasPrimaryMenuAction =
          task.status === "queued" || task.status === "paused" || task.status === "running";
        return (
          <div
            key={task.offPeakTaskId}
            data-testid={TID_OFFPEAK_CARD}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(task)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(task);
              }
            }}
            className={cn(
              // The inset surface shadow is not Card-border semantics; it hues differently from the home cards across themes.
              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-[10px] border border-card-border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              // Terminal states stay grayed yet keep the hover background: the card is clickable and its menu usable.
              task.status === "completed" ? "opacity-60 hover:bg-hover" : "hover:bg-hover",
            )}
          >
            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
              <span className="block truncate pr-14 text-ui-base font-medium leading-5 text-foreground">
                {task.title || task.prompt}
              </span>
              {/* Fix rationale: body and status font sizes scale; a fixed 18px line height crushes or clips larger text. */}
              <p className="line-clamp-2 h-9 text-ui-base font-normal leading-snug text-foreground-subtle">
                {task.prompt}
              </p>
              <div className="mt-auto flex h-6 min-w-0 items-center gap-[10px] text-ui-base leading-snug">
                {/* Bug rationale: the status badge and the right-hand running-session note both shrink, so a long session name crushes the status to one character.
                   Status is the footnote's primary info: make it shrink-0 and truncate only the session segment. */}
                <div
                  className={cn(
                    "flex w-fit shrink-0 items-center gap-0.5 font-normal",
                    footer.className,
                    (task.status === "queued" || task.status === "paused") &&
                      // Zai Dark's brand is white; the queued tag uses the design's dedicated purple.
                      "rounded-[8px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <FooterIcon
                      className={cn("size-4 shrink-0", task.status === "running" && "animate-spin")}
                      strokeWidth={1.33}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="truncate">
                    {intl.formatMessage({ id: footer.labelId }, footer.labelValues)}
                  </span>
                </div>
                {failedQueueFooter && FailedQueueIcon ? (
                  <div className="flex w-fit shrink-0 items-center gap-0.5 rounded-[6px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task opacity-40">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <FailedQueueIcon
                        className="size-4 shrink-0"
                        strokeWidth={1.33}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="truncate">
                      {intl.formatMessage(
                        { id: failedQueueFooter.labelId },
                        failedQueueFooter.labelValues,
                      )}
                    </span>
                  </div>
                ) : null}
                {task.sessionTitle ? (
                  // In-session tasks bind to and run in their creating session; the footnote shows the session title.
                  <span
                    data-testid={TID_OFFPEAK_CARD_SESSION}
                    className="ml-auto min-w-0 truncate text-foreground-subtle"
                    title={task.sessionTitle}
                  >
                    {intl.formatMessage(
                      { id: "offPeak.boundSession.label" },
                      { title: task.sessionTitle },
                    )}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="absolute right-3 top-3 flex items-center gap-1">
              {task.sessionId ? (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={intl.formatMessage({
                    id: "offPeak.goToSession",
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(task);
                  }}
                >
                  <AutomationExternalLinkIcon
                    className="size-4 text-foreground-subtle"
                    aria-hidden="true"
                  />
                </button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-white/10 data-[state=open]:opacity-100"
                    data-testid={TID_OFFPEAK_CARD_MENU}
                    aria-label={intl.formatMessage({
                      id: "automations.moreActions",
                    })}
                    disabled={busy}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <AutomationMoreHorizontalIcon
                      className="size-4 text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className="w-[190px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  {task.status === "queued" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_PAUSE}
                      onSelect={() => onPause(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({ id: "offPeak.action.pause" })}
                      </span>
                      {/* Fix rationale: pause is now immediate, no second confirm; the info entry remains
                         to explain queue wait and re-enqueue, so the consequences are never opaque. */}
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.pauseHint",
                        })}
                      >
                        {/* Fix rationale: the info trigger sits inside a selectable item whose click bubbles into
                           Pause/Continue; isolate click only, leaving pointerdown to Radix's selection timing. */}
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "paused" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_CONTINUE}
                      onSelect={() => onContinue(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationContinueIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({
                          id: "offPeak.action.continue",
                        })}
                      </span>
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.continueHint",
                        })}
                      >
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "running" ? (
                    <DropdownMenuItem className="gap-1" onSelect={() => onCancel(task)}>
                      {/* Fix rationale: the thin outlined X reads lighter than its neighbors and mismatches the home chat's pause-generation semantics. */}
                      <span className="flex size-5 items-center justify-center">
                        <AutomationCancelActionIcon
                          className="size-4 fill-current"
                          aria-hidden="true"
                        />
                      </span>
                      {intl.formatMessage({ id: "offPeak.action.cancel" })}
                    </DropdownMenuItem>
                  ) : null}
                  {/* Fix rationale: with Delete as the only terminal action, a fixed divider reads as a group-less top line. */}
                  {hasPrimaryMenuAction ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                    data-testid={TID_OFFPEAK_ACTION_DELETE}
                    onSelect={() => onDelete(task)}
                  >
                    <AutomationTrashIcon />
                    {intl.formatMessage({ id: "automations.delete" })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}
