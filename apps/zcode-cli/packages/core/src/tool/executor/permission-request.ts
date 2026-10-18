import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionOptionsPolicy,
  type ToolResultDisplayPayload,
  type PermissionUpdate,
  type TraceContext,
} from "@zcode/contracts";
import type { PermissionDecisionResult } from "../../permission/service.js";
import type { ExecutableToolCall } from "../types.js";
import { emitPermissionRequested } from "./events.js";
import { runPermissionRequestHooks } from "./hook-flow.js";
import { racePermissionResponders } from "./permission-responder-race.js";
import { linkAbortSignal } from "./timeout.js";
import type { ToolExecutorDeps } from "./types.js";

/** One request lifecycle; user-once and rechecked requests close only the Hook answerer, never a second approval pipeline. */
export async function requestPermissionResponse(params: {
  deps: ToolExecutorDeps;
  toolCall: ExecutableToolCall;
  input: unknown;
  decision: PermissionDecisionResult;
  mode: CollaborationMode;
  requestId: string;
  traceContext: TraceContext;
  suggestedPermissionUpdates: PermissionUpdate[];
  approval?: { display?: ToolResultDisplayPayload; optionsPolicy?: PermissionOptionsPolicy };
  runHooks: boolean;
  signal?: AbortSignal;
}) {
  const { deps, toolCall, input, decision, mode, requestId, traceContext, signal } = params;
  const controller = new AbortController();
  const unlink = linkAbortSignal(signal, controller);
  let published: Promise<void> | undefined;
  let registered: Promise<void> | undefined;
  const cancellation = Promise.withResolvers<never>();
  const onAbort = () =>
    cancellation.reject(
      createCoreError(CoreErrorType.ToolCancelled, "Permission request cancelled", {
        recoverable: true,
      }),
    );
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  // Root cause: publishing first lets an immediate response outrun deferred registration; an async broker must signal registration completion explicitly.
  const outcome = racePermissionResponders({
    signal: controller.signal,
    requestBroker: (brokerSignal, claimResponse) => {
      const response = deps.permissionBroker.requestPermission(
        {
          input,
          mode,
          requestId,
          requestedAt: new Date(),
          reason: decision.reason ?? "Tool requires approval",
          riskLevel: decision.riskLevel,
          ruleId: decision.ruleId,
          sessionId: deps.sessionId,
          sideEffectScope: decision.sideEffectScope,
          suggestedPermissionUpdates: params.suggestedPermissionUpdates,
          ...(decision.approvalMode ? { approvalMode: decision.approvalMode } : {}),
          ...(params.approval?.optionsPolicy
            ? { optionsPolicy: params.approval.optionsPolicy }
            : {}),
          toolCallId: toolCall.id as PermissionBrokerRequest["toolCallId"],
          toolName: toolCall.name,
          traceId: traceContext.traceId,
          turnId: traceContext.turnId ?? deps.turnId,
        },
        { signal: brokerSignal, timeoutMs: deps.permissionTimeoutMs, claimResponse },
      );
      registered = response.registered;
      const publish = async () => {
        // Registration may land after cancel finalizes; never re-publish a request that is already void.
        if (controller.signal.aborted) return;
        await emitPermissionRequested(
          deps,
          toolCall,
          input,
          requestId,
          decision.riskLevel,
          decision.reason,
          params.suggestedPermissionUpdates,
          traceContext,
          { ...params.approval, approvalMode: decision.approvalMode },
        );
      };
      published = registered ? registered.then(publish) : publish();
      return response;
    },
    runHooks: async (hookSignal) => {
      if (!params.runHooks) return undefined;
      if (registered) await registered;
      if (hookSignal.aborted) return undefined;
      return runPermissionRequestHooks(
        deps,
        toolCall,
        input,
        requestId,
        decision,
        mode,
        traceContext,
        hookSignal,
      );
    },
    onHookFailure: (error) =>
      deps.logger?.warn("PermissionRequest hook chain failed; waiting for client decision", {
        // Keeps the original trace/event after the reply-wait split, correlating Hook withdrawal with the final user response.
        ...traceContextToLogContext(traceContext),
        event: "tool.permission.hook_race_forfeited",
        module: "core.tool.executor",
        requestId,
        status: "waiting",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
  });
  try {
    // Execution requires registration/publication and the answer together; cancel or a failed answer never waits on slow registration IO.
    const [, settled] = await Promise.race([
      Promise.all([published, outcome]),
      cancellation.promise,
    ]);
    if (signal?.aborted)
      throw createCoreError(CoreErrorType.ToolCancelled, "Permission request cancelled", {
        recoverable: true,
      });
    return settled;
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    unlink();
  }
}
