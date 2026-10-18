/* The agent-side official MCP identity-header port.
      The agent process is not the identity authority: it asks the host via the interaction/requestOfficialMcpAuthHeaders reverse request,
      and the host resolves the current Coding Plan credentials and returns this request's identity headers. Credentials never enter runtime config,
      are never persisted, and are never logged. */
import {
  zcodeOfficialMcpAuthHeadersResponseSchema,
  zcodeProtocolMethods,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { OfficialMcpAuthHeadersPort } from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

let requestSequence = 0;

/** The port needs only the reverse-request ability, not the whole server context. */
export type OfficialMcpAuthRequestContext = Pick<ZCodeProtocolAgentServerContext, "requestClient">;

/**
 * Builds the port that fetches identity headers via the protocol reverse request.
 *
 * `resolveContext` is lazy: the MCP connection pool is constructed before ZCodeProtocolAgentServer,
 * so it returns undefined until the server is ready; treat as unavailable (never degrade to anonymous requests).
 *
 * Failures always travel via the return value (ok:false + enumerable reason), never thrown:
 * transport errors normalize to official_auth_unavailable, and the MCP adapter marks that server failed.
 *
 * The workspace field: purpose and known gaps:
 * - the host does **not** route by it -- the response returns via `client.respond(request.id, ...)` on the originating
 *   stdio connection; routing is the connection's job. The field is request context/audit only;
 * - it must still follow the repo rule `workspaceKey = workspaceIdentity?.trim() || workspacePath`,
 *   or remote workspaces sharing a path but differing in identity are indistinguishable in the audit context;
 * - **remaining gap**: the CLI agent process currently has no workspaceIdentity source
 *   (`RunZCodeProtocolAgentOptions` carries only cwd/env/... and there is no env var either), so the field
 *   degrades to workspacePath. The guarantee is "pass identity through correctly when present", not "identity always exists".
 *   If audit ever needs the real remote identity, thread it at the spawn/protocol layer -- out of scope here.
 */
export function createOfficialMcpAuthHeadersPort(input: {
  resolveContext: () => OfficialMcpAuthRequestContext | undefined;
  resolveWorkspace: (input: {
    workspaceIdentity?: string;
    workspacePath?: string;
  }) => ZCodeWorkspaceRef | undefined;
}): OfficialMcpAuthHeadersPort {
  return {
    async resolveHeaders(request) {
      const context = input.resolveContext();
      const workspace = input.resolveWorkspace({
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
      });
      if (!context || !workspace) {
        return { ok: false, reason: "official_auth_unavailable" };
      }
      requestSequence += 1;
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
          {
            mcpKey: request.mcpKey,
            pluginId: request.pluginId,
            requestId: `official-mcp-auth:${requestSequence}`,
            targetOrigin: request.targetOrigin,
            workspace,
          },
          zcodeOfficialMcpAuthHeadersResponseSchema,
          request.signal ? { signal: request.signal } : {},
        );
      } catch {
        // Host unreachable/protocol error: treat as unavailable. Error details are not carried out (may contain request context);
        // the host already logged a secret-free classification.
        return { ok: false, reason: "official_auth_unavailable" };
      }
    },
  };
}
