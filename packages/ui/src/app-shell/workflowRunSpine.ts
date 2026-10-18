import type {
  TimelineInk,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

/**
 * Spine layout: translate the timeline model into the vertical rails and curves to draw for each
 * node. Pure functions, subscripts and pixel offsets only - no React, no DOM; renderers just draw it.
 *
 * Track t rail sits at x = 21 + 12t; a branch rail leaves the main rail 13px above the band-head node with a fork curve, runs
 * vertically, and returns with a mirrored curve at the merge node top (or the band-tail node bottom without one). Inside a
 * branch node the main rail still passes through, inked as the crossing main segment - control flow really passes there; only the node light is off the main line.
 *
 * Rail segments are always looked up as **pairs** (from -> to), never indexed by from alone: inside a band one node can be both the left
 * end of a double segment and of the main segment, so from is no longer unique.
 */

/** Height consumed by the fork/merge curves. */
const SPINE_CURVE_PX = 13;

/** One rail segment; from/to override the defaults (px from node top/bottom), present only to make room for curves. */
export interface SpineRailPiece {
  track: number;
  ink: TimelineInk;
  /** above = node top to light, below = light to node bottom, full = through the whole node. */
  position: "above" | "below" | "full";
  from?: number;
  to?: number;
}

/** The 13px where a branch rail leaves/returns to the main rail. */
export interface SpineCurvePiece {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  /** Snap to the node top or bottom (without a merge node the merge draws at the band-tail bottom). */
  at: "top" | "bottom";
}

export interface SpineSection {
  rails: SpineRailPiece[];
  curves: SpineCurvePiece[];
}

export function spineSections(model: WorkflowTimelineModel): SpineSection[] {
  const sections: SpineSection[] = model.stations.map(() => ({ curves: [], rails: [] }));
  const trackAt = (i: number): number => model.stations[i]?.track ?? 0;
  const plain = model.rails.filter((rail) => rail.kind === undefined);
  /** The horizontal rail across node i with both ends on track t (main rail across branch nodes, branch rail across foreign nodes). */
  const spanning = (i: number, track: number): TimelineInk | undefined =>
    plain.find(
      (rail) =>
        rail.from < i && i < rail.to && trackAt(rail.from) === track && trackAt(rail.to) === track,
    )?.ink;
  const pairInk = (from: number, to: number): TimelineInk =>
    plain.find((rail) => rail.from === from && rail.to === to)?.ink ?? "faint";

  model.stations.forEach((station, i) => {
    const section = sections[i]!;
    const band =
      station.track === 0 ? undefined : model.bands.find((b) => b.from <= i && i <= b.to);
    const track = band?.tracks[station.track];
    if (track === undefined) {
      // Nodes on the main line: as before, the previous node draws the lower half and the next the upper half; no neighbor, no ink.
      const above = model.rails.find(
        (rail) => rail.to === i && rail.kind !== "twin" && rail.kind !== "merge",
      );
      const below = model.rails.find(
        (rail) => rail.from === i && rail.kind !== "twin" && rail.kind !== "fork",
      );
      if (above !== undefined) section.rails.push({ ink: above.ink, position: "above", track: 0 });
      if (below !== undefined) section.rails.push({ ink: below.ink, position: "below", track: 0 });
      return;
    }
    // Branch nodes: both halves read the node own rail; the ends read the rail entry/exit ink (the fork/merge segment ink).
    const at = track.stations.indexOf(i);
    const previous = track.stations[at - 1];
    const next = track.stations[at + 1];
    section.rails.push({
      ink: previous === undefined ? track.entry : pairInk(previous, i),
      position: "above",
      track: station.track,
    });
    section.rails.push({
      ink: next === undefined ? track.exit : pairInk(i, next),
      position: "below",
      track: station.track,
    });
    const main = spanning(i, 0);
    if (main !== undefined) section.rails.push({ ink: main, position: "full", track: 0 });
  });

  for (const band of model.bands) {
    band.tracks.forEach((track, t) => {
      if (t === 0) return;
      const end = band.join ?? band.to;
      const first = track.stations[0]!;
      const last = track.stations[track.stations.length - 1]!;
      // Without a merge node the merge draws at the band-tail bottom, so that node rail is 13px shorter.
      const tail = band.join === undefined ? SPINE_CURVE_PX : undefined;
      sections[band.from]?.curves.push({ at: "top", ink: track.entry, kind: "fork", track: t });
      sections[end]?.curves.push({
        at: tail === undefined ? "top" : "bottom",
        ink: track.exit,
        kind: "merge",
        track: t,
      });
      for (let i = band.from; i <= end; i += 1) {
        const section = sections[i];
        if (section === undefined) continue;
        if (track.stations.includes(i)) {
          if (tail !== undefined && i === end) {
            for (const rail of section.rails) {
              if (rail.track === t && rail.position === "below") rail.to = tail;
            }
          }
          continue;
        }
        // With a merge node, the merge node top is a curve; no straight-through rail segment.
        if (i === end && tail === undefined) continue;
        const ink =
          i < first ? track.entry : i > last ? track.exit : (spanning(i, t) ?? track.exit);
        section.rails.push({
          ink,
          position: "full",
          track: t,
          ...(i === band.from ? { from: SPINE_CURVE_PX } : {}),
          ...(tail !== undefined && i === end ? { to: tail } : {}),
        });
      }
    });
  }
  return sections;
}
