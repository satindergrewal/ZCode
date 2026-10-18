/* Idle-task list:
   2-column card grid; card anatomy matches the scheduled card: title + instruction +
   footer (moon + #N in-queue rank badge). Created-desc; hover menu narrows by state.
   Rank has no Est. */
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

// Grouping by state makes tasks jump on running-terminal transitions, breaking position memory;
// order by immutable created time only, so state changes never reorder.
function sortOffPeakTasksByCreatedAt(tasks: readonly ZCodeOffPeakTask[]): ZCodeOffPeakTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

/** Same scroll threshold as AutomationsSection's scheduled list (spec: at most 8 cards visible). */
const OFFPEAK_LIST_SCROLL_THRESHOLD = 8;

const OFFPEAK_MENU_HINT_MAX_WIDTH = 320;
const OFFPEAK_MENU_HINT_RIGHT_OFFSET = 16;

type OffPeakMenuHintSide = "right" | "top";

function resolveOffPeakMenuHintSide(
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
    // The info entry sits inside the menu; narrow windows flip Radix right to left,
    // and a left tooltip would cross the whole menu. Without horizontal room, popup above instead.
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
  // The design's Paused is a circular stop icon; the old double-bar read as a media pause control.
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
        // Same rule as the scheduled list: 8 visible cards max, the grid scrolls itself, no endless page growth.
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
              // An inset surface shadow is not Card border semantics; it color-shifts against home cards across themes.
              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-[10px] border border-card-border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              // Completed stays dimmed overall, but hover surface still signals the card clicks and the menu works.
              task.status === "completed" ? "opacity-60 hover:bg-hover" : "hover:bg-hover",
            )}
          >
            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
              <span className="block truncate pr-14 text-ui-base font-medium leading-5 text-foreground">
                {task.title || task.prompt}
              </span>
              {/* Body and status type scale with settings; a fixed 18px line box squeezes or clips large text. */}
              <p className="line-clamp-2 h-9 text-ui-base font-normal leading-snug text-foreground-subtle">
                {task.prompt}
              </p>
              <div className="mt-auto flex h-6 min-w-0 items-center gap-[10px] text-ui-base leading-snug">
                Status badge and the right-side Session: ... both shrink; long session titles crushed the status to one glyph.
                   Status is the footer's primary info: shrink-0, and only the session title truncates.
                <div
                  className={cn(
                    "flex w-fit shrink-0 items-center gap-0.5 font-normal",
                    footer.className,
                    (task.status === "queued" || task.status === "paused") &&
                      // Zai Dark's brand is white; the queued tag needs the design's dedicated purple semantic.
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
                  // In-session tasks bind to and run in their creating session; the footer shows that session title.
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
                      Pause now executes immediately, no second confirm; the info entry carries
                         queue wait and re-enqueue notes so the consequence is never opaque.
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.pauseHint",
                        })}
                      >
                        The info entry lives inside a selectable item; click bubbles would run
                           Pause/Continue directly; isolate click only, leaving pointerdown to Radix's selection order.
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
                      {/* A hairline X reads lighter than sibling action icons and mismatches home Chat's stop-generation semantics. */}
                      <span className="flex size-5 items-center justify-center">
                        <AutomationCancelActionIcon
                          className="size-4 fill-current"
                          aria-hidden="true"
                        />
                      </span>
                      {intl.formatMessage({ id: "offPeak.action.cancel" })}
                    </DropdownMenuItem>
                  ) : null}
                  {/* A terminal menu with delete alone turns a fixed separator into a top border with no grouping meaning. */}
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
