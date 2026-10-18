import { PenIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineFill } from "./timeline-holes.js";
import { framePath, legendGaps, type TimelineFrame } from "./timeline-frames.js";
import { HEAD_ROW, MARK_X, stationX } from "./timeline-geometry.js";

/** How long the frame redraws itself and the head stays warning-tinted after the fill joins the run (docs/dynamic-workflow/presentation.md "The stroke"). */
export const FILL_FRESH_MS = 2_000;

/**
 * Which fills are fresh right now: within two seconds of `filledAt`. State plus a timer instead of
 * reading the clock every frame — the model has no time; this clock exists here, for two seconds only.
 * Headed fills and phase-less fills (pen marks) count alike.
 */
export function useFreshFills(
  fills: readonly { holeId: string; filledAt?: number }[],
): ReadonlySet<string> {
  const compute = () => {
    const now = Date.now();
    return new Set(
      fills
        .filter((fill) => fill.filledAt !== undefined && now - fill.filledAt < FILL_FRESH_MS)
        .map((fill) => fill.holeId),
    );
  };
  const [fresh, setFresh] = useState<ReadonlySet<string>>(compute);
  const key = fills.map((fill) => `${fill.holeId}@${fill.filledAt ?? ""}`).join("\u0000");
  useEffect(() => {
    const next = compute();
    setFresh(next);
    if (next.size === 0) return undefined;
    const now = Date.now();
    const latest = Math.max(
      ...fills.filter((fill) => next.has(fill.holeId)).map((fill) => fill.filledAt ?? now),
    );
    const timer = setTimeout(() => setFresh(new Set()), Math.max(0, latest + FILL_FRESH_MS - now));
    return () => clearTimeout(timer);
    // Recompute by fill identity and time only (`key`): `fills` is a new reference every frame; depending on it would reset the timer each frame.
  }, [key]);
  return fresh;
}

/** The fill head owning the event target (`data-fill-head`); with `inside`, also pen marks within the target (station-header buttons taking focus). */
function fillHeadOf(target: EventTarget, inside: boolean): string | undefined {
  // The pointer often lands on the pen icon in the head — an SVGElement, not HTMLElement — hence Element.
  if (!(target instanceof Element)) return undefined;
  const owner =
    target.closest<HTMLElement>("[data-fill-head]") ??
    (inside ? target.querySelector<HTMLElement>("[data-fill-head]") : null);
  return owner?.dataset.fillHead;
}

function focusVisible(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    // Environments without :focus-visible (old jsdom): treat as pointer focus, draw no frame.
    return false;
  }
}

/**
 * Which frame to draw now (card and pane share it): the root-level delegation knows only heads —
 * elements with `data-fill-head` (card head, pane title row, phase-less pen marks). Pointer over it, or
 * focus-visible on it (station-header buttons carrying pen marks count). focus-visible only: clicking the
 * head opens the pane and focus stays there; the frame must not glow forever. No delegation when
 * `enabled` is false.
 */
export function useFillHeadTarget(enabled: boolean): {
  active: string | undefined;
  handlers: {
    onPointerOver?: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave?: () => void;
    onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
    onBlur?: () => void;
  };
} {
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const onPointerOver = useCallback((event: PointerEvent<HTMLDivElement>) => {
    setHovered(fillHeadOf(event.target, false));
  }, []);
  const onPointerLeave = useCallback(() => setHovered(undefined), []);
  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    setFocused(focusVisible(event.target) ? fillHeadOf(event.target, true) : undefined);
  }, []);
  const onBlur = useCallback(() => setFocused(undefined), []);
  return enabled
    ? { active: hovered ?? focused, handlers: { onBlur, onFocus, onPointerLeave, onPointerOver } }
    : { active: undefined, handlers: {} };
}

/**
 * Widths of the head rows (the legend's cut-out in the frame's top edge): measured after every commit,
 * re-measured by ResizeObserver when fonts or copy change. Empty when unmeasurable (jsdom, before first
 * paint) — the frame still draws, just without the cut-out.
 */
function useRowWidths(key: string): {
  refFor: (from: number) => (element: HTMLElement | null) => void;
  widths: Readonly<Record<number, number>>;
} {
  const rows = useRef(new Map<number, HTMLElement>());
  const [widths, setWidths] = useState<Readonly<Record<number, number>>>({});
  const measure = useCallback(() => {
    const next: Record<number, number> = {};
    for (const [from, element] of rows.current) next[from] = element.offsetWidth;
    setWidths((previous) => {
      const same =
        Object.keys(previous).length === Object.keys(next).length &&
        Object.entries(next).every(([from, width]) => previous[Number(from)] === width);
      return same ? previous : next;
    });
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    for (const element of rows.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [key, measure]);
  const refFor = useCallback(
    (from: number) => (element: HTMLElement | null) => {
      if (element === null) rows.current.delete(from);
      else rows.current.set(from, element);
    },
    [],
  );
  return { refFor, widths };
}

/**
 * The fill head and frame (docs/dynamic-workflow/presentation.md "Holes on the timeline").
 *
 * Head: a 24px row on timelines with fills only; the pen (12px) aligns with the first new dot's x, then
 * the hole's name (caption, medium, subtle, 300px truncate). No background, no rule. Clicking opens the
 * pane on the fill's title. It (and phase-less pen marks) carries `data-fill-head`: the timeline reads
 * hover and keyboard focus from these alone; stations and pills light nothing up.
 * Frame: the bounding rect from `timeline-frames.ts`, a path with `pathLength` 1; with `data-fill-on` the
 * dash offset runs 1 to 0 (one stroke, 420ms) and on leave the line fades 160ms. For the fresh two seconds
 * it carries `wf-fill-frame-fresh` and draws itself (an animation, not a transition: its mounting frame is
 * already lit). The head rows are cut out of the top edge (mask), so the head is a legend that holds over
 * any surface. One frame lit at a time: nested fills do not stack.
 * A nested fill sharing the outer's first column lines its head up after the outer's: 12px past the outer
 * head's right edge, same row — same-origin heads share one flex row (gap 12px), settled by layout rather
 * than measurement; different origins each align to their own first dot.
 */
export function WorkflowTimelineFills({
  active,
  fills,
  frames,
  fresh,
  height,
  inset,
  onOpenFill,
  width,
}: {
  fills: readonly TimelineFill[];
  /** One frame per fill (headed and phase-less alike, `timelineFrames`). */
  frames: readonly TimelineFrame[];
  /** The one frame drawn now: pointer on its head, or keyboard focus there. */
  active: string | undefined;
  fresh: ReadonlySet<string>;
  height: number;
  width: number;
  inset: number;
  onOpenFill?: (fill: TimelineFill) => void;
}) {
  const { intl } = useZCodeIntl();
  const maskId = `wf-fill-legend-${useId().replace(/:/gu, "")}`;
  // The model sorts by from ascending, outer first on ties; same-origin heads line up in that order.
  const headRows = new Map<number, TimelineFill[]>();
  for (const fill of fills) {
    const row = headRows.get(fill.from);
    if (row === undefined) headRows.set(fill.from, [fill]);
    else row.push(fill);
  }
  const rowLeft = (from: number): number => stationX(from, inset) + MARK_X - 6;
  const { refFor, widths } = useRowWidths([...headRows.keys()].join(","));
  if (frames.length === 0 && fills.length === 0) return null;
  const gaps = legendGaps(
    [...headRows.keys()].map((from) => ({ left: rowLeft(from), width: widths[from] ?? 0 })),
  );

  const renderHead = (fill: TimelineFill) => {
    const isFresh = fresh.has(fill.holeId);
    const on = active === fill.holeId;
    const time =
      fill.filledAt === undefined ? undefined : new Date(fill.filledAt).toLocaleTimeString();
    const title = intl.formatMessage(
      {
        id:
          time === undefined
            ? "chat.toolCall.workflow.hole.head.title.untimed"
            : "chat.toolCall.workflow.hole.head.title",
      },
      { name: fill.name, time: time ?? "" },
    );
    const body = (
      <>
        <PenIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 max-w-[300px] truncate text-ui-caption font-medium">
          {fill.name}
        </span>
      </>
    );
    const className = cn(
      "wf-fill-head flex h-full items-center gap-1.5 whitespace-nowrap rounded-md",
      isFresh ? "wf-land text-warning" : on ? "text-foreground" : "text-foreground-subtle",
      onOpenFill !== undefined &&
        "cursor-pointer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
    );
    const shared = {
      className,
      "data-fill-head": fill.holeId,
      "data-fill-on": on ? "true" : undefined,
      "data-testid": "workflow-timeline-fill-head",
      title,
    };
    return onOpenFill === undefined ? (
      <span key={fill.holeId} {...shared}>
        {body}
      </span>
    ) : (
      <button key={fill.holeId} onClick={() => onOpenFill(fill)} type="button" {...shared}>
        {body}
      </button>
    );
  };
  return (
    <>
      {/* The frame sits beneath everything: dots and rail draw on its edges. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        data-testid="workflow-timeline-fill-frames"
        height={height}
        width={width}
      >
        {gaps.length === 0 ? null : (
          <defs>
            <mask
              height={height + 40}
              id={maskId}
              maskUnits="userSpaceOnUse"
              width={width + 40}
              x={-20}
              y={-20}
            >
              <rect fill="white" height={height + 40} width={width + 40} x={-20} y={-20} />
              {gaps.map((gap) => (
                <rect
                  fill="black"
                  height={HEAD_ROW}
                  key={gap.x}
                  width={gap.width}
                  x={gap.x}
                  y={0}
                />
              ))}
            </mask>
          </defs>
        )}
        {frames.map((frame) => {
          const isFresh = fresh.has(frame.holeId);
          return (
            <path
              className={cn("wf-fill-frame", isFresh && "wf-fill-frame-fresh")}
              d={framePath(frame.box)}
              data-fill-frame={frame.holeId}
              data-fill-fresh={isFresh ? "true" : undefined}
              data-fill-on={isFresh || active === frame.holeId ? "true" : undefined}
              data-testid="workflow-timeline-fill-frame"
              key={frame.holeId}
              {...(gaps.length === 0 ? {} : { mask: `url(#${maskId})` })}
              pathLength={1}
            />
          );
        })}
      </svg>
      {[...headRows].map(([from, row]) => (
        // Pen center on dot center: dot center at station left + MARK_X, pen 12px wide, left edge 6 back. A same-origin second head follows 12px after the previous.
        <span
          className="absolute flex items-center gap-3"
          data-testid="workflow-timeline-fill-heads"
          key={from}
          ref={refFor(from)}
          style={{ height: HEAD_ROW, left: rowLeft(from), top: 0 }}
        >
          {row.map(renderHead)}
        </span>
      ))}
    </>
  );
}
