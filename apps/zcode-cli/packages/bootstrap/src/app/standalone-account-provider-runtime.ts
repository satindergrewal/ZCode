import { createHash } from "node:crypto";
import {
  createCodingPlanApiKeyResolver,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import { createConfig } from "@zcode/adapters/config";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import {
  createAccountProviderConfigSnapshot,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import type { ProviderFamilyDomain } from "@zcode/shared";

export interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  readonly modelId: string;
  readonly providerId: string;
}

export async function readStandaloneCodingPlanProviders(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return (await readStandaloneCodingPlanCatalog(env)).providers;
}

async function readStandaloneCodingPlanCatalog(
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<{
  readonly zcodeBuiltinRevision: string;
  readonly providers: readonly StandaloneCodingPlanProvider[];
}> {
  if (config)
    return {
      zcodeBuiltinRevision: config.revision,
      providers: config.providers.entries().flatMap(([providerId, provider]) => {
        const access = provider.access;
        const modelId = provider.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
        return access?.type === "zhipu-account" &&
          access.mode === "individual-coding-plan" &&
          access.accountType &&
          modelId
          ? [{ family: access.accountType, modelId, providerId }]
          : [];
      }),
    };
  const filePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(`${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required for login`);
  }
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  try {
    const snapshot = await source.read();
    return readStandaloneCodingPlanCatalog(env, snapshot);
  } finally {
    source.dispose();
  }
}

export async function resolveStandaloneCodingPlanProvider(
  family: ProviderFamilyDomain,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneCodingPlanProvider> {
  const matches = (await readStandaloneCodingPlanProviders(env)).filter(
    (provider) => provider.family === family,
  );
  if (matches.length !== 1) {
    throw new Error(
      `ZCode Built-in Config must declare exactly one Individual Coding Plan provider for ${family}`,
    );
  }
  return matches[0]!;
}

export function standaloneAccountIdentityCredentialKey(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) throw new Error("Standalone Account Provider ID must not be empty");
  return `account-provider:${normalized}:identity`;
}

export function standaloneAccountAuthSourceCredentialKey(providerId: string): string {
  return `account-provider:${providerId}:auth-source`;
}
function oauthCredentialKey(family: ProviderFamilyDomain): string {
  return family === "zai"
    ? SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken
    : SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken;
}

/** Standalone Credential Store private keys; never enter Provider Config, Model, or Protocol. */
export function standaloneAccountProviderCredentialKey(input: {
  readonly providerId: string;
  readonly accountIdentity: string;
}): string {
  const providerId = input.providerId.trim();
  const accountIdentity = input.accountIdentity.trim();
  if (!providerId) throw new Error("Standalone Account Provider ID must not be empty");
  if (!accountIdentity) throw new Error("Standalone Account Identity must not be empty");
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

/** Manual key logins without an account profile use a stable, non-reversible connection identity. */
export function createStandaloneAccountIdentityFromSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new Error("Standalone Account Secret must not be empty");
  return `key-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export async function readStandaloneAccountProviderConfigSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<AccountProviderConfigSnapshot> {
  const catalog = await readStandaloneCodingPlanCatalog(env, config);
  const configuredProviders = catalog.providers;
  const identityKeys = configuredProviders.map(({ providerId }) =>
    standaloneAccountIdentityCredentialKey(providerId),
  );
  const identities = await credentialStore.loadMany(identityKeys);
  const candidates = configuredProviders.flatMap(({ family, providerId }) => {
    const accountIdentity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    if (!accountIdentity) return [];
    const credentialKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity,
    });
    return [{ accountIdentity, credentialKey, family, providerId }] as const;
  });
  const sources = await credentialStore.loadMany(
    candidates.map(({ providerId }) => standaloneAccountAuthSourceCredentialKey(providerId)),
  );
  // Read the scope by source selection first; OAuth never decrypts legacy keys, manual mode never depends on unrelated OAuth ciphertext.
  const credentials = await credentialStore.loadMany(
    candidates.map(({ credentialKey, providerId, family }) =>
      sources[standaloneAccountAuthSourceCredentialKey(providerId)] === "manual"
        ? credentialKey
        : oauthCredentialKey(family),
    ),
  );
  const candidateByProviderId = new Map(
    candidates.map((candidate) => [candidate.providerId, candidate]),
  );
  const providers = new ProviderConfigMap(
    configuredProviders.map(({ family, providerId }) => {
      const candidate = candidateByProviderId.get(providerId);
      const source = sources[standaloneAccountAuthSourceCredentialKey(providerId)];
      const requestCredentialKey =
        source === "manual" ? candidate?.credentialKey : oauthCredentialKey(family);
      const authorized = Boolean(requestCredentialKey && credentials[requestCredentialKey]?.trim());
      if (!candidate || !authorized) {
        // Root cause: the account overlay lacked a member for "no override", so a disconnected account was inexpressible; it must be
        // entitled=false lets the Built-in account provider leave the Registry once its credential is deleted.
        return [
          providerId,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: false }),
          }),
        ] as const;
      }
      return [
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
        }),
      ] as const;
    }),
  );
  return createAccountProviderConfigSnapshot(catalog.zcodeBuiltinRevision, providers);
}

export async function hasStandaloneCodingPlanAccess(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return (await readStandaloneAccountProviderConfigSnapshot(credentialStore, env)).providers
    .entries()
    .some(([, provider]) =>
      provider.access?.type === "zhipu-account" ? provider.access.entitled === true : false,
    );
}

export function createStandaloneProviderRuntimeHeadersPort(
  credentialStore: Pick<SharedZCodeCredentialStore, "load" | "loadMany" | "save" | "delete">,
  env: Readonly<Record<string, string | undefined>>,
  injectedResolver?: ReturnType<typeof createCodingPlanApiKeyResolver>,
): ProviderRuntimeHeadersPort & {
  clearProjectTokens(): void;
  invalidateChangedCredentials(): Promise<void>;
} {
  const config = createConfig({ env }).config;
  const resolver =
    injectedResolver ??
    createCodingPlanApiKeyResolver({
      httpClient: createNodeHttpClientAdapter({
        env,
        proxyUrl: config.network.httpProxy,
        noProxy: config.network.noProxy,
        caCertFile: config.network.caCertFile,
        timeoutMs: config.network.timeout,
      }),
      locationStore: credentialStore,
      observe: (event) => console.warn("[project-access-token]", event),
    });
  const authSnapshots = new Map<string, string>();
  return {
    clearProjectTokens() {
      authSnapshots.clear();
      resolver.clear();
    },
    async invalidateChangedCredentials() {
      const values = await credentialStore.loadMany([...authSnapshots.keys()]);
      if ([...authSnapshots].some(([key, value]) => values[key]?.trim() !== value)) {
        authSnapshots.clear();
        resolver.clear();
      }
    },
    shouldRefreshBeforeModelRequest() {
      return true;
    },
    async refreshBeforeModelRequest(input) {
      input.abortSignal?.throwIfAborted();
      const providerId = input.providerId.trim();
      const access = input.accountAccess;
      if (!access || access.mode !== "individual-coding-plan") {
        throw new Error(
          `Standalone Account Provider has an invalid request identity: ${providerId}`,
        );
      }
      const currentIdentity = (
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
      )?.trim();
      if (!currentIdentity)
        throw new Error(
          `Standalone Account Provider credentials are no longer valid: ${providerId}`,
        );
      const family = access.accountType;
      if (!family) throw new Error("project_token_account_required");
      const sourceKey = standaloneAccountAuthSourceCredentialKey(providerId);
      const source = await credentialStore.load(sourceKey);
      const oauthKey = oauthCredentialKey(family);
      const oauth =
        source === "manual" ? undefined : (await credentialStore.load(oauthKey))?.trim();
      const useOAuth = source === "oauth" || (source !== "manual" && Boolean(oauth));
      let apiKey: string | undefined;
      let apiKeyId: string | undefined;
      let accountScope: string | undefined;
      if (useOAuth) {
        if (!oauth) {
          resolver.clear();
          throw new Error("project_token_login_required");
        }
        accountScope = createHash("sha256")
          .update(JSON.stringify([providerId, family, currentIdentity, oauth]))
          .digest("hex");
        if (
          (input.expectedAccountScope && input.expectedAccountScope !== accountScope) ||
          (input.rejectedProjectTokenFingerprint && !input.expectedAccountScope)
        )
          throw new Error("project_token_scope_invalidated");
        if (source !== "oauth") await credentialStore.save(sourceKey, "oauth");
        authSnapshots.set(oauthKey, oauth);
        authSnapshots.set(standaloneAccountIdentityCredentialKey(providerId), currentIdentity);
        authSnapshots.set(sourceKey, "oauth");
        const material = await resolver.resolveMaterial(
          {
            family,
            accessToken: oauth,
            accountIdentity: currentIdentity,
            rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint,
            trace: input.traceContext,
          },
          { signal: input.abortSignal },
        );
        apiKey = material.token;
        apiKeyId = material.apiKeyId;
        // During a request, deliver only the current account's token; a late issuance must not overwrite a logged-out/switched state.
        if (
          (await credentialStore.load(oauthKey))?.trim() !== oauth ||
          (
            await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
          )?.trim() !== currentIdentity ||
          (await credentialStore.load(sourceKey)) !== "oauth"
        ) {
          resolver.clear();
          throw new Error("project_token_scope_invalidated");
        }
      } else if (source === "manual") {
        if (input.expectedAccountScope || input.rejectedProjectTokenFingerprint)
          throw new Error("project_token_scope_invalidated");
        apiKey = (
          await credentialStore.load(
            standaloneAccountProviderCredentialKey({
              providerId,
              accountIdentity: currentIdentity,
            }),
          )
        )?.trim();
      }
      if (!useOAuth && source !== "manual") {
        // The legacy format cannot tell manual from OAuth-derived keys; with no login state, demand a fresh choice, never guess a fallback.
        resolver.clear();
        throw new Error("project_token_login_required");
      }
      input.abortSignal?.throwIfAborted();
      if (!apiKey) {
        throw new Error(
          `Standalone Account Provider is missing request credentials: ${providerId}`,
        );
      }
      return {
        headersApplied: true,
        requestAuth: {
          apiKey,
          ...(apiKeyId ? { apiKeyId } : {}),
          ...(accountScope ? { accountScope } : {}),
        },
      };
    },
  };
}
