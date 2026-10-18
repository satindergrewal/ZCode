import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * Races the legacy reverse RPC (interaction/requestPermission etc.) against the v4 resolveInteraction command:
 * whoever delivers an answer first wins.
 *
 * Implementation: the RPC is the primary await; a v4 hit cancels the RPC:
 * - register the interactionId in v4Interactions (= the business requestId, same source as the v4 projection's
 *   PendingInteraction.interactionId); when the v4 answer arrives, record it and abort the internal
 *   controller, making requestClient reject with ProtocolRequestError(-32021).
 * - in catch, an existing v4 answer returns the mapped result (swallowing the cancel); otherwise rethrow as-is
 *   (including caller outerSignal cancels), keeping legacy error semantics intact.
 * - finally always unregisters and strips the outerSignal listener; a late v4 answer counts as a miss
 *   (the resolveInteraction handler idempotently closes it out).
 */
export async function raceClientRequestWithV4Interaction<T>(
  context: ZCodeProtocolAgentServerContext,
  interactionId: string,
  outerSignal: AbortSignal | undefined,
  startRequest: (signal: AbortSignal) => Promise<T>,
  mapAnswer: (answer: V4InteractionAnswer) => T,
  registrationOptions?: V4InteractionRegistrationOptions,
  onRegistered?: () => void,
): Promise<T> {
  const controller = new AbortController();
  // Each attempt waits on its own failure notification; success still releases via the registry's V4 answer.
  // Resetting a boolean cannot wake an already-awaiting legacy reply, and reusing a one-shot notification would release retries early.
  let fullAccessFailure: Promise<void> | undefined;
  let finishAnswer!: () => void;
  const answerReady = new Promise<void>((resolve) => {
    finishAnswer = resolve;
  });
  const forwardAbort = () => {
    controller.abort();
    finishAnswer();
  };
  if (outerSignal?.aborted) {
    controller.abort();
  } else {
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  // A container, not a bare value, distinguishes "answer is the undefined field" from "not yet answered".
  let v4Answer: { answer: V4InteractionAnswer } | undefined;
  const unregister = context.v4Interactions.register(
    interactionId,
    (answer) => {
      v4Answer = { answer };
      controller.abort();
      finishAnswer();
    },
    registrationOptions?.fullAccess
      ? {
          ...registrationOptions,
          fullAccess: async () => {
            let notifyFailure!: () => void;
            const failure = new Promise<void>((resolve) => {
              notifyFailure = resolve;
            });
            fullAccessFailure = failure;
            try {
              await registrationOptions.fullAccess!();
            } catch (error) {
              if (fullAccessFailure === failure) fullAccessFailure = undefined;
              notifyFailure();
              throw error;
            }
          },
        }
      : registrationOptions,
  );

  const waitForFullAccess = async () => {
    while (fullAccessFailure && !v4Answer && !outerSignal?.aborted) {
      await Promise.race([fullAccessFailure, answerReady]);
    }
  };

  try {
    onRegistered?.();
    const result = await startRequest(controller.signal);
    if (fullAccessFailure) {
      await waitForFullAccess();
      if (v4Answer) return mapAnswer(v4Answer.answer);
      outerSignal?.throwIfAborted();
    }
    return result;
  } catch (error) {
    if (fullAccessFailure) await waitForFullAccess();
    if (v4Answer) {
      return mapAnswer(v4Answer.answer);
    }
    throw error;
  } finally {
    unregister();
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
}
