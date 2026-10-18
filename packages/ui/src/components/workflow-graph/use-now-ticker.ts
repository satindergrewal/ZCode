import { useEffect, useState } from "react";

/** Natural granularity for countdown copy: below one second no character changes. */
export const NOW_TICKER_INTERVAL_MS = 1_000;

/**
 * A "now" that only advances while `active`.
 *
 * Why not piggyback on projection renders: an ask backing off against the provider
 * **emits no events at all**, so event-driven reads would freeze at the second they were
 * taken. The timer exists only while there is a countdown to show; when `active` flips,
 * "now" is re-read once before starting, without the previous segment's skew. Same
 * stance as WorkflowRunPendingQuestionsSection's wait time, with the granularity
 * tightened from 30s to 1s — this one displays seconds.
 */
export function useNowTicker(active: boolean, intervalMs: number = NOW_TICKER_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
