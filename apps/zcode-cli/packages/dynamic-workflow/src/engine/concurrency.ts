/**
  * Adaptive concurrency controller: a pure AIMD state machine over one provider key.
 *
  * Pure-package discipline: no clock reads, no IO -- now (ms since epoch) is always passed in; the class only answers
  * what-is-the-cap, may-this-admit, did-this-signal-move-the-cap. Who feeds signals and who queues (bootstrap's process-level
  * governor) live outside.
 *
  * The unit is the **model request** (each attempt): inFlight = admitted-not-yet-released requests.
  * No per-ask counting -- a subagent has one request in flight at a time; at-most-N-requests equals at-most-N-subagents.
 *
  * Batch damping via **epoch**: each admission records the then-current epoch; every verdict epoch += 1. A 429 judges the current cap only
  * if its request was issued under the **current** cap (same epoch); an old-epoch 429 judges a cap already
  * cut, so it only clears the streak and refreshes cooldown. Successes likewise: only current-epoch successes count into the streak.
 *
  * Signal methods return the cap changes this signal caused (usually 0 or 1; an idle reset followed by a verdict gives 2),
  * for the caller to fan out verbatim as concurrency-changed events.
 */

import type { ConcurrencyChange, ConcurrencyChangeReason } from "./types.js";

/**
  * On throttle: cap = max(FLOOR, floor(cap x 0.75)) (coefficient 0.5 -> 0.75):
  * halving overreacts to barely-over by one or two -- the gate is per-request; one 429 says the cap is high, rarely twice as high.
 */
export const CONCURRENCY_DECREASE_FACTOR = 0.75;
/** Additive-increase step. */
export const CONCURRENCY_INCREASE_STEP = 1;
/**
  * Consecutive successful requests K per +1. Single tier; lowered 40 -> 4:
  * a failed probe costs one request meeting one 429 then returning to lastGood (a proven level); 40 successes are too high a price
  * for one probe.
 */
export const CONCURRENCY_INCREASE_AFTER_SUCCESSES = 4;
/** Always keep at least one probe in flight. */
export const CONCURRENCY_FLOOR = 1;
/** After this idle (and none in flight), forget the learned cap; back to the ceiling. */
export const CONCURRENCY_IDLE_RESET_MS = 300_000;

/** Throttle-class reasons that may lower the cap. */
export type ConcurrencyThrottleReason = Extract<
  ConcurrencyChangeReason,
  "rate_limited" | "provider_overloaded" | "offpeak_queued"
>;

/** Read-only snapshot (for test assertions and the governor's run-header concurrency projection). */
export interface ConcurrencyControllerSnapshot {
  readonly key: string;
  readonly ceiling: number;
  readonly cap: number;
    /** Verdict counter; handed to the request on admission, brought back for comparison at completion. */
  readonly epoch: number;
  readonly inFlight: number;
  readonly waiters: number;
  readonly successStreak: number;
  readonly cooldownUntil?: number;
  readonly lastRequestAt?: number;
  readonly lastGood?: number;
  readonly lastBad?: number;
}

export class ConcurrencyController {
  private cap: number;
  private epoch = 0;
  private inFlight = 0;
  private waiters_ = 0;
  private successStreak = 0;
  private cooldownUntil?: number;
  private lastRequestAt?: number;
  private lastGood?: number;
  private lastBad?: number;

  /**
      * @param key the provider key (providerId/modelId), only to fill change events -- the controller itself
      *   is agnostic to it. A constructor param, not per-signal: one controller serves one key; that is identity, not configuration.
      * @param ceiling the CPU-derived ceiling: both initial value and upper bound.
   */
  constructor(
    readonly key: string,
    readonly ceiling: number,
  ) {
    this.cap = ceiling;
  }

  snapshot(): ConcurrencyControllerSnapshot {
    return {
      key: this.key,
      ceiling: this.ceiling,
      cap: this.cap,
      epoch: this.epoch,
      inFlight: this.inFlight,
      waiters: this.waiters_,
      successStreak: this.successStreak,
      ...(this.cooldownUntil === undefined ? {} : { cooldownUntil: this.cooldownUntil }),
      ...(this.lastRequestAt === undefined ? {} : { lastRequestAt: this.lastRequestAt }),
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
    };
  }

  /**
      * The gate (admission test): in-flight below cap and not in a Retry-After cooldown. Pure query, no idle reset --
      * the caller (governor) runs {@link observe} on the admission path first (admission is a signal too; the first
      * run after an idle hour must start from the ceiling at once).
   */
  canAdmit(now: number): boolean {
    return (
      this.inFlight < this.cap && (this.cooldownUntil === undefined || now >= this.cooldownUntil)
    );
  }

    /** The empty signal that only runs the idle-reset check (used pre-admission, before the observer admits). */
  observe(now: number): ConcurrencyChange[] {
    return this.idleReset(now);
  }

  /**
      * A request admitted: inFlight++, refresh lastRequestAt, return its epoch (brought back at completion).
      * No idle reset here -- the caller did it in {@link observe}; an admission just judged not-idle
      * cannot become idle.
   */
  admitted(now: number): number {
    this.lastRequestAt = now;
    this.inFlight += 1;
    return this.epoch;
  }

  /**
      * A request finished successfully: inFlight--; only a **current-epoch** success moves
      * successStreak -- an old-epoch success proves the load under the old cap with backoff damping, not that the new cap may rise.
      * successStreak at K **proves** the current cap: lastGood = max(lastGood, cap) (only a completed
      * streak sets lastGood; a reduction never does). With waiters **and** cap below ceiling -> +1.
      // Without waiters the streak still accumulates, unspent.
   */
  succeeded(now: number, epoch: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (epoch !== this.epoch) return changes;
    this.successStreak += 1;
    if (this.successStreak < CONCURRENCY_INCREASE_AFTER_SUCCESSES) return changes;
        // This level was proven by a whole streak -- regardless of anyone waiting to climb right now.
    if (this.lastGood === undefined || this.cap > this.lastGood) this.lastGood = this.cap;
    if (this.waiters_ <= 0 || this.cap >= this.ceiling) return changes;
    const previous = this.cap;
    this.cap = Math.min(this.ceiling, previous + CONCURRENCY_INCREASE_STEP);
    this.successStreak = 0;
    changes.push(this.change(previous, "recovered"));
    return changes;
  }

  /**
      * Throttled / overloaded. Always inFlight--, clear the streak; with Retry-After, push cooldown
      // to the later of the two.
   *
      * Only a 429 with epoch == current epoch moves the cap: it judged the cap it was issued under;
      // old-epoch 429s are ignored (no event). Current-epoch ones split in two: a probe throttled **above** lastGood -> return to
      // lastGood (record lastBad; no coefficient cut); otherwise (no lastGood, or cap at/below it: the wall moved) ->
      // cap = max(FLOOR, floor(cap x 0.75)), lastBad = old cap, and **clear** lastGood -- just falsified,
      // and the new cap is proven by no streak yet (a cut never sets lastGood). Afterwards epoch += 1 --
      // even at the floor with an unchanged number, turn the page: one batch of requests triggers one verdict.
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
        // At the floor with no Retry-After, nothing changed -- no event; a throttling with Retry-After must inform the run header
        // of cooling-until even when the cap stands, so any cooldownMs emits.
    if (previous === this.cap && cooldownMs === undefined) return changes;
    changes.push(this.change(previous, reason, cooldownMs));
    return changes;
  }

    /** Transient non-throttle failure (timeout / 5xx / network): inFlight--, clear streak, cap unchanged. */
  failedTransient(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    return changes;
  }

    /** A request ended in permanent failure / cancellation, or the ticket saw only release: inFlight-- only. */
  ended(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    return changes;
  }

    /** Waiter count fed by the governor on queue changes (cap rises only on demand). */
  waiters(now: number, count: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.waiters_ = Math.max(0, count);
    return changes;
  }

    // --------------------------------- internal ---------------------------------

  /**
      * Idle reset: now - lastRequestAt at/after IDLE_RESET_MS and none in flight -> cap to ceiling,
      // clear streak / cooldown / lastGood / lastBad, epoch += 1. Lazy, on any signal (no timers).
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
        // Idempotent: at ceiling with clean state, do nothing (else every idle signal turns the epoch page).
    if (
      previous === this.ceiling &&
      this.successStreak === 0 &&
      this.cooldownUntil === undefined &&
      this.lastGood === undefined &&
      this.lastBad === undefined
    ) {
      return [];
    }
    this.cap = this.ceiling;
    this.successStreak = 0;
    this.cooldownUntil = undefined;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.epoch += 1;
        // lastRequestAt kept: a still-idle later signal must not reset again; state is already at ceiling.
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
