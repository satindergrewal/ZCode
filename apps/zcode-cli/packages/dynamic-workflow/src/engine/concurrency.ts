/**
 * Adaptive-concurrency controller: a pure AIMD state machine per provider key.
 *
 * Pure-package discipline: no clock, no IO - now (ms since epoch) is always caller-supplied; the
 * class only answers "what is the cap, may this admit, did this signal move the cap". Who feeds
 * signals and who queues (bootstrap's process governor) live outside.
 *
 * The unit is the model request (per attempt): inFlight = admitted, not-yet-released requests.
 * No per-ask count - a subagent has one request in flight at a time; <=N requests equals <=N subagents running.
 *
 * Batch damping via epoch: admission records the epoch; each throttle verdict increments it. A 429
 * judges the current cap only if its request was sent under it (same epoch); an old-epoch 429
 * judges a since-cut cap - clear streak, refresh cooldown, nothing else. Successes likewise: only
 * current-epoch successes count into the streak.
 *
 * Signal methods return the cap changes this signal caused (0 or 1; 2 when an idle reset meets a throttle), fanned out verbatim as concurrency-changed.
 */

import type { ConcurrencyChange, ConcurrencyChangeReason } from "./types.js";

/**
 * Throttle: cap = max(FLOOR, floor(cap * 0.75)) (coefficient raised from 0.5): halving overreacted
 * to barely-over by one or two - the gate is per request; one 429 says too high, rarely 2x.
 */
export const CONCURRENCY_DECREASE_FACTOR = 0.75;
/** Additive-increase step. */
export const CONCURRENCY_INCREASE_STEP = 1;
/**
 * K, consecutive successful requests per +1. Single tier; lowered 40 -> 4: a failed probe costs one
 * 429 then back to lastGood (the proven level) - not worth 40 successes per probe.
 */
export const CONCURRENCY_INCREASE_AFTER_SUCCESSES = 4;
/** Always keep at least one probe running. */
export const CONCURRENCY_FLOOR = 1;
/** Forget a key's learned cap after this idle (and no in-flight), back to initial (decision 20). */
export const CONCURRENCY_IDLE_RESET_MS = 300_000;

/** Throttle-class reasons that reduce the cap. */
export type ConcurrencyThrottleReason = Extract<
  ConcurrencyChangeReason,
  "rate_limited" | "provider_overloaded" | "offpeak_queued"
>;

/** Read-only snapshot (test assertions; the governor's run-header concurrency projection). */
export interface ConcurrencyControllerSnapshot {
  readonly key: string;
  /// Floor and idle-reset target: default concurrency D.
  readonly initial: number;
  /// Auto-growth ceiling (governor-set, movable anytime; always >= initial).
  readonly growthLimit: number;
  readonly cap: number;
  /// Throttle-verdict counter; issued at admission, returned at completion for the epoch test.
  readonly epoch: number;
  readonly inFlight: number;
  readonly waiters: number;
  readonly successStreak: number;
  readonly cooldownUntil?: number;
  readonly lastRequestAt?: number;
  readonly lastGood?: number;
  readonly lastBad?: number;
  /// Last rejection at any epoch; within five minutes it blocks seeding (ConcurrencyController.seed).
  readonly lastThrottledAt?: number;
}

export class ConcurrencyController {
  private cap: number;
  private growthLimit_: number;
  private epoch = 0;
  private inFlight = 0;
  private waiters_ = 0;
  private successStreak = 0;
  private cooldownUntil?: number;
  private lastRequestAt?: number;
  private lastGood?: number;
  private lastBad?: number;
  private lastThrottledAt?: number;

  /**
   * @param key provider key (providerId/modelId), only to stamp change events - the controller is
   *   agnostic to it. A constructor arg, not per-signal: one controller serves one key; identity, not parameter.
   * @param initial default concurrency D
   *   (docs/dynamic-workflow/concurrency.md "Two bounds on a run"): the cap's floor and the
   *   idle-reset target. Not a ceiling.
   * @param growthLimit auto-growth ceiling; default initial (the legacy caps-at-start behavior).
   *   The governor sets max(2D, largest cap of runs using this key) and moves it via setGrowthLimit.
   */
  constructor(
    readonly key: string,
    readonly initial: number,
    growthLimit: number = initial,
  ) {
    this.cap = initial;
    this.growthLimit_ = Math.max(initial, growthLimit);
  }

  snapshot(): ConcurrencyControllerSnapshot {
    return {
      key: this.key,
      initial: this.initial,
      growthLimit: this.growthLimit_,
      cap: this.cap,
      epoch: this.epoch,
      inFlight: this.inFlight,
      waiters: this.waiters_,
      successStreak: this.successStreak,
      ...(this.cooldownUntil === undefined ? {} : { cooldownUntil: this.cooldownUntil }),
      ...(this.lastRequestAt === undefined ? {} : { lastRequestAt: this.lastRequestAt }),
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
      ...(this.lastThrottledAt === undefined ? {} : { lastThrottledAt: this.lastThrottledAt }),
    };
  }

  /**
   * Gate (admission test): in-flight below cap and not in Retry-After cooldown. Pure query, no
   * idle reset - callers run {@link observe} on the admission path first (admission is a signal
   * too; the first run after an idle hour must start from initial, decision 20).
   */
  canAdmit(now: number): boolean {
    return (
      this.inFlight < this.cap && (this.cooldownUntil === undefined || now >= this.cooldownUntil)
    );
  }

  /** Empty signal running only the idle-reset check (pre-admission, before the observer passes). */
  observe(now: number): ConcurrencyChange[] {
    return this.idleReset(now);
  }

  /**
   * Admit one request: inFlight++, refresh lastRequestAt, return its epoch (returned at completion).
   * No idle reset here - the caller did it in observe; a just-admitted not-idle state cannot turn
   * idle between the two calls.
   */
  admitted(now: number): number {
    this.lastRequestAt = now;
    this.inFlight += 1;
    return this.epoch;
  }

  /**
   * A request succeeded: inFlight--; only current-epoch successes raise successStreak - old-epoch
   * successes prove the backoff-suppressed load under the old cap, not that the new cap may rise.
   * streak >= K PROVES the current cap: lastGood = max(lastGood, cap) (decision 40: completed
   * streaks set lastGood, reductions do not). Plus waiters AND cap < growthLimit -> +1.
   * Without waiters the streak accrues unspent (decision 15).
   */
  succeeded(now: number, epoch: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (epoch !== this.epoch) return changes;
    this.successStreak += 1;
    if (this.successStreak < CONCURRENCY_INCREASE_AFTER_SUCCESSES) return changes;
    // This level is proven by the whole streak - regardless of anyone waiting to climb now.
    if (this.lastGood === undefined || this.cap > this.lastGood) this.lastGood = this.cap;
    if (this.waiters_ <= 0 || this.cap >= this.growthLimit_) return changes;
    const previous = this.cap;
    this.cap = Math.min(this.growthLimit_, previous + CONCURRENCY_INCREASE_STEP);
    this.successStreak = 0;
    changes.push(this.change(previous, "recovered"));
    return changes;
  }

  /**
   * Throttled/overloaded. Always inFlight--, clear the streak; with Retry-After, cooldown takes
   * the later of the two.
   *
   * Only a 429 with epoch == current moves the cap: it flew under this cap and judges it;
   * old-epoch 429s are ignored (no event). Current-epoch has two branches: probing above lastGood
   * throttled -> fall back to lastGood (record lastBad; no coefficient cut); else (no lastGood, or
   * cap <= lastGood: the wall moved) -> cap = max(FLOOR, floor(cap*0.75)), lastBad = old cap, and
   * CLEAR lastGood - just falsified; the new cap is unproven (reductions set no lastGood). Either
   * way epoch += 1 - even unchanged at the floor: one verdict per batch.
   */
  throttled(
    now: number,
    epoch: number,
    reason: ConcurrencyThrottleReason,
    retryAfterMs?: number,
  ): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    // Old-epoch rejections still record: they judge no cap, but prove the provider is at the wall now (seeding reads it).
    this.lastThrottledAt = now;
    const cooldownMs = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : undefined;
    if (cooldownMs !== undefined) {
      this.cooldownUntil = Math.max(this.cooldownUntil ?? 0, now + cooldownMs);
    }
    if (epoch !== this.epoch) return changes;

    const previous = this.cap;
    if (this.lastGood !== undefined && this.cap > this.lastGood) {
      this.lastBad = this.cap;
      this.cap = this.lastGood;
    } else {
      this.cap = Math.max(CONCURRENCY_FLOOR, Math.floor(this.cap * CONCURRENCY_DECREASE_FACTOR));
      this.lastBad = previous;
      this.lastGood = undefined;
    }
    this.epoch += 1;
    // At-floor without Retry-After truly changes nothing: no event. A Retry-After throttle moves
    // the run header's cooldown-to even at an unchanged cap, so cooldownMs always emits.
    if (previous === this.cap && cooldownMs === undefined) return changes;
    changes.push(this.change(previous, reason, cooldownMs));
    return changes;
  }

  /** Transient non-throttle failure (timeout/5xx/network): inFlight--, clear the streak; cap unmoved. */
  failedTransient(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    return changes;
  }

  /** Request ended permanent-fail/cancel, or a release with no terminal event: inFlight-- only. */
  ended(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    return changes;
  }

  /** Waiter count fed by the governor on queue changes (cap grows only under demand). */
  waiters(now: number, count: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.waiters_ = Math.max(0, count);
    return changes;
  }

  /**
   * Move the auto-growth ceiling (docs/dynamic-workflow/concurrency.md "Increase"): the one number
   * not the controller's own. The governor sets max(2D, largest cap among this key's live runs);
   * runs coming and going and retunes move it. Clamped >= always.
   * Raising changes nothing at once: the cap keeps climbing stepwise. Lowering below cap pulls the
   * cap to the new ceiling at once with one limit_lowered - else a high cap learned for a big run
   * leaks to later default runs until the idle reset. Also clamp lastGood, clear the streak, bump
   * epoch: 429s flown under the old cap judge nothing about the new one.
   */
  setGrowthLimit(now: number, limit: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.growthLimit_ = Math.max(this.initial, Math.floor(limit));
    if (this.cap <= this.growthLimit_) return changes;
    const previous = this.cap;
    this.cap = this.growthLimit_;
    if (this.lastGood !== undefined && this.lastGood > this.cap) this.lastGood = this.cap;
    this.successStreak = 0;
    this.epoch += 1;
    changes.push(this.change(previous, "limit_lowered"));
    return changes;
  }

  /**
   * Seed (docs/dynamic-workflow/concurrency.md "Seeding"): when the user raises a run's cap, the
   * governor jumps the cap to min(target, growthLimit) instead of climbing K successes per step -
   * 8 to 32 is ~96 successes; users would see "the setting did nothing".
   *
   * Clear lastGood: the seed is a new floor, not a probe above the proven level; else the first
   * 429 falls back to the old proven level instead of the coefficient cut (32 -> 24 -> 18...).
   * Also clear lastBad and the streak; bump the epoch.
   *
   * No-seed cases: target <= cap; or any rejection within five minutes (the idle-reset window) -
   * seeding then would charge the just-hit wall; the cap climbs stepwise as usual instead.
   */
  seed(now: number, target: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    const next = Math.min(this.growthLimit_, Math.floor(target));
    if (next <= this.cap) return changes;
    if (
      this.lastThrottledAt !== undefined &&
      now - this.lastThrottledAt < CONCURRENCY_IDLE_RESET_MS
    ) {
      return changes;
    }
    const previous = this.cap;
    this.cap = next;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.successStreak = 0;
    this.epoch += 1;
    changes.push(this.change(previous, "seeded"));
    return changes;
  }

  // —————————————— internal ——————————————
  /**
   * Idle reset (decision 20): now - lastRequestAt >= IDLE_RESET_MS and none in flight -> cap
   * back to initial; clear streak/cooldown/lastGood/lastBad; epoch += 1. Lazy on any signal.
   */
  private idleReset(now: number): ConcurrencyChange[] {
    if (
      this.lastRequestAt === undefined ||
      this.inFlight !== 0 ||
      now - this.lastRequestAt < CONCURRENCY_IDLE_RESET_MS
    ) {
      return [];
    }
    const previous = this.cap;
    // Idempotent: already at floor and clean does nothing (else every idle signal turns the page).
    if (
      previous === this.initial &&
      this.successStreak === 0 &&
      this.cooldownUntil === undefined &&
      this.lastGood === undefined &&
      this.lastBad === undefined &&
      this.lastThrottledAt === undefined
    ) {
      return [];
    }
    this.cap = this.initial;
    this.successStreak = 0;
    this.cooldownUntil = undefined;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.lastThrottledAt = undefined;
    this.epoch += 1;
    // lastRequestAt kept: a still-idle next signal must not reset again; the state is at floor anyway.
    return previous === this.cap ? [] : [this.change(previous, "idle_reset")];
  }

  private change(
    previous: number,
    reason: ConcurrencyChangeReason,
    cooldownMs?: number,
  ): ConcurrencyChange {
    return {
      key: this.key,
      previous,
      next: this.cap,
      reason,
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    };
  }
}
