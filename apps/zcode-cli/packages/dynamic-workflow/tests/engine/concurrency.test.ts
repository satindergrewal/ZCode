/**
 * Pure state-machine cases for ConcurrencyController (the controller rows of docs/dynamic-workflow/concurrency.md,
 * The controller). Clock-free: tests supply now. The measured unit is the model request (decision 34), damping via
 * epochs (decision 35), backoff factor 0.75, K = 4, lastGood set only by completed streaks (decision 40).
 */

import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_DECREASE_FACTOR,
  CONCURRENCY_FLOOR,
  CONCURRENCY_IDLE_RESET_MS,
  CONCURRENCY_INCREASE_AFTER_SUCCESSES,
  ConcurrencyController,
} from "../../src/engine/index.js";

const KEY = "anthropic/claude";
const K = CONCURRENCY_INCREASE_AFTER_SUCCESSES;
const T0 = 1_000_000;

/** Admits n requests, returning their epoch. */
function admit(c: ConcurrencyController, n: number, now = T0): number[] {
  const epochs: number[] = [];
  for (let i = 0; i < n; i++) epochs.push(c.admitted(now));
  return epochs;
}

/** Admits n requests, succeeds them all in the current epoch; returns every change produced along the way. */
function roundTrip(c: ConcurrencyController, n: number, now = T0) {
  const changes = [];
  for (let i = 0; i < n; i++) {
    const epoch = c.admitted(now);
    changes.push(...c.succeeded(now, epoch));
  }
  return changes;
}

/** One current-epoch 429 (admit, then throttle). */
function throttleNow(
  c: ConcurrencyController,
  reason: "rate_limited" | "provider_overloaded" | "offpeak_queued" = "rate_limited",
  retryAfterMs?: number,
  now = T0,
) {
  const epoch = c.admitted(now);
  return c.throttled(now, epoch, reason, retryAfterMs);
}

describe("ConcurrencyController -- constants (decision 40)", () => {
  it("backs off by 0.75 with 4 successes per step", () => {
    expect(CONCURRENCY_DECREASE_FACTOR).toBe(0.75);
    expect(K).toBe(4);
  });
});

describe("ConcurrencyController -- decrease (decisions 4/6/11/35/40)", () => {
  it("floors current-epoch 429s to cap x 0.75 and rolls the epoch; repeated throttling descends to the floor of 1", () => {
    const c = new ConcurrencyController(KEY, 16);
    expect(c.snapshot().epoch).toBe(0);
    // Lowering the cap sets no lastGood (unproven); it records lastBad = the cap at the wall.
    expect(throttleNow(c)).toEqual([
      { key: KEY, previous: 16, next: 12, reason: "rate_limited", lastBad: 16 },
    ]);
    expect(c.snapshot()).toMatchObject({ epoch: 1, lastBad: 16 });
    expect(c.snapshot().lastGood).toBeUndefined();
    for (const expected of [9, 6, 4, 3, 2, 1]) {
      const [change] = throttleNow(c, "provider_overloaded");
      expect(change?.next).toBe(expected);
    }
    expect(c.snapshot()).toMatchObject({
      cap: CONCURRENCY_FLOOR,
      epoch: 7,
      inFlight: 0,
      lastBad: 2,
    });
    // Throttling at the floor: cap unchanged, no Retry-After -> no event, but the epoch still rolls
    expect(throttleNow(c)).toEqual([]);
    expect(c.snapshot().epoch).toBe(8);
  });

  it("decrements once and emits once for thirteen same-epoch 429s, clearing streaks and inFlight otherwise", () => {
    const c = new ConcurrencyController(KEY, 13);
    const epochs = admit(c, 13);
    expect(new Set(epochs)).toEqual(new Set([0]));
    expect(c.snapshot().inFlight).toBe(13);
    const changes = [];
    for (const epoch of epochs) changes.push(...c.throttled(T0, epoch, "rate_limited"));
    expect(changes).toEqual([
      { key: KEY, previous: 13, next: 9, reason: "rate_limited", lastBad: 13 },
    ]);
    expect(c.snapshot()).toMatchObject({ cap: 9, epoch: 1, inFlight: 0, successStreak: 0 });
  });

  it("leaves cap and events alone on stale-epoch 429s while clearing streak, cutting inFlight, refreshing cooldown", () => {
    const c = new ConcurrencyController(KEY, 8);
    const stale = admit(c, 3); // epoch 0
    throttleNow(c); // 8→6, epoch 1
    c.waiters(T0, 1);
    roundTrip(c, K - 1); // current-epoch successes: streak K-1, one short of cashing in
    expect(c.snapshot()).toMatchObject({ cap: 6, successStreak: K - 1, inFlight: 3 });
    expect(c.throttled(T0, stale[0]!, "rate_limited", 9_000)).toEqual([]);
    expect(c.snapshot()).toMatchObject({
      cap: 6,
      epoch: 1,
      successStreak: 0,
      inFlight: 2,
      cooldownUntil: T0 + 9_000,
    });
    // An earlier Retry-After never pulls cooldown earlier.
    expect(c.throttled(T0, stale[1]!, "rate_limited", 1_000)).toEqual([]);
    expect(c.snapshot().cooldownUntil).toBe(T0 + 9_000);
  });

  it("verdicts only on requests issued under the new cap: after stale-epoch 429s, a new-epoch 429 decrements again", () => {
    const c = new ConcurrencyController(KEY, 13);
    const stale = admit(c, 13);
    for (const epoch of stale) c.throttled(T0, epoch, "rate_limited"); // 13 to 9, once
    expect(c.snapshot().cap).toBe(9);
    expect(throttleNow(c)).toEqual([
      { key: KEY, previous: 9, next: 6, reason: "rate_limited", lastBad: 9 },
    ]);
  });

  it("freezes new admissions until the Retry-After deadline; floor-level throttling with one still emits", () => {
    const c = new ConcurrencyController(KEY, 4);
    const [change] = throttleNow(c, "rate_limited", 20_000);
    expect(change).toMatchObject({ previous: 4, next: 3, cooldownMs: 20_000 });
    expect(c.canAdmit(T0 + 19_999)).toBe(false);
    expect(c.canAdmit(T0 + 20_000)).toBe(true);
    throttleNow(c, "rate_limited", undefined, T0 + 20_000); // 3→2
    throttleNow(c, "rate_limited", undefined, T0 + 20_000); // 2→1
    expect(c.snapshot().cap).toBe(1);
    expect(throttleNow(c, "offpeak_queued", 5_000, T0 + 20_001)).toEqual([
      { key: KEY, previous: 1, next: 1, reason: "offpeak_queued", lastBad: 1, cooldownMs: 5_000 },
    ]);
  });

  it("makes canAdmit false at inFlight >= cap and true again after release", () => {
    const c = new ConcurrencyController(KEY, 2);
    const [a, b] = admit(c, 2);
    expect(c.canAdmit(T0)).toBe(false);
    c.succeeded(T0, a!);
    expect(c.canAdmit(T0)).toBe(true);
    c.ended(T0);
    expect(c.snapshot().inFlight).toBe(0);
    void b;
  });

  it("clears streak and cuts inFlight on transient non-throttle failures, cap untouched", () => {
    const c = new ConcurrencyController(KEY, 8);
    c.waiters(T0, 1);
    roundTrip(c, K - 1);
    admit(c, 1);
    expect(c.snapshot()).toMatchObject({ successStreak: K - 1, inFlight: 1 });
    expect(c.failedTransient(T0)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 8, successStreak: 0, inFlight: 0, epoch: 0 });
  });

  it("has ended only decrement inFlight", () => {
    const c = new ConcurrencyController(KEY, 8);
    c.waiters(T0, 1);
    roundTrip(c, K - 1);
    admit(c, 2);
    expect(c.ended(T0)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ successStreak: K - 1, inFlight: 1, cap: 8 });
  });
});

describe("ConcurrencyController -- increase (decisions 4/15/33/35/40)", () => {
  function lowered(): ConcurrencyController {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c); // cap 12, lastBad 16, no lastGood, epoch 1
    return c;
  }

  it("proves the current cap after K same-epoch successes (lastGood = cap), +1 only with waiters", () => {
    const c = lowered();
    c.waiters(T0, 1);
    expect(roundTrip(c, K - 1)).toEqual([]);
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(roundTrip(c, 1)).toEqual([
      { key: KEY, previous: 12, next: 13, reason: "recovered", lastGood: 12, lastBad: 16 },
    ]);
    expect(c.snapshot().successStreak).toBe(0);
  });

  it("accumulates streaks and proves lastGood without waiters but raises only once waiters appear", () => {
    const c = lowered();
    c.waiters(T0, 0);
    expect(roundTrip(c, K)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 12, successStreak: K, lastGood: 12 });
    c.waiters(T0, 1);
    expect(roundTrip(c, 1)[0]?.next).toBe(13);
  });

  it("excludes stale-epoch successes from the streak (draining the old batch proves nothing)", () => {
    const c = new ConcurrencyController(KEY, 32);
    c.waiters(T0, 3);
    const stale = admit(c, 32);
    c.throttled(T0, stale[0]!, "rate_limited"); // cap 24, epoch 1
    for (const epoch of stale.slice(1)) expect(c.succeeded(T0, epoch)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 24, successStreak: 0, inFlight: 0 });
    expect(c.snapshot().lastGood).toBeUndefined();
    // Only K new-epoch successes cash in.
    expect(roundTrip(c, K)[0]?.next).toBe(25);
  });

  it("never passes the ceiling; a full streak at the ceiling still proves it as lastGood", () => {
    const c = new ConcurrencyController(KEY, 2);
    throttleNow(c); // cap 1
    c.waiters(T0, 1);
    const changes = roundTrip(c, K * 3);
    expect(changes.map((x) => x.next)).toEqual([2]);
    expect(c.snapshot()).toMatchObject({ cap: 2, lastGood: 2 });
  });
});

describe("ConcurrencyController -- remembering the proven level (decisions 22/40)", () => {
  /** From cap 16 down to 12, then climbing to target (K successes per step). */
  function climbTo(target: number): ConcurrencyController {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c);
    c.waiters(T0, 1);
    while (c.snapshot().cap < target) roundTrip(c, K);
    return c;
  }

  it("falls back to lastGood above it, recording lastBad without the factor, still rolling the epoch", () => {
    const c = climbTo(14);
    expect(c.snapshot()).toMatchObject({ cap: 14, lastGood: 13, epoch: 1 });
    expect(throttleNow(c)).toEqual([
      { key: KEY, previous: 14, next: 13, reason: "rate_limited", lastGood: 13, lastBad: 14 },
    ]);
    expect(c.snapshot().epoch).toBe(2);
  });

  it("moves the wall when hit at or below lastGood: factor decrease, lastGood cleared as falsified, lastBad recorded", () => {
    const c = climbTo(14);
    throttleNow(c); // back to 13
    expect(throttleNow(c)).toEqual([
      { key: KEY, previous: 13, next: 9, reason: "rate_limited", lastBad: 13 },
    ]);
    expect(c.snapshot().lastGood).toBeUndefined();
  });

  it("needs K successes per step (K-1 falls short); a new cap must re-prove itself", () => {
    const c = climbTo(14);
    throttleNow(c); // 14 > lastGood 13 -> back to 13
    expect(throttleNow(c)[0]).toMatchObject({ previous: 13, next: 9 });
    expect(roundTrip(c, K - 1)).toEqual([]);
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(roundTrip(c, 1)[0]).toMatchObject({ next: 10, lastGood: 9 });
    const small = new ConcurrencyController(KEY, 6);
    throttleNow(small); // cap 4, lastBad 6
    small.waiters(T0, 1);
    roundTrip(small, K); // cap 5, lastGood 4
    roundTrip(small, K); // cap 6, lastGood 5
    throttleNow(small); // 6 > lastGood 5 -> back to 5, lastBad 6
    expect(small.snapshot()).toMatchObject({ cap: 5, lastGood: 5, lastBad: 6 });
  });

  it("true ceiling 5, cap 13: 13-429-9-429-6-429-4-5-6-429-5, settling at 5", () => {
    const c = new ConcurrencyController(KEY, 13);
    c.waiters(T0, 1);
    expect(throttleNow(c)[0]?.next).toBe(9);
    expect(throttleNow(c)[0]?.next).toBe(6);
    expect(throttleNow(c)[0]?.next).toBe(4);
    expect(roundTrip(c, K)[0]).toMatchObject({ next: 5, lastGood: 4 });
    expect(roundTrip(c, K)[0]).toMatchObject({ next: 6, lastGood: 5 });
    expect(throttleNow(c)[0]).toMatchObject({ previous: 6, next: 5, lastGood: 5, lastBad: 6 });
    // Afterwards each K successes probe 6, costing one 429 and falling back to 5.
    for (let round = 0; round < 3; round++) {
      expect(roundTrip(c, K)[0]?.next).toBe(6);
      expect(throttleNow(c)[0]).toMatchObject({ previous: 6, next: 5, lastBad: 6 });
    }
    expect(c.snapshot()).toMatchObject({ cap: 5, lastGood: 5, lastBad: 6 });
  });
});

describe("ConcurrencyController -- idle reset (decision 20)", () => {
  it("resets to the ceiling on any idle signal after 5 idle minutes with nothing in flight, clearing lastGood/lastBad/cooldown", () => {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c, "rate_limited", 60_000); // cap 12, epoch 1, inFlight 0
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.observe(later - 1)).toEqual([]);
    expect(c.observe(later)).toEqual([{ key: KEY, previous: 12, next: 16, reason: "idle_reset" }]);
    expect(c.snapshot()).toMatchObject({ cap: 16, successStreak: 0, epoch: 2 });
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(c.snapshot().lastBad).toBeUndefined();
    expect(c.snapshot().cooldownUntil).toBeUndefined();
    // Resets are idempotent: another idle signal emits nothing and rolls nothing.
    expect(c.observe(later + 1)).toEqual([]);
    expect(c.snapshot().epoch).toBe(2);
  });

  it("skips the reset while work is in flight", () => {
    const c = new ConcurrencyController(KEY, 16);
    admit(c, 1);
    throttleNow(c); // inFlight 1
    expect(c.observe(T0 + CONCURRENCY_IDLE_RESET_MS * 2)).toEqual([]);
    expect(c.snapshot().cap).toBe(12);
  });

  it("factors the first post-reset 429 (lastGood cleared); reset and throttle are two changes in one signal", () => {
    const c = new ConcurrencyController(KEY, 16);
    throttleNow(c);
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    // Governor admission path: observe (reset) -> admitted -> ...; this simulates a 429 skipping observe with a stale
    const epoch = c.admitted(T0);
    c.ended(T0);
    expect(c.throttled(later, epoch, "rate_limited")).toEqual([
      { key: KEY, previous: 12, next: 16, reason: "idle_reset" },
    ]);
    // The proper path: observe, admit, then throttle -- that is what judges the ceiling.
    expect(c.observe(later)).toEqual([]);
    expect(throttleNow(c, "rate_limited", undefined, later)).toEqual([
      { key: KEY, previous: 16, next: 12, reason: "rate_limited", lastBad: 16 },
    ]);
  });
});

describe("ConcurrencyController -- growth limit (docs/dynamic-workflow/concurrency.md, Increase and The governor)", () => {
  it("starts at initial, grows past it to growthLimit, and still proves growthLimit as lastGood", () => {
    const c = new ConcurrencyController(KEY, 4, 8);
    expect(c.snapshot()).toMatchObject({ initial: 4, growthLimit: 8, cap: 4 });
    c.waiters(T0, 1);
    const changes = roundTrip(c, K * 10);
    expect(changes.map((x) => x.next)).toEqual([5, 6, 7, 8]);
    expect(changes.every((x) => x.reason === "recovered")).toBe(true);
    expect(c.snapshot()).toMatchObject({ cap: 8, lastGood: 8 });
  });

  it("defaults growthLimit to initial: verbatim the old ceiling-is-the-cap behavior", () => {
    const c = new ConcurrencyController(KEY, 6);
    expect(c.snapshot()).toMatchObject({ initial: 6, growthLimit: 6 });
    c.waiters(T0, 1);
    expect(roundTrip(c, K * 3)).toEqual([]);
  });

  it("raises the growth limit without touching cap or emitting; cap climbs one step at a time after", () => {
    const c = new ConcurrencyController(KEY, 4, 8);
    expect(c.setGrowthLimit(T0, 20)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ growthLimit: 20, cap: 4 });
    c.waiters(T0, 1);
    expect(roundTrip(c, K * 20).map((x) => x.next)).toEqual(
      Array.from({ length: 16 }, (_, i) => 5 + i),
    );
    expect(c.snapshot().cap).toBe(20);
  });

  it("on lowering below cap: cap snaps to the new limit, limit_lowered emits, lastGood clamps, streak clears, epoch rolls", () => {
    const c = new ConcurrencyController(KEY, 4, 20);
    c.waiters(T0, 1);
    roundTrip(c, K * 12); // cap 16，lastGood 15
    expect(c.snapshot().cap).toBe(16);
    roundTrip(c, 2); // streak 2
    const stale = c.admitted(T0); // requests issued under the old cap
    const epochBefore = c.snapshot().epoch;
    expect(c.setGrowthLimit(T0, 8)).toEqual([
      { key: KEY, previous: 16, next: 8, reason: "limit_lowered", lastGood: 8 },
    ]);
    expect(c.snapshot()).toMatchObject({
      growthLimit: 8,
      cap: 8,
      lastGood: 8,
      successStreak: 0,
      epoch: epochBefore + 1,
    });
    // A 429 on those old-cap requests judges nothing about the new cap; no further decrease.
    expect(c.throttled(T0, stale, "rate_limited")).toEqual([]);
    expect(c.snapshot().cap).toBe(8);
  });

  it("lowers nothing when cap already sits at or below the new limit: no cap change, event, or epoch roll", () => {
    const c = new ConcurrencyController(KEY, 4, 20);
    const epoch = c.snapshot().epoch;
    expect(c.setGrowthLimit(T0, 8)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ growthLimit: 8, cap: 4, epoch });
  });

  it("never lets the growth limit drop below initial", () => {
    const c = new ConcurrencyController(KEY, 6, 12);
    expect(c.setGrowthLimit(T0, 2)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ growthLimit: 6, cap: 6 });
  });

  it("idle-resets to initial, not to the growth limit", () => {
    const c = new ConcurrencyController(KEY, 4, 8);
    c.waiters(T0, 1);
    roundTrip(c, K * 10); // cap 8
    c.waiters(T0, 0);
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.observe(later)).toEqual([{ key: KEY, previous: 8, next: 4, reason: "idle_reset" }]);
    expect(c.snapshot()).toMatchObject({ cap: 4, growthLimit: 8 });
    expect(c.snapshot().lastGood).toBeUndefined();
  });
});

describe("ConcurrencyController -- seeding straight to a higher bound (docs/dynamic-workflow/concurrency.md, Seeding)", () => {
  it("snaps cap to the target (never past the growth limit), emits seeded, clears lastGood and streak, rolls the epoch", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    c.waiters(T0, 1);
    roundTrip(c, K + 2); // cap 9，lastGood 8，streak 2
    const epoch = c.snapshot().epoch;
    expect(c.seed(T0, 32)).toEqual([{ key: KEY, previous: 9, next: 32, reason: "seeded" }]);
    expect(c.snapshot()).toMatchObject({ cap: 32, successStreak: 0, epoch: epoch + 1 });
    expect(c.snapshot().lastGood).toBeUndefined();
    expect(c.snapshot().lastBad).toBeUndefined();
  });

  it("caps the jump at the growth limit", () => {
    const c = new ConcurrencyController(KEY, 8, 20);
    expect(c.seed(T0, 50)).toEqual([{ key: KEY, previous: 8, next: 20, reason: "seeded" }]);
  });

  it("does nothing when the target is at or below cap", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    const epoch = c.snapshot().epoch;
    expect(c.seed(T0, 8)).toEqual([]);
    expect(c.seed(T0, 3)).toEqual([]);
    expect(c.snapshot()).toMatchObject({ cap: 8, epoch });
  });

  it("factors the first post-seed 429 (32 to 24) instead of falling back to the old lastGood", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    c.waiters(T0, 1);
    roundTrip(c, K); // lastGood 8
    c.seed(T0, 32);
    expect(throttleNow(c)).toEqual([
      { key: KEY, previous: 32, next: 24, reason: "rate_limited", lastBad: 32 },
    ]);
  });

  it("skips the seed on any 429 within five minutes, stale epoch included, and seeds after", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    const stale = c.admitted(T0);
    throttleNow(c); // current epoch: 8 to 6
    c.throttled(T0 + 1_000, stale, "rate_limited"); // stale epoch, still recently-throttled
    expect(c.snapshot().lastThrottledAt).toBe(T0 + 1_000);
    expect(c.seed(T0 + 2_000, 32)).toEqual([]);
    expect(c.snapshot().cap).toBe(6);
    // Work stays in flight so no idle reset; after five minutes the evidence expires and the seed goes.
    c.admitted(T0 + 1_000);
    const later = T0 + 1_000 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.seed(later, 32)).toEqual([{ key: KEY, previous: 6, next: 32, reason: "seeded" }]);
  });

  it("clear lastThrottledAt on idle reset", () => {
    const c = new ConcurrencyController(KEY, 8, 32);
    throttleNow(c);
    const later = T0 + CONCURRENCY_IDLE_RESET_MS;
    expect(c.observe(later)).toHaveLength(1);
    expect(c.snapshot().lastThrottledAt).toBeUndefined();
  });
});
