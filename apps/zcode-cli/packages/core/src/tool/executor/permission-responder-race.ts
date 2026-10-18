// The PermissionRequest hook chain racing the interaction broker.
//
// The old path awaited the hook chain serially after emitPermissionRequested, so the broker's
// answer deferred was registered only once the hooks returned. While a synchronous hook was suspended
// (a bridge forwarding the request to an external UI and blocking on its click), the confirm dialog was
// visible but every click was dropped by resolveInteraction's "idempotent on miss" -- dialog dead, turn hung.
// Fix: start both responders concurrently; first decision wins; the loser is aborted and never awaited.
import type { PermissionBrokerResult } from "@zcode/contracts";
import { linkAbortSignal } from "./timeout.js";

interface PermissionResponderRaceInput {
  /**
   * Hook-chain responder. Resolving undefined means no decision (forfeit; only the broker waits);
   * throwing counts as a forfeit too and invokes {@link PermissionResponderRaceInput.onHookFailure} --
   * a supporting responder's infra failure must not decide a rejection on the user's behalf.
   */
  runHooks: (signal: AbortSignal) => Promise<PermissionBrokerResult | undefined>;
  /**
   * Broker responder. The answer channel (v4 interaction deferred / TUI approval queue) must be
   * registered synchronously within this call -- the precondition for "visible means answerable", guaranteed
   * by the existing broker contract. Rejections (timeout, cancel, fail-closed) rethrow verbatim when no hook
   * wins -- the same error shape as the old serial path. */
  requestBroker: (
    signal: AbortSignal,
    claimResponse: () => boolean,
  ) => Promise<PermissionBrokerResult>;
  /** Outer turn cancel signal: aborts both sides; the broker rejection then propagates per the above. */
  signal?: AbortSignal;
  /** Callback when the hook chain throws while the race is undecided (caller logs a warning). */
  onHookFailure?: (error: unknown) => void;
}

interface PermissionResponderRaceOutcome {
  result: PermissionBrokerResult;
  source: "hook" | "broker";
}

export async function racePermissionResponders(
  input: PermissionResponderRaceInput,
): Promise<PermissionResponderRaceOutcome> {
  const hookController = new AbortController();
  const brokerController = new AbortController();
  const unlinkHook = linkAbortSignal(input.signal, hookController);
  const unlinkBroker = linkAbortSignal(input.signal, brokerController);

  let settled = false;
  let brokerClaimed = false;
  try {
    return await new Promise<PermissionResponderRaceOutcome>((resolve, reject) => {
      const settle = (action: () => void, abortLoser: AbortController) => {
        if (settled) return;
        settled = true;
        action();
        // Settle the winner before aborting the loser: the loser's teardown (child process kill, reverse-RPC
        // cancel) must never block the winner in turn -- the hung thing is the loser itself.
        abortLoser.abort();
      };

      // Broker starts first: requestPermission registers its answer deferred synchronously, so the moment the
      // dialog is visible a click has a destination; no exclusive window for hooks.
      input
        .requestBroker(brokerController.signal, () => {
          if (settled || brokerController.signal.aborted) return false;
          brokerClaimed = true;
          hookController.abort();
          return true;
        })
        .then(
          (result) => settle(() => resolve({ result, source: "broker" }), hookController),
          (error) => {
            // After a hook wins, the broker rejection we abort with is our own cancel: swallow it. A rejection
            // while the race is undecided (timeout/outer cancel/fail-closed) is a real error; rethrow.
            settle(() => reject(error), hookController);
          },
        );

      input.runHooks(hookController.signal).then(
        (decision) => {
          // No decision = forfeit: leave the race state alone; the broker keeps waiting alone.
          if (decision === undefined || brokerClaimed) return;
          settle(() => resolve({ result: decision, source: "hook" }), brokerController);
        },
        (error) => {
          if (settled) return;
          input.onHookFailure?.(error);
        },
      );
    });
  } finally {
    unlinkHook();
    unlinkBroker();
  }
}
