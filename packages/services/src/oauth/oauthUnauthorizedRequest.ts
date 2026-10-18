import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { resolveBigModelUserinfoUrl } from "#src/oauth/providers/bigmodelProviderConfig.js";
import { resolveZaiUserinfoUrl } from "#src/oauth/providers/zaiProviderConfig.js";

function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    const url = new URL(resolve());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// This only classifies candidates; actual logout is OAuthService's within the session mutation queue, never on stale async snapshots.
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;

  // The old observer knew only the ZCode JWT, so business access-token userinfo 401s
  // became plain request errors. Extend to user/team identity queries only, keeping payment and API-key endpoints off global logout.
  const provider = await options.credentialService.load("oauth:active_provider");
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return false;
  const env = options.env ?? process.env;
  const requestUrl = tryResolveHttpUrl(() => options.input);
  if (!requestUrl) return false;
  const customerInfoPath = "/api/biz/customer/getCustomerInfo";
  // One candidate URL's construction failure used to block 401 detection for the rest.
  // Construct lazily per candidate and parse only userinfo-needed config, isolating unrelated auth/login config errors.
  const urls =
    provider === BIGMODEL_PROVIDER_ID
      ? [() => buildBigModelApiUrl(env, customerInfoPath), () => resolveBigModelUserinfoUrl(env)]
      : [() => buildRuntimeZaiBusinessUrl(env, customerInfoPath), () => resolveZaiUserinfoUrl(env)];
  if (
    !urls.some((resolve) => {
      const expected = tryResolveHttpUrl(resolve);
      return (
        expected !== null &&
        requestUrl.origin === expected.origin &&
        requestUrl.pathname === expected.pathname
      );
    })
  )
    return false;

  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    return false;
  // The platform may switch during disk reads; a previous platform's token 401 must not clean the current login.
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}
