import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_WORKSPACE_IDENTITY_ENV,
} from "@zcode/shared";

// Translate the settings-page HTTP proxy, No Proxy and custom CA into env patches for the
// agent subprocess. The agent is a child process inheriting the host process.env; proxy and CA
// are injected at spawn time, so changes apply on the next agent start.
//
// Proxy: set the uppercase standard trio so the settings page wins over inherited shell variables
// (model registry matches uppercase first, HTTPS_PROXY -> HTTP_PROXY -> ...); also set
// ZCODE_HTTP_PROXY so Bash tool subprocesses get the highest priority via subprocess-env.
//
// No Proxy: accept only bypass rules explicitly set in the settings page. Also set
// ZCODE_NO_PROXY so provider/http adapters reuse the same rules without reading the user
// shell NO_PROXY.
//
// Custom CA: accept only a PEM path explicitly set in the settings page. NODE_EXTRA_CA_CERTS makes
// the agent (including model provider requests) trust it at Node startup, while ZCODE_AGENT_CA_CERT
// covers adapters and tool subprocesses across runtimes.

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  ZCODE_HTTP_PROXY_ENV_KEY,
] as const;
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy", ZCODE_NO_PROXY_ENV_KEY] as const;

function buildAgentProxyEnv(httpProxy: string | undefined): Record<string, string> {
  const normalized = normalizeProxyValue(httpProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

function buildAgentCaCertEnv(caCertPath: string | undefined): Record<string, string> {
  const trimmed = caCertPath?.trim();
  if (!trimmed) {
    return {};
  }
  return {
    // NODE_EXTRA_CA_CERTS must exist before the Node process starts; ZCODE_AGENT_CA_CERT serves
    // runtime config, provider fetches and tool subprocesses, so the app-injected cert path
    // survives the standard CA env sanitization.
    NODE_EXTRA_CA_CERTS: trimmed,
    [ZCODE_AGENT_CA_CERT_ENV_KEY]: trimmed,
  };
}

function buildAgentNoProxyEnv(noProxy: string | undefined): Record<string, string> {
  const normalized = normalizeNoProxyValue(noProxy);
  if (!normalized) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const key of NO_PROXY_ENV_KEYS) {
    env[key] = normalized;
  }
  return env;
}

/**
 * Runtime env patch resolved once at agent spawn: proxy + No Proxy + custom CA.
 * Every value comes only from explicit AppSettings; standard proxy/cert variables from the user
 * shell are already sanitized upstream.
 */
export function buildAgentRuntimeEnv(input: {
  httpProxy: string | undefined;
  noProxy?: string | undefined;
  caCertPath?: string | undefined;
}): Record<string, string> {
  const proxyEnv = buildAgentProxyEnv(input.httpProxy);
  return {
    ...proxyEnv,
    ...buildAgentNoProxyEnv(input.noProxy),
    ...buildAgentCaCertEnv(input.caCertPath),
  };
}

/**
 * Forward the authoritative ZCode API origin already resolved by the host to the agent subprocess.
 *
 * The official-MCP trust checks on both sides share one implementation in `@zcode/shared`, but the
 * inputs used to diverge: the host called `resolveRuntimeZCodeEndpointOrigin(env, { overrideOrigin:
 * settings.zcodeEndpointOrigin })` while the agent only called `resolveRuntimeZCodeEndpointOrigin(env)`,
 * so the settings override never reached the subprocess. With `ZCODE_ENV=test` and a custom endpoint
 * configured in the settings page, the two sides necessarily compute different origins, and the
 * official MCP gets fail-closed rejected on one side, with logs that look like a misconfigured
 * plugin url. A single-source implementation cannot fix diverging inputs, so the inputs must be
 * unified too.
 *
 * Why inject `ZCODE_BASE_URL` instead of parameterizing only the trust check: the agent calls
 * `resolveRuntimeZCodeEndpointOrigin` in 4 places (trust check, provider routing origin header,
 * model-config, auth-login), all reading the same env; one injection aligns all of them, while
 * fixing only the trust check would leave the other 3 divergent.
 *
 * Idempotency: the input is the host's final resolved value. The agent inherits the host
 * process.env, so its env derivation already equals the host's; stacking the override yields
 * exactly this value. In production the host ignores the override, the injected value equals the
 * env-derived value, and behavior is unchanged.
 *
 * Freshness: same semantics as proxy/CA - read at spawn, effective on the next agent start. When
 * settings change mid-session the host updates immediately while the agent keeps the old value
 * until it restarts; the mismatch only fails closed in between, never opens access.
 */
export function buildAgentEndpointOriginEnv(
  endpointOrigin: string | undefined,
): Record<string, string> {
  const trimmed = endpointOrigin?.trim();
  if (!trimmed) {
    return {};
  }
  // ZCODE_BASE_URL is the highest-priority key for envBaseOrigin in resolveRuntimeZCodeEndpointOrigin,
  // so it also wins over the inherited ZCODE_ENDPOINT_ORIGIN.
  return { ZCODE_BASE_URL: trimmed };
}

/** Inject the remote workspace identity known to the host into the matching agent; local workspaces keep the path fallback. */
export function buildAgentWorkspaceIdentityEnv(
  workspaceIdentity: string | undefined,
): Record<string, string> {
  const trimmed = workspaceIdentity?.trim();
  return trimmed ? { [ZCODE_WORKSPACE_IDENTITY_ENV]: trimmed } : {};
}

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // Already has a scheme (http://, socks5://, ...): keep as-is; bare host:port gets http://.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeNoProxyValue(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}
