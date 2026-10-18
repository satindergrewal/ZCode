import { useEffect, useState, type CSSProperties } from "react";
import { STATION_PITCH } from "./timeline-geometry.js";
import type { WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Fill growth (docs/dynamic-workflow/presentation.md Holes on the timeline, Growth): when a completion lands
 * stations right of the insertion slide by the inserted width, a 320ms transform that ends at the new position
 * (the layout position; the animation merely starts at -width). The new stations' own wf-land / wf-rail-grow
 * entrances and the region's two-second freshness live elsewhere.
 *
 * The model has no time and no history, so how-many-inserted comes from the component diffing frames: a new
 * fill head plus a station-count increase. No previous frame on first render; cold-opening an already-filled
 * timeline does not slide. The camera stays: the fill's first station shares the hole's subscript and x, an
 * unchanged scrollLeft means parked on the waiting station's x. Under reduced-motion .wf-slide is none and new
 * rows appear.
 */
export const SLIDE_MS = 320;

export interface FillSlide {
  /** Stations after it slide. */
  after: number;
  /** Inserted width (px); stations slide from -shift to 0. */
  shift: number;
  /** Fresh key per growth so back-to-back growths each play. */
  key: number;
}

interface SeenShape {
  key: string;
  stations: number;
  fills: readonly string[];
}

function shapeOf(model: WorkflowTimelineModel): SeenShape {
  const fills = (model.fills ?? []).map((fill) => fill.holeId);
  return {
    key: `${model.stations.map((station) => station.id).join("\u0000")}\u0001${fills.join("\u0000")}`,
    stations: model.stations.length,
    fills,
  };
}

/** What grew between frames: a new fill head plus a station increase, else no growth. */
export function fillGrowth(
  previous: Pick<SeenShape, "stations" | "fills">,
  model: WorkflowTimelineModel,
): Pick<FillSlide, "after" | "shift"> | undefined {
  const grown = (model.fills ?? []).filter((fill) => !previous.fills.includes(fill.holeId));
  const delta = model.stations.length - previous.stations;
  if (grown.length === 0 || delta <= 0) return undefined;
  return { after: Math.max(...grown.map((fill) => fill.to)), shift: delta * STATION_PITCH };
}

export function useFillGrowth(model: WorkflowTimelineModel): FillSlide | undefined {
  const shape = shapeOf(model);
  const [seen, setSeen] = useState(shape);
  const [slide, setSlide] = useState<FillSlide | undefined>(undefined);
  // Render-phase derivation (React derive-state-from-props): record this frame when its shape differs from the
  // last; a growth starts one slide batch.
  if (seen.key !== shape.key) {
    const growth = fillGrowth(seen, model);
    setSeen(shape);
    if (growth !== undefined) setSlide((current) => ({ ...growth, key: (current?.key ?? 0) + 1 }));
  }
  // Once the animation ends (or never ran under reduced-motion) drop the class, so remounted stations
  // later do not replay it.
  useEffect(() => {
    if (slide === undefined) return undefined;
    const timer = setTimeout(() => setSlide(undefined), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [slide]);
  return slide;
}

export function slideClass(index: number, slide: FillSlide | undefined): string | undefined {
  return slide !== undefined && index > slide.after ? "wf-slide" : undefined;
}

export function slideStyle(index: number, slide: FillSlide | undefined): CSSProperties {
  return slide !== undefined && index > slide.after
    ? ({ "--wf-slide": `${-slide.shift}px` } as CSSProperties)
    : {};
}
