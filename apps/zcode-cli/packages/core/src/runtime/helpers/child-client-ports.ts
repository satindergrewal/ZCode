// ============================================================
// Child-runtime outward-interaction port derivation (the single egress).
// ============================================================
//
// A child runtime has two session-identity axes:
//   ledger identity sessionId — event persistence / transcript / trace / session store, the child's own;
//   routing identity — every agent-to-app reverse request (permission, AskUserQuestion, provider
//                        runtime headers) must use the parent's, up to the root session.
// Clients know only the root session; asking with a child id leaves the desktop session-less, the response never sent, the subagent hung.
//
// This rule used to be scattered across child assembly sites: core's subagent wrapped two private layers while dwf actors and legacy
// workflow children forwarded appOptions ports verbatim — two wrong, one right. Derivation converges here, invoked by the
** **parent runtime** (AgentRuntime.createChildClientPorts); parentSessionId is filled by the parent itself,
// so callers cannot get it wrong.

import type { PermissionBrokerPort, SessionId } from "../deps.js";
import type { ProviderRuntimeHeadersPort } from "../types.js";
import type { SubagentInteractionOriginContext } from "../../subagent/interaction-origin.js";
import { createSubagentInteractionBroker } from "./subagent-interaction-broker.js";

/** A runtime's ports facing the protocol client. */
export interface ClientFacingPorts {
  permissionBroker?: PermissionBrokerPort;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
}

/**
 * Mints the attribution a child needs. `parentSessionId` is absent here — only the parent runtime can supply it,
 * which is exactly the mechanical guarantee that routing identity is chosen correctly.
 */
export type ChildClientPortsContext = Omit<SubagentInteractionOriginContext, "parentSessionId">;

/**
 * Derive the child's outward ports from the parent's.
 *
 * - providerRuntimeHeadersPort: wraps and rewrites the input `sessionId` to the parent session (the main runtime reports its own
 *   session; see methods/model-runtime-headers.ts). When nested, **outer writes last** (the client-closest layer runs
 *   last), so the final value is always the root session.
 * - permissionBroker: wraps and rewrites `request.sessionId`, outer-writes-last as well; `origin` keeps the innermost value,
 *   so subagent attribution survives every outer layer.
 */
export function deriveChildClientPorts(
  parent: ClientFacingPorts,
  context: ChildClientPortsContext & { parentSessionId: SessionId },
): ClientFacingPorts {
  return {
    ...(parent.permissionBroker === undefined
      ? {}
      : { permissionBroker: createSubagentInteractionBroker(parent.permissionBroker, context) }),
    ...(parent.providerRuntimeHeadersPort === undefined
      ? {}
      : {
          providerRuntimeHeadersPort: rerouteProviderRuntimeHeadersPort(
            parent.providerRuntimeHeadersPort,
            context.parentSessionId,
          ),
        }),
  };
}

/**
 * Provider runtime headers are a standalone reverse protocol request, never mirroring child events; a child session id is only the CLI's
 * internal ledger, and the desktop subscribes only to the parent task's session, so credential-refresh headers must route via the parent. The service layer
 * compares the requested model with the parent's current one and, on mismatch, syncs only this header — never switching the parent to the child's model.
 */
function rerouteProviderRuntimeHeadersPort(
  parentPort: ProviderRuntimeHeadersPort,
  parentSessionId: SessionId,
): ProviderRuntimeHeadersPort {
  return {
    shouldRefreshBeforeModelRequest(input) {
      return parentPort.shouldRefreshBeforeModelRequest?.(input) ?? true;
    },
    refreshBeforeModelRequest(input) {
      return parentPort.refreshBeforeModelRequest({ ...input, sessionId: parentSessionId });
    },
  };
}
