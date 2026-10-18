import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import { LEDGE_PITCH, LEDGE_LAMP, ledgeLamps, railKey, scrollbarThumb } from "./timeline-ledge.js";
import type { TimelineViewport } from "./use-timeline-viewport.js";

/**
 * The ledge and the scrollbar.
 *
 * Ledge: stations folded off a viewport edge draw as a row of the same 10px light (16px
 * pitch) joined by that edge's ink rail; a short stub reaches the first open station on
 * the content side, and `+n` caps the far end past five. Each light is a button — one
 * click and the camera brings that station back. Folded stations are not drawn in the
 // content; the ledge light **is** the station.
 *
 * Scrollbar: 2px at the timeline's foot, border-colored track, foreground-subtlest
 * thumb; invisible at rest, visible on card hover or while scrolling, thickening to 4px
 * on hover. Draggable thumb, click-to-page track. The native scrollbar is hidden.
 */

/** Station light: the `STATUS_DOT` vocabulary; running adds a 3px breathing halo — the only glow on screen. */
export function stationLampClass(status: StepRunStatus | undefined): string {
  const resolved = status ?? "pending";
  return cn(
    "wf-lamp size-2.5 shrink-0 rounded-full",
    STATUS_DOT[resolved],
    resolved === "running" && "wf-lamp-running motion-reduce:animate-none",
  );
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Patch segments stay 1px like the static main rail; a weight seam at the scroll edge reads as a glitch.
// Twin segment: parallel stations on a ledge are not one line but two, 1px each, 2px
// apart — the ledge flattens the band and has no room for fork/merge curves; side-by-side
// lines are the only remaining mark of "simultaneous".
function Segment({ rail, width }: { rail: TimelineRail | undefined; width: number }) {
  if (rail?.kind === "twin") {
    return (
      <span
        aria-hidden
        className="relative h-0 shrink-0"
        data-ledge-ink={rail.ink}
        data-ledge-twin="true"
        style={{ width }}
      >
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: -1 }}
        />
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: 1 }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "h-0 shrink-0 border-t border-foreground-subtlest",
        rail === undefined && "invisible",
      )}
      data-ledge-ink={rail?.ink ?? "none"}
      style={{ width }}
    />
  );
}

export function WorkflowLedge({
  indexes,
  nameOf,
  onSelect,
  rails,
  side,
  stations,
  stubWidth,
  top,
}: {
  side: "left" | "right";
  /** Stations folded to this side (ascending). */
  indexes: readonly number[];
  stations: readonly TimelineStation[];
  /** Rail segments between adjacent stations, keyed by **pair** (`railKey`): one station in a band grows several segments. */
  rails: ReadonlyMap<string, TimelineRail>;
  /** Width of the stub rail from ledge to the first open station; 0 = skip. */
  stubWidth: number;
  /** Top of the rail row (ledge and lights share the height). */
  top: number;
  nameOf: (index: number) => string;
  onSelect: (index: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (indexes.length === 0) return null;
  const { shown, more } = ledgeLamps(indexes, side);
  const stubRail =
    side === "left"
      ? rails.get(railKey(indexes[indexes.length - 1]!, indexes[indexes.length - 1]! + 1))
      : rails.get(railKey(indexes[0]! - 1, indexes[0]!));
  const stub = stubWidth > 0 ? <Segment rail={stubRail} width={stubWidth} /> : null;
  const count =
    more > 0 ? (
      <span
        className="shrink-0 text-center font-mono text-ui-2xs text-foreground-subtlest"
        data-testid="workflow-timeline-ledge-more"
        style={{ width: 26 }}
      >
        +{more}
      </span>
    ) : null;
  const lamps = shown.map((index, k) => {
    const station = stations[index]!;
    const label = `${nameOf(index)} · ${intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${station.status ?? "pending"}` })}`;
    return (
      <span className="flex items-center" key={station.id}>
        {k > 0 ? (
          <Segment
            rail={rails.get(railKey(shown[k - 1]!, index))}
            width={LEDGE_PITCH - LEDGE_LAMP}
          />
        ) : null}
        <button
          aria-label={label}
          className="wf-ledge-lamp relative flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/40"
          data-station-index={index}
          data-testid="workflow-timeline-ledge-lamp"
          onClick={() => onSelect(index)}
          style={{ height: LEDGE_LAMP, width: LEDGE_LAMP }}
          title={label}
          type="button"
        >
          <span
            aria-hidden
            className={cn(stationLampClass(station.status), "wf-land")}
            data-lamp={station.status ?? "pending"}
          />
        </button>
      </span>
    );
  });
  return (
    <div
      aria-label={intl.formatMessage(
        { id: `chat.toolCall.workflow.timeline.ledge.${side === "left" ? "earlier" : "later"}` },
        { count: indexes.length },
      )}
      className={cn(
        "wf-ledge pointer-events-auto absolute flex h-6 items-center",
        side === "left" ? "left-0 pl-2" : "right-0 pr-2",
      )}
      data-testid={`workflow-timeline-ledge-${side}`}
      role="group"
      style={{ top }}
    >
      {side === "left" ? count : stub}
      {lamps}
      {side === "left" ? stub : count}
    </div>
  );
}

/**
 * After a thumb drag or track click the browser fires a follow-up click that bubbles up
 * the DOM to the host card — the tail digest treats "click on blank space" as
 * collapse/expand, and its interactive-child predicate knows buttons/links/inputs, not
 * scrollbars, so one drag folds the card. The scrollbar's click stops here: the
 * interaction is consumed.
 */
function stopClick(event: ReactMouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

export function WorkflowTimelineScrollbar({
  scrollRef,
  viewport,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  viewport: TimelineViewport;
}) {
  const { intl } = useZCodeIntl();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const thumb = scrollbarThumb(viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth);
  if (thumb === undefined) return null;
  const range = viewport.scrollWidth - viewport.clientWidth;
  const ratio = viewport.scrollWidth / viewport.clientWidth;

  const onThumbDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startLeft: viewport.scrollLeft,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onThumbMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    const element = scrollRef.current;
    if (state === null || element === null || state.pointerId !== event.pointerId) return;
    element.scrollLeft = state.startLeft + (event.clientX - state.startX) * ratio;
  };
  const onThumbUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  const onTrackDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const element = scrollRef.current;
    if (element === null) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const direction = x < thumb.left ? -1 : 1;
    element.scrollBy({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: direction * viewport.clientWidth,
    });
  };
  return (
    <div
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.timeline.scrollbar" })}
      aria-orientation="horizontal"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round((100 * Math.min(viewport.scrollLeft, range)) / range)}
      className="wf-sb absolute inset-x-0 bottom-0 h-0.5 cursor-pointer rounded-full bg-border"
      data-dragging={dragging ? "true" : undefined}
      data-scrolling={viewport.scrolling ? "true" : undefined}
      data-testid="workflow-timeline-scrollbar"
      onClick={stopClick}
      onPointerDown={onTrackDown}
      role="scrollbar"
    >
      <span
        className="wf-sb-thumb absolute inset-y-0 rounded-full bg-foreground-subtlest"
        data-testid="workflow-timeline-scrollbar-thumb"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        style={{ left: thumb.left, width: thumb.width }}
      />
    </div>
  );
}
