import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import {
  CAPTION_X,
  PLATFORM_ROW,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { railKey } from "./timeline-ledge.js";
import type { TypewriterState } from "./use-typewriter.js";
import { StationMeta } from "./WorkflowStationMeta.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";

/**
 * Station header: name + metadata, a background-less
 * pill. Without bands it sits on the track row, right of the lamp; with bands it moves to the platform row
 * while the lamp stays on its own track — the marker is identical in both places, hence split out of `WorkflowTimeline.tsx` as one shared copy.
 *
 * A non-clickable header is a `span`, not a disabled `button`: browsers dispatch no click
 * on disabled controls, so block toggles would never receive it; a span has no semantics and clicks bubble as usual.
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
  /** The cursor following the pen in a draft; null otherwise. */
  caret: ReactNode;
  foldClass: string;
  title: string;
  /** Absent = the header is not a control — clicks bubble to the host (the run-tail summary's block toggle). */
  onSelect?: () => void;
}) {
  const pending = station.status === undefined || station.status === "pending";
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
      <StationMeta station={station} />
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
  /** The station's full name, by index; in a draft the pen has written only the first characters. */
  fullNames: readonly string[];
  folded: ReadonlySet<number>;
  titleOf: (station: TimelineStation) => string;
  onSelectStation?: (station: TimelineStation) => void;
}

/**
 * The track row (no bands): station headers (lamp + name + meta) and the rail segment to the next station, one cell per station. A station folded to the ledge keeps only
 * its rail segment; the pill column does not fold (user revision: symmetric sides) — pills only fade at the viewport's true boundary.
 */
export function WorkflowStationRow({
  draft,
  folded,
  fullNames,
  onSelectStation,
  pen,
  rails,
  stations,
  titleOf,
  top,
  width,
}: RowProps & {
  /** Rail segment between adjacent stations, keyed by `railKey`. */
  rails: ReadonlyMap<string, TimelineRail>;
  draft: boolean;
  pen: TypewriterState;
  top: number;
  width: number;
}) {
  const n = stations.length;
  return (
    <div className="absolute left-0 flex" style={{ height: RAIL_ROW, top, width }}>
      {stations.map((station, i) => {
        const rail = rails.get(railKey(i, i + 1));
        const full = fullNames[i]!;
        const name = draft ? full.slice(0, pen.shown[i] ?? 0) : full;
        const penHere = draft && i === n - 1;
        const foldClass = cn("wf-foldable", folded.has(i) && "wf-folded");
        return (
          <div
            className="flex h-6 min-w-0 items-center"
            data-station-folded={folded.has(i) ? "true" : undefined}
            data-station-status={station.status ?? "pending"}
            data-testid="workflow-timeline-station"
            key={station.id}
            style={{ width: i < n - 1 ? STATION_PITCH : STATION_WIDTH }}
          >
            <span
              aria-hidden
              className={cn(
                stationLampClass(station.status),
                "mx-3",
                foldClass,
                draft && "wf-land",
              )}
              data-lamp={station.status ?? "pending"}
            />
            <StationHead
              caret={
                penHere ? (
                  // Cursor follows the pen: steady while writing, blinking once caught up.
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
            {i < n - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "wf-ink relative h-0 min-w-3 flex-1 rounded-full border-t border-foreground-subtlest",
                  draft && "wf-rail-grow",
                  rail === undefined && "invisible",
                  // Traveling segments draw the underline as usual, plus a motionless light (`.wf-rail-march::after`): brightening toward the lamp.
                  rail?.ink === "march" && "wf-rail-march",
                )}
                data-rail-from={i}
                data-rail-ink={rail?.ink ?? "none"}
                data-rail-to={i + 1}
                data-testid="workflow-timeline-rail"
                style={{ marginLeft: 10, marginRight: -6 }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The platform row: with bands, headers move below the rail
 * to this row, lamps stay on their tracks, and branch-track stations are tied back to their name by a dotted leader — main-line stations need none, their lamp
 * sits right above the name. Drafts never have bands, so the pen is not a concern here.
 */
export function WorkflowStationPlatform({
  folded,
  fullNames,
  layout,
  onSelectStation,
  stations,
  titleOf,
}: RowProps & { layout: TimelineLayout }) {
  return (
    <>
      {stations.map((station, i) => (
        <div
          className="absolute flex h-6 min-w-0 items-center"
          data-station-folded={folded.has(i) ? "true" : undefined}
          data-station-status={station.status ?? "pending"}
          data-station-track={station.track}
          data-testid="workflow-timeline-station"
          key={station.id}
          style={{
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
