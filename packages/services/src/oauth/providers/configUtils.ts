import {
  ZCODE_VERSION,
  buildRuntimeZCodeApiUrl,
  buildRuntimeZCodeEndpointUrls,
} from "@zcode/shared";

const DESKTOP_OAUTH_CALLBACK_URI = "zcode://oauth/callback";

export function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnv(env, key);
  if (raw == null) {
    return fallback;
  }

  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function buildZCodeApiUrlFromEnv(env: NodeJS.ProcessEnv, path: string): string {
  // OAuth providers are runtime config following env.ZCODE_ENV;
  // hosts come from generic .env values, production default; login and token exchange share one config source.
  return buildRuntimeZCodeApiUrl(env, path);
}

export function buildDesktopOAuthRedirectUriFromEnv(env: NodeJS.ProcessEnv): string {
  const url = new URL("/app/oauth/login", buildRuntimeZCodeEndpointUrls(env).origin);
  url.searchParams.set("redirect", DESKTOP_OAUTH_CALLBACK_URI);
  // Website gates auto deep link on the app version; without it, keep legacy client behavior.
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}
