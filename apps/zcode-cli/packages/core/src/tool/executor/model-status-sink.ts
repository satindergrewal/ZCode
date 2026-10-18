import {
  SessionEventType,
  getCurrentModelInvocationContext,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
} from "@zcode/contracts";
import { withModelInvocationContext } from "../../runtime/methods/runtime-model.js";
import type { ToolExecutionContext } from "../types.js";

/**
 * Default status sink for model requests made inside tools.
 *
 * `statusSink` must not be each call site's memory chore -- WebSearch remembers, WebFetch does not. A request
 * without a sink still passes the admission gate and queues, but the runner's queued/admitted/429 events go
 * nowhere: the executor deadline never learns to pause (observed: 18 WebFetches queued 20-45s then cancelled
 * at the 60s timeout with `queuedMs: 0` in the error) and the driver cannot see the subagent waiting.
 * Same treatment as the admission port: bind the default at the **boundary** instead of trusting call sites --
 * wrap the `context.model` handed to the handler; when the call site set no sink, add the session-event sink;
 * a call-site sink is kept as-is. */
export function createToolModelStatusSink(
  context: Pick<ToolExecutionContext, "emitEvent" | "sessionId" | "turnId" | "traceId">,
): ModelStatusSink | undefined {
  if (!context.emitEvent) return undefined;

  return {
    publish: async (statusEvent: ModelNetworkStatusEvent) => {
      await context.emitEvent?.({
        id: crypto.randomUUID() as never,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ModelNetworkStatus,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: statusEvent,
      });
    },
  };
}

/** Adds the default sink when the call site set none; an explicit one is kept (defaults never override callers). */
export function withDefaultToolModelStatusSink(
  model: Model | undefined,
  sink: ModelStatusSink | undefined,
): Model | undefined {
  if (model === undefined || sink === undefined) return model;
  return withModelInvocationContext(model, () =>
    getCurrentModelInvocationContext()?.statusSink === undefined ? { statusSink: sink } : {},
  );
}
