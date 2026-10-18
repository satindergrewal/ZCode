import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountProviderUnavailableReason,
  AccountProviderConnectionResolver,
  AccountProviderConnectionResult,
  ProviderConfigSnapshot,
  ProviderSource,
} from "@zcode/provider";
import { AccountProviderService, createAccountProviderConfigResolver } from "@zcode/provider";
import {
  type ApiClient,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type {
  CodingPlanAvailabilityProvider,
  CodingPlanAvailabilityResult,
  CodingPlanUnavailableReason,
} from "#src/model-provider/codingPlanProviderAvailability.js";
import {
  validateBigModelAccountProviderAvailability,
  validateZaiAccountProviderAvailability,
} from "#src/model-provider/codingPlanProviderAvailability.js";

export interface AccountProviderConnectionSettings {
  readonly providerFamilyDomain: ProviderFamilyDomain | null;
  readonly selections: ProviderFamilyConnectionSelectionSettings;
  /** Legacy host-imported connections have no proven identity; runtime fact only, never config or protocol. */
  readonly unresolvedFamilies?: readonly ProviderFamilyDomain[];
}

export interface AccountProviderFamilyAvailabilityInput {
  readonly family: ProviderFamilyDomain;
  readonly providers: readonly CodingPlanAvailabilityProvider[];
  readonly selections: ProviderFamilyConnectionSelectionSettings;
}

export type AccountProviderFamilyAvailabilityResolver = (
  input: AccountProviderFamilyAvailabilityInput,
) => Promise<Partial<Record<string, CodingPlanAvailabilityResult>>>;

export interface AccountProviderConnectionResolverOptions {
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadCodingPlanApiKey: (
    providerId: string,
    family: ProviderFamilyDomain,
    accountIdentity: string,
    forceRefresh: boolean,
  ) => Promise<string | null>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveFamilyAvailability: AccountProviderFamilyAvailabilityResolver;
}

export interface CodingPlanFamilyAvailabilityResolverOptions {
  readonly apiClient: ApiClient;
  readonly credentialService?: {
    load(key: string): Promise<string | null>;
  };
}

export interface AccountProviderConfigSourceOptions extends AccountProviderConnectionResolverOptions {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
}

/**
 * Neither off-peak nor highspeed is a plan of its own; both derive from a connected personal/team Coding Plan.
 * Execution entries authenticated per request via ticket / highspeed-card JWTs; neither holds a checkable plan key.
 * So neither enters Coding Plan availability checks nor compares directly on selection.kind.
 */
function isCodingPlanDerivedMode(mode: string | undefined): mode is "off-peak" | "highspeed" {
  return mode === "off-peak" || mode === "highspeed";
}

/**
 * Projects account state, connection mode, and plan entitlements into one domain Connection Result.
 *
 * The adapter holds no credentials. Where the Personal Coding Plan key physically lives is the injector's call;
 * Start/Team dynamic credentials keep flowing through the existing availability dependency per request.
 */
export function createAccountProviderConnectionResolver(
  options: AccountProviderConnectionResolverOptions,
): AccountProviderConnectionResolver {
  let previousScopes = new Map<string, string>();
  return async ({ configuredProviders, reasons = [] }) => {
    const settings = structuredClone(await options.readSettings());
    const forceCredentialRefresh = reasons.some(isCredentialRefreshReason);
    const accountIdentityByFamily = new Map<ProviderFamilyDomain, Promise<string | null>>();
    const loadAccountIdentity = (family: ProviderFamilyDomain) => {
      const existing = accountIdentityByFamily.get(family);
      if (existing) return existing;
      const pending = options.loadAccountIdentity(family).then((identity) => {
        const normalized = identity?.trim() ?? "";
        return normalized || null;
      });
      accountIdentityByFamily.set(family, pending);
      return pending;
    };
    const availabilityByProviderId = new Map<string, CodingPlanAvailabilityResult>();

    for (const family of ["zai", "bigmodel"] as const) {
      const configured = configuredProviders
        .entries()
        .flatMap(([providerId, config]) =>
          config.access?.type === "zhipu-account" &&
          config.access.accountType === family &&
          config.access.mode &&
          !isCodingPlanDerivedMode(config.access.mode)
            ? [{ providerId, config, planKind: config.access.mode }]
            : [],
        );
      if (configured.length === 0) continue;

      // Legacy team-identity completion gated paid access only; Start trusts the signed-in account alone.
      const queryable = configured.filter(({ providerId, planKind }) => {
        if (settings.unresolvedFamilies?.includes(family) && planKind !== "start-plan") {
          availabilityByProviderId.set(providerId, { kind: "unknown" });
          return false;
        }
        return true;
      });
      if (queryable.length === 0) continue;

      const accountIdentity = await loadAccountIdentity(family);
      if (!accountIdentity) {
        for (const { providerId } of queryable) {
          availabilityByProviderId.set(providerId, {
            kind: "unavailable",
            reason: "coding_plan_not_connected",
          });
        }
        continue;
      }

      const availabilityProviders = await Promise.all(
        queryable.map(async ({ providerId, planKind }) => ({
          providerId,
          family,
          planKind,
          apiKey:
            planKind !== "team-coding-plan"
              ? await options
                  .loadCodingPlanApiKey(providerId, family, accountIdentity, forceCredentialRefresh)
                  .catch(() => null)
              : null,
        })),
      );
      const resolved = await options.resolveFamilyAvailability({
        family,
        providers: availabilityProviders,
        selections: settings.selections,
      });
      for (const { providerId } of queryable) {
        availabilityByProviderId.set(providerId, resolved[providerId] ?? { kind: "unknown" });
      }
    }

    const connections: AccountProviderConnectionResult[] = [];
    const scopes = new Map<string, string>();
    for (const [providerId, config] of configuredProviders.entries()) {
      const access = config.access;
      if (access?.type !== "zhipu-account") continue;
      if (!access.accountType || !access.mode) {
        connections.push({ providerId, status: "unavailable" });
        continue;
      }
      const selection = settings.selections[access.accountType];
      // last-known-good holds only per account+team identity; a post-switch network blip must not revive old grants.
      const scope = JSON.stringify([
        await loadAccountIdentity(access.accountType),
        access.mode === "team-coding-plan" && selection?.kind === "team-coding-plan"
          ? [selection.organizationId, selection.projectId, selection.productId]
          : null,
      ]);
      scopes.set(providerId, scope);
      const resetPrevious =
        previousScopes.has(providerId) && previousScopes.get(providerId) !== scope;
      if (isCodingPlanDerivedMode(access.mode)) {
        const selectedPlanKind = selection?.kind;
        const matchingPlanAvailable =
          settings.providerFamilyDomain === access.accountType &&
          (selectedPlanKind === "individual-coding-plan" ||
            selectedPlanKind === "team-coding-plan") &&
          configuredProviders
            .entries()
            .some(
              ([candidateId, candidate]) =>
                candidate.access?.type === "zhipu-account" &&
                candidate.access.accountType === access.accountType &&
                candidate.access.mode === selectedPlanKind &&
                availabilityByProviderId.get(candidateId)?.kind === "available",
            );
        connections.push({
          providerId,
          status: matchingPlanAvailable ? "available" : "unavailable",
        });
        continue;
      }
      const availability = availabilityByProviderId.get(providerId) ?? {
        kind: "unknown" as const,
      };
      connections.push({
        providerId,
        status: availability.kind,
        // The reason must ship with the result; without it the UI can only show signed-in-but-unplanned as
        // plain disconnected.
        ...(availability.kind === "unavailable"
          ? {
              unavailableReason: resolveAccountUnavailableReason(availability.reason),
            }
          : {}),
        // Start follows the login; paid plans follow the connection choice. Both may be current without rewriting grants or config.
        current:
          settings.providerFamilyDomain === access.accountType &&
          (access.mode === "start-plan"
            ? Boolean(await loadAccountIdentity(access.accountType))
            : selection?.kind === access.mode),
        // Two teams share one provider id, so observers must compare full identity within one snapshot
        // instead of reading a plan/account switch as expiry. Account State only, never Config.
        connectionKey: createHash("sha256")
          .update(
            JSON.stringify([
              await loadAccountIdentity(access.accountType),
              access.accountType,
              access.mode === "start-plan" ? { kind: "start-plan" } : (selection ?? null),
            ]),
          )
          .digest("hex"),
        ...("models" in availability ? { models: availability.models } : {}),
        ...("effectiveAt" in availability ? { effectiveAt: availability.effectiveAt } : {}),
        ...(resetPrevious ? { resetPrevious: true } : {}),
      });
    }
    // Entitlement lookups can straddle account/plan switches, stitching old settings to a new identity.
    // Verify this round's scope before publishing, and never advance previousScopes on failure or the next round
    // mistakes the unpublished account for last-known-good. Retries stay driven by the existing refresh events.
    const identitiesUnchanged = await Promise.all(
      [...accountIdentityByFamily].map(
        async ([family, captured]) =>
          (await captured) === ((await options.loadAccountIdentity(family))?.trim() || null),
      ),
    );
    if (
      identitiesUnchanged.some((unchanged) => !unchanged) ||
      !isDeepStrictEqual(settings, await options.readSettings())
    ) {
      throw new Error(
        "Connection or identity changed during the account query; discarding stale result",
      );
    }
    previousScopes = scopes;
    return Object.freeze(connections);
  };
}

function isCredentialRefreshReason(reason: string): boolean {
  // ProviderSettingsFacade prefixes login-refresh reasons with settings:; missing that match keeps
  // serving a dead key after re-login on the same account. Match the reason suffix exactly; normal refreshes keep the cache.
  return (
    reason.includes("oauth-callback") || reason.split(":").at(-1) === "oauth-login-entitlement"
  );
}

/**
 * Maps Coding Plan availability reasons onto account-domain reasons.
 * Account State is cross-family truth and never adopts Coding Plan internal enums;
 * the UI relies on these stable semantics, blind to the checker implementation.
 */
function resolveAccountUnavailableReason(
  reason: CodingPlanUnavailableReason,
): AccountProviderUnavailableReason {
  switch (reason) {
    case "coding_plan_not_authenticated":
      return "not-authenticated";
    case "coding_plan_not_connected":
      return "not-connected";
    case "coding_plan_auth_failed":
      return "credential-failed";
    case "coding_plan_not_entitled":
      return "not-entitled";
  }
}

/** Assembles config, account connection resolution, and the tier-3 account provider config source. */
export function createAccountProviderConfigSource(
  options: AccountProviderConfigSourceOptions,
): AccountProviderService {
  return new AccountProviderService({
    configSource: options.configSource,
    resolve: createAccountProviderConfigResolver(createAccountProviderConnectionResolver(options)),
  });
}

/* */
export function createCodingPlanFamilyAvailabilityResolver(
  options: CodingPlanFamilyAvailabilityResolverOptions,
): AccountProviderFamilyAvailabilityResolver {
  return ({ family, providers, selections }) => {
    const context = {
      apiClient: options.apiClient,
      credentialService: options.credentialService,
      providerFamilyConnectionSelections: selections,
    };
    return family === "zai"
      ? validateZaiAccountProviderAvailability(providers, context)
      : validateBigModelAccountProviderAvailability(providers, context);
  };
}

/**
 * Projects the active model's static access constraints onto the current account connection.
 *
 * Never freeze team scope/account version into the model: switches would invalidate old models wrongly.
 * Re-read the current selection per request; return dynamic access facts only when family and mode agree.
 */
export async function resolveCurrentAccountAccess(input: {
  readonly access: ZCodeProviderAccountAccess;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}): Promise<ZCodeAccountAccess | null> {
  const settings = await input.readSettings();
  const { accountType, mode } = input.access;
  if (settings.providerFamilyDomain !== accountType) return null;
  if (mode === "start-plan") {
    if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
    return { type: "zhipu-account", family: accountType, planKind: "start-plan" };
  }
  const selection = settings.selections[accountType];
  if (!selection) return null;
  if (isCodingPlanDerivedMode(mode)) {
    if (selection.kind !== "individual-coding-plan" && selection.kind !== "team-coding-plan") {
      return null;
    }
  } else if (selection.kind !== mode) {
    return null;
  }
  if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
  if (selection.kind === "team-coding-plan") {
    return {
      type: "zhipu-account",
      family: accountType,
      planKind: selection.kind,
      productId: selection.productId,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
    };
  }
  return {
    type: "zhipu-account",
    family: accountType,
    planKind: selection.kind,
  };
}
