// ============================================================
// AgentRuntime-backed WorkflowDriver: containment for model-side failures
// ============================================================
// workflow-driver.ts hit the oxlint max-lines cap (400), so the model-side containment for rejected turns
// (policy table decides stop -> the whole run
// stopped(provider); context_exceeded -> the node fails ContextLimit; retry / cancelled -> backoff and re-drive)
// moves here. Free functions read driver deps/sink and re-call runTurn via {@link ModelFailureHost}; no private
// state leaks. Constants and pure helpers (backoff curve, Retry-After parsing, salutation) live in workflow-driver-helpers.ts.

import {
  inspectWorkflowModelFailure,
  type WorkflowModelFailureInspection,
} from "@zcode/adapters/model";
import {
  refToString,
  WorkflowError,
  type InstanceRef,
  type ProviderStopDetails,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import {
  PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS,
  TRANSIENT_CONTINUE_PROMPT,
  defaultSchedule,
  readRetryAfterMs,
  subagentLabel,
  transientBackoffMs,
} from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/** The host surface handed to the containment logic: deps, sink, disposed flag, and starting another turn on the same session. */
export interface ModelFailureHost {
  readonly deps: Pick<AgentRuntimeWorkflowDriverDeps, "clock" | "logger" | "runId">;
  readonly sink: WorkflowReportSink;
  isDisposed(): boolean;
  runTurn(state: SessionState, instance: InstanceRef, input: string, epilogueStart: number): void;
}

/**
 * Model-side containment for rejected turns: driver and runner share one policy table. false = not a model-layer error
 * (inspect returned undefined), handled by the caller as a driver-side failure; true = handled per policy.
 */
export function handleModelTurnFailure(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  error: unknown,
): boolean {
  const inspected = inspectWorkflowModelFailure(error);
  if (inspected === undefined) return false;
  switch (inspected.policy.decision) {
    case "stop":
      // A deterministic model-side error: stop the whole run (stopped(provider), recoverable) without settling the node.
      host.sink.stopRun(providerStopError(state, inspected, error));
      return true;
    case "context_exceeded":
      // Core compaction failed: the ask itself is too large -- the script's fault. The node fails ContextLimit, catchable by the script.
      host.sink.askFailed(
        instance,
        new WorkflowError(
          "ContextLimit",
          `Subagent ${subagentLabel(state)} exceeded the model's context window even after ` +
            `compaction. Give this ask a smaller input or split the work across subagents.`,
          { cause: error },
        ),
      );
      return true;
    default:
      // retry / cancelled: transient failures passed through by the runner (stream-recovery exhausted, ...) --
      // share the runner's backoff curve, wait it out, then start a continuation turn; only cancel ends it.
      scheduleTransientRedrive(host, state, instance, inspected, error);
      return true;
  }
}

/**
 * Driver-side re-drive for transient failures: per-ask count, 2s->60s jittered backoff (Retry-After first), announce via
 * `askWaiting(backoff)` before waiting, honor cancellation while waiting, then send one continuation turn on the same persistent runtime
 * (the nudge mechanism). Unbounded -- the run-level stall clock is what makes the waiting visible.
 */
function scheduleTransientRedrive(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  inspected: WorkflowModelFailureInspection,
  error: unknown,
): void {
  state.transientAttempts += 1;
  const attempt = state.transientAttempts;
  const retryAfterMs = readRetryAfterMs(error);
  const delayMs = retryAfterMs ?? transientBackoffMs(attempt, host.deps.clock?.random);
  host.sink.askWaiting(instance, {
    cause: "backoff",
    reason: inspected.reason,
    attempt,
    delayMs,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  host.deps.logger?.warn?.("Dynamic workflow subagent turn failed transiently; redriving", {
    attempt,
    delayMs,
    event: "dynamic_workflow.ask.transient_redrive",
    instance: refToString(instance),
    module: "bootstrap.app",
    reason: inspected.reason,
    runId: host.deps.runId ?? "run",
  });
  const schedule = host.deps.clock?.schedule ?? defaultSchedule;
  state.cancelRedrive?.();
  state.cancelRedrive = schedule(() => {
    state.cancelRedrive = undefined;
    // The ask was cancelled / settled / reassigned while waiting: this continuation has no listener.
    if (
      host.isDisposed() ||
      state.cancelled ||
      state.accepted ||
      state.abortController?.signal.aborted === true ||
      state.currentInstance === undefined ||
      refToString(state.currentInstance) !== refToString(instance)
    ) {
      return;
    }
    host.runTurn(state, instance, TRANSIENT_CONTINUE_PROMPT, 0);
  }, delayMs);
}

/** A `ProviderStop` error: a model-side error the policy table stops on, plus the structured detail the notice copy needs. */
function providerStopError(
  state: SessionState,
  inspected: WorkflowModelFailureInspection,
  cause: unknown,
): WorkflowError {
  const kind = inspected.policy.decision === "stop" ? inspected.policy.kind : "other";
  const rawMessage = (
    inspected.rawMessage ?? (cause instanceof Error ? cause.message : String(cause))
  ).slice(0, PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS);
  const details: ProviderStopDetails = {
    kind,
    reason: inspected.reason,
    subagent: refToString(state.actor),
    ...(state.actorName === undefined ? {} : { subagentName: state.actorName }),
    ...(inspected.providerId === undefined ? {} : { providerId: inspected.providerId }),
    ...(inspected.modelId === undefined ? {} : { modelId: inspected.modelId }),
    ...(inspected.providerCode === undefined ? {} : { providerCode: inspected.providerCode }),
    ...(rawMessage.length === 0 ? {} : { rawMessage }),
    ...(inspected.resetAt === undefined ? {} : { resetAt: inspected.resetAt }),
  };
  const code = inspected.providerCode === undefined ? "" : ` [${inspected.providerCode}]`;
  return new WorkflowError(
    "ProviderStop",
    `Subagent ${subagentLabel(state)} hit a permanent model-side error ` +
      `(${inspected.reason}${code}): ${rawMessage}`,
    { cause, providerStop: details },
  );
}
