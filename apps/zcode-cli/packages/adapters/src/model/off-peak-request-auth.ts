import type {
  ModelInvocationContext,
  ModelRequestAuth,
  ModelRequestAuthSourceInput,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";

/** The dispatch snapshot pins ticket and login scope only; a short-lived PAT resolves against the origin owner per HTTP attempt. */
export async function refreshOffPeakRequestAuth(params: {
  auth: ModelRequestAuth;
  input: ModelRequestAuthSourceInput & { rejectedProjectTokenFingerprint?: string };
  accountAccess: ZCodeProviderAccountAccess;
  refresh?: ModelInvocationContext["refreshRuntimeHeadersBeforeAttempt"];
}): Promise<ModelRequestAuth> {
  const { auth } = params;
  if (!auth.accountScope) return auth;
  if (!params.refresh) throw new Error("Off-peak request auth owner is unavailable");
  const result = await params.refresh({
    ...params.input,
    accountAccess: params.accountAccess,
    expectedAccountScope: auth.accountScope,
    reason: "model-request",
  });
  if (
    !result.headersApplied ||
    !result.requestAuth?.apiKey?.trim() ||
    result.requestAuth.accountScope !== auth.accountScope
  )
    throw new Error("project_token_scope_invalidated");
  const headers = { ...auth.headers };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-coding-plan-api-key") delete headers[name];
  }
  return {
    ...auth,
    apiKeyId: result.requestAuth.apiKeyId,
    headers: { ...headers, "X-Coding-Plan-Api-Key": result.requestAuth.apiKey },
  };
}
