import { requestVerificationTimeoutMessage } from "@zcode/shared";
import { randomUUID } from "node:crypto";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProviderRuntimeHeadersResponseSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeAppOptions } from "../app/types.js";
import {
  ProtocolRequestError,
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// Without a responder the UI's SDK timeout never starts; the port's overall deadline covers queueing and credential resolution alike.
const PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS = 180_000;
const CLIENT_REQUEST_TIMEOUT_CODE = -32022;

export function createProviderRuntimeHeadersPort(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): NonNullable<ZCodeAppOptions["providerRuntimeHeadersPort"]> {
  return {
    shouldRefreshBeforeModelRequest() {
            // The bound Model decides whether an Account request enters auth; never narrow all accounts to the legacy Start ID.
            // Plain API never enters this port; Team/Individual keep the request-level auth contract.
      return true;
    },
    async refreshBeforeModelRequest(input) {
      const requestId = `${input.sessionId}:provider-runtime-headers:${randomUUID()}`;
      let result;
      try {
        result = await context.requestClient(
          zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
          {
                        // Concurrent requests within one millisecond must not share an association key, or pending replies overwrite/cross-use.
            requestId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            workspace,
            modelSelection: { providerId: input.providerId, modelId: input.modelId },
            providerId: input.providerId,
            ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
            ...(input.expectedAccountScope
              ? { expectedAccountScope: input.expectedAccountScope }
              : {}),
            ...(input.rejectedProjectTokenFingerprint
              ? { rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint }
              : {}),
            reason: input.reason,
          },
          zcodeProviderRuntimeHeadersResponseSchema,
          {
            signal: input.abortSignal,
            trace: protocolTraceFromTraceContext(input.traceContext),
            timeoutMs: PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS,
          },
        );
      } catch (error) {
                // requestClient abort clears only the CLI wait; the Host keeps holding the credential-resolution queue until timeout.
                // Cancel is sent on this port only; other reverse-RPC lifecycles are untouched.
        const timedOut =
          error instanceof ProtocolRequestError && error.code === CLIENT_REQUEST_TIMEOUT_CODE;
                // Both the overall deadline and explicit stops must release the Host, or the CLI has failed while the stale request still occupies the queue.
        if (input.abortSignal?.aborted || timedOut) {
          context.notify({
            method: zcodeProtocolNotifications.providerRuntimeHeadersCancelled,
            trace: protocolTraceFromTraceContext(input.traceContext),
            params: { workspace, sessionId: input.sessionId, requestId },
          });
        }
        if (timedOut) {
          const timeoutError = new ProtocolRequestError(
            CLIENT_REQUEST_TIMEOUT_CODE,
            requestVerificationTimeoutMessage,
            error.data,
          );
          timeoutError.cause = error;
          throw timeoutError;
        }
        throw error;
      }
      if (!result.headersApplied) {
                // Runtime-header refresh can fail from config-read errors or missing credentials;
                // never rewrite those into one failure string -- that hides the real cause and misleads retry policy.
        throw new ProtocolRequestError(
          -32031,
          result.errorMessage ??
            "Provider runtime headers were not applied before model request attempt.",
          {
            providerId: input.providerId,
            ...(input.rejectedProjectTokenFingerprint
              ? { rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint }
              : {}),
            reason: input.reason,
            workspaceKey: workspace.workspaceKey,
          },
        );
      }
            // zcode-plan's account auth material is per-request runtime config,
            // but the provider registry revision is workspace-global; under concurrent refresh a later request advances the global revision,
            // so a global-revision mismatch must not be misread as "this request's headers not applied".
      return result;
    },
  };
}
