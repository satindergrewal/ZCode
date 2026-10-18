/*
 * ZCode official Server MCP credential resolution and identity-header construction.
 *
 * Logically equivalent to Off-Peak's offPeakRuntimeModel.ts but fully independent:
 * no shared functions, no behavior edits. Plan gates, Team support scope, and credential channels evolve
 * independently, so a shared helper would turn any side's tweak into a both-side review.
 *
 * Three deliberate differences from Off-Peak:
 *   1. Emits Bigmodel-Target-Type (Off-Peak has no producer today);
 *   2. No mock credential branch (official MCP has no mock gateway; tests inject sources);
 *   3. official_* failure classes, never Off-Peak reason strings.
 *
 * Credential channel: Coding Plan credentials ride \`X-Bigmodel-Authorization\` + the MaaS login JWT,
 * not \`X-Coding-Plan-Api-Key\`. The server marks the API-key channel legacy-client-compat, and sending both
 * headers hurts: JWT wins quota queries while API-key ownership checks still run, so one stale key 403s the
 * whole request. Off-Peak keeps the API-key channel - another reason for the equivalence-independence above.
 */
import {
  OFFICIAL_MCP_AUTH_HEADER_NAMES,
  getModelProviderFamilySpec,
  zcodeProviderAccountAccessSchema,
  type OfficialMcpAuthFailureReason,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("official-mcp");

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_OAUTH_PROVIDER_KEY = "oauth:active_provider";

/**
 * Credential key of the MaaS login JWT (\`oauth:<provider>:access_token\`, see oauth/repo/oauthCredentialRepo.ts).
 *
 * Select precisely by provider family, never cross-family fallback: ZAI's business JWT against BigModel's
 * Coding Plan yields one doomed request whose cause misleadingly reads no-plan.
 * These lines mirror bigmodelUsageQuotaProvider's reset channel, equivalent but independent (see the header).
 */
function maasJwtCredentialKey(providerFamily: "zai" | "bigmodel"): string {
  return `oauth:${getModelProviderFamilySpec(providerFamily).oauthProviderId}:access_token`;
}

/**
 * JWT remaining validity (seconds) for logs only. Never control flow; undefined on parse failure.
 *
 * Rationale: the MaaS JWT has no refresh path; once expired, queryCodingPlan upstream 401s while
 * the client sees need-Coding-Plan copy - cause and message diverge. With this number,
 * a mysterious 403 is instantly an expired token. Log the number, never the token.
 */
function readJwtExpiresInSeconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded: unknown = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const exp = (decoded as { exp?: unknown }).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    return Math.round(exp - Date.now() / 1000);
  } catch {
    return undefined;
  }
}

/** Validity-bucket granularity (seconds) of credential-resolve info logs; one log per bucket, see createCredentialResolvedLogKey. */
const CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS = 3600;

/**
 * Dedupe key of credential-resolve success logs (exported for unit tests only).
 *
 * Production logs keep the JWT validity bucket to separate expired credentials from plan gaps, without token values.
 * The resolver merges in-flight requests only, no time cache; bucket per hour so single
 * MCP calls do not info-log. Re-log on bucket change, expiry, or plan-type switch.
 */
function createCredentialResolvedLogKey(input: {
  providerFamily: "zai" | "bigmodel";
  planTargetType: string | null;
  maasJwtExpiresInSeconds: number | undefined;
}): string {
  const expires = input.maasJwtExpiresInSeconds;
  const expiryBucket =
    expires === undefined
      ? "unparsable"
      : expires <= 0
        ? "expired"
        : `t${Math.floor(expires / CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS)}`;
  return `${input.providerFamily}|${input.planTargetType ?? "none"}|${expiryBucket}`;
}

let lastCredentialResolvedLogKey: string | undefined;

interface OfficialMcpCredentialResolverDeps {
  accountRequestAuthService: {
    resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  };
  credentialService: { load(key: string): Promise<string | null | undefined> };
  modelSelectionService: {
    getView(): Promise<ModelSelectionView>;
  };
}

export type OfficialMcpPlanScope =
  | { targetType: "PERSONAL" }
  | { targetType: "TEAM"; organizationId: string; projectId: string };

export type OfficialMcpWireScope = OfficialMcpPlanScope | null;

/** Post-resolve credential snapshot. Lives in host/service memory only; mask before any RPC. */
export interface OfficialMcpCredentialSnapshot {
  jwt: string;
  /**
   * MaaS login JWT (verbatim \`oauth:<family>:access_token\`, **no Bearer prefix**).
   * buildOfficialMcpAuthHeaders adds the prefix, matching reset/usage channel conventions.
   */
  codingPlanAuthorization?: string;
  providerFamily: "zai" | "bigmodel";
  /** Product/quota ownership of the selected connection; null when legacy Team keys cannot attribute. */
  planScope: OfficialMcpPlanScope | null;
  /** Identity-header scope actually sent to Server MCP; null, as ZAI Team and Off-Peak. */
  wireScope: OfficialMcpWireScope;
}

export type OfficialMcpCredentialOutcome =
  | { ok: true; snapshot: OfficialMcpCredentialSnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

type SelectedPlan = {
  providerFamily: "zai" | "bigmodel";
  providerId: string;
  planScope: OfficialMcpPlanScope | null;
  wireScope: OfficialMcpWireScope;
};

type SelectedProvider = {
  providerId: string;
  access: ZCodeProviderAccountAccess;
};

function fail(reason: OfficialMcpAuthFailureReason): {
  ok: false;
  reason: OfficialMcpAuthFailureReason;
} {
  return { ok: false, reason };
}

/**
 * Determine the enabled Coding Plan provider from the Registry; dynamic plan and Team scope resolve in the account service.
 * Never read nor fabricate the current Team scope from static Provider Config.
 */
function resolveSelectedProvider(
  registry: ModelSelectionView,
): { ok: true; provider: SelectedProvider } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  const candidates = registry.providers.flatMap((provider) => {
    const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    return parsed.success &&
      (parsed.data.mode === "individual-coding-plan" || parsed.data.mode === "team-coding-plan")
      ? [{ providerId: provider.providerId, access: parsed.data }]
      : [];
  });
  if (candidates.length !== 1) {
    return fail("official_auth_plan_required");
  }
  return { ok: true, provider: candidates[0]! };
}

function resolveSelectedPlan(
  selectedProvider: SelectedProvider,
  access: ZCodeAccountAccess | null,
): { ok: true; plan: SelectedPlan } | { ok: false; reason: OfficialMcpAuthFailureReason } {
  if (
    !access ||
    access.family !== selectedProvider.access.accountType ||
    (selectedProvider.access.mode === "team-coding-plan"
      ? access.planKind !== "team-coding-plan"
      : access.planKind !== "individual-coding-plan")
  ) {
    return fail("official_auth_plan_required");
  }
  const { providerId } = selectedProvider;
  const providerFamily = access.family;
  if (access.planKind === "team-coding-plan") {
    const teamScope: OfficialMcpPlanScope = {
      organizationId: access.organizationId,
      projectId: access.projectId,
      targetType: "TEAM",
    };
    return {
      ok: true,
      plan: {
        providerFamily,
        providerId,
        planScope: teamScope,
        wireScope: providerFamily === "bigmodel" ? teamScope : null,
      },
    };
  }
  return {
    ok: true,
    plan: {
      providerFamily,
      providerId,
      planScope: { targetType: "PERSONAL" },
      wireScope: { targetType: "PERSONAL" },
    },
  };
}

/** Non-secret selection fingerprint, compared pre/post resolve so two generations never splice into one request. */
function createSelectionFingerprint(registry: ModelSelectionView): string {
  return JSON.stringify({ revision: registry.revision, providers: registry.providers });
}

type OfficialMcpIdentitySnapshot = {
  activeProvider: "zai" | "bigmodel";
  jwt: string;
  registry: ModelSelectionView;
  selectionFingerprint: string;
};

async function readIdentitySnapshot(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<
  | { ok: true; snapshot: OfficialMcpIdentitySnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason }
> {
  const [registry, activeProviderValue, jwtValue] = await Promise.all([
    deps.modelSelectionService.getView(),
    deps.credentialService.load(ACTIVE_OAUTH_PROVIDER_KEY),
    deps.credentialService.load(ZCODE_JWT_TOKEN_KEY),
  ]);
  const activeProvider = activeProviderValue?.trim();
  const jwt = jwtValue?.trim() ?? "";
  if ((activeProvider !== "zai" && activeProvider !== "bigmodel") || !jwt) {
    return fail("official_auth_unavailable");
  }
  return {
    ok: true,
    snapshot: {
      activeProvider,
      jwt,
      registry,
      selectionFingerprint: createSelectionFingerprint(registry),
    },
  };
}

function isSameIdentitySnapshot(
  before: OfficialMcpIdentitySnapshot,
  after: OfficialMcpIdentitySnapshot,
): boolean {
  return (
    before.activeProvider === after.activeProvider &&
    before.jwt === after.jwt &&
    before.selectionFingerprint === after.selectionFingerprint
  );
}

function identityOnlyOutcome(identity: OfficialMcpIdentitySnapshot): OfficialMcpCredentialOutcome {
  log.debug("official mcp identity-only credentials resolved", {
    providerFamily: identity.activeProvider,
    reason: "official_auth_plan_required",
  });
  return {
    ok: true,
    snapshot: {
      jwt: identity.jwt,
      planScope: null,
      providerFamily: identity.activeProvider,
      wireScope: null,
    },
  };
}

/**
 * Resolve the official MCP credentials of the selected connection.
 *
 * Race guard: Registry, dynamic Account Access, active provider, zcode JWT, and MaaS JWT
 * may all change mid-resolve. Sample before/after and compare; any mismatch restarts the whole
 * round, never splicing generations - neither cross-family mixes (ZAI JWT + BigModel key)
 * nor same-family rotation (old JWT + new JWT). Still unstable after two rounds: unavailable.
 */
export async function resolveOfficialMcpCredentials(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<OfficialMcpCredentialOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await readIdentitySnapshot(deps);
    if (!identity.ok) {
      if (attempt === 0) continue;
      return identity;
    }
    const selectedProvider = resolveSelectedProvider(identity.snapshot.registry);
    if (!selectedProvider.ok) {
      const latestIdentity = await readIdentitySnapshot(deps);
      if (
        !latestIdentity.ok ||
        !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot)
      ) {
        continue;
      }
      return identityOnlyOutcome(identity.snapshot);
    }
    const accountAccess = await deps.accountRequestAuthService.resolveAccessCurrent(
      selectedProvider.provider.access,
    );
    const selected = resolveSelectedPlan(selectedProvider.provider, accountAccess);
    if (!selected.ok) return selected;

    // The zcode JWT mirrors global login; checking selectedKey only can splice a ZAI JWT with a BigModel key.
    if (identity.snapshot.activeProvider !== selected.plan.providerFamily) {
      return fail("official_auth_unavailable");
    }

    const maasJwtKey = maasJwtCredentialKey(selected.plan.providerFamily);
    const codingPlanAuthorization = (await deps.credentialService.load(maasJwtKey))?.trim() ?? "";
    if (!codingPlanAuthorization) {
      // Classify unavailable, not plan_required: incomplete login (re-login needed),
      // not no-plan. Both provider adapters hard-require this token at login,
      // so normal flows never hit it; it appears on legacy-migrated login states.
      log.warn("official mcp maas jwt missing", {
        providerFamily: selected.plan.providerFamily,
        reason: "official_auth_unavailable",
      });
      return fail("official_auth_unavailable");
    }

    const [latestIdentity, latestMaasJwt] = await Promise.all([
      readIdentitySnapshot(deps),
      deps.credentialService.load(maasJwtKey),
    ]);
    const latestSelectedProvider = latestIdentity.ok
      ? resolveSelectedProvider(latestIdentity.snapshot.registry)
      : latestIdentity;
    const latestAccountAccess = latestSelectedProvider.ok
      ? await deps.accountRequestAuthService.resolveAccessCurrent(
          latestSelectedProvider.provider.access,
        )
      : null;
    if (
      !latestIdentity.ok ||
      !isSameIdentitySnapshot(identity.snapshot, latestIdentity.snapshot) ||
      !latestSelectedProvider.ok ||
      JSON.stringify(accountAccess) !== JSON.stringify(latestAccountAccess) ||
      codingPlanAuthorization !== (latestMaasJwt?.trim() ?? "")
    ) {
      continue;
    }

    // The provider entry only proves the Coding Plan connection exists. The business key is no credential
    // (MaaS JWT channel now), so do not require a value - otherwise a mid-refresh transient
    // misjudges a workable call as no-plan. Real no-plan is caught by the two gates above:
    // API-key mode and selected Start Plan connection, neither needing the business key.
    const provider = identity.snapshot.registry.providers.find(
      (candidate) => candidate.providerId === selected.plan.providerId,
    );
    if (!provider) return fail("official_auth_plan_required");

    // info not debug: production drops debug, and MaaS JWT remaining validity is the key triage clue
    // (see createCredentialResolvedLogKey). Log remaining seconds, never the token.
    // Log only across buckets, keeping log volume far below request count.
    const maasJwtExpiresInSeconds = readJwtExpiresInSeconds(codingPlanAuthorization);
    const logKey = createCredentialResolvedLogKey({
      providerFamily: selected.plan.providerFamily,
      planTargetType: selected.plan.planScope?.targetType ?? null,
      maasJwtExpiresInSeconds,
    });
    if (logKey !== lastCredentialResolvedLogKey) {
      lastCredentialResolvedLogKey = logKey;
      log.info("official mcp credentials resolved", {
        maasJwtExpiresInSeconds,
        providerFamily: selected.plan.providerFamily,
        planTargetType: selected.plan.planScope?.targetType ?? null,
        wireTargetType: selected.plan.wireScope?.targetType ?? null,
      });
    }

    return {
      ok: true,
      snapshot: {
        codingPlanAuthorization,
        jwt: identity.snapshot.jwt,
        planScope: selected.plan.planScope,
        providerFamily: selected.plan.providerFamily,
        wireScope: selected.plan.wireScope,
      },
    };
  }

  return fail("official_auth_unavailable");
}

/**
 * Build this request's identity headers from the credential snapshot.
 * Team identity is pair-atomic: with either of organization/project missing, send neither.
 */
export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}`,
  };
  if (snapshot.codingPlanAuthorization) {
    // The server CutPrefixes 'Bearer ' and accepts bare tokens; send Bearer form per the MCP API docs.
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] =
      `Bearer ${snapshot.codingPlanAuthorization}`;
  }
  const scope = snapshot.wireScope;
  if (scope) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = scope.targetType;
    if (scope.targetType === "TEAM") {
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.organization] = scope.organizationId;
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.project] = scope.projectId;
    }
  }
  return headers;
}

/** Request context relayed by the host handler; never part of credential selection. */
interface OfficialMcpAuthHeadersRequestContext {
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * Identity-header resolution entry with in-flight dedupe.
 *
 * Merge concurrent requests only: later callers reuse the in-flight Promise; dropped at settle,
 * the next request resolves fully. No time-based cache, so no stale-credential read window exists.
 // Host-global scope: credentials are global state; per plugin/mcpKey/workspace bucketing weakens dedupe, adds no isolation.
 */
export function createOfficialMcpAuthHeadersResolver(deps: OfficialMcpCredentialResolverDeps): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  let pending: Promise<OfficialMcpAuthHeadersOutcome> | null = null;

  return {
    // request exists for contract parity (the host handler validated trust earlier, see zcodeAgentService);
    // credentials are host-global and NOT bucketed by plugin/mcpKey/workspace - bucketing weakens in-flight
    // dedupe without adding isolation. Params stay so future audits need no signature change.
    resolveHeaders(_request?: OfficialMcpAuthHeadersRequestContext) {
      if (pending) return pending;
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        const outcome = await resolveOfficialMcpCredentials(deps);
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        return { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) };
      })();
      pending = inFlight;
      // Use two-arg then, not finally: finally derives an equally-rejecting promise
      // the caller never awaits (only inFlight), becoming an unhandled rejection.
      // Clear the slot on resolve errors too, or later requests reuse the failed Promise forever.
      const clear = (): void => {
        if (pending === inFlight) pending = null;
      };
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
