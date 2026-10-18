/**
 * Bands and tracks.
 *
 * The analyzer's `alongside` is a **node fact**: when this phase started, the other phases' not-yet-joined strands were still running.
 * This folds it into the on-screen **band** — a contiguous run of phases in declaration order, split internally into **tracks**, track 0 the main line
 * (the bottom row), branch tracks stacked above. The band forks before and merges after; arcs treat the whole band as **one node**.
 *
 * Indices only: no ids, no ink, no pixels. The timeline model and the sidebar's mini run-line share this folding; the latter only has
 * the index space of `phaseNames`, no display graph.
 */

/** A band: every station in the closed interval `[from, to]`; `tracks[0]` is the main line. */
export interface PhaseBand {
  from: number;
  to: number;
  tracks: number[][];
}

/**
 * Band folding. `alongside[i]` = indices of the stations parallel to station i (out-of-range, self, and unlisted entries count as unsaid).
 *
 * 1. Symmetrize: only the later arrival can report `alongside` (when B starts, A is still running and A's payload has no B); on screen
 *    the two are peers.
 * 2. Connected components of `~` with >= 2 members yield the interval `[min, max]`; overlapping intervals union; gaps inside an interval count as members too
 *    (defensive — cannot happen without loops).
 * 3. Tracks are a greedy coloring of the interval graph in **declaration order**: each member takes the lowest track with no parallel member on it,
 *    else opens a new one. The first member thus always lands on track 0.
 */
export function foldPhaseBands(
  count: number,
  alongside: readonly (readonly number[])[],
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

  return merged.map((span) => {
    const tracks: number[][] = [];
    for (let i = span.from; i <= span.to; i += 1) {
      const free = tracks.find((members) => !members.some((member) => near[i]!.has(member)));
      if (free === undefined) tracks.push([i]);
      else free.push(i);
    }
    return { from: span.from, to: span.to, tracks };
  });
}

/** The band containing station i; undefined outside bands. */
export function bandOf<T extends PhaseBand>(bands: readonly T[], i: number): T | undefined {
  return bands.find((band) => band.from <= i && i <= band.to);
}

/** The track of station i; outside bands always 0 (the main line). */
export function trackOf(bands: readonly PhaseBand[], i: number): number {
  const track = bandOf(bands, i)?.tracks.findIndex((members) => members.includes(i));
  return track === undefined || track < 0 ? 0 : track;
}

/** Rail segment kind; absent = an ordinary segment on one track. */
export type TimelineRailKind = "fork" | "merge" | "twin";

export interface RailSpec {
  from: number;
  to: number;
  kind?: TimelineRailKind;
}

export interface ArcSpec {
  from: number;
  to: number;
  /** Which track's air the arc draws in: same-track arcs use that track's air, everything else the topmost air. */
  air: number;
}

/** A band plus its two on-screen endpoints: the predecessor hosting the fork and the successor hosting the merge. */
export interface BoundBand extends PhaseBand {
  pred?: number;
  join?: number;
}

export interface PhaseEdgeFold {
  bands: BoundBand[];
  rails: RailSpec[];
  arcs: ArcSpec[];
}

/** Band predecessor / merge: the adjacent station **outside** the band with an edge to any member. None is recognized between adjacent bands; there it is plain rail. */
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

/** Rail segments growing inside the band: adjacent same-track members (unconditional — a track is one strand), forks, merges, twin segments. */
function bandRails(bands: readonly BoundBand[]): RailSpec[] {
  const rails: RailSpec[] = [];
  for (const band of bands) {
    band.tracks.forEach((members, track) => {
      for (let k = 1; k < members.length; k += 1) {
        rails.push({ from: members[k - 1]!, to: members[k]! });
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
    // Twin segment: declaration-adjacent stations in the band on different tracks. Only the bench and side panel read it; it never travels.
    for (let i = band.from; i < band.to; i += 1) {
      if (trackOf(bands, i) !== trackOf(bands, i + 1))
        rails.push({ from: i, kind: "twin", to: i + 1 });
    }
  }
  return rails;
}

/**
 * Edges -> rail segments and arcs. The band absorbs some edges: fork and merge already say
 * "control passed through here"; the remainder become arcs, their endpoints **re-attached** to the band's two ends — the band is one node.
 */
export function foldPhaseEdges(
  count: number,
  folded: readonly PhaseBand[],
  edges: readonly { from: number; to: number }[],
): PhaseEdgeFold {
  const bands = bindBands(count, folded, edges);
  const top = Math.max(1, ...bands.map((band) => band.tracks.length)) - 1;
  const rails = bandRails(bands);
  const arcs: ArcSpec[] = [];
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
        // Across tracks: the forward edge is already covered by the fork; the backward one is the band's self-loop.
        if (edge.to < edge.from) arcs.push({ air: top, from: source.to, to: source.from });
        continue;
      }
      const members = source.tracks[track]!;
      // Same track and adjacent: the strand is already there; no need to draw it twice.
      if (members[members.indexOf(edge.from) + 1] !== edge.to) {
        arcs.push({ air: track, from: edge.from, to: edge.to });
      }
      continue;
    }
    // Leaving / entering the band: the adjacent one is already absorbed by merge / fork; the rest re-attach to the band's two ends.
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
  return {
    arcs: dedupe(arcs, (arc) => `${arc.air}:${arc.from}>${arc.to}`),
    bands,
    rails: order(rails),
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

/** Rail segments ordered by left end, then right end; without bands, identical item by item to the old per-station order. */
function order(rails: RailSpec[]): RailSpec[] {
  return dedupe(rails, (rail) => `${rail.from}>${rail.to}:${rail.kind ?? ""}`).sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
}

/** Number of arc lanes (highest lane + 1); the render layer reserves arc height by it. */
export function arcLaneCount(arcs: readonly { lane: number }[]): number {
  return arcs.reduce((max, arc) => Math.max(max, arc.lane + 1), 0);
}

/**
 * Arc lane assignment: greedy coloring of the interval graph. Arcs go from shortest span to longest (ties keep payload order), each into the **lowest free lane** —
 * free = no arc already on that lane **intersects** it in station indices (closed intervals: even sharing one endpoint counts, because two arcs'
 * verticals at the same station would join into one line). Hence: unrelated arcs share a height; nested arcs sit low inside, high outside (short ones place first, long
 * ones are pushed up); only truly crossing arcs get lifted.
 *
 * The old rule was "k-th arc, k-th lane": two unrelated back edges at opposite ends also came out one high one low, sending readers hunting for a
 * reason that does not exist.
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
 * Color per `air`: one track's air holds only that track's arcs; cross-track arcs always in the topmost air —
 * arcs in the two airs may intersect in x without yielding. Returns lane numbers aligned with the input.
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
