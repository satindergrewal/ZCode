import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  buildNativeSupplierKey,
  resolveSupplierKeyFromModelDisplayValue,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";

interface ModelConfigSyncScope {
  provider: ZCodeProvider;
  supplierKey: string;
}

interface ModelConfigSyncWorkspaceSnapshot {
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

  // After a custom provider's config changes, the current model may sit in a ghost supplier
  // state with keys like ghost:glm:no-preference:provider=provider-demo...
  // Recognizing only custom:* would leave later provider-registry refreshes unable to locate
  // the custom provider. Recover the provider metadata from the ghost identity so saving the
  // config refreshes the right entry.
  const providerSegment = identity
    .split(",")
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith("provider="));
  const providerId = providerSegment?.slice("provider=".length).trim();
  return providerId || null;
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
    // ZCode Agent replies on custom providers often carry a bare model name (e.g. glm-5.1).
    // Deriving the supplier from the model value alone misclassifies it as a native supplier
    // and sends post-save refreshes to the wrong scope. While the provider matches
    // selectedProvider, a bare model name does not prove the supplier changed, so keep
    // selectedSupplierKey.
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
