/* eslint-disable max-lines -- the released legacy provider store is modeled only at the one-way importer boundary. */
import { z } from "zod";

export interface ClaudeModelMapping {
  haiku: string;
  sonnet: string;
  opus: string;
  reasoning: string;
}

/**
 * Per-provider model slot mappings for ZCode Agent providers.
 * Only claude for now; add fields here when more providers land.
 */
export interface ProviderModelMappings {
  [provider: string]: unknown;
  /** @deprecated Claude slots are no longer written to the v2 store; read legacy configs only, then clean up. */
  claude?: ClaudeModelMapping;
}

export interface ModelProviderEndpoints {
  /** @deprecated Legacy provider reads only; the new store uses baseURL + paths. */
  anthropic?: string;
  /** @deprecated Legacy provider reads only; the new store uses baseURL + paths. */
  openai?: string;
  /** @deprecated Gemini custom providers now use endpoints.openai + compat; kept for legacy reads. */
  gemini?: string;
  /** v2 catalog endpoint base URL; legacy field kept for migration-era UI/connectivity reads. */
  baseURL?: string;
  /** v2 catalog endpoint paths keyed by public runtime kind. */
  paths?: Partial<Record<ModelProviderKind, string>>;
}

export type RemoteProviderSchema = "anthropic" | "openai:chat" | "openai:messages" | "gemini";

export type ModelProviderSupportedFormat = "anthropic" | "openai" | "responses" | "gemini";

export type ModelProviderApiFormat =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export type ModelProviderCatalogSourceId = "china-llm-zcode-dev";

export type ModelProviderKind = "anthropic" | "openai" | "openai-compatible";

export type ModelProviderModality = "text" | "image" | "video" | "audio" | "pdf";

export interface ProviderOptionsPatch {
  set?: Array<{ path: string[]; value: unknown }>;
  unset?: Array<{ path: string[] }>;
}

export interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<string, Partial<Record<ModelProviderKind, ProviderOptionsPatch>>>;
}

export function stripModelProviderReasoningPatches(
  reasoning: ModelProviderReasoningSpec,
): ModelProviderReasoningSpec {
  return {
    ...(reasoning.defaultLevel ? { defaultLevel: reasoning.defaultLevel } : {}),
    levels: Object.fromEntries(Object.keys(reasoning.levels).map((level) => [level, {}])),
  };
}

export interface ModelProviderCatalogModel {
  id: string;
  name?: string;
  kinds: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  modalities: {
    input: ModelProviderModality[];
    output: ModelProviderModality[];
  };
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
}

export interface ModelProviderCatalogProvider {
  id: string;
  name: string;
  endpoints: {
    baseURL: string;
    paths: Partial<Record<ModelProviderKind, string>>;
  };
  defaultKind?: ModelProviderKind;
  models: ModelProviderCatalogModel[];
}

export interface ModelProviderCatalogFile {
  schemaVersion: "zcode.model-providers.v1";
  providers: ModelProviderCatalogProvider[];
}

export interface ModelProviderModelConfig extends ModelProviderCatalogModel {
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}

export type ModelProviderModelEntry = string | ModelProviderModelConfig;

export type ModelProviderSource = "builtin" | "models-dev" | "custom" | "workspace";

export type ModelProviderSystemDisabledReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled"
  | "oauth_provider_inactive";

export interface ModelProviderConfig {
  id: string;
  name: string;
  /** Enabled by default; false only hides it from chat model lists and never deletes the provider. */
  enabled?: boolean;
  /**
   * Why the system auto-disabled the provider. enabled=false with an empty reason means user-disabled;
   * later entitlement successes must not re-enable it.
   */
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKey: string;
  apiKeyUrl?: string;
  models: ModelProviderModelEntry[];
  defaultKind?: ModelProviderKind;
  /** @deprecated Legacy display-name map, v1 auto-migration only. */
  modelDisplayNames?: Record<string, string>;
  /** @deprecated Legacy model-format map, v1 auto-migration only. */
  modelSupportedFormats?: Record<string, ModelProviderSupportedFormat[]>;
  providerMappings?: ProviderModelMappings;
  createdAt: number;
  updatedAt: number;
}

export interface ModelProviderStoreFile {
  schemaVersion: "zcode.model-providers.v2";
  providers: ModelProviderConfig[];
}

const claudeModelMappingSchema = z.object({
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
  reasoning: z.string(),
});

const providerModelMappingsSchema = z
  .object({
    claude: claudeModelMappingSchema.optional(),
  })
  .catchall(z.unknown());

const modelSupportedFormatSchema = z.enum(["anthropic", "openai", "responses", "gemini"]);

export const modelProviderApiFormatSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);

export const modelProviderKindSchema = z.enum(["anthropic", "openai", "openai-compatible"]);

export const modelProviderCatalogSourceIdSchema = z.enum(["china-llm-zcode-dev"]);

export const modelProviderModalitySchema = z.enum(["text", "image", "video", "audio", "pdf"]);

const providerOptionsPatchOperationSchema = z.object({
  path: z.array(z.string().min(1)).min(1),
});

export const providerOptionsPatchSchema = z.object({
  set: z.array(providerOptionsPatchOperationSchema.extend({ value: z.unknown() })).optional(),
  unset: z.array(providerOptionsPatchOperationSchema).optional(),
});

export const modelProviderReasoningSpecSchema = z.object({
  defaultLevel: z.string().min(1).optional(),
  levels: z.record(
    z.string().min(1),
    z.partialRecord(modelProviderKindSchema, providerOptionsPatchSchema),
  ),
});

export const modelProviderEndpointPathsSchema = z.partialRecord(
  modelProviderKindSchema,
  z.string(),
);

const modelProviderCatalogEndpointSchema = z.object({
  baseURL: z.string(),
  paths: modelProviderEndpointPathsSchema,
});

export const modelProviderCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  kinds: z.array(modelProviderKindSchema),
  defaultKind: modelProviderKindSchema.optional(),
  modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
  modalities: z.object({
    input: z.array(modelProviderModalitySchema),
    output: z.array(modelProviderModalitySchema),
  }),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: modelProviderReasoningSpecSchema.optional(),
  priority: z.number().finite().optional(),
});

export const modelProviderCatalogProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoints: modelProviderCatalogEndpointSchema,
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderCatalogModelSchema),
});

export const modelProviderCatalogFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v1"),
  providers: z.array(modelProviderCatalogProviderSchema),
});

export const modelProviderModelConfigSchema = modelProviderCatalogModelSchema.extend({
  disabledReason: z.string().optional(),
  supportsTools: z.boolean().optional(),
  supportsStructuredOutput: z.boolean().optional(),
  modified: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export const modelProviderSourceSchema = z.enum(["builtin", "models-dev", "custom", "workspace"]);

export const modelProviderSystemDisabledReasonSchema = z.enum([
  "coding_plan_not_authenticated",
  "coding_plan_not_connected",
  "coding_plan_auth_failed",
  "coding_plan_not_entitled",
  "oauth_provider_inactive",
]);

const legacyModelProviderEndpointsSchema = z.object({
  anthropic: z.string().default(""),
  openai: z.string().default(""),
  gemini: z.string().default(""),
});

export const modelProviderEndpointsSchema = legacyModelProviderEndpointsSchema.extend({
  anthropic: z.string().optional(),
  openai: z.string().optional(),
  gemini: z.string().optional(),
  baseURL: z.string().optional(),
  paths: modelProviderEndpointPathsSchema.optional(),
});

export const legacyModelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: legacyModelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  models: z.array(z.string()).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const legacyModelProviderListSchema = z.array(legacyModelProviderConfigSchema);

export const modelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: modelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
  catalogProviderId: z.string().optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderModelConfigSchema).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const modelProviderListSchema = z.array(modelProviderConfigSchema);

export const modelProviderStoreFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v2"),
  providers: modelProviderListSchema,
});

export const modelProviderDisplayOrderStateSchema = z.object({
  providerIds: z.array(z.string().min(1)),
  updatedAt: z.number().int().nonnegative(),
});

export function stripLegacyClaudeProviderMappings(
  providerMappings: ProviderModelMappings | undefined,
): ProviderModelMappings | undefined {
  if (!providerMappings) {
    return undefined;
  }
  const { claude: _legacyClaudeMapping, ...remainingMappings } = providerMappings;
  // The v2 store no longer persists Claude slots, but keep providerMappings for
  // future provider slot configs; drop only legacy subfields, preserve unknown keys.
  return remainingMappings;
}

export const MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW = 200_000;
// Legacy/metadata-less models without catalog facts share the settings page's
// conservative default, so registry and UI never disagree 128k vs 200k.
const LEGACY_MODEL_CONTEXT_WINDOW = MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW;
export const MODEL_ONE_MILLION_CONTEXT_WINDOW = 1_000_000;

export function resolveModelProviderContextWindow(contextWindow: number | undefined): number {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
    return LEGACY_MODEL_CONTEXT_WINDOW;
  }

  const normalized = Math.floor(contextWindow);
  return normalized > 0 ? normalized : LEGACY_MODEL_CONTEXT_WINDOW;
}

export function isModelProviderModelConfig(
  model: ModelProviderModelEntry,
): model is ModelProviderModelConfig {
  return typeof model === "object" && model !== null;
}

export function getModelProviderModelIds(
  provider: Pick<ModelProviderConfig, "models"> | null | undefined,
): string[] {
  if (!provider) {
    return [];
  }

  return (
    provider.models
      // Deletions persist as tombstones in provider.models for persistence/remote merge;
      // every selectable/provisioned catalog treats them as absent so chat and CLI never list them.
      .filter((model) => !isModelProviderModelConfig(model) || model.deleted !== true)
      .map((model) => (isModelProviderModelConfig(model) ? model.id.trim() : model.trim()))
      .filter((modelId) => modelId.length > 0)
  );
}

function uniqueModelProviderKinds(kinds: readonly ModelProviderKind[]): ModelProviderKind[] {
  return [...new Set(kinds)];
}

export function mapModelProviderSupportedFormatToKind(
  format: ModelProviderSupportedFormat,
): ModelProviderKind | null {
  switch (format) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai-compatible";
    case "responses":
      return "openai";
    case "gemini":
      return null;
  }
}

export function createModelProviderModelConfig(params: {
  id: string;
  name?: string;
  kinds?: readonly ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: {
    input?: readonly ModelProviderModality[];
    output?: readonly ModelProviderModality[];
  };
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}): ModelProviderModelConfig {
  const inputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.input ?? (["text"] satisfies ModelProviderModality[])),
  ];
  const outputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.output ?? (["text"] satisfies ModelProviderModality[])),
  ];
  return {
    id: params.id.trim(),
    name: params.name?.trim() || undefined,
    kinds: uniqueModelProviderKinds([...(params.kinds ?? [])]),
    ...(params.defaultKind ? { defaultKind: params.defaultKind } : {}),
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
    contextWindow: resolveModelProviderContextWindow(params.contextWindow),
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.priority !== undefined && Number.isFinite(params.priority)
      ? { priority: params.priority }
      : {}),
    ...(params.disabledReason ? { disabledReason: params.disabledReason } : {}),
    ...(params.supportsTools !== undefined ? { supportsTools: params.supportsTools } : {}),
    ...(params.supportsStructuredOutput !== undefined
      ? { supportsStructuredOutput: params.supportsStructuredOutput }
      : {}),
    ...(params.modified !== undefined ? { modified: params.modified } : {}),
    ...(params.deleted !== undefined ? { deleted: params.deleted } : {}),
  };
}

export function resolveModelProviderDefaultKind(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
): ModelProviderKind {
  if (provider.defaultKind) {
    return provider.defaultKind;
  }

  const paths = provider.endpoints.paths;
  if (paths?.["openai-compatible"] !== undefined) {
    return "openai-compatible";
  }
  if (paths?.openai !== undefined) {
    return "openai";
  }
  if (paths?.anthropic !== undefined) {
    return "anthropic";
  }

  const apiFormat = resolveModelProviderApiFormat(provider);
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

export function resolveModelProviderKindApiFormat(kind: ModelProviderKind): ModelProviderApiFormat {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
      return "openai-chat-completions";
  }
}

export function mapModelProviderApiFormatToKind(
  apiFormat: ModelProviderApiFormat,
): ModelProviderKind {
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

export function getDefaultModelProviderEndpointPathForKind(kind: ModelProviderKind): string {
  switch (kind) {
    case "anthropic":
      return "/v1/messages";
    case "openai":
      return "/responses";
    case "openai-compatible":
      return "/chat/completions";
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function collapseDuplicatedAbsoluteRuntimeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return normalized;
    }
    const marker = `${parsed.protocol}//${parsed.host}`;
    const secondMarkerIndex = normalized.indexOf(marker, marker.length);
    if (secondMarkerIndex < 0) {
      return normalized;
    }

    const firstUrl = normalized.slice(0, secondMarkerIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(secondMarkerIndex).replace(/\/+$/, "");
    if (firstUrl === secondUrl) {
      // Legacy saves could append the runtime baseURL as a path again,
      // producing https://host/path/https://host/path; fold only that exact duplication.
      return firstUrl;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

function joinBaseUrlAndPath(baseURL: string, path: string): string {
  const trimmedBase = baseURL.trim();
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return trimmedBase;
  }
  if (isAbsoluteHttpUrl(trimmedPath)) {
    // Legacy endpoints.paths may already hold a full runtime baseURL.
    // Never stack endpoints.baseURL on top or the duplicate comes back.
    return trimmedPath;
  }
  if (!trimmedBase) {
    return trimmedPath;
  }
  if (trimmedBase.endsWith("/") && trimmedPath.startsWith("/")) {
    return `${trimmedBase.slice(0, -1)}${trimmedPath}`;
  }
  if (!trimmedBase.endsWith("/") && !trimmedPath.startsWith("/")) {
    return `${trimmedBase}/${trimmedPath}`;
  }
  return `${trimmedBase}${trimmedPath}`;
}

export function normalizeModelProviderBaseUrlForKind(
  baseURL: string,
  kind: ModelProviderKind,
): string {
  const suffixes: Record<ModelProviderKind, string[]> = {
    anthropic: ["/v1/messages", "/messages"],
    // OpenAI Responses SDK baseURLs include /v1; runtime appends /responses.
    // Never strip /v1/responses wholesale, or typed https://host/v1 persists as https://host.
    openai: ["/responses"],
    "openai-compatible": ["/chat/completions"],
  };
  let normalized = normalizeModelProviderConfiguredBaseUrl(baseURL);
  for (const suffix of suffixes[kind]) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized.replace(/\/+$/, "");
}

export function normalizeModelProviderConfiguredBaseUrl(baseURL: string): string {
  // The settings/config.json base URL is user-authored: never strip /v1, /responses, or
  // /chat/completions by API format; only fold duplicate URLs and trim.
  return collapseDuplicatedAbsoluteRuntimeBaseUrl(baseURL).replace(/\/+$/, "");
}

export function resolveModelProviderRuntimeBaseUrl(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
  kind = mapModelProviderApiFormatToKind(resolveModelProviderApiFormat(provider)),
): string {
  const baseURL = provider.endpoints.baseURL?.trim() ?? "";
  const paths = provider.endpoints.paths ?? {};
  if (!provider.endpoints.baseURL?.trim() && !provider.endpoints.paths) {
    return "";
  }
  // baseURL is a prefix; only kinds in paths mean a usable protocol.
  // Otherwise OpenAI-only providers get probed as Anthropic-capable.
  if (paths[kind] === undefined) {
    return "";
  }
  // A catalog baseURL+path is the full request URL, but OpenAI/Anthropic
  // SDKs take an API base and append /chat/completions, /responses, or /messages.
  // Passing the full URL yields .../chat/completions/chat/completions.
  return normalizeModelProviderBaseUrlForKind(joinBaseUrlAndPath(baseURL, paths[kind] ?? ""), kind);
}

export function getModelProviderEndpointKinds(
  endpoints: ModelProviderEndpoints,
): ModelProviderKind[] {
  const kinds: ModelProviderKind[] = [];
  const paths = endpoints.paths;
  if (endpoints.baseURL?.trim() || paths) {
    if (paths?.anthropic !== undefined) {
      kinds.push("anthropic");
    }
    if (paths?.openai !== undefined) {
      kinds.push("openai");
    }
    if (paths?.["openai-compatible"] !== undefined) {
      kinds.push("openai-compatible");
    }
    return kinds;
  }
  return [];
}

function pathFromModelProviderEndpointUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${path}${url.search}`;
}

function buildEndpointsFromLegacyRuntimeBaseUrls(
  entries: Array<[ModelProviderKind, string]>,
): ModelProviderEndpoints {
  const normalizedEntries = entries.flatMap(([kind, rawUrl]) => {
    const url = normalizeModelProviderBaseUrlForKind(rawUrl, kind);
    return url ? [{ kind, url }] : [];
  });
  if (normalizedEntries.length === 0) {
    return {};
  }

  const parsedEntries = normalizedEntries.map((entry) => {
    try {
      return { ...entry, parsed: new URL(entry.url) };
    } catch {
      return { ...entry, parsed: null };
    }
  });
  const firstParsed = parsedEntries[0]?.parsed;
  const canShareOrigin =
    firstParsed && parsedEntries.every((entry) => entry.parsed?.origin === firstParsed.origin);

  return {
    ...(canShareOrigin ? { baseURL: firstParsed.origin } : {}),
    paths: Object.fromEntries(
      parsedEntries.map((entry) => [
        entry.kind,
        canShareOrigin && entry.parsed ? pathFromModelProviderEndpointUrl(entry.parsed) : entry.url,
      ]),
    ) as Partial<Record<ModelProviderKind, string>>,
  };
}

function resolveLegacyModelProviderDefaultKind(
  provider: Pick<z.infer<typeof legacyModelProviderConfigSchema>, "apiFormat" | "endpoints">,
): ModelProviderKind {
  switch (provider.apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
    case undefined:
      break;
  }

  if (provider.endpoints.anthropic?.trim()) {
    return "anthropic";
  }
  if (provider.endpoints.openai?.trim()) {
    return "openai-compatible";
  }
  return "anthropic";
}

function getDefaultModelSupportedFormatsFromLegacyEndpoints(
  endpoints: Pick<ModelProviderEndpoints, "anthropic" | "openai">,
): ModelProviderSupportedFormat[] {
  const formats: ModelProviderSupportedFormat[] = [];
  if (endpoints.anthropic?.trim()) {
    formats.push("anthropic");
  }
  if (endpoints.openai?.trim()) {
    formats.push("openai");
  }
  return formats;
}

export function migrateLegacyModelProviderConfig(
  provider: z.infer<typeof legacyModelProviderConfigSchema>,
): ModelProviderConfig {
  const defaultKind = resolveLegacyModelProviderDefaultKind(provider);
  // Legacy providers may carry both protocols; keep historical paths through migration
  // and let the storage boundary converge on one kind via runtime config.
  const legacyEntries: Array<[ModelProviderKind, string]> = [];
  const anthropicEndpoint = provider.endpoints.anthropic?.trim();
  if (anthropicEndpoint) {
    legacyEntries.push(["anthropic", anthropicEndpoint]);
  }
  const openaiEndpoint = provider.endpoints.openai?.trim();
  if (openaiEndpoint) {
    legacyEntries.push([defaultKind === "openai" ? "openai" : "openai-compatible", openaiEndpoint]);
  }
  const endpoints = buildEndpointsFromLegacyRuntimeBaseUrls(legacyEntries);
  const migratedModels = provider.models.map((modelId) => {
    const formats =
      provider.modelSupportedFormats?.[modelId] ??
      (provider.apiFormat
        ? getDefaultModelSupportedFormatsFromApiFormat(provider.apiFormat)
        : getDefaultModelSupportedFormatsFromLegacyEndpoints(provider.endpoints));
    const kinds = uniqueModelProviderKinds(
      formats.flatMap((format) => {
        const kind = mapModelProviderSupportedFormatToKind(format);
        return kind ? [kind] : [];
      }),
    );
    const disabledReason =
      kinds.length === 0 && formats.includes("gemini")
        ? "legacy gemini format is not supported by zcode.model-providers.v2"
        : undefined;

    return createModelProviderModelConfig({
      id: modelId,
      name: provider.modelDisplayNames?.[modelId],
      kinds,
      defaultKind: kinds.includes(defaultKind) ? defaultKind : kinds[0],
      disabledReason,
    });
  });

  return {
    id: provider.id,
    name: provider.name,
    ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
    ...(provider.systemDisabledReason
      ? { systemDisabledReason: provider.systemDisabledReason }
      : {}),
    endpoints,
    apiFormat: provider.apiFormat,
    source: provider.source,
    modelsDevProviderId: provider.modelsDevProviderId,
    apiKeyRequired: provider.apiKeyRequired,
    headers: provider.headers,
    logoUrl: provider.logoUrl,
    apiKey: provider.apiKey,
    apiKeyUrl: provider.apiKeyUrl,
    defaultKind,
    models: migratedModels,
    providerMappings: stripLegacyClaudeProviderMappings(provider.providerMappings),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export function migrateLegacyModelProviderListToStoreFile(raw: unknown): ModelProviderStoreFile {
  const providers = legacyModelProviderListSchema.parse(raw);
  return {
    schemaVersion: "zcode.model-providers.v2",
    providers: providers.map(migrateLegacyModelProviderConfig),
  };
}

export function getDefaultModelSupportedFormatsFromEndpoints(
  endpoints: Partial<
    Pick<ModelProviderEndpoints, "anthropic" | "openai" | "gemini" | "baseURL" | "paths">
  >,
): ModelProviderSupportedFormat[] {
  const formats: ModelProviderSupportedFormat[] = [];
  const paths = endpoints.paths;
  if (endpoints.baseURL?.trim() || paths) {
    if (paths?.anthropic !== undefined) {
      formats.push("anthropic");
    }
    if (paths?.["openai-compatible"] !== undefined) {
      formats.push("openai");
    }
    if (paths?.openai !== undefined) {
      formats.push("responses");
    }
    return formats;
  }
  return [];
}

export function getDefaultModelSupportedFormatsFromApiFormat(
  apiFormat: ModelProviderApiFormat,
): ModelProviderSupportedFormat[] {
  switch (apiFormat) {
    case "anthropic-messages":
      return ["anthropic"];
    case "openai-responses":
      return ["responses"];
    case "openai-chat-completions":
      return ["openai"];
  }
}

export function resolveModelProviderApiFormat(
  provider: Pick<ModelProviderConfig, "apiFormat" | "endpoints"> &
    Partial<Pick<ModelProviderConfig, "defaultKind">>,
): ModelProviderApiFormat {
  if (
    provider.apiFormat === "anthropic-messages" ||
    provider.apiFormat === "openai-chat-completions" ||
    provider.apiFormat === "openai-responses"
  ) {
    return provider.apiFormat;
  }

  if (provider.defaultKind) {
    return resolveModelProviderKindApiFormat(provider.defaultKind);
  }

  // Legacy data may declare several protocols; without explicit defaultKind/apiFormat
  // prefer the Anthropic-compatible mainline.
  if (provider.endpoints.paths?.anthropic !== undefined) {
    return "anthropic-messages";
  }

  if (provider.endpoints.paths?.openai !== undefined) {
    return "openai-responses";
  }

  if (provider.endpoints.paths?.["openai-compatible"] !== undefined) {
    return "openai-chat-completions";
  }

  return "anthropic-messages";
}

export function resolveModelProviderBaseUrl(
  provider: Pick<ModelProviderConfig, "apiFormat" | "endpoints"> &
    Partial<Pick<ModelProviderConfig, "defaultKind">>,
): string {
  const kind = mapModelProviderApiFormatToKind(resolveModelProviderApiFormat(provider));
  const runtimeBaseURL = resolveModelProviderRuntimeBaseUrl(provider, kind);
  if (runtimeBaseURL) {
    // Fix: the settings input shows the SDK/runtime baseURL.
    // When the stored base is a prefix, rebuild display value with the fixed operation path.
    return runtimeBaseURL;
  }
  const baseURL = provider.endpoints.baseURL?.trim();
  if (baseURL) {
    // Bugfix: early settings stored the full Chat Completions URL in baseURL.
    // Show the SDK API base so resaving does not perpetuate the malformed form.
    return normalizeModelProviderBaseUrlForKind(baseURL, kind);
  }
  return resolveModelProviderRuntimeBaseUrl(provider, kind);
}

/** Connectivity-test error classification */
