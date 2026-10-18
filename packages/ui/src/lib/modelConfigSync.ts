import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  buildNativeSupplierKey,
  resolveSupplierKeyFromModelDisplayValue,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

interface ModelConfigSyncScope {
  provider: ZCodeProvider;
  supplierKey: string;
}

export interface ModelConfigSyncWorkspaceSnapshot {
  activeTaskId: string | null;
  selectedProvider: ZCodeProvider;
  selectedSupplierKey: string;
  configOptions: ZCodeConfigOption[] | null;
  optimisticTaskListByTaskId: Record<string, Pick<ZCodeTaskMeta, "provider">>;
  taskListCache: ZCodeTaskMeta[] | null;
}

export function parseCustomProviderIdFromSupplierKey(supplierKey: string): string | null {
  const normalizedSupplierKey = supplierKey.trim();
  if (normalizedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const providerId = normalizedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return providerId || null;
  }

  if (!normalizedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return null;
  }

  const firstSeparatorIndex = normalizedSupplierKey.indexOf(":", GHOST_SUPPLIER_KEY_PREFIX.length);
  const secondSeparatorIndex =
    firstSeparatorIndex >= 0 ? normalizedSupplierKey.indexOf(":", firstSeparatorIndex + 1) : -1;
  if (secondSeparatorIndex < 0) {
    return null;
  }

  const encodedIdentity = normalizedSupplierKey.slice(secondSeparatorIndex + 1);
  let identity = encodedIdentity;
  try {
    identity = decodeURIComponent(encodedIdentity);
  } catch {
    identity = encodedIdentity;
  }

  // After a custom provider edit the current model can sit in a ghost
  // supplier state keyed like ghost:glm:no-preference:provider=provider-demo...
  // Matching only custom:* leaves later registry refreshes unable to find the custom provider.
  // Recover the provider metadata from the ghost identity so saving refreshes the right config.
  const providerSegment = identity
    .split(",")
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith("provider="));
  const providerId = providerSegment?.slice("provider=".length).trim();
  return providerId || null;
}

export function isCustomSupplierKeyForProvider(supplierKey: string, providerId: string): boolean {
  return parseCustomProviderIdFromSupplierKey(supplierKey) === providerId.trim();
}

function isCustomSupplierKey(supplierKey: string): boolean {
  return parseCustomProviderIdFromSupplierKey(supplierKey) !== null;
}

function resolveModelSupplierKeyFromConfigOptions(
  configOptions: ZCodeConfigOption[] | null,
  provider: ZCodeProvider,
): string | null {
  const modelValue = resolveModelValueFromConfigOptions(configOptions);
  if (!modelValue) {
    return null;
  }

  return resolveSupplierKeyFromModelDisplayValue(provider, modelValue);
}

function resolveActiveTaskProvider(
  snapshot: ModelConfigSyncWorkspaceSnapshot,
): ZCodeProvider | null {
  const activeTaskId = snapshot.activeTaskId?.trim();
  if (!activeTaskId) {
    return null;
  }

  const taskProvider =
    snapshot.optimisticTaskListByTaskId[activeTaskId]?.provider ??
    snapshot.taskListCache?.find((task) => task.taskId === activeTaskId)?.provider ??
    null;

  return taskProvider ?? null;
}

export function resolveWorkspaceModelConfigSyncScope(
  snapshot: ModelConfigSyncWorkspaceSnapshot,
): ModelConfigSyncScope {
  const activeTaskProvider = resolveActiveTaskProvider(snapshot);
  if (!activeTaskProvider) {
    return {
      provider: snapshot.selectedProvider,
      supplierKey: snapshot.selectedSupplierKey,
    };
  }

  const modelSupplierKey = resolveModelSupplierKeyFromConfigOptions(
    snapshot.configOptions,
    activeTaskProvider,
  );
  if (modelSupplierKey && isCustomSupplierKey(modelSupplierKey)) {
    return {
      provider: activeTaskProvider,
      supplierKey: modelSupplierKey,
    };
  }

  if (activeTaskProvider === snapshot.selectedProvider) {
    // Bugfix: custom-provider agent replies often carry a bare model name (glm-5.1);
    // deriving the supplier from it alone misreads native and refreshes the wrong scope after settings saves.
    // When the provider matches selectedProvider, a bare model name proves nothing -- keep selectedSupplierKey.
    return {
      provider: activeTaskProvider,
      supplierKey: snapshot.selectedSupplierKey,
    };
  }

  if (modelSupplierKey) {
    return {
      provider: activeTaskProvider,
      supplierKey: modelSupplierKey,
    };
  }

  return {
    provider: activeTaskProvider,
    supplierKey: buildNativeSupplierKey(activeTaskProvider),
  };
}

function resolveModelValueFromConfigOptions(
  configOptions: ZCodeConfigOption[] | null,
): string | null {
  const modelOption = configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );

  if (!modelOption) {
    return null;
  }

  const modelValue = modelOption.currentValue;
  const normalizedModelValue =
    typeof modelValue === "string" ? modelValue.trim() : String(modelValue ?? "").trim();

  return normalizedModelValue.length > 0 ? normalizedModelValue : null;
}

export function resolveModelNameForConfigSync(params: {
  configOptions: ZCodeConfigOption[] | null;
  selectedProvider: ZCodeProvider;
  providerId: string;
  providerModels: string[];
}): string | undefined {
  const modelValue = resolveModelValueFromConfigOptions(params.configOptions);
  if (!modelValue) {
    return undefined;
  }

  const decodedCustomValue = decodeCustomModelValue(modelValue);
  if (decodedCustomValue?.providerId === params.providerId) {
    const customModelName = decodedCustomValue.modelName?.trim();
    if (customModelName && params.providerModels.includes(customModelName)) {
      return customModelName;
    }

    return undefined;
  }

  if (params.providerModels.includes(modelValue)) {
    return modelValue;
  }

  return undefined;
}
