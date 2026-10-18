/* oxlint-disable eslint(max-lines) -- Provider/Model atomic config lifecycle shares one Repository update boundary; splitting it would duplicate ordering and normalization. */
import type {
  ModelConfigRules,
  ModelId,
  ProviderConfig,
  ProviderId,
  ProviderTemplateId,
  ProviderConfigRule,
  ProviderTemplateLocale,
} from "./config/index.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ProviderConfigMap,
  ProviderConfig as ProviderConfigValue,
  ProviderTemplateMap,
  resolveProviderTemplateName,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderConfigSnapshot, ProviderSource } from "./sources.js";

export interface ProviderConfigLayerSnapshot {
  readonly revision: string;
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface ProviderConfigLayerUpdate {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

export interface PersonalProviderConfigRepository extends ProviderSource<ProviderConfigLayerSnapshot> {
  update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot>;
}

export interface ProviderConfigServiceDependencies {
  readonly zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly personalRepository: PersonalProviderConfigRepository;
}

export interface PersonalProviderCreation {
  readonly providerId: ProviderId;
}

export interface CreatePersonalProviderInput {
  readonly templateId?: ProviderTemplateId;
  readonly providerName?: string;
  readonly locale?: ProviderTemplateLocale;
  readonly initialConfig?: ProviderConfig;
}

/** Host-internal member facts supplied by the facade; never trust renderer-reported model lists. */
export interface ProviderModelMembership {
  readonly providerId: ProviderId;
  readonly inheritedModelIds: readonly ModelId[];
  readonly personalRevision: string;
  /** Inside a Personal transaction, verify the published snapshot is fresh; no network. */
  readonly assertCurrent: () => void;
}

function assertMembershipCurrent(
  membership: ProviderModelMembership | undefined,
  providerId: ProviderId,
  current: ProviderConfigLayerSnapshot,
): void {
  if (!membership) return;
  membership.assertCurrent();
  if (membership.providerId !== providerId || membership.personalRevision !== current.revision) {
    throw new Error("Provider Settings membership revision conflict");
  }
}

/** A Personal root record is an overlay, not proof a provider exists; inherited-only providers get overlays on demand. */
function writableProviderOverlay(
  builtin: ProviderConfigLayerSnapshot,
  current: ProviderConfigLayerSnapshot,
  providerId: ProviderId,
): ProviderConfig {
  const provider = current.providers.get(providerId);
  if (provider) return provider;
  if (builtin.providers.has(providerId)) return new ProviderConfigValue({});
  // A deleted custom/template instance has no inherited provider identity; late operations
  // must not resurrect it.
  throw new Error(`Provider not found: ${providerId}`);
}

export class ProviderConfigService implements ProviderSource<ProviderConfigSnapshot> {
  readonly #zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly #personalRepository: PersonalProviderConfigRepository;
  readonly #listeners = new Set<(reason: string) => void>();
  readonly #sourceDisposers: Array<() => void>;
  #disposed = false;

  constructor(dependencies: ProviderConfigServiceDependencies) {
    this.#zcodeBuiltinSource = dependencies.zcodeBuiltinSource;
    this.#personalRepository = dependencies.personalRepository;
    this.#sourceDisposers = [
      this.#zcodeBuiltinSource.onDidChange((reason) => this.#emit(`zcodeBuiltin:${reason}`)),
      this.#personalRepository.onDidChange((reason) => this.#emit(`personal:${reason}`)),
    ];
  }

  async read(): Promise<ProviderConfigSnapshot> {
    this.#assertNotDisposed();
    const [zcodeBuiltin, personal] = await Promise.all([
      this.#zcodeBuiltinSource.read(),
      this.#personalRepository.read(),
    ]);
    return Object.freeze({
      revision: JSON.stringify([zcodeBuiltin.revision, personal.revision]),
      zcodeBuiltinRevision: zcodeBuiltin.revision,
      personalRevision: personal.revision,
      zcodeBuiltinProviders: zcodeBuiltin.providers,
      zcodeBuiltinProviderTemplates: zcodeBuiltin.providerTemplates ?? ProviderTemplateMap.empty(),
      personalProviders: personal.providers,
      zcodeBuiltinModelRules: zcodeBuiltin.models,
      personalModels: personal.models,
      personalProviderOrder: personal.providerOrder ?? [],
    });
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** For version migrations / source cutovers only: atomically replace the whole Personal Overlay. */
  replacePersonalConfig(config: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    // Full import/distribution differs from field edits: a new envelope without a default
    // selection clears it -- never inherit the receiver's old value.
    return this.#personalRepository.update(() => config);
  }

  async savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      const builtin = zcodeBuiltin.providers.get(providerId);
      const currentPersonal = current.providers.get(providerId);
      const currentEffectiveProviders = zcodeBuiltin.providers.overlay(current.providers);
      // The account kill switch was removed; reject new operations at the common write boundary
      // so hidden UI cannot persist invalid state.
      if (builtin?.access?.type === "zhipu-account" && metadata?.enabled === false) {
        throw new Error(`Account provider cannot be disabled: ${providerId}`);
      }
      if (builtin?.access?.type === "zhipu-account" && config.access !== undefined) {
        // The generic save path parses ProviderConfig only and used to bypass the Personal
        // source schema, letting pinned-account access hit disk and fail wholesale on next read.
        throw new Error(
          `Pinned-account access is declared by the ZCode Built-in config only: ${providerId}`,
        );
      }
      // Plain save used to double as create, letting a late save resurrect a deleted overlay.
      // Create is a explicit domain op; plain save updates existing config and rejects if absent.
      if (!currentPersonal && !builtin) {
        throw new Error(`Personal provider not created yet: ${providerId}`);
      }
      let normalized = config;
      if (builtin) {
        if (normalized.group != null && normalized.group !== builtin.group) {
          throw new Error(`Personal overlay cannot rewrite a Built-in provider group: ${providerId}`);
        }
        normalized = normalized.withoutGroup();
      } else {
        const group = normalized.group ?? currentPersonal?.group;
        if (group !== "standard-personal") {
          throw new Error(`Personal-only provider must use the standard-personal group: ${providerId}`);
        }
        normalized = normalized.overlay(new ProviderConfigValue({ group }));
      }
      const membershipBaseline =
        builtin ?? resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      const next = normalized.withModelMembershipFrom(
        // Plain provider saves keep dynamic member order too; a rename must not drop saved
        // ordering by re-deriving it from the static list.
        normalizePersonalProviderMembership(
          currentPersonal,
          membershipBaseline,
          membership?.inheritedModelIds,
        ),
      );
      const currentRule = current.providers.getRule(providerId);
      const providers = current.providers.setRule({
        ...currentRule,
        providerId,
        ...(metadata?.templateId === undefined ? {} : { templateId: metadata.templateId }),
        ...(metadata?.enabled === undefined ? {} : { enabled: metadata.enabled }),
        ...(metadata?.providerName === undefined
          ? {}
          : { providerName: metadata.providerName?.trim() || null }),
        config: next,
      });
      const nextEffectiveProviders = zcodeBuiltin.providers.overlay(providers);
      // Older versions may have left duplicate names. Full validation would let those legacy
      // issues block unrelated saves; here only new duplicates introduced by this rename fail.
      assertProviderLabelMutationIsUnique(
        providerId,
        currentEffectiveProviders,
        nextEffectiveProviders,
      );
      return {
        providers,
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  async createPersonalProvider(
    input: CreatePersonalProviderInput = {},
  ): Promise<PersonalProviderCreation> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    const templateId = input.templateId?.trim();
    const template = templateId ? zcodeBuiltin.providerTemplates?.get(templateId) : undefined;
    if (templateId && !template) throw new Error(`Provider template not found: ${templateId}`);
    if (input.initialConfig?.group !== undefined) {
      throw new Error("initialConfig must not contain group");
    }
    if (input.initialConfig?.builtinModelIds !== undefined) {
      throw new Error("initialConfig must not contain builtinModelIds");
    }
    let createdProviderId: ProviderId | undefined;
    await this.#updatePersonal((current) => {
      const occupied = new Set([...zcodeBuiltin.providers.keys(), ...current.providers.keys()]);
      const providerId = nextPersonalProviderId(occupied, templateId);
      createdProviderId = providerId;
      const effectiveProviders = resolvePersonalProviderBaselines(zcodeBuiltin, current.providers);
      const label = nextPersonalProviderLabel(
        input.providerName ??
          (template && templateId
            ? resolveProviderTemplateName(templateId, template, input.locale ?? "en-US")
            : "new-provider"),
        effectiveProviders,
      );
      const initial = input.initialConfig ?? new ProviderConfigValue();
      const providers = current.providers.setRule({
        providerId,
        ...(templateId ? { templateId } : {}),
        providerName: label,
        config: new ProviderConfigValue({
          group: "standard-personal",
          access: templateId ? undefined : new ApiKeyAccessConfig(),
          personalModelIds: [],
          modelOrder: [],
        }).overlay(initial),
      });
      return {
        providers,
        models: current.models,
        providerOrder: appendCurrentProviderOrder(
          zcodeBuiltin.providers,
          providers,
          current.providerOrder,
          providerId,
        ),
      };
    });
    if (!createdProviderId) throw new Error("Personal provider creation failed");
    return Object.freeze({ providerId: createdProviderId });
  }

  deletePersonalProvider(providerId: ProviderId): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    return this.#updatePersonal((current) => ({
      providers: current.providers.delete(providerId),
      models: current.models.deleteExactForProvider(providerId),
      providerOrder: current.providerOrder?.filter((candidate) => candidate !== providerId),
    }));
  }

  async reorderPersonalProviders(
    providerIds: readonly ProviderId[],
  ): Promise<ProviderConfigLayerSnapshot> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => ({
      providers: current.providers,
      models: current.models,
      providerOrder: normalizeProviderOrder(zcodeBuiltin.providers, current.providers, providerIds),
    }));
  }

  async reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      const builtinProvider =
        zcodeBuiltin.providers.get(providerId) ??
        resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      const provider = writableProviderOverlay(zcodeBuiltin, current, providerId);
      const modelOrder = normalizeModelOrder(
        membership?.inheritedModelIds ?? builtinProvider?.builtinModelIds ?? [],
        provider.personalModelIds ?? [],
        modelIds,
      );
      return {
        providers: current.providers.set(providerId, provider.withModelOrder(modelOrder)),
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  async addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = writableProviderOverlay(zcodeBuiltin, current, normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      if (builtinModelIds.includes(normalizedModelId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${normalizedModelId}`);
      }
      const currentModelIds = provider.personalModelIds ?? [];
      if (currentModelIds.includes(normalizedModelId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${normalizedModelId}`);
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider.withPersonalModelIds([...currentModelIds, normalizedModelId]).withModelOrder(
            // Adding must not re-sort by membership or saved user ordering is lost.
            normalizeModelOrder(
              builtinModelIds,
              [...currentModelIds, normalizedModelId],
              provider.modelOrder ?? [],
            ),
          ),
        ),
        models: current.models.setExact(
          normalizedProviderId,
          normalizedModelId,
          config.overlay(new ModelConfig({ enabled: true })),
          useRecommendedConfig,
        ),
        providerOrder: current.providerOrder,
      };
    });
  }

  async renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const currentId = normalizeId("modelId", currentModelId);
    const nextId = normalizeId("modelId", nextModelId);
    if (currentId === nextId) return this.#personalRepository.read();
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      // Inherited-ownership protection covers facade and direct calls alike; it cannot be
      // checked only when AsyncLocalStorage context exists.
      if (builtinModelIds.includes(currentId))
        throw new Error(`Built-in model cannot be renamed: ${normalizedProviderId}/${currentId}`);
      if (!provider?.personalModelIds?.includes(currentId)) {
        throw new Error(`Personal model not found: ${normalizedProviderId}/${currentId}`);
      }
      if (provider.personalModelIds.includes(nextId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }
      if (builtinModelIds.includes(nextId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }
      const modelIds = provider.personalModelIds.map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        ),
        models: current.models.renameExactModel(normalizedProviderId, currentId, nextId),
        providerOrder: current.providerOrder,
      };
    });
  }

  async setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const id = normalizeId("providerId", providerId);
    const model = normalizeId("modelId", modelId);
    if (typeof enabled !== "boolean") throw new Error("Model enabled must be a boolean");
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, id, current);
      const provider = current.providers.get(id);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, id);
      if (!inherited.includes(model) && !provider?.personalModelIds?.includes(model)) {
        throw new Error(`Model not found: ${id}/${model}`);
      }
      // Enable/disable used to reuse full-draft save, clobbering other edits or getting
      // blocked by pinned-config completeness. The transaction touches latest enabled only --
      // mode, members, and other model fields stay untouched.
      const config = (current.models.getExact(id, model) ?? new ModelConfig({})).overlay(
        new ModelConfig({ enabled }),
      );
      return {
        providers: current.providers,
        models: current.models.setExact(id, model, config),
        providerOrder: current.providerOrder,
      };
    });
  }

  /** The single write boundary of the model edit dialog: members, order, and exact rules commit in one Repository update. */
  async savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const originalId = normalizeId("modelId", originalModelId);
    const nextId = normalizeId("modelId", nextModelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      if (current.revision !== expectedPersonalRevision) {
        throw new Error(
          `Personal Provider Config revision conflict: expected ${expectedPersonalRevision}, current ${current.revision}`,
        );
      }
      const recommended =
        useRecommendedConfig ??
        current.models.getExactRule(normalizedProviderId, originalId)?.type !==
          "manual-provider-model";
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      const builtinSet = new Set(builtinModelIds);
      if (originalId !== nextId && builtinSet.has(originalId)) {
        throw new Error(`Built-in model cannot be renamed: ${normalizedProviderId}/${originalId}`);
      }
      if (originalId !== nextId && builtinSet.has(nextId)) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }
      const personalModelIds = provider?.personalModelIds ?? [];
      const originalExists = builtinSet.has(originalId) || personalModelIds.includes(originalId);
      if (!originalExists) {
        throw new Error(`Model not found: ${normalizedProviderId}/${originalId}`);
      }
      if (originalId !== nextId && (personalModelIds.includes(nextId) || builtinSet.has(nextId))) {
        throw new Error(`Model already exists: ${normalizedProviderId}/${nextId}`);
      }

      let providers = current.providers;
      let models = current.models;
      if (originalId !== nextId) {
        if (!provider?.personalModelIds?.includes(originalId)) {
          throw new Error(`Personal model not found: ${normalizedProviderId}/${originalId}`);
        }
        const modelIds = provider.personalModelIds.map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        providers = providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        );
        models = models.renameExactModel(normalizedProviderId, originalId, nextId);
      }
      models =
        recommended && isStructurallyEmpty(config.toJSON())
          ? models.deleteExact(normalizedProviderId, nextId)
          : models.setExact(normalizedProviderId, nextId, config, recommended);
      return { providers, models, providerOrder: current.providerOrder };
    });
  }

  async deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, normalizedProviderId);
      if (inherited.includes(normalizedModelId))
        throw new Error(`Built-in model cannot be deleted: ${normalizedProviderId}/${normalizedModelId}`);
      if (!provider?.personalModelIds?.includes(normalizedModelId)) {
        throw new Error(`Personal model not found: ${normalizedProviderId}/${normalizedModelId}`);
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(
              provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
            )
            .withModelOrder(
              normalizeModelOrder(
                inherited,
                provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
                provider.modelOrder ?? [],
              ),
            ),
        ),
        models: current.models.deleteExact(normalizedProviderId, normalizedModelId),
        providerOrder: current.providerOrder,
      };
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#sourceDisposers.splice(0)) dispose();
    this.#listeners.clear();
  }

  #updatePersonal(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    return this.#personalRepository.update((current) => ({
      // Provider/model/order edits touch only their own members; a shared file must not wipe
      // the default selection.
      defaultModelSelection: current.defaultModelSelection,
      ...transform(current),
    }));
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason || "changed");
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("ProviderConfigService disposed");
  }
}

function isStructurallyEmpty(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length === 0;
  return Object.values(value).every(isStructurallyEmpty);
}

function assertProviderLabelMutationIsUnique(
  providerId: ProviderId,
  currentProviders: ProviderConfigMap,
  nextProviders: ProviderConfigMap,
): void {
  const currentLabel = currentProviders.getRule(providerId)?.providerName?.trim();
  const nextLabel = nextProviders.getRule(providerId)?.providerName?.trim();
  const currentKey = currentLabel?.toLocaleLowerCase();
  const nextKey = nextLabel?.toLocaleLowerCase();
  if (!nextKey || nextKey === currentKey) return;
  for (const candidate of nextProviders.rules()) {
    const candidateId = candidate.providerId;
    if (candidateId === providerId) continue;
    if (candidate.providerName?.trim().toLocaleLowerCase() === nextKey) {
      throw new Error(`Provider name already exists: ${nextLabel}`);
    }
  }
}

function normalizePersonalProviderMembership(
  personal: ProviderConfig | undefined,
  builtin: ProviderConfig | undefined,
  inheritedModelIds?: readonly ModelId[],
): ProviderConfig | undefined {
  if (!personal) return undefined;
  const builtinModelIds = uniqueInOrder(inheritedModelIds ?? builtin?.builtinModelIds ?? []);
  const builtinSet = new Set(builtinModelIds);
  const personalModelIds = uniqueInOrder(personal.personalModelIds ?? []).filter(
    (modelId) => !builtinSet.has(modelId),
  );
  let normalized = personal.withPersonalModelIds(personalModelIds);
  if (personal.modelOrder !== undefined && personal.modelOrder !== null) {
    normalized = normalized.withModelOrder(
      normalizeModelOrder(builtinModelIds, personalModelIds, personal.modelOrder),
    );
  }
  return normalized;
}

function assertNonEmptyId(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function normalizeId(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

function normalizeProviderOrder(
  _zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  requested: readonly ProviderId[],
): ProviderId[] {
  const personalIds = personalProviders
    .entries()
    .filter(([, config]) => config.group === "standard-personal")
    .map(([providerId]) => providerId);
  return [...resolveOwnedOrder([], personalIds, requested)];
}

function appendCurrentProviderOrder(
  zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  currentOrder: readonly ProviderId[] | undefined,
  addedProviderId: ProviderId,
): ProviderId[] {
  const current = normalizeProviderOrder(
    zcodeBuiltinProviders,
    personalProviders,
    currentOrder ?? [],
  );
  return normalizeProviderOrder(zcodeBuiltinProviders, personalProviders, [
    ...current.filter((providerId) => providerId !== addedProviderId),
    addedProviderId,
  ]);
}

function normalizeModelOrder(
  builtinModelIds: readonly ModelId[],
  personalModelIds: readonly ModelId[],
  requested: readonly ModelId[],
): ModelId[] {
  return [...resolveOwnedOrder(builtinModelIds, personalModelIds, requested)];
}

function nextPersonalProviderId(
  occupied: ReadonlySet<ProviderId>,
  templateId?: ProviderTemplateId,
): ProviderId {
  const base = templateId ? normalizeProviderIdSeed(templateId) : "new-provider";
  if (!occupied.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function normalizeProviderIdSeed(value: string): string {
  return (
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "new-provider"
  );
}

function resolvePersonalProviderBaselines(
  zcodeBuiltin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
): ProviderConfigMap {
  const personal = personalProviders.mapConfigs((config, _id, rule) => {
    const template = rule.templateId
      ? zcodeBuiltin.providerTemplates?.get(rule.templateId)
      : undefined;
    return template ? template.config.overlay(config) : config;
  });
  return zcodeBuiltin.providers.overlay(personal);
}

function resolveTemplateBaseline(
  builtin: ProviderConfigLayerSnapshot,
  providers: ProviderConfigMap,
  providerId: ProviderId,
): ProviderConfig | undefined {
  const templateId = providers.getRule(providerId)?.templateId;
  return templateId ? builtin.providerTemplates?.get(templateId)?.config : undefined;
}

function resolveProviderBuiltinModelIds(
  builtin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
  providerId: ProviderId,
): readonly ModelId[] {
  return (
    builtin.providers.get(providerId)?.builtinModelIds ??
    resolveTemplateBaseline(builtin, personalProviders, providerId)?.builtinModelIds ??
    []
  );
}

function nextPersonalProviderLabel(seed: string, providers: ProviderConfigMap): string {
  const base = seed.trim() || "new-provider";
  const labels = new Set(
    providers
      .rules()
      .map((provider) => provider.providerName?.trim().toLocaleLowerCase())
      .filter((label): label is string => Boolean(label)),
  );
  if (!labels.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!labels.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
