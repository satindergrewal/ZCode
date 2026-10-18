// ============================================================
// Active duration of a dwf run (the completion card's time cell)
// ============================================================
// Rationale and accounting: docs/dynamic-workflow/transcript-and-notifications.md "How long it took" —
// the completion card shows the **whole lineage's active time**: every incarnation of this run plus every
// ancestor's incarnations via `resumedFrom`; gaps between incarnations do not count.
//
// Defect (2026-09-21): duration was "the settling process's own clock" (the registry entry's
// completedAt - startedAt). Resume mints a new entry and revision a new runId; both reset that clock to zero,
// while a revised/restored incarnation is mostly cache replay — seconds. A four-hour run revised once reported "12 seconds",
// while the neighboring tokens cell counted the whole lineage (that cell has counted per lineage since run creation, see execution-engine.md
// "Usage across the lineage"). Two cells, one question — they must measure the same span.
//
// Duration, unlike tokens, need not accumulate on the row: the event log dates every incarnation (`run-started` -> that
// incarnation's last event), so this is a **read-only summation** — zero writes, zero migration, and it holds for old runs that predate the fix.

import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { supportsRunLifeSpans } from "./dynamic-workflow-run-journal.js";

/**
 * Hop cap for lineage walks. One revision is one hop and real chains are single-digit; the cap only guards
 * "the row's resumedFrom externally written into a long chain" — reading one run's duration must not scan unbounded rows.
 */
const LINEAGE_HOP_LIMIT = 64;

/**
 * Active duration of this run and its lineage (ms), or `undefined` (no incarnation has evidence).
 *
 * `undefined` and `0` differ: the former means "the journal cannot say" (read face absent, run predates this accounting,
 * the row was cleaned), and the caller falls back to the incarnation it observed; the latter means "an incarnation exists, its duration under 1 ms".
 *
 * Cycle protection is not decorative: `resumedFrom` is metadata written at run creation and should not cycle, but this
 * loop's termination depends on **stored data**, not this process's logic — one self-referential row turns a
 * snapshot read into a livelock, on the background tracker's polling path no less.
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
      // Clamp to non-negative: both moments come from `dwf_event.time_created`, but that is **wall clock** — one time sync can
      // put "the last event" before "the first". A negative would subtract another incarnation's real time from the total, worse than dropping it.
      total += Math.max(0, life.lastActivityAt - life.startedAt);
    }
    // Walk lineage upward only, never down supersededBy: a revision is the next version of the
    // same work built on its predecessor; later siblings have their own cards and don't count.
    cursor = journal.getRun(cursor)?.resumedFrom;
  }
  return sawLife ? total : undefined;
}
