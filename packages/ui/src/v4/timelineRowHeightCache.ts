// Virtual-scroll core: the v4 timeline row-height cache (pure data, no DOM/React).
//
// Why: the @tanstack/react-virtual measurementsCache keys by itemKey and survives window unmount/remount;
// but streaming rows that keep growing lose everything when the virtualizer resets
// (rows array rebuilt, StrictMode remount, error-to-timeline switch): caches fall back to the fixed
// estimateSize, jumping the scrollbar and the bottom anchor. This adds a per-component-instance persistent
// cache keyed by the stable render-unit key (turnId), keeping measured heights across row remounts.
//

/** Fallback estimate for unmeasured rows (same as the legacy ConversationTimeline ROW_ESTIMATE_PX). */
export const DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72;

/** Cache cap: bounds memory on very long sessions; evict the least-recently-written row (write order ~ row order, oldest first). */
export const MAX_ROW_HEIGHT_CACHE_ENTRIES = 4000;

export type TimelineRowHeightCacheKey = string | number;

export class TimelineRowHeightCache {
  private readonly sizes = new Map<TimelineRowHeightCacheKey, number>();

  constructor(private readonly maxEntries: number = MAX_ROW_HEIGHT_CACHE_ENTRIES) {}

  get size(): number {
    return this.sizes.size;
  }

  /** Records one real measurement. Rewrites refresh the eviction order (active rows survive). */
  set(key: TimelineRowHeightCacheKey, heightPx: number): void {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      return;
    }
    // Map iteration order = insertion order; delete-then-set moves the row to the newest end.
    this.sizes.delete(key);
    this.sizes.set(key, heightPx);
    while (this.sizes.size > this.maxEntries) {
      const oldest = this.sizes.keys().next();
      if (oldest.done) break;
      this.sizes.delete(oldest.value);
    }
  }

  get(key: TimelineRowHeightCacheKey): number | undefined {
    return this.sizes.get(key);
  }

  /** The estimateSize entry: measured value when present, estimate otherwise. */
  estimate(
    key: TimelineRowHeightCacheKey | undefined,
    fallbackPx: number = DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  ): number {
    if (key === undefined) return fallbackPx;
    return this.sizes.get(key) ?? fallbackPx;
  }

  /** Whole-map reset on session switch (turnId is not globally unique across sessions). */
  clear(): void {
    this.sizes.clear();
  }
}
