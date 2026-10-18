/*
 * Credential resolution and identity headers for the official ZCode server MCP.
 *
 * This mirrors offPeakRuntimeModel.ts (Off-Peak) in spirit but is fully independent:
 * no shared functions, no behavior changes there. Plan gates, team support, and credential channels will evolve separately,
 * and a shared helper would turn any tweak into a cross-impact review.
 *
 * Three deliberate differences from Off-Peak:
 *   1. Emits Bigmodel-Target-Type (Off-Peak has no producer yet);
 *   2. No mock-credential branch (no mock gateway here; tests inject sources);
 *   3. Failures classify as official_*, never Off-Peak reason strings.
 *
 * Credential channel: Coding Plan uses X-Bigmodel-Authorization with the MaaS login JWT
 * and no longer sends X-Coding-Plan-Api-Key. The server flags the key channel legacy-only, and
 * sending both hurts: the JWT wins the quota lookup while key attribution still runs, so one stale key
 * 403s the request. Off-Peak keeps the key channel, another reason for the split.
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
 * Credential key of the MaaS login JWT (oauth:<provider>:access_token; see oauth/repo/oauthCredentialRepo.ts).
 *
 * Select per provider family with no cross-family fallback: a ZAI JWT against BigModel
 * Coding Plan buys one doomed request blaming a missing plan.
 * Equivalent-but-independent of the bigmodelUsageQuotaProvider reset channel (see header).
 */
function maasJwtCredentialKey(providerFamily: "zai" | "bigmodel"): string {
  return `oauth:${getModelProviderFamilySpec(providerFamily).oauthProviderId}:access_token`;
}

/**
 * Logs-only JWT remaining validity in seconds. No control flow; undefined when unparseable.
 *
 * Why: the MaaS JWT never refreshes; expiry surfaces as a queryCodingPlan upstream 401
 * while clients see need-a-plan copy. With this number,
 * mysterious 403s read as expired-token instantly. Log the number, never the token.
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

/* */
const CREDENTIAL_RESOLVED_LOG_BUCKET_SECONDS = 3600;

/**
 * Dedupe key for credential-resolved logs (exported for tests only).
 *
 * Production logs keep validity buckets to split expired-credential from no-plan, without token values.
 * The resolver merges in-flight requests only, no time cache; bucket hourly so
 * every MCP call is not an info line. Re-log on bucket change, expiry, or plan-type switch.
 */
export function createCredentialResolvedLogKey(input: {
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

export interface OfficialMcpCredentialResolverDeps {
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

/** Post-resolution credential snapshot. Lives in host/service memory; sanitized before any RPC. */
export interface OfficialMcpCredentialSnapshot {
  jwt: string;
  /**
   * The MaaS login JWT (oauth:<family>:access_token verbatim, no Bearer prefix).
   * buildOfficialMcpAuthHeaders adds the prefix, matching reset/usage conventions.
   */
  codingPlanAuthorization?: string;
  providerFamily: "zai" | "bigmodel";
  //* Product/quota owner of the selected connection; null when legacy keys cannot attribute. */
  planScope: OfficialMcpPlanScope | null;
  //* Identity-header scope actually sent; null for ZAI Team, matching Off-Peak. */
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
 * Reads the enabled Coding Plan provider from the registry; plan type and team scope come from the account services.
 * Never read or fabricate team scope from static provider config.
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

/** Non-secret selection fingerprint, compared across the resolution to avoid mixing generations. */
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
 * Resolves credentials for the selected connection.
 *
 * Race safety: registry, account access, active provider, and both JWTs
 * can change mid-resolution. Snapshot before/after and compare; any mismatch restarts
 * the whole pass. Never stitch generations: neither cross-family mixes (ZAI zcode JWT + BigModel MaaS JWT)
 * nor same-family rotations. Two unstable passes return unavailable.
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

    // The zcode JWT mirrors global login; checking selectedKey alone can mix ZAI JWT with a BigModel key.
    if (identity.snapshot.activeProvider !== selected.plan.providerFamily) {
      return fail("official_auth_unavailable");
    }

    const maasJwtKey = maasJwtCredentialKey(selected.plan.providerFamily);
    const codingPlanAuthorization = (await deps.credentialService.load(maasJwtKey))?.trim() ?? "";
    if (!codingPlanAuthorization) {
      // Classify unavailable, not plan_required: the login state is incomplete (re-login needed),
      // not a missing plan. Both adapters persist this token at login,
      // so normal flows never hit this; legacy imports do.
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

    // The provider entry only proves the connection exists. The business key is no longer the credential
    // (the MaaS JWT channel is), so do not require a value: a mid-refresh key
    // would fail a viable call as plan-less. Real plan checks stay in the two gates above:
    // API-key mode and a selected Start Plan, neither key-dependent.
    const provider = identity.snapshot.registry.providers.find(
      (candidate) => candidate.providerId === selected.plan.providerId,
    );
    if (!provider) return fail("official_auth_plan_required");

    // info, not debug: prod drops debug, and remaining JWT validity is the key triage clue
    // (see createCredentialResolvedLogKey). Log seconds, never the token.
    // Log only on bucket change so log volume tracks buckets, not call counts.
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
 * Builds request identity headers from the snapshot.
 * Team identity is atomic: send both or neither.
 */
export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}`,
  };
  if (snapshot.codingPlanAuthorization) {
    // The server CutPrefixes Bearer and accepts bare tokens; send Bearer per the MCP doc.
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

/** Request context passed through by the host handler; never selects credentials. */
export interface OfficialMcpAuthHeadersRequestContext {
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

export type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * Identity-header entry point with in-flight dedupe.
 *
 * Only concurrent calls share: latecomers reuse the in-flight Promise, dropped on settle,
 * and the next request resolves fresh. No time-based cache, so no stale-credential window.
 * Host-global scope: credentials are global, and bucketing by plugin/mcpKey/workspace would weaken dedupe, not add isolation.
 */
export function createOfficialMcpAuthHeadersResolver(deps: OfficialMcpCredentialResolverDeps): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  let pending: Promise<OfficialMcpAuthHeadersOutcome> | null = null;

  return {
    // request exists for the contract only (the host handler already validated; see zcodeAgentService);
    // credentials are host-global and never bucketed by plugin/mcpKey/workspace; buckets would weaken
    // in-flight dedupe without adding isolation. Params stay for future audits.
    resolveHeaders(_request?: OfficialMcpAuthHeadersRequestContext) {
      if (pending) return pending;
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        const outcome = await resolveOfficialMcpCredentials(deps);
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        return { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) };
      })();
      pending = inFlight;
      // Use paired then handlers, not finally: finally derives a equally-rejecting promise
      // nobody awaits, turning into an unhandled rejection.
      // Clear the slot on errors or every later request reuses the failed Promise.
      const clear = (): void => {
        if (pending === inFlight) pending = null;
      };
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
