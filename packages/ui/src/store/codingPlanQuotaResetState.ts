import type { BroadcastClaimLease, BroadcastMessage, IBroadcastService } from "@zcode/services";
import type { CodingPlanResetType } from "@zcode/shared";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";

export interface CodingPlanQuotaResetAutomaticObservation {
  completedAt: number;
  /** Auth-session sequence, incremented within one renderer lifetime when the user goes signed-out -> signed-in. */
  authSessionSeq: number;
}

export interface CodingPlanQuotaResetAutomaticObservations {
  fiveHour: CodingPlanQuotaResetAutomaticObservation | null;
  week: CodingPlanQuotaResetAutomaticObservation | null;
}

/** Cross-window played record: source + kind -> a used_at already toasted in some window. */
export interface CodingPlanQuotaResetAutoPlayedSlot {
  fiveHour: number | null;
  week: number | null;
}

interface CodingPlanQuotaResetStoreState {
  authSessionSeq: number;
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
}

/** Cross-window broadcast channel for the once-per-window auto-complete toast (state: prefix per the cross-window convention). */
const CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL = "state:codereset-autoplayed";

interface CodingPlanQuotaResetAutoPlayedBroadcastPayload {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}

function buildCodingPlanQuotaResetAutoPlayClaimKey(
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): string {
  return `coding-plan-reset-autoplay:${encodeURIComponent(sourceKey)}:${resetType}:${completedAt}`;
}

function parseCodingPlanQuotaResetAutoPlayedPayload(
  payload: unknown,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const sourceKey = typeof record.sourceKey === "string" ? record.sourceKey.trim() : "";
  const resetType =
    record.resetType === "WEEK" || record.resetType === "FIVE_HOUR" ? record.resetType : null;
  const completedAt =
    typeof record.completedAt === "number" && Number.isFinite(record.completedAt)
      ? record.completedAt
      : null;
  if (!sourceKey || !resetType || completedAt === null) {
    return null;
  }
  return { sourceKey, resetType, completedAt };
}

/**
 * Parses played-auto-complete cross-window broadcasts; non-channel messages, local echoes and bad payloads return null.
 *
 * The host send echoes each message locally (no sourceWindowId);
 * only BroadcastHub-relayed cross-window messages carry sourceWindowId, so local echoes must be ignored,
 * otherwise the window own just-broadcast played would suppress its animation on the spot.
 */
export function parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (message.channel !== CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL) {
    return null;
  }
  if (message.sourceWindowId === undefined) {
    return null;
  }
  return parseCodingPlanQuotaResetAutoPlayedPayload(message.payload);
}

/**
 * Broadcast the used_at this window played first; other windows suppress the same used_at toast.
 */
function broadcastCodingPlanQuotaResetAutoPlayed(
  broadcastService: Pick<IBroadcastService, "send">,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): void {
  void broadcastService.send({
    channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
    payload: { sourceKey, resetType, completedAt },
  });
}

interface CodingPlanQuotaResetStoreUpdate {
  patch: Pick<
    CodingPlanQuotaResetStoreState,
    | "codingPlanQuotaResetUiBySource"
    | "codingPlanQuotaResetAutomaticObservationsBySource"
    | "codingPlanQuotaResetAutoPlayedBySource"
  >;
}

/**
 * Write the reset UI state and the auto-complete auth-session trace atomically, keeping entry and observation consistent across renders.
 *
 * Status observation and composer play eligibility are separate. Settings/Usage also call this,
 * and writing played here would consume the cross-window play right with nothing shown.
 */
function updateCodingPlanQuotaResetStoreState(
  state: CodingPlanQuotaResetStoreState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  entry: CodingPlanQuotaResetUiEntry | null,
  authSessionSeq: number,
): CodingPlanQuotaResetStoreUpdate {
  // Async status from a previous auth session can return after sign-out/unmount.
  // The store must validate the sequence at the atomic write, never trust a ref inside an unmounted hook.
  if (state.authSessionSeq !== authSessionSeq) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const nextEntries = { ...state.codingPlanQuotaResetUiBySource };
  const current = nextEntries[sourceKey] ?? { fiveHour: null, week: null };
  const updated =
    resetType === "WEEK" ? { ...current, week: entry } : { ...current, fiveHour: entry };
  if (updated.fiveHour === null && updated.week === null) {
    delete nextEntries[sourceKey];
  } else {
    nextEntries[sourceKey] = updated;
  }

  const automaticCompletedAt =
    entry?.status === "completed" && entry.startedAt === null ? entry.completedAt : null;
  if (automaticCompletedAt === null) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const currentObservations = state.codingPlanQuotaResetAutomaticObservationsBySource[
    sourceKey
  ] ?? {
    fiveHour: null,
    week: null,
  };
  const previousObservation =
    resetType === "WEEK" ? currentObservations.week : currentObservations.fiveHour;
  // The observation records the auth session that first saw a used_at. After re-login, same-history
  // reconciliation may update the entry, never rewrite the observation to the new session, or the old animation replays.
  if (previousObservation?.completedAt === automaticCompletedAt) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const nextObservations = {
    ...state.codingPlanQuotaResetAutomaticObservationsBySource,
  };
  const observation = { completedAt: automaticCompletedAt, authSessionSeq };
  nextObservations[sourceKey] =
    resetType === "WEEK"
      ? { ...currentObservations, week: observation }
      : { ...currentObservations, fiveHour: observation };

  return {
    patch: {
      codingPlanQuotaResetUiBySource: nextEntries,
      codingPlanQuotaResetAutomaticObservationsBySource: nextObservations,
      codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
    },
  };
}

/**
 * Apply a played broadcast from another window: merge played and clear the observedAt of the
 * same used_at auto-complete currently playing here (collapse the tooltip, block the confetti encore).
 */
export function applyCodingPlanQuotaResetAutoPlayedBroadcast(
  state: Pick<
    CodingPlanQuotaResetStoreState,
    "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
  >,
  payload: CodingPlanQuotaResetAutoPlayedBroadcastPayload,
): Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
> {
  const playedBySource = { ...state.codingPlanQuotaResetAutoPlayedBySource };
  const slot = playedBySource[payload.sourceKey] ?? { fiveHour: null, week: null };
  const currentPlayed = payload.resetType === "WEEK" ? slot.week : slot.fiveHour;
  // Cross-window messages arrive out of order. played is a monotonic played-at-least-through cursor;
  // a late old broadcast must never roll back newer records, or later status treats played completions as candidates again.
  if (currentPlayed === null || payload.completedAt > currentPlayed) {
    playedBySource[payload.sourceKey] =
      payload.resetType === "WEEK"
        ? { ...slot, week: payload.completedAt }
        : { ...slot, fiveHour: payload.completedAt };
  }

  const entriesBySource = { ...state.codingPlanQuotaResetUiBySource };
  const entries = entriesBySource[payload.sourceKey];
  const key = payload.resetType === "WEEK" ? "week" : "fiveHour";
  const entry = entries?.[key];
  if (
    entry &&
    entry.status === "completed" &&
    entry.startedAt === null &&
    entry.completedAt === payload.completedAt &&
    entry.observedAt !== null
  ) {
    entriesBySource[payload.sourceKey] = {
      ...entries,
      [key]: { ...entry, observedAt: null },
    } as CodingPlanQuotaResetUiEntries;
  }

  return {
    codingPlanQuotaResetUiBySource: entriesBySource,
    codingPlanQuotaResetAutoPlayedBySource: playedBySource,
  };
}

type CodingPlanQuotaResetAutoPlayState = Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
>;

export interface CodingPlanQuotaResetAutoPlayReservation {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
  lease: BroadcastClaimLease;
}

export type CodingPlanQuotaResetAutoPlayReservationAttempt =
  | { status: "reserved"; reservation: CodingPlanQuotaResetAutoPlayReservation }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

function isCodingPlanQuotaResetAutoPlayCandidate(
  state: CodingPlanQuotaResetAutoPlayState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): boolean {
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  const candidate = state.codingPlanQuotaResetUiBySource[sourceKey]?.[key];
  const played = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  return Boolean(
    candidate?.status === "completed" &&
    candidate.startedAt === null &&
    candidate.observedAt !== null &&
    candidate.completedAt === completedAt &&
    (played === null || played < completedAt),
  );
}

/**
 * The composer requests a transient reservation before playing the auto-complete toast.
 *
 * Reservation and played commit are separate phases. The component may unmount or switch source while awaiting Main;
 * this phase holds only a tokened lease: no played write, no broadcast, and busy never counts as played.
 */
export async function reserveCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "acquireClaim" | "releaseClaim">;
  readState: () => CodingPlanQuotaResetAutoPlayState;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> {
  const { broadcastService, readState, writeState, sourceKey, resetType, completedAt } = params;
  const payload = { sourceKey, resetType, completedAt };
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  const initialState = readState();
  const initialPlayed =
    initialState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  if (initialPlayed !== null && initialPlayed >= completedAt) {
    writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    return { status: "blocked" };
  }
  if (!isCodingPlanQuotaResetAutoPlayCandidate(initialState, sourceKey, resetType, completedAt)) {
    return { status: "blocked" };
  }

  let claimResult;
  try {
    claimResult = await broadcastService.acquireClaim(
      buildCodingPlanQuotaResetAutoPlayClaimKey(sourceKey, resetType, completedAt),
    );
  } catch {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "busy") {
    return { status: "retry", retryAfterMs: Math.max(50, claimResult.retryAfterMs) };
  }
  if (claimResult.status === "unavailable") {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "committed") {
    // committed only means Main holds the permanent claim; the loser still waits for the real played broadcast/local cursor,
    // so never clear observedAt here, or occupied would again read as played.
    return { status: "blocked" };
  }

  const latestState = readState();
  if (!isCodingPlanQuotaResetAutoPlayCandidate(latestState, sourceKey, resetType, completedAt)) {
    await broadcastService.releaseClaim(claimResult.lease);
    const latestPlayed =
      latestState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
    if (latestPlayed !== null && latestPlayed >= completedAt) {
      writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    }
    return { status: "blocked" };
  }

  return {
    status: "reserved",
    reservation: { sourceKey, resetType, completedAt, lease: claimResult.lease },
  };
}

/**
 * Commit the reservation once the component is still mounted, source/candidate match and display is imminent.
 * Writes local played synchronously, then sends the Main commit and played broadcast; no unmount can interleave in the same JS task.
 */
export function commitCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "commitClaim" | "send">;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): boolean {
  const { broadcastService, writeState, reservation } = params;
  const { sourceKey, resetType, completedAt } = reservation;
  let committed = false;
  writeState((state) => {
    if (!isCodingPlanQuotaResetAutoPlayCandidate(state, sourceKey, resetType, completedAt)) {
      return state;
    }
    committed = true;
    const slots = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey] ?? {
      fiveHour: null,
      week: null,
    };
    return {
      codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
      codingPlanQuotaResetAutoPlayedBySource: {
        ...state.codingPlanQuotaResetAutoPlayedBySource,
        [sourceKey]:
          resetType === "WEEK"
            ? { ...slots, week: completedAt }
            : { ...slots, fiveHour: completedAt },
      },
    };
  });
  if (!committed) {
    return false;
  }

  void broadcastService.commitClaim(reservation.lease);
  broadcastCodingPlanQuotaResetAutoPlayed(broadcastService, sourceKey, resetType, completedAt);
  return true;
}

export async function releaseCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "releaseClaim">;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): Promise<void> {
  await params.broadcastService.releaseClaim(params.reservation.lease);
}

interface CodingPlanQuotaResetStoreActions {
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

type CodingPlanQuotaResetStoreWriter = (
  updater: (state: CodingPlanQuotaResetStoreState) => Partial<CodingPlanQuotaResetStoreState>,
) => void;

/** Keeps reset-state actions in this domain file, so the global store stops growing. */
export function createCodingPlanQuotaResetStoreActions(params: {
  broadcastService: Pick<
    IBroadcastService,
    "acquireClaim" | "commitClaim" | "releaseClaim" | "send"
  >;
  readState: () => CodingPlanQuotaResetStoreState;
  writeState: CodingPlanQuotaResetStoreWriter;
}): CodingPlanQuotaResetStoreActions {
  const { broadcastService, readState, writeState } = params;
  return {
    setCodingPlanQuotaResetUiEntry: (sourceKey, resetType, entry, authSessionSeq) =>
      writeState(
        (state) =>
          updateCodingPlanQuotaResetStoreState(state, sourceKey, resetType, entry, authSessionSeq)
            .patch,
      ),
    reserveCodingPlanQuotaResetAutoPlay: (sourceKey, resetType, completedAt) =>
      reserveCodingPlanQuotaResetAutoPlay({
        broadcastService,
        readState,
        writeState: (updater) => writeState((state) => updater(state)),
        sourceKey,
        resetType,
        completedAt,
      }),
    commitCodingPlanQuotaResetAutoPlay: (reservation) =>
      commitCodingPlanQuotaResetAutoPlay({
        broadcastService,
        writeState: (updater) => writeState((state) => updater(state)),
        reservation,
      }),
    releaseCodingPlanQuotaResetAutoPlay: (reservation) =>
      releaseCodingPlanQuotaResetAutoPlay({ broadcastService, reservation }),
  };
}
