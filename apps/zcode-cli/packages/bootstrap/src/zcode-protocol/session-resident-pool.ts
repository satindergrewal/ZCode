// The CLI session resident pool.
//
// A capacity/lifecycle controller, not the owner of session content. The host provides the current resident registry, synchronous
// safety facts, and the deactivation surface; the pool maintains only idle TTL, LRU touch, operation leases, and
// deactivation gate。

export const DEFAULT_SESSION_RESIDENT_TARGET_COUNT = 8;
export const DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT = 16;
export const DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

export type SessionDeactivationReason = "high_water_lru" | "idle_timeout";

export interface SessionDeactivationDecision {
  highWaterCount: number;
  idleMs: number;
  idleTimeoutMs: number;
  reason: SessionDeactivationReason;
  residentCountBefore: number;
  targetCount: number;
}

export interface SessionResidencyFacts {
  persisted: boolean;
  hasResidencyBlockingWork: boolean;
  hasPendingInteractions: boolean;
  hasQueuedCommands: boolean;
  hasSubscribers: boolean;
  hasLegacySubscriber: boolean;
  lastActivityAt: number;
}

export interface SessionResidentPoolHost {
  listSessionIds(): string[];
  readResidencyFacts(sessionId: string): SessionResidencyFacts | null;
  /**
      * The first synchronous slice must remove the session from the resident registry; the returned Promise waits only for
      * async wind-down such as app.close.
   */
  deactivate(sessionId: string): Promise<void>;
  onDeactivated?(sessionId: string, decision: SessionDeactivationDecision): void;
  onError?(sessionId: string, error: unknown, decision: SessionDeactivationDecision): void;
}

export interface SessionResidentPoolOptions {
  highWaterCount?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  targetCount?: number;
}

interface ResidencyCandidate {
  eligibleSinceAt: number;
  lastUsedAt: number;
  sessionId: string;
}

export class SessionResidentPool {
  private readonly highWaterCount: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly targetCount: number;
  private readonly eligibleSinceAt = new Map<string, number>();
  private readonly lastTouchedAt = new Map<string, number>();
  private readonly operationLeaseCounts = new Map<string, number>();
  private readonly inFlightDeactivations = new Map<string, Promise<void>>();
  private activeOperationCount = 0;
  private rebalancing = false;

  constructor(
    private readonly host: SessionResidentPoolHost,
    options: SessionResidentPoolOptions = {},
  ) {
    const targetCount = options.targetCount ?? DEFAULT_SESSION_RESIDENT_TARGET_COUNT;
    const highWaterCount = options.highWaterCount ?? DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS;
    if (!Number.isInteger(targetCount) || targetCount < 0) {
      throw new RangeError("session resident targetCount must be a non-negative integer");
    }
    if (!Number.isInteger(highWaterCount) || highWaterCount < targetCount) {
      throw new RangeError(
        "session resident highWaterCount must be an integer greater than or equal to targetCount",
      );
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
      throw new RangeError("session resident idleTimeoutMs must be a non-negative number");
    }
    this.targetCount = targetCount;
    this.highWaterCount = highWaterCount;
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  /**
      * Acquires the protocol-request lease. A process-wide count keeps async workspace operations and the sampler's
      * reclamation from racing across sessions; the per-session count expresses exact ownership and feeds that session's eligibility.
   */
  async acquireOperation(
    sessionIdsInput?: string | readonly string[],
  ): Promise<() => void> {
    const sessionIds = [
      ...new Set(
        (typeof sessionIdsInput === "string" ? [sessionIdsInput] : sessionIdsInput ?? []).filter(
          (sessionId) => sessionId.length > 0,
        ),
      ),
    ];
    this.activeOperationCount += 1;
    for (const sessionId of sessionIds) {
      this.operationLeaseCounts.set(
        sessionId,
        (this.operationLeaseCounts.get(sessionId) ?? 0) + 1,
      );
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const sessionId of sessionIds) {
        this.touch(sessionId);
        const next = (this.operationLeaseCounts.get(sessionId) ?? 1) - 1;
        if (next <= 0) this.operationLeaseCounts.delete(sessionId);
        else this.operationLeaseCounts.set(sessionId, next);
      }
      this.activeOperationCount = Math.max(0, this.activeOperationCount - 1);
      this.rebalance();
    };

    try {
      for (const sessionId of sessionIds) {
        await this.waitForDeactivation(sessionId);
        this.touch(sessionId);
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  touch(sessionId: string, usedAt = this.now()): void {
    if (!Number.isFinite(usedAt)) return;
    const previous = this.lastTouchedAt.get(sessionId);
    if (previous === undefined || usedAt > previous) {
      this.lastTouchedAt.set(sessionId, usedAt);
    }
        // The idle TTL means "continuous idle since last use": once a protocol request reuses the session the
        // clock restarts -- never keep an eligible window that was about to expire before the touch.
    this.eligibleSinceAt.delete(sessionId);
  }

    /** The TTL / high-low watermark convergence entry shared by the sampler and request-release. */
  rebalance(): void {
    if (this.activeOperationCount > 0 || this.rebalancing) return;
    this.rebalancing = true;
    try {
      const observedAt = this.now();
      const initialResidentIds = this.host.listSessionIds();
      this.pruneMetadata(new Set(initialResidentIds));
      const initialCandidates = this.readCandidates(initialResidentIds, observedAt);
      const expiredCandidates = initialCandidates
        .filter((candidate) => observedAt - candidate.eligibleSinceAt >= this.idleTimeoutMs)
        .sort(
          (left, right) =>
            left.eligibleSinceAt - right.eligibleSinceAt ||
            left.lastUsedAt - right.lastUsedAt ||
            left.sessionId.localeCompare(right.sessionId),
        );

      let residentCount = initialResidentIds.length;
      for (const candidate of expiredCandidates) {
        if (this.activeOperationCount > 0) break;
                // Between candidate collection and execution, re-subscribes or background tasks may appear; even an expired TTL must not bypass
                // the fresh-facts and eligibleSince re-checks.
        const freshFacts = this.host.readResidencyFacts(candidate.sessionId);
        if (!freshFacts || !this.isEligible(candidate.sessionId, freshFacts)) {
          this.eligibleSinceAt.delete(candidate.sessionId);
          continue;
        }
        const eligibleSinceAt = this.eligibleSinceAt.get(candidate.sessionId);
        if (eligibleSinceAt === undefined || observedAt - eligibleSinceAt < this.idleTimeoutMs) {
          continue;
        }
        const decision = this.createDecision(
          "idle_timeout",
          residentCount,
          observedAt - eligibleSinceAt,
        );
        if (this.executeDeactivation(candidate.sessionId, decision)) {
          residentCount -= 1;
        }
      }

      const remainingResidentIds = this.host.listSessionIds();
      residentCount = remainingResidentIds.length;
      if (residentCount <= this.highWaterCount) return;

      const highWaterCandidates = this.readCandidates(remainingResidentIds, observedAt).sort(
        (left, right) =>
          left.lastUsedAt - right.lastUsedAt || left.sessionId.localeCompare(right.sessionId),
      );

      for (const candidate of highWaterCandidates) {
        if (residentCount <= this.targetCount || this.activeOperationCount > 0) break;
                // New facts (subscriptions/background tasks) may appear between candidate collection and execution. Re-read before acting:
                // a stale LRU snapshot must never cancel a running session.
        const freshFacts = this.host.readResidencyFacts(candidate.sessionId);
        if (!freshFacts || !this.isEligible(candidate.sessionId, freshFacts)) {
          this.eligibleSinceAt.delete(candidate.sessionId);
          continue;
        }
        const eligibleSinceAt = this.eligibleSinceAt.get(candidate.sessionId) ?? observedAt;
        const decision = this.createDecision(
          "high_water_lru",
          residentCount,
          observedAt - eligibleSinceAt,
        );
        if (this.executeDeactivation(candidate.sessionId, decision)) {
          residentCount -= 1;
        }
      }
    } finally {
      this.rebalancing = false;
    }
  }

  waitForDeactivation(sessionId: string): Promise<void> {
    return this.inFlightDeactivations.get(sessionId) ?? Promise.resolve();
  }

  private isEligible(sessionId: string, facts: SessionResidencyFacts): boolean {
    return (
      facts.persisted &&
      !facts.hasResidencyBlockingWork &&
      !facts.hasPendingInteractions &&
      !facts.hasQueuedCommands &&
      !facts.hasSubscribers &&
      !facts.hasLegacySubscriber &&
      (this.operationLeaseCounts.get(sessionId) ?? 0) === 0 &&
      !this.inFlightDeactivations.has(sessionId)
    );
  }

  private readCandidates(sessionIds: readonly string[], observedAt: number): ResidencyCandidate[] {
    const candidates: ResidencyCandidate[] = [];
    for (const sessionId of sessionIds) {
      const facts = this.host.readResidencyFacts(sessionId);
      if (!facts || !this.isEligible(sessionId, facts)) {
        this.eligibleSinceAt.delete(sessionId);
        continue;
      }
      let eligibleSinceAt = this.eligibleSinceAt.get(sessionId);
      if (eligibleSinceAt === undefined) {
        eligibleSinceAt = observedAt;
        this.eligibleSinceAt.set(sessionId, eligibleSinceAt);
      }
      candidates.push({
        eligibleSinceAt,
        lastUsedAt: Math.max(
          facts.lastActivityAt,
          this.lastTouchedAt.get(sessionId) ?? Number.NEGATIVE_INFINITY,
        ),
        sessionId,
      });
    }
    return candidates;
  }

  private createDecision(
    reason: SessionDeactivationReason,
    residentCountBefore: number,
    idleMs: number,
  ): SessionDeactivationDecision {
    return {
      highWaterCount: this.highWaterCount,
      idleMs: Math.max(0, idleMs),
      idleTimeoutMs: this.idleTimeoutMs,
      reason,
      residentCountBefore,
      targetCount: this.targetCount,
    };
  }

  private executeDeactivation(sessionId: string, decision: SessionDeactivationDecision): boolean {
    let pending: Promise<void>;
    try {
      pending = this.host.deactivate(sessionId);
    } catch (error) {
      this.host.onError?.(sessionId, error, decision);
      return false;
    }

    const tracked = pending
      .then(() => this.host.onDeactivated?.(sessionId, decision))
      .catch((error: unknown) => this.host.onError?.(sessionId, error, decision))
      .finally(() => {
        if (this.inFlightDeactivations.get(sessionId) === tracked) {
          this.inFlightDeactivations.delete(sessionId);
        }
      });
    this.inFlightDeactivations.set(sessionId, tracked);
    this.eligibleSinceAt.delete(sessionId);
    this.lastTouchedAt.delete(sessionId);
    return true;
  }

  private pruneMetadata(residentIds: ReadonlySet<string>): void {
    for (const sessionId of this.lastTouchedAt.keys()) {
      if (
        !residentIds.has(sessionId) &&
        !this.inFlightDeactivations.has(sessionId) &&
        !this.operationLeaseCounts.has(sessionId)
      ) {
        this.lastTouchedAt.delete(sessionId);
      }
    }
    for (const sessionId of this.eligibleSinceAt.keys()) {
      if (!residentIds.has(sessionId) && !this.inFlightDeactivations.has(sessionId)) {
        this.eligibleSinceAt.delete(sessionId);
      }
    }
  }
}
