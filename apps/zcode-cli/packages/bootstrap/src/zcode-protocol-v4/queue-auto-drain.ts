import type { GoalStatus } from "@zcode/contracts";

/**
 * The only auto-promotion gate for the plain queue. No fail-open bypass here: the verifier persists
 * the target as complete first, then shares this check with explicit passes.
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    !input.sessionBusy &&
    (input.targetStatus === null || input.targetStatus === "complete")
  );
}
