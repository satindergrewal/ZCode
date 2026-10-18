/**
 * Bands and tracks.
 *
 * The analyzer's alongside is a NODE fact: entering this phase, other phases' strands not yet joined still run.
 * This folds it into the drawn BAND, a declaration-ordered run of phases split internally into TRACKS, track 0
 * the mainline (bottom row) with branch tracks stacked above. Fork before the band, join after; arcs treat the
 * whole band as ONE node.
 *
 * Subscripts only: no ids, no ink, no pixels. The timeline model and the side pane's mini run line share this
 * fold; the latter only has phaseNames subscripts, no display graph.
 */

/**
 * A phase stream (docs/dynamic-workflow/presentation.md Streams): from hands to to while both run. Subscripts
 * only, same space as alongside.
 */
export interface StreamSpec {
  from: number;
  to: number;
}

/** A band: every station in the closed range [from, to]; tracks[0] is the mainline. */
export interface PhaseBand {
  from: number;
  to: number;
  tracks: number[][];
}

/**
 * Band folding. alongside[i] = subscripts of stations parallel to i (out-of-range, self and unlisted read as
 * unsaid).
 *
 * 1. Symmetrize: only the later party can report (entering B, A is running and A's payload has no B); on screen
 *    the two are peers.
 * 2. Components of ~ with 2+ members yield range [min, max]; intersecting ranges union; gaps inside count as
 *    members (robustness; impossible without loops).
 * 3. Tracks are greedy interval-graph coloring in declaration order: each member takes the lowest track with no
 *    parallel member on it, else a new one. The first member thus always sits on track 0.
 * 4. With streams, coloring counts two stations parallel only when neither reaches the other: a phase and each
 *    downstream phase are one line's work and belong on one track however simultaneous. A band whose members all
 *    land on one track DISSOLVES, not a band: stations return to the mainline joined by stream rails
 *    (spec Bands and tracks). The sidebar mini run line passes no streams.
 */
export function foldPhaseBands(
  count: number,
  alongside: readonly (readonly number[])[],
  streams: readonly StreamSpec[] = [],
): PhaseBand[] {
  const near = Array.from({ length: Math.max(0, count) }, () => new Set<number>());
  for (let i = 0; i < near.length; i += 1) {
    for (const j of alongside[i] ?? []) {
      if (!Number.isInteger(j) || j < 0 || j >= near.length || j === i) continue;
      near[i]!.add(j);
      near[j]!.add(i);
    }
  }

  const seen = Array.from({ length: near.length }, () => false);
  const spans: { from: number; to: number }[] = [];
  for (let root = 0; root < near.length; root += 1) {
    if (seen[root] === true || near[root]!.size === 0) continue;
    let from = root;
    let to = root;
    const stack = [root];
    seen[root] = true;
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (i < from) from = i;
      if (i > to) to = i;
      for (const j of near[i]!) {
        if (seen[j] === true) continue;
        seen[j] = true;
        stack.push(j);
      }
    }
    spans.push({ from, to });
  }

  spans.sort((left, right) => left.from - right.from);
  const merged: { from: number; to: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }

  const reach = streamReach(near.length, streams);
  const apart = (i: number, j: number): boolean =>
    near[i]!.has(j) && !reach[i]!.has(j) && !reach[j]!.has(i);
  return merged.flatMap((span) => {
    const tracks: number[][] = [];
    for (let i = span.from; i <= span.to; i += 1) {
      const free = tracks.find((members) => !members.some((member) => apart(i, member)));
      if (free === undefined) tracks.push([i]);
      else free.push(i);
    }
    return tracks.length > 1 ? [{ from: span.from, to: span.to, tracks }] : [];
  });
}

/** Reachable along streams: reach[i] = stations from i following streams (out-of-range/self unsaid). */
function streamReach(count: number, streams: readonly StreamSpec[]): Set<number>[] {
  const next = Array.from({ length: count }, () => [] as number[]);
  for (const stream of streams) {
    if (!inRange(stream.from, count) || !inRange(stream.to, count)) continue;
    if (stream.from !== stream.to) next[stream.from]!.push(stream.to);
  }
  return next.map((_, start) => {
    const reached = new Set<number>();
    const stack = [...next[start]!];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (reached.has(i)) continue;
      reached.add(i);
      stack.push(...next[i]!);
    }
    return reached;
  });
}

const inRange = (i: number, count: number): boolean => Number.isInteger(i) && i >= 0 && i < count;

/** The band containing station i; undefined off-band. */
export function bandOf<T extends PhaseBand>(bands: readonly T[], i: number): T | undefined {
  return bands.find((band) => band.from <= i && i <= band.to);
}

/** Station i's track; 0 (mainline) off-band. */
export function trackOf(bands: readonly PhaseBand[], i: number): number {
  const track = bandOf(bands, i)?.tracks.findIndex((members) => members.includes(i));
  return track === undefined || track < 0 ? 0 : track;
}

/** Rail kind; absent = plain segment on one track; stream = the phase stream between adjacent stations on one track. */
export type TimelineRailKind = "fork" | "merge" | "twin" | "stream";

export interface RailSpec {
  from: number;
  to: number;
  kind?: TimelineRailKind;
}

export interface ArcSpec {
  from: number;
  to: number;
  /** Which track's air: same-track in-band arcs use that track's air, everything else the topmost. */
  air: number;
  /** Non-adjacent phase stream: drawn as an arc but it means handed-to, neither loop nor control jump. */
  stream?: true;
}

/** Band plus its two drawn anchors: the predecessor hosting the fork and successor hosting the join. */
export interface BoundBand extends PhaseBand {
  pred?: number;
  join?: number;
}

export interface PhaseEdgeFold {
  bands: BoundBand[];
  rails: RailSpec[];
  arcs: ArcSpec[];
}

/** Band predecessor/join: the adjacent station OUTSIDE the band edged to any member. Adjacent bands don't count; plain rail there. */
function bindBands(
  count: number,
  bands: readonly PhaseBand[],
  edges: readonly { from: number; to: number }[],
): BoundBand[] {
  const outside = (i: number): boolean => i >= 0 && i < count && bandOf(bands, i) === undefined;
  return bands.map((band) => {
    const before = band.from - 1;
    const after = band.to + 1;
    const pred =
      outside(before) &&
      edges.some((edge) => edge.from === before && bandOf(bands, edge.to) === band);
    const join =
      outside(after) &&
      edges.some((edge) => edge.to === after && bandOf(bands, edge.from) === band);
    return {
      ...band,
      ...(join ? { join: after } : {}),
      ...(pred ? { pred: before } : {}),
    };
  });
}

/**
 * Rail segments the band grows itself: same-track adjacent members (UNCONDITIONAL, a track is one strand; the
 * stream rail when a stream spans them), fork, join, twin segments.
 */
function bandRails(bands: readonly BoundBand[], streamed: ReadonlySet<string>): RailSpec[] {
  const rails: RailSpec[] = [];
  for (const band of bands) {
    band.tracks.forEach((members, track) => {
      for (let k = 1; k < members.length; k += 1) {
        const from = members[k - 1]!;
        const to = members[k]!;
        rails.push({
          from,
          ...(streamed.has(`${from}>${to}`) ? { kind: "stream" as const } : {}),
          to,
        });
      }
      if (band.pred !== undefined) {
        rails.push({
          from: band.pred,
          ...(track === 0 ? {} : { kind: "fork" as const }),
          to: members[0]!,
        });
      }
      if (band.join !== undefined) {
        rails.push({
          from: members[members.length - 1]!,
          ...(track === 0 ? {} : { kind: "merge" as const }),
          to: band.join,
        });
      }
    });
    // Twin segment: declaration-adjacent in-band stations on different tracks. Read by card and side pane only; never marches.
    for (let i = band.from; i < band.to; i += 1) {
      if (trackOf(bands, i) !== trackOf(bands, i + 1))
        rails.push({ from: i, kind: "twin", to: i + 1 });
    }
  }
  return rails;
}

/**
 * Edges to rail segments and arcs. Bands eat some: fork and join already say control passed here; the rest
 * become arcs with endpoints REHUNG onto the band's ends, a band is one node.
 */
export function foldPhaseEdges(
  count: number,
  folded: readonly PhaseBand[],
  edges: readonly { from: number; to: number }[],
  streams: readonly StreamSpec[] = [],
): PhaseEdgeFold {
  const bands = bindBands(count, folded, edges);
  const top = Math.max(1, ...bands.map((band) => band.tracks.length)) - 1;
  const streamed = new Set(
    streams
      .filter((stream) => inRange(stream.from, count) && inRange(stream.to, count))
      .map((stream) => `${stream.from}>${stream.to}`),
  );
  const rails = bandRails(bands, streamed);
  const arcs: ArcSpec[] = [];
  // Streams (spec Rails kind 6 and the paragraph after): adjacent same-track pairs are stream rails (in-band
  // ones drawn by bandRails), non-adjacent become stream arcs; cross-track streams in a band go undrawn, fork
  // and join already said both run at once.
  for (const key of streamed) {
    const [from, to] = key.split(">").map(Number) as [number, number];
    if (from === to) continue;
    const source = bandOf(bands, from);
    const target = bandOf(bands, to);
    if (source === undefined && target === undefined) {
      if (to === from + 1) rails.push({ from, kind: "stream", to });
      else arcs.push({ air: top, from, stream: true, to });
      continue;
    }
    if (source === undefined || source !== target) continue;
    const track = trackOf(bands, from);
    if (track !== trackOf(bands, to)) continue;
    const members = source.tracks[track]!;
    if (members[members.indexOf(from) + 1] !== to)
      arcs.push({ air: track, from, stream: true, to });
  }
  for (const edge of edges) {
    const source = bandOf(bands, edge.from);
    const target = bandOf(bands, edge.to);
    if (source === undefined && target === undefined) {
      if (edge.to === edge.from + 1) rails.push({ from: edge.from, to: edge.to });
      else arcs.push({ air: top, from: edge.from, to: edge.to });
      continue;
    }
    if (source !== undefined && source === target) {
      const track = trackOf(bands, edge.from);
      if (track !== trackOf(bands, edge.to)) {
        // Cross-track: forward edges said by the fork; backward is the band's self-loop.
        if (edge.to < edge.from) arcs.push({ air: top, from: source.to, to: source.from });
        continue;
      }
      const members = source.tracks[track]!;
      // Same track and adjacent: the strand is already there, draw nothing twice.
      if (members[members.indexOf(edge.from) + 1] !== edge.to) {
        arcs.push({ air: track, from: edge.from, to: edge.to });
      }
      continue;
    }
    // Leaving/entering: the adjacent leg is absorbed by join/fork; the rest re-hang onto the band's ends.
    if (source !== undefined && target === undefined && edge.to === source.to + 1) continue;
    if (source === undefined && target !== undefined && edge.from === target.from - 1) continue;
    const from = source === undefined ? edge.from : source.to;
    const to = target === undefined ? edge.to : target.from;
    if (source !== undefined && target !== undefined && source.to + 1 === target.from) {
      rails.push({ from, to });
      continue;
    }
    arcs.push({ air: top, from, to });
  }
  // A stream rail replaces the plain segment of the same pair: one rail per pair, the stream says more.
  const streamRails = new Set(
    rails.filter((rail) => rail.kind === "stream").map((rail) => `${rail.from}>${rail.to}`),
  );
  return {
    arcs: dedupe(arcs, (arc) => `${arc.air}:${arc.from}>${arc.to}:${arc.stream ? "s" : ""}`),
    bands,
    rails: order(
      rails.filter(
        (rail) => rail.kind !== undefined || !streamRails.has(`${rail.from}>${rail.to}`),
      ),
    ),
  };
}

function dedupe<T extends { from: number; to: number }>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.from === item.to || seen.has(key(item))) return false;
    seen.add(key(item));
    return true;
  });
}

/** Rails sort by left then right end; bandless, identical to the old per-station order. */
function order(rails: RailSpec[]): RailSpec[] {
  return dedupe(rails, (rail) => `${rail.from}>${rail.to}:${rail.kind ?? ""}`).sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
}

/** Arc lane count (highest lane + 1); renderers reserve height by it. */
export function arcLaneCount(arcs: readonly { lane: number }[]): number {
  return arcs.reduce((max, arc) => Math.max(max, arc.lane + 1), 0);
}

/**
 * Arc lanes: greedy interval coloring. Arcs land on the LOWEST free lane by span ascending (payload order on
 * ties); free means no existing arc on that lane intersects it in station subscripts (closed intervals: even a
 * shared endpoint counts, two arcs would merge into one line at the station's vertical). Hence: disjoint arcs
 * share a height; nested arcs go inner-low-outer-high (short lands first); only true crossings climb.
 *
 * The old rule was arc k = lane k: two unrelated loop-backs at opposite ends also staggered, sending readers
 * hunting for a reason that isn't there.
 */
export function assignArcLanes(
  pairs: readonly { from: number; to: number }[],
): { from: number; to: number; lane: number }[] {
  const placed: { lo: number; hi: number; lane: number }[] = [];
  return pairs.map((pair) => {
    const lo = Math.min(pair.from, pair.to);
    const hi = Math.max(pair.from, pair.to);
    const taken = new Set(
      placed
        .filter((other) => Math.max(lo, other.lo) <= Math.min(hi, other.hi))
        .map((other) => other.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    placed.push({ hi, lane, lo });
    return { from: pair.from, lane, to: pair.to };
  });
}

/**
 * Per-air coloring: a track's air holds only that track's arcs; cross-track arcs always the topmost air,
 * and arcs in the two airs may intersect in x without yielding. Returns lanes aligned with input.
 */
export function assignAirLanes(arcs: readonly ArcSpec[]): number[] {
  const lanes = Array.from({ length: arcs.length }, () => 0);
  for (const air of new Set(arcs.map((arc) => arc.air))) {
    const group = arcs.flatMap((arc, at) => (arc.air === air ? [{ ...arc, at }] : []));
    assignArcLanes(group).forEach((placed, k) => {
      lanes[group[k]!.at] = placed.lane;
    });
  }
  return lanes;
}
