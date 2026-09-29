import type { AgentRuntimeInternal } from "../internal.js";
import { traceContextToLogContext } from "../deps.js";
import type { ContinueActiveTargetLoopOptions, TurnResult } from "../types.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { TargetContinuationLoopRuntimeCommand } from "../command-queue.js";
import { executeTargetContinuationWithOutcome } from "./target.js";
import { hasRunningBackgroundRuntimeTask } from "../../runtime-task/registry.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";

interface RunActiveTargetContinuationLoopOptions extends ContinueActiveTargetLoopOptions {
  yieldBeforeFirstContinue?: boolean;
}

const BACKGROUND_DEFERRAL_POLL_INTERVAL_MS = 20_000;
const DEFAULT_MAX_VERIFIER_FAILURE_CONTINUATIONS = 3;
const DEFAULT_REQUIRED_COMPLETION_CONFIRMATIONS = 2;
const DEFAULT_BACKGROUND_DEFERRAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function continueActiveTargetLoop(
  this: AgentRuntimeInternal,
  options: ContinueActiveTargetLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;

  return await enqueueCancellableRuntimeCommand<
    TurnResult | null,
    TargetContinuationLoopRuntimeCommand
  >(this, {
    abortSignal: options.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "target-continuation-loop",
      options: {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
        traceContext,
        trigger: options.trigger,
        ...(options.verifyBeforeFirstContinue !== undefined
          ? { verifyBeforeFirstContinue: options.verifyBeforeFirstContinue }
          : {}),
      },
      priority: "next",
      reject,
      resolve,
      traceContext,
    }),
  });
}

export async function runActiveTargetContinuationLoop(
  this: AgentRuntimeInternal,
  options: RunActiveTargetContinuationLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;
  const verificationConfig = this.config.targetCompletionVerification;
  const maxVerifierFailureContinuations = Math.max(
    0,
    verificationConfig?.maxFailureContinuations ?? DEFAULT_MAX_VERIFIER_FAILURE_CONTINUATIONS,
  );
  const requiredCompletionConfirmations = Math.max(
    1,
    verificationConfig?.requiredCompletionConfirmations ?? DEFAULT_REQUIRED_COMPLETION_CONFIRMATIONS,
  );
  const backgroundDeferralDeadlineMs =
    verificationConfig?.backgroundDeferralTimeoutMs ?? DEFAULT_BACKGROUND_DEFERRAL_TIMEOUT_MS;

  let verifyBeforeContinue = options.verifyBeforeFirstContinue === true;
  let lastResult: TurnResult | null = null;
  let yieldToPendingCommands = options.yieldBeforeFirstContinue !== false;
  let continuationIntent = options.intent;
  let verifierFailureStreak = 0;
  let completionConfirmations = 0;

  while (!options.abortSignal?.aborted) {
    if (yieldToPendingCommands && this.runtimeCommandQueue.hasPending()) {
      return lastResult;
    }

    if (
      options.trigger === "task-notification" &&
      verifyBeforeContinue &&
      verificationConfig?.enabled === false
    ) {
      return lastResult;
    }

    let outcome = await executeTargetContinuationWithOutcome.call(this, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
      ...(continuationIntent ? { intent: continuationIntent } : {}),
      traceContext,
      verifyBeforeContinue,
    });

    // Background benches/serves are normal during long missions: instead of letting the
    // deferral kill the loop, wait for the tasks to drain and re-attempt verification.
    if (outcome.kind === "deferred-background") {
      const deadline = Date.now() + backgroundDeferralDeadlineMs;
      while (
        hasRunningBackgroundRuntimeTask(this.runtimeTaskRegistry) &&
        Date.now() < deadline &&
        !options.abortSignal?.aborted
      ) {
        await sleep(BACKGROUND_DEFERRAL_POLL_INTERVAL_MS);
      }
      if (options.abortSignal?.aborted) return lastResult;
      outcome = await executeTargetContinuationWithOutcome.call(this, {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
        traceContext,
        verifyBeforeContinue: true,
      });
    }

    if (outcome.kind === "executed") {
      // The first continuation applies and persists this submission; later automatic rounds
      // read the fresh Session Selection, so a user turn that lands in between becomes the
      // new authority.
      continuationIntent = undefined;
      verifyBeforeContinue = true;
      yieldToPendingCommands = true;
      if (outcome.verifiedHealthy) {
        verifierFailureStreak = 0;
      }
      completionConfirmations = 0;
      lastResult = outcome.result;
      continue;
    }

    if (outcome.kind === "completed") {
      // A single verifier pass can be a false positive (the model's status-report text can
      // mislead the verifier). Accept completion only after the required number of
      // independent passes agree.
      completionConfirmations += 1;
      if (completionConfirmations >= requiredCompletionConfirmations) {
        return lastResult;
      }
      verifyBeforeContinue = true;
      yieldToPendingCommands = true;
      continue;
    }

    if (outcome.kind === "skipped-verifier-failed") {
      // A verifier malfunction is not task completion: degrade to one unverified
      // continuation so the mission keeps moving, and only give up after the consecutive
      // failure cap — no infinite spin, no silent abandonment.
      verifierFailureStreak += 1;
      if (verifierFailureStreak > maxVerifierFailureContinuations) {
        this.logger?.warn(
          "Goal continuation stopped after repeated verifier failures without next action",
          {
            ...traceContextToLogContext(traceContext),
            event: "target.continuation.verifier_failure_cap_reached",
            module: "core.runtime",
            verifierFailureStreak,
            maxVerifierFailureContinuations,
          },
        );
        return lastResult;
      }
      const fallback = await executeTargetContinuationWithOutcome.call(this, {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
        traceContext,
        verifyBeforeContinue: false,
      });
      if (fallback.kind !== "executed") return lastResult;
      continuationIntent = undefined;
      verifyBeforeContinue = true;
      yieldToPendingCommands = true;
      lastResult = fallback.result;
      continue;
    }

    // skipped: no active target / plan mode / target gone — nothing to continue.
    return lastResult;
  }

  return lastResult;
}
