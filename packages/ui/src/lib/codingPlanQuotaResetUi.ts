import type {
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  UsageQuotaLimit,
} from "@zcode/shared";
// How long the post-completion "quota reset" notice stays before auto-dismissing (bar stays at 100%).
export const CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS = 2_600;
// Automatic/operational resets synthesize a short "resetting" phase on the Composer trigger
// before switching to "reset". The backend has no processing signal; this only recreates the
// processing->reset transition on the client.
export const CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS = 1_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// Optimistically rewrite "next reset time" after completion: 5h quota by 5 hours, weekly by 7 days.
function resolveCodingPlanQuotaResetDurationMs(resetType: CodingPlanResetType): number {
  return resetType === "WEEK" ? WEEK_MS : FIVE_HOURS_MS;
}

// available: the server granted a usable 5-hour reset opportunity.
// processing: a manual redemption is in flight, awaiting the use + status reconciliation.
// completed: status has returned the server used_at; automatic/operational resets skip processing.
export type CodingPlanQuotaResetUiStatus = "available" | "processing" | "completed";

export interface CodingPlanQuotaResetUiEntry {
  status: CodingPlanQuotaResetUiStatus;
  /** Remaining reset opportunities; zeroed while processing/completed. */
  opportunityCount: number;
  /** Earliest opportunity expiry; only meaningful while available. */
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
  // Manual redemptions also pass through processing, so "seen processing" can no longer be
  // the trigger's confetti condition -- the manual reset would animate twice (button + trigger).
  // The trigger confetti only on new used_at values from automatic completions; clear the
  // trail on source switch to avoid double/missed animations across team/personal plans.
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
): CodingPlanQuotaResetUiEntry {
  const isSameCompletion = previous?.status === "completed" && previous.completedAt === completedAt;
  return {
    status: "completed",
    opportunityCount: 0,
    opportunityExpiresAt: null,
    // The manual click and the completion history may be observed from different entries.
    // Trusting only the current source's processing state would make the Composer misread a
    // settings-initiated manual reset as automatic, duplicating Tooltip and confetti. Repeated
    // reconciliation of the same completion must also keep the original classification instead
    // of decaying into "automatic" on the next poll.
    startedAt: isSameCompletion
      ? previous.startedAt
      : previous?.status === "processing"
        ? previous.startedAt
        : manualStartedAt,
    completedAt,
    // Polling may discover an automatic/operational reset up to 60s after used_at. The toast
    // must be measured from first observation; repeated polls of the same used_at must not
    // extend it.
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
 * resetType selects the 5-hour vs weekly opportunity/history fields. has_unread_history is a
 * single cursor shared by both reset types, so only the type with the newest used_at "owns"
 * the unread flag; otherwise one weekly reset would misread a stale 5-hour history as just
 * completed, and vice versa.
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
  // The shared has_unread_history belongs to the type with the newest used_at; on a tie the
  // current type owns it, guaranteeing at least one type can enter completed when new history
  // exists without both stealing it simultaneously.
  const ownsUnread =
    status.hasUnreadHistory &&
    latestUsedAt !== null &&
    (otherUsedAt === null || latestUsedAt >= otherUsedAt);
  const validOpportunities = availableResets
    .filter((item) => Number.isFinite(item.expireAt) && item.expireAt > now)
    .sort((left, right) => left.expireAt - right.expireAt);
  // Sticky completed state for the same used_at and shared manual-trajectory attribution
  // apply only while "no new opportunity exists". The backend may re-grant opportunities
  // within the same reset period (used_at unchanged); if completed kept priority the UI
  // would swallow the new opportunity until the user re-logged-in (clearing window memory).
  // A valid opportunity means a new period began -> back to AVAILABLE. ownsUnread (a
  // just-discovered unread completion) is unaffected: the completion toast and quota
  // correction play first and yield on the next round after history/read; processing
  // reconciliation is unaffected too: with opportunity count > 0 the manual /use
  // confirmation loop must still observe completed.
  const hasValidOpportunity = validOpportunities.length > 0;
  const shouldComplete = Boolean(
    latestUsedAt !== null &&
    (ownsUnread ||
      previous?.status === "processing" ||
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
    );
  }

  // During a manual use, the status poll may still read the pre-consumption snapshot. Stay
  // processing: only the server used_at confirms success; an old opportunity must not flip
  // the entry back to clickable.
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

export function startCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  idempotencyKey: string,
  now: number,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "available") {
    return entry;
  }

  return {
    ...entry,
    status: "processing",
    // Keep the pre-click opportunity snapshot while processing so failure can restore it
    // losslessly and reuse the idempotency key.
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
    // After a reset the quota pool has no active window (the new window starts with the next
    // prompt), so the refreshed real quota can lack nextResetTime. The entitlement refresh
    // lands within ticks of completion and the optimistic override lives only a few hundred
    // ms, so "resets at" would flash and vanish. While completed, keep completedAt + period
    // as the display fallback; yield as soon as the server provides a real window (user sent
    // a new message). percentage is no longer overridden; the refreshed value wins.
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

// available is carried by the gift badge + reset button, so the toolbar Tooltip stays closed.
// Manual resets already show loading on the button and confetti on success; another
// processing/completed Tooltip here would duplicate the feedback. Only automatic/operational
// completions (startedAt null) keep the toast.
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

// Synthesized phases for automatic/operational reset notices on the Composer trigger:
// - processing: ~1s after first observation show "resetting", recreating the server-side
//   processing feel (the backend has no processing signal).
// - completed: then switch to "reset", kept until the user hovers the trigger's quota panel
//   and the component dismisses it.
// Returns null when dismissed=true (already hover-dismissed) or not an automatic completion
// (manual startedAt present / not completed / not yet observed).
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
 * Prune replay-confetti arms that are no longer valid: when a type's armed used_at is no
 * longer the current automatic completion (observedAt cleared by cross-window suppression, or
 * superseded by a newer used_at), the arm must be cleared or another window's hover would
 * still throw confetti from the "reset" position, breaking "play once across windows".
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
