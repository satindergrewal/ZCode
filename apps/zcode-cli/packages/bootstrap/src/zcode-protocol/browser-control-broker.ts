import { randomUUID } from "node:crypto";
import type { BrowserControlPort, TraceContext } from "@zcode/contracts";
import {
  zcodeBrowserExecuteResultSchema,
  zcodeBrowserListResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolClientRequestOptions,
} from "./server-types.js";

/**
 * One server context's broker state. The broker is built twice per context — the process-level node_repl broker takes
 // the one in server.ts and each app's runtime port (server-operations.ts) — state must be shared.
 *
 // Root cause (2026-09-30): connection memory lived in separate closures. node_repl's execute recorded on the process-level instance,
 // while the runtime's turnEnded / closeSession hit the app instance, which only ever saw the app's own commands (end-of-turn screenshots),
 // so lifecycle reached the desktop only in the exact turn that screenshotted (desktop log 2026-09-30: session sess_fc6b0f61 opened
 // Browser, zero turnEnded). Child registration alike: the actor registers on the app instance while the actor's browser
 // requests while arriving via the process-level instance.
 */
interface ProtocolBrowserBrokerState {
  connectionsBySession: Map<string, Map<string, { browserId: string; browserGeneration: number }>>;
  /** Child sessions unknown to the client (dwf / core Agent subagents) -> the client session that spawned them. Written only by forChildSession. */
  childSessionParents: Map<string, string>;
  /** Child sessions whose tab owner is the parent (core Agent subagents, tabOwner: parent). */
  parentTabOwnerChildren: Set<string>;
}

const brokerStateByContext = new WeakMap<
  ZCodeProtocolAgentServerContext,
  ProtocolBrowserBrokerState
>();

function brokerState(context: ZCodeProtocolAgentServerContext): ProtocolBrowserBrokerState {
  let state = brokerStateByContext.get(context);
  if (!state) {
    state = {
      connectionsBySession: new Map(),
      childSessionParents: new Map(),
      parentTabOwnerChildren: new Set(),
    };
    brokerStateByContext.set(context, state);
  }
  return state;
}

/**
 * ProtocolBrowserControlBroker -- the agent-side BrowserControlPort implementation.
 *
 * Each browser-client agent.browsers.* call turns a BrowserCommand into a ZCode Protocol
 * interaction/browserExecute reverse request here, executed by the app (host -> main WebContentsView/CDP)
 * with the result returned. Injected alongside the permission broker (server-operations createWorkspaceZCodeApp options).
 */
export function createProtocolBrowserControlBroker(
  context: ZCodeProtocolAgentServerContext,
): BrowserControlPort {
  const state = brokerState(context);
  const { connectionsBySession, childSessionParents } = state;

  const rememberConnection = (sessionId: string, browserId: string, browserGeneration: number) => {
    const connections = connectionsBySession.get(sessionId) ?? new Map();
    connections.set(`${browserId}\u0000${browserGeneration}`, { browserId, browserGeneration });
    connectionsBySession.set(sessionId, connections);
  };

  const sendLifecycle = async (
    sessionId: string,
    turnId: string | undefined,
    command:
      | { method: "turnEnded"; turnId?: string }
      | { method: "closeSession"; closeTabs?: boolean },
  ): Promise<void> => {
    const connections = [...(connectionsBySession.get(sessionId)?.values() ?? [])];
    await Promise.allSettled(
      connections.map(({ browserId, browserGeneration }) =>
        context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...buildBrowserRequestContext(context, state, { sessionId, turnId }),
            browserId,
            browserGeneration,
            command,
          },
          zcodeBrowserExecuteResultSchema,
        ),
      ),
    );
  };

  const port: BrowserControlPort = {
    async list({ sessionId, turnId, traceContext, signal }) {
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionBrowserList,
        buildBrowserRequestContext(context, state, { sessionId, turnId, traceContext }),
        zcodeBrowserListResultSchema,
        buildRequestOptions(traceContext, signal),
      );
      return result.browsers;
    },

    async execute({
      browserId,
      browserGeneration,
      sessionId,
      turnId,
      command,
      traceContext,
      signal,
    }) {
      const requestContext = buildBrowserRequestContext(context, state, {
        sessionId,
        turnId,
        traceContext,
      });
      // Validate the session before recording the connection: a rejected request (unregistered / closed child) never leaves an entry in shared state.
      // Recorded under the tab ownership actually handed out: a subagent sharing the parent's tab is closed down by the parent's lifecycle.
      rememberConnection(requestContext.sessionId, browserId, browserGeneration);
      const cancelBackendRequest = () => {
        // Cancelling only the agent-side requestClient would let the host/main CDP action keep running.
        // Send an internal cancelRequest with the same backend/generation; main interrupts the waiter by the original requestId;
        // when a dispatched action cannot be proven side-effect-free, the manager returns an uncertain marker.
        void context
          .requestClient(
            zcodeProtocolMethods.interactionBrowserExecute,
            {
              ...buildBrowserRequestContext(context, state, { sessionId, turnId, traceContext }),
              browserId,
              browserGeneration,
              command: { method: "cancelRequest", requestId: requestContext.requestId },
            },
            zcodeBrowserExecuteResultSchema,
            buildRequestOptions(traceContext, undefined),
          )
          .catch(() => undefined);
      };
      if (signal?.aborted) cancelBackendRequest();
      else signal?.addEventListener("abort", cancelBackendRequest, { once: true });
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...requestContext,
            browserId,
            browserGeneration,
            command,
          },
          zcodeBrowserExecuteResultSchema,
          buildRequestOptions(traceContext, signal),
        );
      } finally {
        signal?.removeEventListener("abort", cancelBackendRequest);
      }
    },

    async turnEnded({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "turnEnded", turnId });
    },

    async closeSession({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "closeSession" });
      connectionsBySession.delete(sessionId);
    },

    forChildSession({ childSessionId, parentSessionId, tabOwner = "child" }) {
      childSessionParents.set(childSessionId, parentSessionId);
      if (tabOwner === "parent") {
        state.parentTabOwnerChildren.add(childSessionId);
        const release = () => {
          if (childSessionParents.get(childSessionId) !== parentSessionId) return;
          childSessionParents.delete(childSessionId);
          state.parentTabOwnerChildren.delete(childSessionId);
        };
        // The tab belongs to the current conversation: neither subagent turn-end nor run-end may close the parent's tab,
        // that would release a tab the user is watching. Teardown belongs to the parent's own turnEnded / closeSession.
        return {
          list: port.list,
          execute: port.execute,
          async turnEnded() {},
          async closeSession() {
            release();
          },
        };
      }
      return {
        list: port.list,
        execute: port.execute,
        turnEnded: port.turnEnded,
        async closeSession({ sessionId, turnId }) {
          try {
            // A child session never comes back as a conversation to claim the tab: the retained view is visible to no one and just holds a guest.
            await sendLifecycle(sessionId, turnId, { method: "closeSession", closeTabs: true });
          } finally {
            connectionsBySession.delete(sessionId);
            if (childSessionParents.get(childSessionId) === parentSessionId) {
              childSessionParents.delete(childSessionId);
            }
          }
        },
      };
    },
  };
  return port;
}

function buildBrowserRequestContext(
  context: ZCodeProtocolAgentServerContext,
  state: ProtocolBrowserBrokerState,
  input: {
    sessionId: string;
    turnId?: string;
    traceContext?: TraceContext;
  },
) {
  // The child session's workspace / clientMode come from the originating client session; the handed-out sessionId is the desktop browser scope's
  // tab ownership, not the routing identity (docs/zcode-protocol-model-backed-control-requests.md contract 4): dwf subagents use
  // the child session's own id; core Agent subagents the parent's. Unregistered falls back to the raw id; not found rejects.
  const parentSessionId = state.childSessionParents.get(input.sessionId);
  const record = requireSession(context, parentSessionId ?? input.sessionId);
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;

  return {
    requestId: randomUUID(),
    // core Agent subagents share the parent's tab: the desktop keys tab ownership and panel expansion on sessionId,
    // a child-session id is unknown to the desktop; tabs opened with it neither expand the panel nor appear in any conversation.
    sessionId:
      parentSessionId !== undefined && state.parentTabOwnerChildren.has(input.sessionId)
        ? parentSessionId
        : input.sessionId,
    ...((input.turnId ?? input.traceContext?.turnId)
      ? { turnId: String(input.turnId ?? input.traceContext?.turnId) }
      : {}),
    // workspacePath can collide across remote workspaces; the isolation key must prefer
    // workspaceIdentity so browser backend/tab ownership never crosses workspaces.
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: record.deliveryKind ?? "desktop-continuous",
    sessionContext: "live" as const,
  };
}

function buildRequestOptions(
  traceContext: TraceContext | undefined,
  signal: AbortSignal | undefined,
): ZCodeProtocolClientRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
  };
}
