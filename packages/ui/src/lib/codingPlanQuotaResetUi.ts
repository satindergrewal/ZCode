import type {
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  UsageQuotaLimit,
} from "@zcode/shared";

// Duration for the bar animating from current usage back to 100%; keeps the existing 500ms ease-out.
export const CODING_PLAN_QUOTA_RESET_PROGRESS_DURATION_MS = 500;
// How long the post-completion "quota reset" notice stays before auto-dismissing (bar stays at 100%).
export const CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS = 2_600;
// Auto/ops resets synthesize a brief resetting phase on the composer trigger, then switch to reset-done.
// The backend has no processing signal; this recreates the processing->done look client-side, once.
export const CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS = 1_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// Optimistically rewrite "next reset time" after completion: 5h quota by 5 hours, weekly by 7 days.
export function resolveCodingPlanQuotaResetDurationMs(resetType: CodingPlanResetType): number {
  return resetType === "WEEK" ? WEEK_MS : FIVE_HOURS_MS;
}

// available: the server granted a usable 5-hour reset opportunity.
// processing: a manual redemption is in flight, awaiting the use + status reconciliation.
// completed: status has returned the server used_at; automatic/operational resets skip processing.
export type CodingPlanQuotaResetUiStatus = "available" | "processing" | "completed";

export interface CodingPlanQuotaResetUiEntry {
  status: CodingPlanQuotaResetUiStatus;
  /** Remaining reset chances; completed carries the same status snapshot's leftovers, processing keeps the pre-click snapshot. */
  opportunityCount: number;
  /** Earliest reset-opportunity expiry; null when none remain. */
  opportunityExpiresAt: number | null;
  /** When the local manual redemption started; null for automatic/operational resets. */
  startedAt: number | null;
  /** Server latest_{five_hour,week}_reset_history.used_at. */
  completedAt: number | null;
  /** When the client first observed the current completedAt; used only for the toast/animation. */
  observedAt: number | null;
  /** Allows temporarily overriding quota to 100% until the entitlement refresh succeeds. */
  quotaOverridePending: boolean;
  nextResetAt: number | null;
  /** Idempotency key reused across retries of the same failure; cleared after reconciliation. */
  idempotencyKey: string | null;
  error: string | null;
}

export interface CodingPlanQuotaResetCelebrationState {
  sourceKey: string | null;
  /** Confetti already thrown for this used_at; one completion must never replay across renders/polls. */
  celebratedCompletedAt: number | null;
}

/** Per-source reset state, kept separate for the 5-hour and weekly quotas. */
export interface CodingPlanQuotaResetUiEntries {
  fiveHour: CodingPlanQuotaResetUiEntry | null;
  week: CodingPlanQuotaResetUiEntry | null;
}

/** One reset state machine serves both 5-hour/weekly quotas, branching only when reading opportunity/history fields. */
export const CODING_PLAN_QUOTA_RESET_TYPES = [
  "FIVE_HOUR",
  "WEEK",
] as const satisfies readonly CodingPlanResetType[];

export function advanceCodingPlanQuotaResetCelebration(
  previous: CodingPlanQuotaResetCelebrationState | null,
  input: {
    sourceKey: string | null;
    completedAt: number | null;
    /** Toast window for automatic/operational completions (startedAt null); manual resets celebrate via their own button. */
    automaticCompletion: boolean;
  },
): {
  state: CodingPlanQuotaResetCelebrationState;
  shouldCelebrate: boolean;
} {
  // Manual redemption also passes through processing, so seen-processing alone must not trigger the confetti --
  // manual resets would animate both button and trigger. The trigger honors only a new used_at from an auto completion;
  // clear the trail on source switch so Team/personal plans neither double-fire nor miss the auto-reset animation.
  const sourceChanged = previous?.sourceKey !== input.sourceKey;
  const celebratedCompletedAt = sourceChanged ? null : (previous?.celebratedCompletedAt ?? null);
  const shouldCelebrate = Boolean(
    input.sourceKey &&
    input.automaticCompletion &&
    input.completedAt !== null &&
    input.completedAt !== celebratedCompletedAt,
  );

  return {
    state: {
      sourceKey: input.sourceKey,
      celebratedCompletedAt: shouldCelebrate ? input.completedAt : celebratedCompletedAt,
    },
    shouldCelebrate,
  };
}

function createAvailableEntry(
  opportunityCount: number,
  opportunityExpiresAt: number,
  idempotencyKey: string | null,
): CodingPlanQuotaResetUiEntry {
  return {
    status: "available",
    opportunityCount,
    opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey,
    error: null,
  };
}

function createCompletedEntry(
  previous: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
  observedAt: number,
  manualStartedAt: number | null,
  nextResetMs: number,
  remainingOpportunities: ReadonlyArray<{ expireAt: number }>,
): CodingPlanQuotaResetUiEntry {
  const isSameCompletion = previous?.status === "completed" && previous.completedAt === completedAt;
  return {
    status: "completed",
    // Bugfix: the completed state used to zero chance count/expiry. With multiple chances of one kind, after redeeming one the rest wait
    // for the next status flip to available: meanwhile the dialog row rendered an empty expiry as expires in 0m 0s
    // and a re-click was silently ignored by reset(), recoverable only by reopening. Completion and remaining chances are two
    // orthogonal facets of one status snapshot; keep the remaining valid chances as-is (caller sorts by expiry),
    // and re-redeemability is judged solely by hasUsableCodingPlanQuotaResetOpportunity.
    opportunityCount: remainingOpportunities.length,
    opportunityExpiresAt: remainingOpportunities[0]?.expireAt ?? null,
    // Bugfix: manual clicks and completion history can be observed from different surfaces. Trusting only the current source's
    // processing made the composer misread a settings-initiated manual reset as auto, duplicating tooltip+confetti.
    // Reconciling the same completion twice must keep the original class, never degrade to auto on the next poll.
    startedAt: isSameCompletion
      ? previous.startedAt
      : previous?.status === "processing"
        ? previous.startedAt
        : manualStartedAt,
    completedAt,
    // Auto/ops resets may be observed up to 60s after used_at.
    // The short notice counts from first observation; repeat polls of the same used_at must not extend it.
    observedAt: isSameCompletion ? (previous.observedAt ?? observedAt) : observedAt,
    quotaOverridePending: isSameCompletion ? previous.quotaOverridePending : true,
    nextResetAt: completedAt + nextResetMs,
    idempotencyKey: null,
    error: null,
  };
}

/**
 * Apply a server status snapshot to the window-shared UI state.
 *
 * Old history with has_unread_history=false must not enter completed on first mount, or the
 * client would overwrite a hours-old historical reset with a current 100% remaining bar.
 *
 * resetType picks five-hour vs weekly chances/history. has_unread_history is a single cursor shared by both reset
 * kinds, so only the newest-used_at kind owns the unread flag; otherwise one weekly
 * reset misreads expired five-hour history as just-completed, and vice versa.
 */
export function applyCodingPlanQuotaResetStatus(
  previous: CodingPlanQuotaResetUiEntry | null,
  status: CodingPlanResetStatusSnapshot,
  now: number,
  manualStartedAt: number | null = null,
  resetType: CodingPlanResetType = "FIVE_HOUR",
): CodingPlanQuotaResetUiEntry | null {
  const availableResets =
    resetType === "WEEK" ? status.availableWeekResets : status.availableFiveHourResets;
  const latestUsedAt =
    (resetType === "WEEK"
      ? status.latestWeekResetHistory?.usedAt
      : status.latestFiveHourResetHistory?.usedAt) ?? null;
  const otherUsedAt =
    (resetType === "WEEK"
      ? status.latestFiveHourResetHistory?.usedAt
      : status.latestWeekResetHistory?.usedAt) ?? null;
  // The shared has_unread_history belongs to the newest-used_at kind; on a tie the current kind wins,
  // guaranteeing some kind enters completed on new history without both grabbing it.
  const ownsUnread =
    status.hasUnreadHistory &&
    latestUsedAt !== null &&
    (otherUsedAt === null || latestUsedAt >= otherUsedAt);
  const validOpportunities = availableResets
    .filter((item) => Number.isFinite(item.expireAt) && item.expireAt > now)
    .sort((left, right) => left.expireAt - right.expireAt);
  // The same-used_at sticky completed state and shared manual-trail attribution apply only while no new chance exists.
  // The backend may grant again within one reset period (used_at unchanged); if completed kept priority the new chance
  // would be swallowed until re-login (window memory cleared). A valid chance means
  // a new period -> AVAILABLE. ownsUnread (freshly seen unread completion) is unaffected: the completion notice
  // and quota correction play first, yielding after history/read; processing reconciliation is unaffected too: with
  // balance >0 the manual /use confirm loop must still see completed.
  const hasValidOpportunity = validOpportunities.length > 0;
  // Bugfix: processing used to confirm success on any non-empty used_at. Redeeming again from COMPLETED (N left),
  // the pre-click baseline is the previous used_at; a lagging post-/use status (still the old used_at, unread maybe
  // uncleared) read as a second success: premature success feedback, stale balance, and the shared trail stuck at
  // completedAt=null, the next click silently blocked by cross-surface double-redeem guard. processing honors only the manual trail's
  // manualStartedAt (the hook returns only when used_at differs from the pre-click baseline); on baseline keep waiting;
  // after 4 reconciliations without a new used_at the hook runs failure recovery.
  const shouldComplete = Boolean(
    latestUsedAt !== null &&
    (previous?.status === "processing"
      ? manualStartedAt !== null
      : ownsUnread ||
        ((manualStartedAt !== null ||
          (previous?.status === "completed" && previous.completedAt === latestUsedAt)) &&
          !hasValidOpportunity)),
  );
  if (shouldComplete && latestUsedAt !== null) {
    return createCompletedEntry(
      previous,
      latestUsedAt,
      now,
      manualStartedAt,
      resolveCodingPlanQuotaResetDurationMs(resetType),
      validOpportunities,
    );
  }

  // During a manual use, status polls may still see the pre-consumption snapshot (empty used_at or the pre-click baseline). Stay
  // processing; only a new used_at confirms success -- a stale opportunity must not flip it back to clickable.
  if (previous?.status === "processing") {
    return previous;
  }

  const earliest = validOpportunities[0];
  if (earliest) {
    return createAvailableEntry(
      validOpportunities.length,
      earliest.expireAt,
      previous?.status === "available" ? previous.idempotencyKey : null,
    );
  }

  return null;
}

/**
 * The single not-yet-redeemable... rather redeemable check: not processing, count > 0, earliest expiry after now.
 * Applies to available and to completed-with-remainder alike; the badge, the title Reset, the dialog row, and
 * the reset() gate all use it instead of per-site status === "available" checks.
 */
export function hasUsableCodingPlanQuotaResetOpportunity(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
): boolean {
  return Boolean(
    entry &&
    entry.status !== "processing" &&
    entry.opportunityCount > 0 &&
    entry.opportunityExpiresAt !== null &&
    entry.opportunityExpiresAt > now,
  );
}

/**
 * Completion time for the title-side action: null while redeemable chances remain (show clickable Reset opening the dialog),
 * else completedAt (completed shows Reset-done).
 * Bugfix: once completed carries remainder, passing entry.completedAt directly made the title show reset-done
 * even with chances left, blocking re-opening the dialog to redeem them.
 */
export function resolveCodingPlanQuotaResetActionCompletedAt(controller: {
  entry: CodingPlanQuotaResetUiEntry | null;
  opportunityVisible: boolean;
}): number | null {
  return controller.opportunityVisible ? null : (controller.entry?.completedAt ?? null);
}

export function startCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  idempotencyKey: string,
  now: number,
): CodingPlanQuotaResetUiEntry | null {
  // A completed state's remaining chances are directly redeemable (completed -> processing); its idempotencyKey
  // was cleared at completion, and the path below mints a fresh key -- never the previous one's.
  if (!entry || !hasUsableCodingPlanQuotaResetOpportunity(entry, now)) {
    return entry;
  }

  return {
    ...entry,
    status: "processing",
    // Keep the pre-click chance snapshot during processing so failure restores losslessly and reuses the idempotency key.
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: now,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey: entry.idempotencyKey ?? idempotencyKey,
    error: null,
  };
}

export function failCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  error: string,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "processing") {
    return entry;
  }

  return {
    ...entry,
    status: "available",
    // Failure recovery must keep the pre-click count and expiry, or the entry disappears
    // and the same redemption cannot be retried with its original idempotency key.
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    error,
  };
}

export function resolveCodingPlanQuotaResetRemainingPercentage(
  remainingPercentage: number | null,
  entry: CodingPlanQuotaResetUiEntry | null,
): number | null {
  return entry?.status === "completed" && entry.quotaOverridePending ? 100 : remainingPercentage;
}

/**
 * Merge 5-hour and weekly opportunity badges for display: one gift badge, summed counts,
 * countdown from the earliest-expiring visible tier; when a tier expires/hides the badge
 * falls back to the remaining tier. Display only -- the reset buttons stay per-type.
 */
export function mergeCodingPlanQuotaResetOpportunityBadges(
  items: ReadonlyArray<{
    count: number;
    expiresAt: number | null;
    visible: boolean;
  }>,
): { count: number; expiresAt: number | null; visible: boolean } {
  const visibleItems = items.filter((item) => item.visible && item.count > 0);
  return {
    count: visibleItems.reduce((sum, item) => sum + item.count, 0),
    expiresAt:
      visibleItems
        .map((item) => item.expiresAt)
        .filter((value): value is number => value !== null)
        .sort((left, right) => left - right)[0] ?? null,
    visible: visibleItems.length > 0,
  };
}

export function completeCodingPlanQuotaResetEntitlementRefresh(
  entry: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    entry?.status !== "completed" ||
    entry.completedAt !== completedAt ||
    !entry.quotaOverridePending
  ) {
    return entry;
  }
  return { ...entry, quotaOverridePending: false };
}

export function resolveCodingPlanQuotaResetLimit(
  limit: UsageQuotaLimit | null | undefined,
  entry: CodingPlanQuotaResetUiEntry | null,
): UsageQuotaLimit | null {
  if (!limit) {
    return null;
  }
  if (entry?.status !== "completed") {
    return limit;
  }
  if (!entry.quotaOverridePending) {
    // After a reset the quota pool has no active window (the next one starts at the next prompt), so the refreshed truth
    // may lack nextResetTime. The entitlement refresh lands the same tick as completion, so the optimistic rewrite lives mere
    // milliseconds and the reset time flashes away. During completed, keep fallback display from completedAt + period;
    // yield as soon as the server provides a real window (user sent a message). percentage is no longer overwritten; refresh wins.
    return limit.nextResetTime == null && entry.nextResetAt !== null
      ? { ...limit, nextResetTime: entry.nextResetAt }
      : limit;
  }

  return {
    ...limit,
    // The quota endpoint's percentage is usage; the UI completed state overrides to 0% used, i.e. 100% remaining.
    percentage: 0,
    nextResetTime: entry.nextResetAt ?? limit.nextResetTime,
  };
}

// available is carried by the gift badge + Reset button, so no toolbar tooltip.
// A manual reset already shows loading on the button and confetti on success; another
// processing/completed tooltip here would duplicate feedback. Only auto/ops completions (empty startedAt) keep the notice.
export function resolveCodingPlanQuotaResetStatusVisible(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  doneDisplayMs: number = CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
): boolean {
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return false;
  }
  return now - entry.observedAt < doneDisplayMs;
}

// Synthesized phases for auto/ops reset notices on the composer trigger:
// - processing: ~1s after first observation show resetting, recreating the server-processing look (no backend signal).
// - completed: then switch to reset-done and persist until the user hovers the trigger; the component collapses it after the panel.
// Returns null when dismissed=true (hover-collapsed) or not an auto completion (manual startedAt set / incomplete / unobserved).
export type CodingPlanQuotaResetAutomaticPhase = "processing" | "completed";

export function resolveCodingPlanQuotaResetAutomaticPhase(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  dismissed: boolean,
  processingMs: number = CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
): CodingPlanQuotaResetAutomaticPhase | null {
  if (dismissed) {
    return null;
  }
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return null;
  }
  return now - entry.observedAt < processingMs ? "processing" : "completed";
}

/**
 * Clear a stale replay-confetti arm: when the armed used_at no longer matches the effective auto completion
 * (observedAt nulled by cross-window suppression, or superseded by a newer used_at) the arm must clear,
 * or other windows still confetti from the reset-done spot on hover, breaking fire-once-across-windows.
 */
export function pruneCodingPlanQuotaResetConfettiArms(
  arms: Record<CodingPlanResetType, number | null>,
  automaticCompletedAtByType: Record<CodingPlanResetType, number | null>,
): Record<CodingPlanResetType, number | null> {
  let changed = false;
  const next = { ...arms };
  for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
    const armed = next[resetType];
    if (armed !== null && automaticCompletedAtByType[resetType] !== armed) {
      next[resetType] = null;
      changed = true;
    }
  }
  return changed ? next : arms;
}
