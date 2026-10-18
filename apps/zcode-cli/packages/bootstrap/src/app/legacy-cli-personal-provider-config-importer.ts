import { readFile } from "node:fs/promises";
import { BUILTIN_PROVIDER_TEMPLATE_IDS } from "@zcode/shared";
import { getDefaultConfigPath } from "@zcode/adapters/config";
import {
  parseLegacyCliModelConfig,
  type LegacyCliModelConfigProjection,
} from "./legacy-cli-model-config.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderApiType,
  type ProviderConfigLayerUpdate,
  type ModelSelection,
} from "@zcode/provider";

interface LegacyCliPersonalProviderConfigImportInput {
  readonly input: unknown;
}

const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

class UnsupportedLegacyCliProviderConfigError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `Legacy CLI provider ${providerId} carries execution fields the formal Config cannot express yet`,
    );
    this.name = "UnsupportedLegacyCliProviderConfigError";
    this.providerId = providerId;
  }
}

function resolveLegacyProviderApiType(
  kind: "anthropic" | "openai" | "openai-compatible" | undefined,
): ProviderApiType {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
    case undefined:
      return "openai-chat-completions";
  }
  return "openai-chat-completions";
}

/** Migrates explicit provider definitions from the legacy CLI user file into the new Personal Overlay. */
export function importLegacyCliPersonalProviderConfig(
  input: LegacyCliPersonalProviderConfigImportInput,
): ProviderConfigLayerUpdate {
  const runtimePatch = parseLegacyCliModelConfig(input.input);
  // The generic ZCodeConfigFileSchema deliberately leaves legacy providers in passthrough unknowns, while the
  // migrator takes types from that result, so the Bootstrap build cannot prove model/provider shape.
  // Consume only the dedicated legacy-format parser's validated projection, keeping compat logic sealed at the read boundary.
  let providers = ProviderConfigMap.empty();
  let models = ModelConfigRules.empty();

  for (const [rawProviderId, provider] of Object.entries(runtimePatch.provider ?? {})) {
    const providerId = rawProviderId.trim();
    if (!providerId) continue;
    // Standalone also reads builtin:* / source=custom written by legacy Desktop.
    // Matching the Desktop import: legacy builtin static config and account credentials are not migrated; metered API keeps only the key.
    const templateId =
      providerId === "builtin:bigmodel"
        ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
        : providerId === "builtin:zai"
          ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
          : undefined;
    if (templateId) {
      const apiKey = provider.options?.apiKey?.trim();
      if (apiKey)
        providers = providers.setRule({
          providerId: templateId,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey }),
          }),
        });
      continue;
    }
    if (providerId.startsWith("builtin:") || providerId.startsWith("account:")) continue;
    if (provider.source !== undefined && provider.source !== "custom") continue;
    if (requiresUnsupportedNoAuthentication(provider)) {
      throw new UnsupportedLegacyCliProviderConfigError(providerId);
    }
    const members = collectLegacyCliModelMembers(provider);
    const modelIds = members.map((member) => member.modelId);
    const providerName = provider.name?.trim();
    providers = providers.setRule({
      providerId,
      providerName: providerName && providerName !== providerId ? providerName : undefined,
      config: new ProviderConfig({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({
          apiKey: provider.options?.apiKey,
        }),
        api: new ProviderApiConfig({
          type: resolveLegacyProviderApiType(provider.kind),
          baseUrl: provider.options?.baseURL,
          headers: mergeHeaders(provider.headers, provider.options?.headers),
        }),
        ...(modelIds.length > 0 ? { personalModelIds: modelIds, modelOrder: modelIds } : {}),
      }),
    });
    for (const member of members) {
      if (member.contextWindow === undefined) continue;
      models = models.setExact(
        providerId,
        member.modelId,
        new ModelConfig({
          properties: new ModelPropertiesConfig({ contextWindow: member.contextWindow }),
        }),
      );
    }
  }

  // Default selection and providers come from the same legacy-file read, imported only on first Personal file creation.
  // Later clearing of defaults must not re-read the legacy main, nor create a half config that blocks migrating the remaining fields.
  const defaultModelSelection = importLegacyCliConfiguredDefault(input.input) ?? undefined;
  return Object.freeze({ providers, models, defaultModelSelection });
}

export async function readLegacyCliPersonalProviderConfig(input: {
  readonly filePath?: string;
}): Promise<ProviderConfigLayerUpdate | null> {
  const filePath = input.filePath ?? getDefaultConfigPath();
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return importLegacyCliPersonalProviderConfig({ input: raw });
  } catch (error) {
    if (isFileNotFound(error)) return null;
    // Migration is all-or-nothing. While the formal Config cannot express legacy execution fields, keep the legacy chain
    // and never write a partial Personal file that would block future re-migration.
    if (error instanceof UnsupportedLegacyCliProviderConfigError) return null;
    throw error;
  }
}

/** The legacy CLI user file's main model migrates only into the Environment default selection. */
export function importLegacyCliConfiguredDefault(input: unknown): ModelSelection | null {
  const main = parseLegacyCliModelConfig(input).model?.main;
  if (!main || main.provider === RETIRED_ZAPI_PROVIDER_ID) return null;
  return Object.freeze({
    providerId: main.provider,
    modelId: main.model,
  });
}

type LegacyCliProvider = NonNullable<LegacyCliModelConfigProjection["provider"]>[string];

interface LegacyCliModelMember {
  readonly modelId: string;
  readonly contextWindow?: number;
}

function collectLegacyCliModelMembers(
  provider: LegacyCliProvider,
): readonly LegacyCliModelMember[] {
  const seen = new Set<string>();
  const members: LegacyCliModelMember[] = [];
  for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
    if (model.deleted === true) continue;
    const modelId = (model.id ?? modelKey).trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const contextWindow = model.contextWindow ?? model.limit?.context;
    members.push({
      modelId,
      ...(isPositiveInteger(contextWindow) ? { contextWindow } : {}),
    });
  }
  return members;
}

function mergeHeaders(
  ...values: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const result = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(result).length > 0 ? result : undefined;
}

function requiresUnsupportedNoAuthentication(provider: LegacyCliProvider): boolean {
  return provider.options?.apiKeyRequired === false;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
