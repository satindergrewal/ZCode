import { BIGMODEL_PROVIDER_ID } from "@zcode/shared";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

interface BigModelStartPlanZcodeJwtCredentialService {
  load(key: string): Promise<string | null>;
}

export async function resolveBigModelStartPlanZcodeJwt(params: {
  credentialService?: BigModelStartPlanZcodeJwtCredentialService;
  provider?: { readonly apiKey?: string | null } | null;
  trustCachedZcodeJwt?: boolean;
}): Promise<string> {
  const activeProvider = (await params.credentialService?.load(ACTIVE_PROVIDER_KEY))?.trim() || "";
  if (params.trustCachedZcodeJwt === true || activeProvider === BIGMODEL_PROVIDER_ID) {
    const credentialJwt = (await params.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() || "";
    if (credentialJwt) {
      return credentialJwt;
    }
  }

  // The zcode JWT must persist during the BigModel OAuth callback via the authorization-code body.
  // Start Plan balance/runtime reads consume the saved JWT or provider copy only; never
  // re-mint via a BigModel access_token provider+access_token body, avoiding /oauth/token 400.
  return params.provider?.apiKey?.trim() || "";
}
