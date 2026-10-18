/* Shared constants and types for ZCode official-server MCP auth.
   In shared because the header set has two consumers in different packages:
   - packages/services produces the identity headers;
   - apps/zcode-cli/packages/adapters (plugin parser + MCP adapter) intercepts and preserves them.
   Both must share one source, or a new identity header would miss the blocklist, leaving static headers able to shadow credentials. */

/// The only legal value of `auth.type` in `.mcp.json`; case-sensitive, no aliases.
export const ZCODE_OFFICIAL_MCP_AUTH_TYPE = "zcode_official" as const;

/// The only legal provider in phase one. Later short-lived tokens add new provider values without changing this one's meaning.
export const ZCODE_OFFICIAL_MCP_AUTH_PROVIDER_JWT_TOKEN = "jwt_token" as const;

/**
 * Official MCP uses two independent credential sets: user identity and plan identity.
 * codingPlanAuthorization must carry the MaaS login JWT; the Coding Plan business API key
 * is not a substitute. The server validates the JWT's customer_id against the current user.
 */
export const OFFICIAL_MCP_AUTH_HEADER_NAMES = {
  authorization: "Authorization",
  codingPlanAuthorization: "X-Bigmodel-Authorization",
  targetType: "Bigmodel-Target-Type",
  organization: "Bigmodel-Organization",
  project: "Bigmodel-Project",
} as const;

/**
 * Key carrying the stdio official-MCP identity headers on every outbound request/notification's `params._meta`.
 *
 * A **cross-language protocol constant** with plugin processes--the plugin side (e.g. a plugin's Python server)
 * reads the same string. Renaming breaks every published plugin: a protocol breaking change.
 * The namespace prefix stays `com.zcode/`, matching the existing `com.zcode/request-context`.
 */
export const OFFICIAL_MCP_AUTH_META_KEY = "com.zcode/official-mcp-auth" as const;

/**
 * Reserved headers forbidden in static plugin `headers` (lowercase; comparison case-insensitive).
 *
 * Identity headers: prevent plugin static config from forging or shadowing credentials.
 * Protocol headers (mcp-session-id / mcp-protocol-version): the SDK's `requestInit.headers` takes
 * precedence over protocol headers, so static config could override the session id--forbidden too.
 *
 * `x-coding-plan-api-key` is no longer sent by clients (moved to the MaaS JWT channel) but **must stay
 * on the blocklist**: the server-side channel still exists (`credential := cmp.Or(Authorization, APIKey)`);
 * removing it would let a plugin smuggle a Coding Plan credential via static header against the official endpoint.
 * Listed explicitly rather than derived from the header table precisely because the table no longer has it.
 */
export const OFFICIAL_MCP_RESERVED_HEADER_NAMES: readonly string[] = [
  ...Object.values(OFFICIAL_MCP_AUTH_HEADER_NAMES).map((name) => name.toLowerCase()),
  "x-coding-plan-api-key",
  "mcp-session-id",
  "mcp-protocol-version",
];

const RESERVED_HEADER_SET = new Set(OFFICIAL_MCP_RESERVED_HEADER_NAMES);

/** Case-insensitive reserved-header test. */
export function isOfficialMcpReservedHeaderName(name: string): boolean {
  return RESERVED_HEADER_SET.has(name.trim().toLowerCase());
}

/** Reserved headers hit in a static-header record (lowercase, deduped, stably sorted); empty when none. */
export function findOfficialMcpReservedHeaders(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) return [];
  const hits = new Set<string>();
  for (const name of Object.keys(headers)) {
    const normalized = name.trim().toLowerCase();
    if (RESERVED_HEADER_SET.has(normalized)) hits.add(normalized);
  }
  return [...hits].sort();
}

/** Values of the server's `Bigmodel-Target-Type` (aligned with zcode-server's CodingPlanTargetType). */
export type OfficialMcpTargetType = "PERSONAL" | "TEAM";

/**
 * Port/protocol-level failure classes (the two "no request sent" cases).
 * Network-layer failures (401/403/3xx) are classified by the MCP adapter after the response, not via this enum.
 */
export const OFFICIAL_MCP_AUTH_FAILURE_REASONS = [
  "official_auth_unavailable",
  "official_auth_plan_required",
] as const;

export type OfficialMcpAuthFailureReason = (typeof OFFICIAL_MCP_AUTH_FAILURE_REASONS)[number];

export const OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS = [
  ...OFFICIAL_MCP_AUTH_FAILURE_REASONS,
  "official_mcp_origin_untrusted",
] as const;

export type OfficialMcpAuthPortFailureReason =
  (typeof OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS)[number];

/** The MCP adapter's full failure classification, including network results. For record status and logs only. */
export type OfficialMcpAuthFailureKind =
  | OfficialMcpAuthFailureReason
  | "official_mcp_origin_untrusted"
  | "official_auth_rejected"
  | "official_auth_forbidden"
  | "official_auth_redirect_blocked";

// -- Official MCP trust adjudication --
// In shared, not the CLI bootstrap, because two consumers in mutually blind packages need it:
//   - apps/zcode-cli/packages/adapters: local validation before the request;
 //   - packages/services (host): a second check at the identity authority boundary (depends only on @zcode/shared,
//     cannot import CLI-side packages).
// A single source is a hard requirement: divergent checks would have one side allow and the other reject.

/**
 * Normalized origin: must be https, no username/password, and the URL itself in origin form.
 * Credential-bearing URLs are rejected because `https://user:pass@a.example`'s origin is `https://a.example`; comparing
 * against the origin alone would let it pass.
 */
function normalizeHttpsOrigin(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.username !== "" || url.password !== "") return undefined;
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLoopbackOrigin(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.username !== "" || url.password !== "") return undefined;
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export const OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV = "ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS";

/** The real workspace identity injected by the host at spawn; for isolation/audit only, not file execution. */
export const ZCODE_WORKSPACE_IDENTITY_ENV = "ZCODE_WORKSPACE_IDENTITY";

/** Safe log summary of the identity headers: names, Team pairing, TargetType; no values. */
export function summarizeOfficialMcpIdentityHeaders(
  headers: Record<string, string>,
): Record<string, unknown> {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const organization = lower.has("bigmodel-organization");
  const project = lower.has("bigmodel-project");
  return {
    identityHeaderNames: [...lower.keys()].sort(),
    identityOrganizationPresent: organization,
    identityProjectPresent: project,
    identityTeamPaired: organization === project,
    ...(lower.get("bigmodel-target-type")
      ? { identityTargetType: lower.get("bigmodel-target-type") }
      : {}),
  };
}

export interface OfficialMcpTrustResult {
  trusted: boolean;
  /// Human-readable rejection reason, for logs only, never flow branching.
  detail: "ok" | "invalid_input" | "origin_mismatch" | "zcode_origin_unresolved";
}

export interface IsOfficialMcpOriginTrustedInput {
  /// Raw value of the local self-test switch (usually env); opens http loopback only.
  devTrustedOriginsRaw?: string | undefined;
  origin: string;
  /**
   * The id of the plugin declaring this MCP. **Not part of trust adjudication**; attribution for
   * logs and credential resolution. Kept in the input so logs can answer "which plugin asked".
   */
  pluginId: string;
  /// The current ZCode API origin, resolved by each caller under its own rules.
  zcodeApiOrigin: string | undefined;
}

/**
 * Validate official-MCP credential targets: require an HTTPS origin equal to the runtime ZCode API origin,
 * and a URL without username/password. Dev config allows only explicitly listed HTTP loopback origins.
 *
 * pluginId is attribution/logging, not an authorization filter; any loaded plugin may request official auth.
 * Destination checks do not replace per-endpoint user/plan/quota checks, nor per-plugin consent.
 * Plugins using stdio auth hold credentials and must be treated as trusted executable code.
 */
export function isOfficialMcpOriginTrusted(
  input: IsOfficialMcpOriginTrustedInput,
): OfficialMcpTrustResult {
  const origin = input.origin.trim();
  if (!origin) {
    return { detail: "invalid_input", trusted: false };
  }

  // Local self-test switch: http loopback only, so credentials cannot be steered to a remote host.
  // The **target origin itself must be loopback**: otherwise both normalizes yield undefined,
  // and `undefined === undefined` would let the switch open every origin (https remotes included).
  const loopbackOrigin = normalizeLoopbackOrigin(origin);
  if (loopbackOrigin) {
    for (const candidate of parseDevTrustedOrigins(input.devTrustedOriginsRaw)) {
      if (normalizeLoopbackOrigin(candidate) === loopbackOrigin) {
        return { detail: "ok", trusted: true };
      }
    }
  }

  const expected = input.zcodeApiOrigin ? normalizeHttpsOrigin(input.zcodeApiOrigin) : undefined;
  if (!expected) return { detail: "zcode_origin_unresolved", trusted: false };
  if (normalizeHttpsOrigin(origin) !== expected) {
    return { detail: "origin_mismatch", trusted: false };
  }
  return { detail: "ok", trusted: true };
}

/**
 * Local self-test switch: comma-separated loopback origins, e.g. `http://127.0.0.1:3999`.
 * http loopback only: the worst case is sending your own JWT to a local process that could read the same
 * credential anyway--no new trust surface. Unset behaves exactly as if the switch did not exist.
 */
function parseDevTrustedOrigins(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The trust adjudicator. `isTrusted` keeps this DI shape so adapter and host share one implementation.
 * Async so the host can resolve the origin from settings (same rule as off-peak tasks), avoiding
 * "off-peak connects, official MCP does not" splits.
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: {
    mcpKey: string;
    origin: string;
    pluginId: string;
  }): Promise<OfficialMcpTrustResult>;
}

export interface CreateOfficialMcpTrustedOriginRegistryOptions {
  /// Raw self-test switch value (comma-separated loopback origins), usually env.
  devTrustedOriginsRaw?: string | undefined;
  /// Resolver of the current ZCode API origin; both sides must use equivalent rules or one allows while the other rejects.
  resolveZCodeApiOrigin: () => string | undefined | Promise<string | undefined>;
}

export function createOfficialMcpTrustedOriginRegistry(
  options: CreateOfficialMcpTrustedOriginRegistryOptions,
): OfficialMcpTrustedOriginRegistry {
  return {
    async isTrusted({ origin, pluginId }) {
      let zcodeApiOrigin: string | undefined;
      try {
        zcodeApiOrigin = await options.resolveZCodeApiOrigin();
      } catch {
        // Resolve failure means untrusted; never allow just because the origin is unavailable.
        return { detail: "zcode_origin_unresolved", trusted: false };
      }
      return isOfficialMcpOriginTrusted({
        devTrustedOriginsRaw: options.devTrustedOriginsRaw,
        origin,
        pluginId,
        zcodeApiOrigin,
      });
    },
  };
}
