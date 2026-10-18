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
import {
  WorkflowLedge,
  WorkflowTimelineScrollbar,
  prefersReducedMotion,
} from "./WorkflowTimelineLedge.js";

export { STATION_GAP, STATION_PITCH, STATION_WIDTH, timelineWidth } from "./timeline-geometry.js";

/**
 * The horizontal timeline: one rail, stations on the rail,
 * pills hanging under stations, arcs in the air above the rail. Pure DOM + one SVG layer (arcs only), no canvas library.
 *
 * Geometry constants verbatim from the design canvas (`timeline-geometry.ts`): station width 168, gap 24 (five stations = 936, inside the
 * 960 conversation column), track row 24, lane gap 14. The lamp sits in the pill-avatar column (station left + 17), the name in the subagent-name column (station left + 34)
 — the station header is just a background-less pill.
 *
 * Wider than the container, it scrolls freely: stations whose lamps leave the view fold onto that side's **ledge** — same lamp, 16px apart,
 * on clean ground at the viewport edge; the track row fades 40px near the ledge, pills only fade at the viewport's true boundary; position lives in a 2px scrollbar at the bottom.
 * The native scrollbar is hidden, the right edge no longer painted with a gradient, and the header no longer needs rank bands. The camera stays on the running station; while flying, the target station does not fold
 (the viewport was measured before scrollTo; computing it as out of view from a stale position is a false positive).
 *
 * The draft (`model.draft`) is written by the pen: stations revealed one by one in declaration order, rail segments growing from the left,
 * lamps landing, names written character by character, the cursor following the pen and blinking when it catches up. Stations the pen has not reached are not on the rail yet.
 */
function stationHeight(station: TimelineStation): number {
  // A station past the threshold is five pinned pills plus one "n more" row: that row is the sixth
  // pill, so a station never exceeds six pills of height.
  const roster = stationRosterOf(station, ROSTER_PINS_CARD);
  const n = roster === undefined ? station.pills.length : roster.pinned.length + 1;
  return n === 0 ? 0 : n * PILL_HEIGHT + (n - 1) * PILL_GAP;
}

/**
 * The timeline's total height (arc lanes + track row + platform row + tallest pill column). When the run-tail summary expands /
 * collapses it transitions the frame's height between two values, so it must be computable outside render — the row layout is therefore
 * a pure function in `timeline-geometry.ts`. The trailing 8px is the scrollbar's home (6px under the pills, 2px tall,
 * 4px on hover) — it overlays the padding against the bottom edge without changing the height.
 */
export function timelineHeight(model: WorkflowTimelineModel): number {
  const rows = timelineLayout(model.arcs, model.bands);
  return rows.pillsTop + Math.max(0, ...model.stations.map(stationHeight)) + 8;
}

/** Stagger between pills landing in sequence (same value as the design canvas). */
export const PILL_STAGGER_MS = 30;

function pillName(pill: TimelinePill, format: Parameters<typeof laneDisplayName>[1]): string {
  return pill.runtimeName ?? laneDisplayName(pill.lane, format);
}

export interface WorkflowTimelineProps {
  model: WorkflowTimelineModel;
  className?: string;
  /** Select a station; absent = the header is not a control — clicks bubble to the host (the run-tail summary's block toggle). */
  onSelectStation?: (station: TimelineStation) => void;
  /**
   * Clicking a roster station's "n more" row: open the run detail, land on this station. Gated separately from the header's
   * `onSelectStation`: in the run-tail summary the header remains part of the block toggle, while this row
   * is a door of its own. Absent = the row is static.
   */
  onOpenMore?: (station: TimelineStation) => void;
  /** Click a pill (with session opens the transcript, without opens the placeholder); absent = not clickable. */
  onOpenPill?: (pill: TimelinePill) => void;
  /**
   * Click the script pill: open the whole run's script transcript,
   * landing on this station; absent = the script pill is not clickable. Gated per lane, independently of `onOpenPill`.
   */
  onOpenWorkspace?: (pill: TimelinePill) => void;
}

export const WorkflowTimeline = memo(function WorkflowTimeline({
  className,
  model,
  onOpenMore,
  onOpenPill,
  onOpenWorkspace,
  onSelectStation,
}: WorkflowTimelineProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const markerId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  // The scrolling element also goes into state: the draft's first frame returns null at n === 0 and the scroll layer mounts a frame later — the viewport hook depends on the element,
  // attaching the listener only once the element exists (depending on the ref object, the first frame's null means it never attaches).
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScroller(element);
  }, []);
  // One leg of the camera's flight: recorded at takeoff, cleared on landing or user takeover; while flying the target station does not fold.
  const [flight, setFlight] = useState<CameraFlight | undefined>(undefined);

  const { arcs } = model;
  const draft = model.draft !== undefined;
  const fullNames = model.stations.map((station) => phaseDisplayName(station.naming, format));
  const pen = useTypewriter(draft ? fullNames : undefined);
  const stations = draft ? model.stations.slice(0, pen.visible) : model.stations;
  const n = stations.length;
  const rails = draft ? model.rails.filter((rail) => rail.to < n) : model.rails;
  // Row layout: with bands the main line is the bottom
  // row, branches stack above it, headers move to the platform row; without bands the whole formula degenerates pixel-identically to the old "arc lanes + track row",
  // and the DOM takes the original branch too.
  const layout = timelineLayout(model.arcs, model.bands);
  const { banded, inset, pillsTop } = layout;
  const top = layout.rowY[0]! - RAIL_ROW / 2;
  const width = timelineWidth(n, inset);
  const height = timelineHeight(draft ? { ...model, stations } : model);
  // Pills land station by station, left to right, top down inside a station: the k-th delays k × 30 ms (the "n more" row queues too).
  let pillOrdinal = 0;
  const nextDelay = () => {
    const delay = PILL_STAGGER_MS * pillOrdinal;
    pillOrdinal += 1;
    return delay;
  };
  // Rail segments keyed by **pair of stations**: inside a band one station can grow the main-line segment,
  // a forked one, and a twin segment at once.
  const railByPair = useMemo(
    () => new Map(rails.map((rail) => [railKey(rail.from, rail.to), rail])),
    [rails],
  );

  // Viewport: scroll position, visible width, content width. Unmeasurable (jsdom) means all three 0; nothing folds below.
  const viewport = useTimelineViewport(scroller, width);
  // Settle the flight after every scroll sample: landing or deviation ends it. Position only, no timers.
  useEffect(() => {
    setFlight((current) => flightAfterScroll(current, viewport.scrollLeft));
  }, [viewport.scrollLeft]);
  const overflow = viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth;
  const fold = overflow
    ? foldStations(n, viewport.scrollLeft, viewport.clientWidth, flight?.index, inset)
    : NO_FOLD;
  const folded = useMemo(() => new Set([...fold.left, ...fold.right]), [fold]);
  // The mask has two bands: the rail band fades near the ledge, the pill band only at the viewport's true boundary.
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
  // Ledge lamps: the camera brings that station back to center (same rule as the running station's camera).
  const selectFolded = useCallback(
    (index: number) =>
      scrollTo(stationCameraLeft(index, scrollRef.current?.clientWidth ?? 0, inset)),
    [inset, scrollTo],
  );
  // With focus on a header or a ledge lamp, ← → scroll one station each.
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

  // Camera: when wider than the container, scroll the focused station into view; once the user scrolls, stop grabbing (re-anchor only when the focus changes).
  // In a run the focus is the running station (centered); in a draft the focus follows the pen — the newest revealed hugs the right edge.
  // The draft's target is index·PITCH + STATION_WIDTH − clientWidth: do not add one more station gap (a 24px overshoot; only the browser's clamping lands it right).
  const focusIndex = draft ? (n > 0 ? n - 1 : undefined) : model.runningIndex;
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || focusIndex === undefined) return;
    if (element.scrollWidth <= element.clientWidth) return;
    const left = draft
      ? Math.max(0, stationX(focusIndex, inset) + STATION_WIDTH - element.clientWidth)
      : stationCameraLeft(focusIndex, element.clientWidth, inset);
    // Takeoff: clamp the target to the scrollable range; already at target, no flight.
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
    // The script pill follows the same opening grammar: in a live run, a handle
    // means openable, landing on the station's first card. No hue; on hover the border falls back to border-hover (the pill's own rule).
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
    >
      {/* Ledge and scrollbar overlay the scrolling layer, positioned against it (not the padded frame). */}
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
            <WorkflowTimelineArcs
              arcs={arcs}
              bands={model.bands}
              height={height}
              layout={layout}
              markerId={markerId}
              stations={model.stations}
              width={width}
            >
              {/* With bands, rails also enter this SVG layer: fork and merge are curves DOM borders cannot draw. */}
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
              />
            ) : null}

            {banded ? (
              <WorkflowStationPlatform
                folded={folded}
                fullNames={fullNames}
                layout={layout}
                stations={stations}
                titleOf={stationTitle}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            ) : (
              <WorkflowStationRow
                draft={draft}
                folded={folded}
                fullNames={fullNames}
                pen={pen}
                rails={railByPair}
                stations={stations}
                titleOf={stationTitle}
                top={top}
                width={width}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            )}

            {stations.map((station, i) => {
              const roster = stationRosterOf(station, ROSTER_PINS_CARD);
              // A roster present means there is still something to say: when a station's pills are all evicted by the bound, the "n more" row remains instead of vanishing.
              if (station.pills.length === 0 && roster === undefined) return null;
              return (
                <div
                  className="absolute flex flex-col"
                  data-station-roster={roster === undefined ? undefined : "true"}
                  data-testid="workflow-timeline-pills"
                  key={station.id}
                  style={{
                    gap: PILL_GAP,
                    left: stationX(i, inset),
                    top: pillsTop,
                    width: STATION_WIDTH,
                  }}
                >
                  {roster === undefined ? (
                    station.pills.map(renderPill)
                  ) : (
                    // Roster station: the five pinned keep the pill wiring, then one row
                    // of "n more" — clicking opens the run detail on this station (`onOpenMore`, its own gate).
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
        {/* Edge ledges: stations folded to both sides, a row of lamps on the track row; the content under the ledge is already masked clear. */}
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
