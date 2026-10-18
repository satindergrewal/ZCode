import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

interface BigModelZcodeTokenEnvelope {
  code?: number;
  msg?: string;
  data?: {
    token?: string | null;
    access_token?: string | null;
    accessToken?: string | null;
    bigmodel?: {
      access_token?: string | null;
      accessToken?: string | null;
      refresh_token?: string | null;
      refreshToken?: string | null;
    } | null;
  } | null;
}

interface BigModelCustomerInfo {
  customerNumber?: unknown;
  customerName?: unknown;
  nickName?: unknown;
  avatar?: unknown;
}

/** Max wait for OAuth startup restore (1 minute). */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
const log = createServiceLogger("bigmodelOAuth");

function maskOAuthCode(code: string): string {
  if (code.length <= 8) {
    return "*".repeat(code.length);
  }

  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function readOptionalString(value: unknown): string | undefined {
  // BigModel userinfo is remote runtime data; exception types never join trim nor persist as display fields.
  return typeof value === "string" ? value : undefined;
}

function readTrimmedString(value: unknown): string {
  return readOptionalString(value)?.trim() || "";
}

function resolveBigModelDisplayName(customer: BigModelCustomerInfo): string {
  const customerName = readTrimmedString(customer.customerName);
  const nickName = readTrimmedString(customer.nickName);
  return customerName || nickName || "user";
}

/** BigModel OAuth protocol adapter. */
export class BigModelProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = BIGMODEL_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
  }

  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // Polling-ready already returned the BigModel business token; skip Z.AI's second exchange.
    return tokenSet;
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    // BigModel's production callback used authCode; newer builds may fall back to code.
    // Accept both, so a console param rename never breaks login.
    const code = parsed.searchParams.get("authCode") ?? parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");

    if (!code || !state) {
      throw new Error("OAuth callback missing authCode/code or state");
    }

    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    const query = new URLSearchParams({
      redirect: context.redirectUri,
      appId: this.config.appId,
      state: context.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    _context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const tokenSet = await this.exchangeZcodeJwtToken(params, _context);

    return {
      ...tokenSet,
    };
  }

  private async exchangeZcodeJwtToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    log.info(undefined, "zcode token request", {
      method: "POST",
      url: this.config.tokenUrl,
      headers: { "Content-Type": "application/json" },
      body: {
        provider: BIGMODEL_PROVIDER_ID,
        code: maskOAuthCode(params.code),
        codeLength: params.code.length,
        redirect_uri: context.redirectUri,
        state: context.state,
      },
    });

    try {
      const payload = await readApiJson<BigModelZcodeTokenEnvelope>(
        this.apiClient,
        this.config.tokenUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The backend token route parses the zcode JWT per OAuth-callback code semantics.
          // BigModel Start Plan must not re-exchange access_token at balance time,
          // or the body diverges from Z.ai's login path with HTTP 400. Pass the shared
          // OAuth provider enum so multi-provider never guesses identity from redirect_uri.
          body: JSON.stringify({
            provider: BIGMODEL_PROVIDER_ID,
            code: params.code,
            redirect_uri: context.redirectUri,
            state: context.state,
          }),
        },
      );
      if (payload.code !== undefined && payload.code !== 0) {
        // BigModel's one-shot authCode now goes only to the zcode token route.
        // On failure, never persist a half-login or Start Plan keeps showing disconnected.
        log.warn(undefined, "zcode token business response rejected", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error(
          payload.msg?.trim() || `BigModel zcode token exchange failed (code: ${payload.code})`,
        );
      }
      const zcodeJwtToken = payload.data?.token?.trim() || "";
      if (!zcodeJwtToken) {
        log.warn(undefined, "zcode token response missing data.token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error("BigModel zcode token exchange failed: response missing data.token");
      }
      const accessToken = resolveBigModelBusinessAccessToken(payload);
      if (!accessToken) {
        // Paid Coding Plan still calls bigmodel.cn business APIs with the
        // BigModel business access token; the zcode JWT goes to zcodejwttoken for Start Plan only.
        // Writing the zcode JWT into oauth:bigmodel:access_token makes plan preview report token expired forever.
        log.warn(undefined, "zcode token response missing bigmodel access token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error(
          "BigModel zcode token exchange failed: response missing data.bigmodel.access_token",
        );
      }

      const refreshToken =
        payload.data?.bigmodel?.refresh_token?.trim() ??
        payload.data?.bigmodel?.refreshToken?.trim() ??
        "";
      return {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        zcodeJwtToken,
      };
    } catch (error) {
      // The BigModel callback code is one-shot; do not pre-consume it via
      // tokenByAuthCode. On zcode-token failure abort login and record trace headers.
      log.warn(undefined, "zcode token request failed", {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError
          ? {
              method: error.method,
              status: error.status,
              url: error.url,
              responseHeaders: error.responseHeaders ?? {},
            }
          : {}),
      });
      throw error;
    }
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    if (tokenSet.zcodeJwtToken && tokenSet.accessToken === tokenSet.zcodeJwtToken) {
      // Without tokenByAuthCode the callback stage has no BigModel access token.
      // The zcode JWT cannot call bigmodel.cn customer endpoints; skip pointless auth failures.
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    const userinfoPayload = await readApiJson<{
      data?: BigModelCustomerInfo;
    }>(this.apiClient, this.config.userinfoUrl, {
      method: "GET",
      // Startup restore depends on this userinfo validation chain.
      // Without a timeout the network layer may pend forever, the UI stuck on restoring.
      // Fix 1 minute so failure paths settle, no infinite loading.
      timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
      headers: {
        // BigModel customer info wants the raw token in Authorization,
        // never a Bearer prefix, which deterministically fails auth.
        Authorization: tokenSet.accessToken,
        "Content-Type": "application/json",
      },
    });
    const customer = userinfoPayload.data;

    if (!customer) {
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    // BigModel customerName is the real account display name; nickName is a fallback.
    // Empty string equals missing in API semantics; trim-then-choose, never show a blank account.
    const username = resolveBigModelDisplayName(customer);

    return {
      id: readOptionalString(customer.customerNumber) ?? "unknown",
      username,
      displayName: username,
      avatarUrl: readOptionalString(customer.avatar),
    };
  }

  async loadLegacyTokenSet(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null> {
    const accessToken = await loadCredential("auth_token");
    if (!accessToken) {
      return null;
    }

    const refreshToken = await loadCredential("refresh_token");

    // Legacy BigModel logins wrote only auth_token/refresh_token;
    // without provider-level compat, upgrades misread them as tokenless.
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(`BigModel OAuth error: ${String(error)}`);
  }
}

function resolveBigModelBusinessAccessToken(payload: BigModelZcodeTokenEnvelope): string {
  return (
    payload.data?.bigmodel?.access_token?.trim() ??
    payload.data?.bigmodel?.accessToken?.trim() ??
    payload.data?.access_token?.trim() ??
    payload.data?.accessToken?.trim() ??
    ""
  );
}
