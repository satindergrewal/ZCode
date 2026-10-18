import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelinePill, TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";
import { ROSTER_PINS_CARD, rosterMore, stationRosterOf } from "./roster-model.js";
import { useTypewriter } from "./use-typewriter.js";
import { WorkflowAgentPill } from "./WorkflowAgentPill.js";
import { WorkflowMoreRow } from "./WorkflowMoreRow.js";
import {
  PILL_GAP,
  PILL_HEIGHT,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  stationX,
  timelineLayout,
  timelineWidth,
} from "./timeline-geometry.js";
import { WorkflowTimelineArcs } from "./WorkflowTimelineArcs.js";
import {
  WorkflowTimelineFills,
  useFillHeadTarget,
  useFreshFills,
} from "./WorkflowTimelineFills.js";
import type { TimelineFill } from "./timeline-holes.js";
import { timelineFrames } from "./timeline-frames.js";
import { WorkflowStationPlatform, WorkflowStationRow } from "./WorkflowTimelineStation.js";
import { WorkflowTimelineLamps, WorkflowTimelineTracks } from "./WorkflowTimelineTracks.js";
import {
  NO_FOLD,
  flightAfterScroll,
  foldStations,
  ledgeStubWidth,
  railKey,
  stationCameraLeft,
  timelineMaskStyle,
  type CameraFlight,
} from "./timeline-ledge.js";
import { useTimelineViewport } from "./use-timeline-viewport.js";
import { slideClass, slideStyle, useFillGrowth } from "./use-fill-growth.js";
import {
  WorkflowLedge,
  WorkflowTimelineScrollbar,
  prefersReducedMotion,
} from "./WorkflowTimelineLedge.js";

export { STATION_GAP, STATION_PITCH, STATION_WIDTH, timelineWidth } from "./timeline-geometry.js";

/**
 * Horizontal timeline: one rail, stations standing on it,
 * pills hanging under stations, arcs in the air above the rail. Pure DOM + one SVG layer (arcs only), no canvas library.
 *
 * Geometry constants match the design canvas verbatim (`timeline-geometry.ts`): station width 168, pitch 24 (five stations = 936, inside the 960
 * session column), rail row 24, arc lane gap 14. Dots sit in the pill avatar column (station left + 17), names in the subagent column (station left + 34);
 * the station header is just a background-free pill.
 *
 * Wider than the container and it scrolls freely: stations scrolled out of view fold onto that side's **ledge** — the same dot, one per 16px,
 * on clean ground at the viewport edge; the rail fades 40px near the ledge, pills fade only at the viewport's true bounds; position lives in a 2px scrollbar at the bottom.
 * The native scrollbar is hidden, the right edge gets no gradient, and the header no longer needs rank badges. The camera still tracks the running station; while flying, the target station does not fold
 * (the viewport is measured before scrollTo; computing out-of-view from a stale position mid-flight is a false positive).
 *
 * The draft (`model.draft`) is written by the pen: stations reveal one by one in declaration order, rail segments extend from the left,
 * dots land, names type out character by character, the cursor follows the pen and blinks once it catches up to the stream. Stations the pen has not reached are not on the rail yet.
 */
function stationHeight(station: TimelineStation): number {
  // Past the threshold a station is five pinned pills plus an "n more" row: that row is the sixth
  // pill, so a station never holds more than six pills.
  const roster = stationRosterOf(station, ROSTER_PINS_CARD);
  const n = roster === undefined ? station.pills.length : roster.pinned.length + 1;
  return n === 0 ? 0 : n * PILL_HEIGHT + (n - 1) * PILL_GAP;
}

/**
 * Overall timeline height (arc lane + rail row + platform row + tallest pill column). The run-tail digest's expand /
 * collapse transitions the outer frame's height between two values, so it must be computable outside render — the row layout is therefore
 * a pure function in `timeline-geometry.ts`. The trailing 8px gap is the scrollbar's home (6px below the pills, 2px tall,
 * 4px on hover) — it overlays the gap at the bottom edge without changing the height.
 */
export function timelineHeight(model: WorkflowTimelineModel): number {
  const rows = timelineLayout(model.arcs, model.bands, hasFillHeads(model));
  return rows.pillsTop + Math.max(0, ...model.stations.map(stationHeight)) + 8;
}

/** Only timelines with fills get the header row (docs/dynamic-workflow/presentation.md "Holes on the timeline"). */
function hasFillHeads(model: Pick<WorkflowTimelineModel, "fills">): boolean {
  return (model.fills?.length ?? 0) > 0;
}

/** Delay between successive pill landings (same value as the design canvas). */
export const PILL_STAGGER_MS = 30;

function pillName(pill: TimelinePill, format: Parameters<typeof laneDisplayName>[1]): string {
  return pill.runtimeName ?? laneDisplayName(pill.lane, format);
}

export interface WorkflowTimelineProps {
  model: WorkflowTimelineModel;
  className?: string;
  /** Click a station; absent means the station header is not a control — clicks bubble to the host (the digest's whole-card toggle). */
  onSelectStation?: (station: TimelineStation) => void;
  /**
   * Clicking a roster station's "n more" row: opens run details, landed on this station. Gated apart from the header's
   * `onSelectStation`: in the digest the header remains part of the whole-card toggle while that row
   * is a door of its own. Absent means the row is static.
   */
  onOpenMore?: (station: TimelineStation) => void;
  /** Click a pill (with a session opens the transcript, without opens a placeholder); absent means not clickable. */
  onOpenPill?: (pill: TimelinePill) => void;
  /**
   * Click the script pill: opens the whole run's script transcript
   * and lands on this station; absent means not clickable. Gated separately from `onOpenPill` — each in its own lane.
   */
  onOpenWorkspace?: (pill: TimelinePill) => void;
  /**
   * Clicking a fill's head (docs/dynamic-workflow/presentation.md "Holes on the timeline"): opens the side panel, landed on the fill's
   * title (the first station it wrote). Absent means the head is not a control.
   */
  onOpenFill?: (fill: TimelineFill) => void;
}

export const WorkflowTimeline = memo(function WorkflowTimeline({
  className,
  model,
  onOpenFill,
  onOpenMore,
  onOpenPill,
  onOpenWorkspace,
  onSelectStation,
}: WorkflowTimelineProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const markerId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  // The scroll layer element lives in state too: the draft's first frame returns null and the scroll layer mounts a frame later — the viewport hook depends on the element,
  // attaching listeners only once it exists (keyed on the ref object, the first frame's null would never attach).
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScroller(element);
  }, []);
  // One camera flight: recorded at takeoff, cleared on landing or user takeover; the target station does not fold mid-flight.
  const [flight, setFlight] = useState<CameraFlight | undefined>(undefined);

  const { arcs } = model;
  const draft = model.draft !== undefined;
  const fullNames = model.stations.map((station) => phaseDisplayName(station.naming, format));
  const pen = useTypewriter(draft ? fullNames : undefined);
  const stations = draft ? model.stations.slice(0, pen.visible) : model.stations;
  const n = stations.length;
  const rails = draft ? model.rails.filter((rail) => rail.to < n) : model.rails;
  // Row layout: with a branch the main line sits on the bottom
  // row, branches stack above it, and the station header moves to the platform row; without one the whole formula reduces pixel-for-pixel to the previous "arc lane + rail row",
  // and the DOM takes the original branch too.
  // Fills (docs/dynamic-workflow/presentation.md "Holes on the timeline"): with a head, one extra 24px row on top; tail padding
  // grows 40px past the last station; which **head** holds pointer or keyboard focus (`data-fill-head`, the pen marker of phase-less fills too) is
  // delegated from the root, and that one frame draws accordingly. Stations and pills light nothing up — see timeline-frames.ts for why.
  const fills = (model.fills ?? []).filter((fill) => fill.to < n);
  const layout = timelineLayout(model.arcs, model.bands, fills.length > 0);
  const { banded, inset, pillsTop } = layout;
  const top = layout.rowY[0]! - RAIL_ROW / 2;
  const width = timelineWidth(n, inset, model.tailStub !== undefined);
  const height = timelineHeight(draft ? { ...model, stations } : model);
  const frames = timelineFrames({
    columnHeight: (i) => stationHeight(stations[i]!),
    fills,
    height,
    inset,
    layout,
    parents: model.holeParents ?? {},
    stations,
    width,
  });
  const fillTarget = useFillHeadTarget(frames.length > 0);
  const fresh = useFreshFills(frames);
  // Growth: when a fill attaches to the run, stations right of the inserted column slide over (`use-fill-growth.ts`).
  const slide = useFillGrowth(model);
  // Pills land station by station left to right, top to bottom within one: pill k is delayed k x 30 ms (the "n more" row queues too).
  let pillOrdinal = 0;
  const nextDelay = () => {
    const delay = PILL_STAGGER_MS * pillOrdinal;
    pillOrdinal += 1;
    return delay;
  };
  // Rail segments are keyed by a **pair of stations**: within a branch one station can grow the main line's segment,
  // a branch segment, and a double-line segment at once.
  const railByPair = useMemo(
    () => new Map(rails.map((rail) => [railKey(rail.from, rail.to), rail])),
    [rails],
  );

  // Viewport: scroll position, width, content width. Unmeasurable (jsdom) means all three are 0 and nothing below folds.
  const viewport = useTimelineViewport(scroller, width);
  // The flight settles after every scroll sample: over on arrival or divergence. Driven by position alone, no timers.
  useEffect(() => {
    setFlight((current) => flightAfterScroll(current, viewport.scrollLeft));
  }, [viewport.scrollLeft]);
  const overflow = viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth;
  const fold = overflow
    ? foldStations(n, viewport.scrollLeft, viewport.clientWidth, flight?.index, inset)
    : NO_FOLD;
  const folded = useMemo(() => new Set([...fold.left, ...fold.right]), [fold]);
  // Two mask bands: the rail band fades near the ledges, the pill band only at the viewport's true bounds.
  const mask = overflow
    ? timelineMaskStyle(fold, pillsTop - 8, {
        left: viewport.scrollLeft > 0,
        right: viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth - 1,
      })
    : undefined;

  const scrollTo = useCallback((left: number) => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, []);
  // Ledge dots: the camera centers that station again (same rule as the running station's camera).
  const selectFolded = useCallback(
    (index: number) =>
      scrollTo(stationCameraLeft(index, scrollRef.current?.clientWidth ?? 0, inset)),
    [inset, scrollTo],
  );
  // With focus on a station header or a ledge dot, the arrow keys scroll one station at a time.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-testid='workflow-timeline-station'], .wf-ledge") === null) return;
      const element = scrollRef.current;
      if (element === null || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      scrollTo(element.scrollLeft + (event.key === "ArrowLeft" ? -STATION_PITCH : STATION_PITCH));
    },
    [scrollTo],
  );

  // Camera: scrolls the focused station into view when content overflows; never fights the user once they scroll (re-anchors only on focus change).
  // In a run the focus is the running station (centered); in a draft focus follows the pen — the newest revealed hugs the right edge.
  // The draft target is index·PITCH + STATION_WIDTH − clientWidth: adding one more pitch overshoots by 24px (only browser clamping lands it right).
  const focusIndex = draft ? (n > 0 ? n - 1 : undefined) : model.runningIndex;
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || focusIndex === undefined) return;
    if (element.scrollWidth <= element.clientWidth) return;
    const left = draft
      ? Math.max(0, stationX(focusIndex, inset) + STATION_WIDTH - element.clientWidth)
      : stationCameraLeft(focusIndex, element.clientWidth, inset);
    // Takeoff: clamp the target to the scrollable range; already at the target is not a flight.
    const target = Math.min(left, element.scrollWidth - element.clientWidth);
    const from = element.scrollLeft;
    setFlight(Math.abs(from - target) <= 1 ? undefined : { from, index: focusIndex, target });
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, [draft, focusIndex, inset]);

  if (n === 0) return null;

  const stationTitleOf = (phaseId: string): string => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };
  const stationTitle = (station: TimelineStation): string => {
    const name = phaseDisplayName(station.naming, format);
    return station.onLoop && station.rounds > 0
      ? `${name} · ${intl.formatMessage({ id: "chat.toolCall.workflow.timeline.rounds" }, { count: station.rounds })}`
      : name;
  };

  const renderPill = (pill: TimelinePill) => {
    const enterDelayMs = nextDelay();
    const label = pillName(pill, format);
    // Subagent pills in a live run are always openable: with a session, the transcript; not yet started,
    // a placeholder in the same tab — the slot identity (`pill.slot`) is the handle. No run, no slot.
    // The script pill follows the same opening grammar: with a handle in a live run it
    // opens, landed on the station's first card. No hue; the hover border falls back to border-hover (the pill's own rule).
    const open =
      onOpenPill !== undefined && pill.slot !== undefined
        ? {
            label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
            onOpen: () => onOpenPill(pill),
            testId: "workflow-timeline-pill-open",
          }
        : onOpenWorkspace !== undefined && pill.workspace !== undefined
          ? {
              label: format(
                { id: "chat.toolCall.workflow.timeline.openScript" },
                { phase: stationTitleOf(pill.workspace.phaseId) },
              ),
              onOpen: () => onOpenWorkspace(pill),
              testId: "workflow-timeline-workspace-open",
            }
          : undefined;
    return (
      <WorkflowAgentPill
        enterDelayMs={enterDelayMs}
        key={pill.key}
        avatarIndex={pill.avatarIndex}
        laneClass={pill.laneClass}
        name={label}
        status={pill.status}
        {...(open === undefined ? {} : { open })}
      />
    );
  };

  const ledgeProps = {
    nameOf: (index: number) => fullNames[index]!,
    onSelect: selectFolded,
    rails: railByPair,
    stations,
    top,
  };

  return (
    <div
      className={cn("wf-motion wf-timeline min-w-0", className)}
      data-testid="workflow-timeline"
      onKeyDown={onKeyDown}
      {...fillTarget.handlers}
    >
      {/* Ledge and scrollbar sit above the scroll layer, positioned against it (not the padded outer frame). */}
      <div className="relative">
        <div
          className="wf-scroller overflow-x-auto overflow-y-hidden"
          data-testid="workflow-timeline-scroller"
          data-timeline-fade={
            fold.left.length > 0 && fold.right.length > 0
              ? "both"
              : fold.left.length > 0
                ? "left"
                : fold.right.length > 0
                  ? "right"
                  : undefined
          }
          ref={attachScroller}
          style={mask}
        >
          <div className="relative" style={{ height, width }}>
            {/* The fill frame (beneath everything) and its head (in the header row): docs/dynamic-workflow/presentation.md "Holes on the timeline". */}
            <WorkflowTimelineFills
              active={fillTarget.active}
              fills={fills}
              frames={frames}
              fresh={fresh}
              height={height}
              inset={inset}
              width={width}
              {...(onOpenFill === undefined ? {} : { onOpenFill })}
            />
            <WorkflowTimelineArcs
              arcs={arcs}
              bands={model.bands}
              height={height}
              layout={layout}
              markerId={markerId}
              stations={model.stations}
              width={width}
            >
              {/* With a branch the rail joins this SVG layer too: forks and merges are curves a DOM border cannot draw. */}
              {banded ? (
                <WorkflowTimelineTracks
                  folded={folded}
                  layout={layout}
                  model={{ bands: model.bands, rails, stations }}
                />
              ) : null}
            </WorkflowTimelineArcs>

            {banded ? (
              <WorkflowTimelineLamps
                draft={draft}
                folded={folded}
                layout={layout}
                stations={stations}
                {...(slide === undefined ? {} : { slide })}
              />
            ) : null}

            {banded ? (
              <WorkflowStationPlatform
                folded={folded}
                fullNames={fullNames}
                layout={layout}
                stations={stations}
                titleOf={stationTitle}
                {...(slide === undefined ? {} : { slide })}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            ) : (
              <WorkflowStationRow
                draft={draft}
                folded={folded}
                fresh={fresh}
                fullNames={fullNames}
                pen={pen}
                rails={railByPair}
                stations={stations}
                titleOf={stationTitle}
                top={top}
                width={width}
                {...(slide === undefined ? {} : { slide })}
                {...(model.tailStub === undefined ? {} : { tailStub: model.tailStub })}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            )}

            {stations.map((station, i) => {
              const roster = stationRosterOf(station, ROSTER_PINS_CARD);
              // The roster still has something to say: when a station's pills are all culled by the cap, the "n more" row remains rather than vanishing.
              if (station.pills.length === 0 && roster === undefined) return null;
              return (
                <div
                  className={cn(
                    "absolute flex flex-col",
                    station.ghost && "wf-ghost",
                    slideClass(i, slide),
                  )}
                  data-fill={station.fill}
                  data-station-roster={roster === undefined ? undefined : "true"}
                  data-testid="workflow-timeline-pills"
                  key={station.id}
                  style={{
                    ...slideStyle(i, slide),
                    gap: PILL_GAP,
                    left: stationX(i, inset),
                    top: pillsTop,
                    width: STATION_WIDTH,
                  }}
                >
                  {roster === undefined ? (
                    station.pills.map(renderPill)
                  ) : (
                    // Roster station: the five pinned keep the pill wiring, then a row
                    // of "n more" — clicking opens run details, landed on this station (`onOpenMore`, a gate of its own).
                    <>
                      {roster.pinned.map(renderPill)}
                      <WorkflowMoreRow
                        enterDelayMs={nextDelay()}
                        more={rosterMore(roster)}
                        {...(onOpenMore === undefined ? {} : { onOpen: () => onOpenMore(station) })}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* Ledges (the "ledge" postscript): stations folded to the viewport's sides, a row of dots on the rail row, the content beneath cleared by the mask. */}
        <WorkflowLedge
          indexes={fold.left}
          side="left"
          stubWidth={ledgeStubWidth(fold, "left", viewport.scrollLeft, viewport.clientWidth, inset)}
          {...ledgeProps}
        />
        <WorkflowLedge
          indexes={fold.right}
          side="right"
          stubWidth={ledgeStubWidth(
            fold,
            "right",
            viewport.scrollLeft,
            viewport.clientWidth,
            inset,
          )}
          {...ledgeProps}
        />
        {overflow ? <WorkflowTimelineScrollbar scrollRef={scrollRef} viewport={viewport} /> : null}
      </div>
    </div>
  );
});
