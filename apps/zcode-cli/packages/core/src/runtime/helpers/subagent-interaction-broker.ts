import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
} from "../deps.js";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "../../subagent/interaction-origin.js";

export interface SubagentInteractionBrokerContext extends SubagentInteractionOriginContext {
  parentToolCallId?: PermissionBrokerRequest["toolCallId"] | string;
}

type BrokerResponse = ReturnType<PermissionBrokerPort["requestPermission"]>;

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): BrokerResponse {
      // Why: a subagent's permission / AskUserQuestion / ExitPlanMode all need the parent task's UI to respond;
      // broker requests route outward to the parent session while origin keeps the child attribution for UI/logs.
      // Contract (2026-09-17 review): `registered` is just a property pinned on the Promise; this function must return the parent broker's
      // response object as-is — never async, never re-wrapped in .then — or the signal is silently lost, the executor falls back to
      // assuming synchronous registration, and "dialog visible but deferred unregistered" returns. subagent-interaction-broker.test.ts guards that identity.
      //
      // Wrappers stack. `sessionId` is rewritten last by the **outermost** layer (closest to the client), so any depth ends at the root session;
      // `origin` conversely keeps the **innermost** existing value,
      // so attribution is always the actually-requesting subagent, never an intermediate layer.
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin: request.origin ?? buildSubagentInteractionOrigin(context, request.turnId),
        },
        options,
      );
    },
  };
}
