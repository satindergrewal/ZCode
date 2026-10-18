import type {
  TimelineInk,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

/**
 * Spine layout (docs/dynamic-workflow/presentation.md "The spine"): translates the timeline model into the
 * vertical rails each section draws plus the joint rows between sections. Pure functions, subscripts and
 * pixels only, no React, no DOM; renderers just draw what this says.
 *
 * Laid out like the commit graph: rails left, text right, never sharing a column. Track t's vertical rail sits
 * at `x = 21 + pitch*t`, and the whole spine's text starts at one column (`39 + gutter`, `gutter = pitch*(T-1)`,
 * T the widest band's track count): which track a site sits on moves its lamp, never its text. Previously a
 * section header only cleared its OWN track (`39 + 12*track`) and other tracks crossed over the site names;
 * with more tracks the mainline names got crossed one by one.
 *
 * Fork and join happen BETWEEN sites, so each gets a joint row (`SPINE_JOINT_PX`) instead of squeezing into a
 * neighboring section header: every band has a fork row before its first section and a join row after its last.
 * Previously the curve sat 13px above the band's first section, or on the join site's top / the last section's
 * bottom, so a band starting at the first site dropped its fork from outside the list and a band ending at the
 * last site drew its join under the pill, rejoining a mainline long since ended.
 *
 * A band with no predecessor draws an OPEN fork row (`open`): the main rail does not come from the previous
 * site, it grows a round head 4px above the row, a root. A band with no join site draws an open join row, the
 * rail stops 4px below, a sink (the card's TAIL / STUB).
 * Bug (2026-09-24, on-device): v1 drew joint rows only when predecessor/join sites existed and strands
 * started/ended on their own lamps; when the whole workflow is one band and every strand has a single site
 * (four phases, pairwise parallel) every strand has zero length and the spine is four floating lamps. Open
 * joint rows live in their own rows, never overlapping headers or pills, so they are always drawn.
 *
 * A strand's vertical rail runs from the fork row's bottom to the join row's top. It still splits per section
 * into above/below halves plus `full` for through-running sections, stretching with expand/collapse, no measuring.
 */

/** Joint row height. */
export const SPINE_JOINT_PX = 16;
//** Mainline vertical rail x (center). */
export const SPINE_TRACK_X = 21;
//** Track pitch is 12 up to this many branch tracks, tightened to 8 beyond. */
const WIDE_PITCH_BRANCHES = 4;

/**
 * One rail segment: `above` section top to lamp, `below` lamp to section bottom, `full` through the whole
 * section. `stream` marks half of a stream rail: it leaves a chevron notch at the section boundary and the
 * `below` half draws the chevron inside that notch (presentation.md "The spine").
 */
export interface SpineRailPiece {
  track: number;
  ink: TimelineInk;
  position: "above" | "below" | "full";
  stream?: true;
}

/** One joint row: the main rail passes straight through (ink of the mainline segment crossing it), one curve per branch. */
export interface SpineJoint {
  main: TimelineInk;
  branches: { track: number; ink: TimelineInk }[];
  /** Open: a fork row with no predecessor (root) or a join row with no sink, the rail only stubs out beyond the row. */
  open?: true;
}

export interface SpineSection {
  rails: SpineRailPiece[];
  /** Fork row attached BEFORE this section (the section opens some band). */
  fork?: SpineJoint;
  /** Join row attached AFTER this section (the section closes some band). */
  merge?: SpineJoint;
}

export interface SpineLayout {
  /** Pitch between adjacent tracks. */
  pitch: number;
  /** Extra width the text column yields vs a bandless spine: `pitch*(T-1)`; 0 with no bands. */
  gutter: number;
  sections: SpineSection[];
}

export function spineLayout(model: WorkflowTimelineModel): SpineLayout {
  const { bands, rails, stations } = model;
  const widest = Math.max(1, ...bands.map((band) => band.tracks.length));
  const pitch = widest - 1 <= WIDE_PITCH_BRANCHES ? 12 : 8;
  const bandAt = (i: number) => bands.find((band) => band.from <= i && i <= band.to);
  // Double-edge segments only assert parallelism, the spine does not draw them; fork/join segments belong to
  // joint rows, also not drawn inside sections. Stream rails split in halves like plain segments, plus the notch.
  const plain = rails.filter((rail) => rail.kind === undefined || rail.kind === "stream");
  const railOf = (from: number, to: number) =>
    plain.find((rail) => rail.from === from && rail.to === to);
  const plainInk = (from: number, to: number): TimelineInk => railOf(from, to)?.ink ?? "faint";
  const streamMark = (from: number, to: number) =>
    railOf(from, to)?.kind === "stream" ? { stream: true as const } : {};

  const sections: SpineSection[] = stations.map((_, i) => {
    const band = bandAt(i);
    if (band === undefined) {
      // Sites outside bands: as before, the previous site draws the lower half, the next the upper; adjacent
      // bandless neighbors stay blank. The mainline leg of join/fork segments (kind absent) still connects here;
      // the branch legs belong to the joint rows.
      const pieces: SpineRailPiece[] = [];
      const above = plain.find((rail) => rail.to === i);
      const below = plain.find((rail) => rail.from === i);
      if (above !== undefined)
        pieces.push({ ink: above.ink, position: "above", ...streamMark(above.from, i), track: 0 });
      if (below !== undefined)
        pieces.push({ ink: below.ink, position: "below", ...streamMark(i, below.to), track: 0 });
      return { rails: pieces };
    }
    const pieces: SpineRailPiece[] = [];
    band.tracks.forEach((track, t) => {
      const members = track.stations;
      const at = members.indexOf(i);
      if (at >= 0) {
        // Own track: the upper half ties to the previous member or the fork row, the lower to the next member or join row.
        const previous = members[at - 1];
        const next = members[at + 1];
        pieces.push({
          ink: previous === undefined ? track.entry : plainInk(previous, i),
          position: "above",
          ...(previous === undefined ? {} : streamMark(previous, i)),
          track: t,
        });
        pieces.push({
          ink: next === undefined ? track.exit : plainInk(i, next),
          position: "below",
          ...(next === undefined ? {} : streamMark(i, next)),
          track: t,
        });
        return;
      }
      // Other tracks cross the whole section: entry ink before the first member, exit ink after the last,
      // the segment's ink in between. The mainline crossing a branch site uses this leg too.
      const before = members.filter((member) => member < i).pop();
      const after = members.find((member) => member > i);
      const ink =
        before === undefined
          ? track.entry
          : after === undefined
            ? track.exit
            : plainInk(before, after);
      pieces.push({ ink, position: "full", track: t });
    });
    return { rails: pieces };
  });

  for (const band of bands) {
    const main = band.tracks[0]!;
    const branches = (end: "entry" | "exit") =>
      band.tracks.slice(1).map((track, k) => ({ ink: track[end], track: k + 1 }));
    sections[band.from]!.fork = {
      branches: branches("entry"),
      main: main.entry,
      ...(band.pred === undefined ? { open: true as const } : {}),
    };
    sections[band.to]!.merge = {
      branches: branches("exit"),
      main: main.exit,
      ...(band.join === undefined ? { open: true as const } : {}),
    };
  }
  return { gutter: pitch * (widest - 1), pitch, sections };
}
