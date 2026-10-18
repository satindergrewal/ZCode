import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import {
  CAPTION_X,
  PLATFORM_ROW,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  TAIL_STUB,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { railKey } from "./timeline-ledge.js";
import type { TypewriterState } from "./use-typewriter.js";
import { HoleFillMark, HoleWaitingMeta } from "./WorkflowHoleParts.js";
import { StationMeta } from "./WorkflowStationMeta.js";
import { StreamChevronsBox } from "./WorkflowStreamChevrons.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";
import { slideClass, slideStyle, type FillSlide } from "./use-fill-growth.js";

/**
 * Station header: name plus metadata, a background-free pill. Without a branch it sits on the rail row
 * beside the dot; with one it moves to the platform row while the dot stays on its own rail — the
 * markup is identical in both places, hence split out of `WorkflowTimeline.tsx` to share one copy.
 *
 * A non-clickable header is a `span`, not a disabled `button`: browsers dispatch no click on disabled
 * controls and the whole-card toggle would never receive it; a span has no semantics and clicks bubble.
 */
export function StationHead({
  caret,
  foldClass,
  name,
  onSelect,
  station,
  title,
}: {
  station: TimelineStation;
  name: string;
  /** The draft caret that follows the pen; null otherwise. */
  caret: ReactNode;
  foldClass: string;
  title: string;
  /** Absent means the header is not a control — clicks bubble to the host (the digest's whole-card toggle). */
  onSelect?: () => void;
}) {
  const pending = station.status === undefined || station.status === "pending";
  // Hole station (docs/dynamic-workflow/presentation.md "Holes on the timeline"): subtle until the name
  // arrives, metadata slot reading awaiting-fill while waiting; a phase-less fill puts a pen mark after
  // the name. Types never reach the UI.
  const hole = station.hole;
  const head = (
    <>
      <span
        className={cn(
          "truncate text-ui-caption font-medium",
          pending ? "text-foreground-subtle" : "text-foreground",
        )}
      >
        {name}
        {caret}
      </span>
      {hole?.state === "filled" ? <HoleFillMark holeId={hole.siteId} /> : null}
      {hole?.state === "waiting" ? (
        <HoleWaitingMeta hole={hole} />
      ) : (
        <StationMeta station={station} />
      )}
    </>
  );
  return onSelect === undefined ? (
    <span
      className={cn(
        "wf-station flex h-6 min-w-0 shrink items-center gap-2 rounded-md text-left",
        foldClass,
      )}
      data-testid="workflow-timeline-station-head"
      title={title}
    >
      {head}
    </span>
  ) : (
    <button
      className={cn(
        "wf-station wf-station-open flex h-6 min-w-0 shrink cursor-pointer items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        foldClass,
      )}
      onClick={onSelect}
      title={title}
      type="button"
    >
      {head}
    </button>
  );
}

interface RowProps {
  stations: readonly TimelineStation[];
  /** Fill growth (`use-fill-growth.ts`): stations past `after` take `wf-slide`, gliding in from −shift. */
  slide?: FillSlide;
  /** Station full names by index; in a draft the pen has typed only a prefix. */
  fullNames: readonly string[];
  folded: ReadonlySet<number>;
  titleOf: (station: TimelineStation) => string;
  onSelectStation?: (station: TimelineStation) => void;
}

/**
 * Rail row (branchless): station header (dot + name + metadata) and the segment toward the next
 * station, one cell each. Folded stations keep only the segment; pill columns never fold (user revision:
 * symmetric sides) — they merely scroll, fading at the viewport's true bounds.
 */
export function WorkflowStationRow({
  draft,
  folded,
  fresh,
  fullNames,
  onSelectStation,
  pen,
  rails,
  slide,
  stations,
  tailStub,
  titleOf,
  top,
  width,
}: RowProps & {
  /** Rail segments between adjacent stations, looked up by `railKey`. */
  rails: ReadonlyMap<string, TimelineRail>;
  draft: boolean;
  pen: TypewriterState;
  top: number;
  width: number;
  /** The last station is a tail void: `open` draws a 40px fading dashed stub past it, `filled` keeps only the room. */
  tailStub?: "open" | "filled";
  /** Stations written by a fill newly joined to the run: dot lands, segment grows (`wf-land` / `wf-rail-grow`). */
  fresh?: ReadonlySet<string>;
}) {
  const n = stations.length;
  return (
    <div className="absolute left-0 flex" style={{ height: RAIL_ROW, top, width }}>
      {stations.map((station, i) => {
        const rail = rails.get(railKey(i, i + 1));
        const stream = rail?.kind === "stream";
        const full = fullNames[i]!;
        const name = draft ? full.slice(0, pen.shown[i] ?? 0) : full;
        const penHere = draft && i === n - 1;
        const foldClass = cn("wf-foldable", folded.has(i) && "wf-folded");
        const landing = draft || (station.fill !== undefined && fresh?.has(station.fill) === true);
        const last = i === n - 1;
        return (
          <div
            className={cn(
              "flex h-6 min-w-0 items-center",
              station.ghost && "wf-ghost",
              slideClass(i, slide),
            )}
            data-fill={station.fill}
            data-station-folded={folded.has(i) ? "true" : undefined}
            data-station-ghost={station.ghost ? "true" : undefined}
            data-station-hole={station.hole?.state}
            data-station-status={station.status ?? "pending"}
            data-testid="workflow-timeline-station"
            key={station.id}
            style={{
              ...slideStyle(i, slide),
              width: !last
                ? STATION_PITCH
                : STATION_WIDTH + (tailStub === undefined ? 0 : TAIL_STUB),
            }}
          >
            <span
              aria-hidden
              className={cn(
                stationLampClass(station.status, station.hole),
                "mx-3",
                foldClass,
                landing && "wf-land",
              )}
              data-lamp={
                station.hole !== undefined && station.hole.state !== "filled"
                  ? `hole-${station.hole.state}`
                  : (station.status ?? "pending")
              }
            />
            <StationHead
              caret={
                penHere ? (
                  // Caret follows the pen: steady while writing, blinking once it catches the stream.
                  <span
                    aria-hidden
                    className={cn(
                      "ml-px inline-block h-3 w-px bg-foreground align-[-1px]",
                      pen.idle && "wf-caret",
                    )}
                    data-pen={pen.idle ? "idle" : "writing"}
                    data-testid="workflow-timeline-caret"
                  />
                ) : null
              }
              foldClass={foldClass}
              name={name}
              station={station}
              title={titleOf(station)}
              {...(onSelectStation === undefined
                ? {}
                : { onSelect: () => onSelectStation(station) })}
            />
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  "wf-ink relative h-0 flex-1 rounded-full border-t border-foreground-subtlest",
                  // Stream rail (presentation.md "Stream rails"): the line gaps for the chevrons at center
                  // (line drawn by ::before, border transparent), at least 42px so a segment remains on both
                  // sides; it never layers march light.
                  stream ? "wf-rail-stream min-w-[42px]" : "min-w-3",
                  landing && "wf-rail-grow",
                  rail === undefined && "invisible",
                  // Segments touching an open hole are dashed: no code there yet (docs/dynamic-workflow/presentation.md).
                  rail?.dashed && "border-dashed",
                  // Marching segments draw the base line as usual plus still light (`.wf-rail-march::after`): brightening toward the dot.
                  !stream && rail?.ink === "march" && "wf-rail-march",
                )}
                data-rail-dashed={rail?.dashed ? "true" : undefined}
                data-rail-from={i}
                data-rail-ink={rail?.ink ?? "none"}
                data-rail-kind={rail?.kind}
                data-rail-to={i + 1}
                data-testid="workflow-timeline-rail"
                style={{ marginLeft: 10, marginRight: -6 }}
              >
                {stream ? (
                  <StreamChevronsBox ink={rail.ink} style={{ left: "50%", top: -0.5 }} />
                ) : null}
              </span>
            ) : tailStub === "open" ? (
              // Tail void: the rail runs 40px further, fading — the script's ending is not written yet.
              <span
                aria-hidden
                className="wf-tail-stub h-0 shrink-0 border-t border-dashed border-foreground-subtlest"
                data-testid="workflow-timeline-tail-stub"
                style={{ marginLeft: 10, width: TAIL_STUB }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Platform row: with a branch every header moves to this row below the rail, dots stay on their own
 * rails, and branch stations are tied back to their names by a dotted leader — main-line stations need
 * none, their dot sits right above the name. Drafts never branch, so the pen is no concern here.
 */
export function WorkflowStationPlatform({
  folded,
  fullNames,
  layout,
  onSelectStation,
  slide,
  stations,
  titleOf,
}: RowProps & { layout: TimelineLayout }) {
  return (
    <>
      {stations.map((station, i) => (
        <div
          className={cn(
            "absolute flex h-6 min-w-0 items-center",
            station.ghost && "wf-ghost",
            slideClass(i, slide),
          )}
          data-fill={station.fill}
          data-station-folded={folded.has(i) ? "true" : undefined}
          data-station-hole={station.hole?.state}
          data-station-status={station.status ?? "pending"}
          data-station-track={station.track}
          data-testid="workflow-timeline-station"
          key={station.id}
          style={{
            ...slideStyle(i, slide),
            left: stationX(i, layout.inset) + CAPTION_X,
            top: layout.capY - PLATFORM_ROW / 2,
            width: STATION_WIDTH - CAPTION_X,
          }}
        >
          <StationHead
            caret={null}
            foldClass={cn("wf-foldable", folded.has(i) && "wf-folded")}
            name={fullNames[i]!}
            station={station}
            title={titleOf(station)}
            {...(onSelectStation === undefined ? {} : { onSelect: () => onSelectStation(station) })}
          />
        </div>
      ))}
    </>
  );
}
