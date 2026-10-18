// Active duration of a dwf run, feeding the "time" cell of the completion card.
// Sums this run's every start plus each ancestor along `resumedFrom`, each over its own active
// span; gaps after a stop or process exit and before the next resume don't count.
//
// Can't just use the current registry entry's `completedAt - startedAt`: resume or revision resets
// that clock, dropping earlier segments. Duration, like token usage, must cover the whole lineage.
//
// The event log already records each span's start and last activity, so a read-side sum suffices;
// no extra persistence needed.

import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { supportsRunLifeSpans } from "./dynamic-workflow-run-journal.js";

/**
 * Hop limit when walking lineage upward. One revision is one hop and real chains are single-digit;
 * the cap only guards against a row's `resumedFrom` being externally rewritten into a long chain —
 * reading one run's duration must not scan unboundedly many rows.
 */
const LINEAGE_HOP_LIMIT = 64;

/**
 * Active duration in milliseconds of this run and its lineage, or `undefined` (no evidence from
 * any generation).
 *
 * `undefined` and `0` differ: the former means "the journal has nothing to say" (read facade
 * absent, the run's events predate this ledger, or the row was pruned) and the caller falls back
 * to the generation it observed itself; the latter means "a generation exists but lasted under 1 ms".
 *
 * The cycle guard is not decorative: `resumedFrom` is metadata written at run-creation time and
 * acyclic in theory, but the loop's termination depends on data in the store, not this process's
 * logic — a self-referential row rewritten by outside forces would turn a snapshot read into an
 * infinite loop, and snapshot reads sit on the background tracker's polling path.
 */
export function runLineageActiveMs(journal: JournalStorePort, runId: string): number | undefined {
  if (!supportsRunLifeSpans(journal)) return undefined;
  let total = 0;
  let sawLife = false;
  let cursor: string | undefined = runId;
  const visited = new Set<string>();
  for (let hop = 0; cursor !== undefined && hop < LINEAGE_HOP_LIMIT; hop += 1) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    for (const life of journal.listRunLifeSpans(cursor)) {
      sawLife = true;
      // Clamp to non-negative: both timestamps derive from `dwf_event.time_created`, a wall
      // clock — one time sync can put "last" before "first", and a negative total would
      // erase another generation's real duration, worse than dropping this span.
      total += Math.max(0, life.lastActivityAt - life.startedAt);
    }
    // Walk lineage upward only, never down supersededBy: a revision is the next version of the
    // same work built on its predecessor; later siblings have their own cards and don't count.
    cursor = journal.getRun(cursor)?.resumedFrom;
  }
  return sawLife ? total : undefined;
}
