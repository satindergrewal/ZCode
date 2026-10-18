import type {
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
} from "@/store/codingPlanQuotaResetState.js";

export type CodingPlanQuotaResetAutoPlayCoordinationResult =
  | { status: "committed" }
  | { status: "released" }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

/**
 * Bridges the async reservation to the component display boundary.
 *
 * By the time main returns a winner the Composer may be unmounted or switched sources; recheck
 * isCurrent before committing played. A stale winner only releases its token and never consumes
 * the global play slot.
 */
export async function coordinateCodingPlanQuotaResetAutoPlay(params: {
  reserve: () => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  isCurrent: () => boolean;
  commit: (reservation: CodingPlanQuotaResetAutoPlayReservation) => boolean;
  release: (reservation: CodingPlanQuotaResetAutoPlayReservation) => Promise<void>;
  onCommitted: (reservation: CodingPlanQuotaResetAutoPlayReservation) => void;
}): Promise<CodingPlanQuotaResetAutoPlayCoordinationResult> {
  const attempt = await params.reserve();
  if (attempt.status === "retry") {
    return attempt;
  }
  if (attempt.status === "blocked") {
    return attempt;
  }

  const { reservation } = attempt;
  if (!params.isCurrent()) {
    await params.release(reservation);
    return { status: "released" };
  }
  if (!params.commit(reservation)) {
    await params.release(reservation);
    return { status: "released" };
  }

  params.onCommitted(reservation);
  return { status: "committed" };
}
