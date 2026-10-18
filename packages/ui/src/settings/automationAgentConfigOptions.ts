import {
  getZCodeAgentModeSelectOptions,
  type ModelSelection,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  type ModelProviderGroupLabelOptions,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveV4ModelTriggerLabel } from "@/v4/composer/modelTriggerDisplay.js";

// The scheduled form stays a pure local draft: never borrow workspace default-config writes for options,
// or merely opening/cancel would change the project's and draft session's runtime config.

/** Permission default: Ask before changes. */
export const AUTOMATION_DEFAULT_MODE = "build";

/** Creation must pin the target Host's preferredSelection to a concrete model, never save a virtual default model. */
export function resolveAutomationPreferredModelValue(
  view: Pick<ModelSelectionView, "preferredSelection">,
): string | null {
  const preferred = view.preferredSelection;
  return preferred ? encodeCustomModelValue(preferred.providerId, preferred.modelId) : null;
}

export function buildAutomationModelSelectGroups(params: {
  selectedProvider: ZCodeProvider;
  labels: ModelProviderGroupLabelOptions;
  registrySelectionView: ModelSelectionView;
}): ModelSelectGroup[] {
  return buildRegistryModelSelectGroups(
    params.selectedProvider,
    params.registrySelectionView,
    params.labels,
  );
}

export function buildAutomationModeOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
    options: getZCodeAgentModeSelectOptions(),
  };
}

function findDirectModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  for (const group of modelGroups) {
    const item = group.items.find((candidate) => candidate.value === modelValue);
    if (item) return item;
  }
  return null;
}

export function resolveAutomationModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  const direct = findDirectModelItem(modelGroups, modelValue);
  if (direct) return direct;

  const separator = modelValue.indexOf("/");
  const qualifiedProviderId = separator > 0 ? modelValue.slice(0, separator) : null;
  const qualifiedModelId = separator > 0 ? modelValue.slice(separator + 1) : modelValue;
  const modelMatches = modelGroups.flatMap((group) =>
    group.items.filter((item) => {
      const decoded = decodeCustomModelValue(item.value);
      return decoded?.modelName === qualifiedModelId;
    }),
  );
  if (qualifiedProviderId) {
    const providerMatches = modelMatches.filter(
      (item) => decodeCustomModelValue(item.value)?.providerId === qualifiedProviderId,
    );
    if (providerMatches.length === 1) return providerMatches[0] ?? null;
  }
  // Historic automations may hold a bare model name; the same name across providers must not be guessed.
  // Workspace runtimes may also return wrapped values like zcode-openai-compatible/model; when the provider mismatches,
  // backfill the menu item only if the name is globally unique, keeping think metadata with the default.
  return modelMatches.length === 1 ? (modelMatches[0] ?? null) : null;
}

export function resolveAutomationModelTriggerLabel(params: {
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelValue: string;
  fallbackLabel: string;
}): string {
  const selectedItem = resolveAutomationModelItem(params.modelGroups, params.modelValue);
  if (!selectedItem) {
    const decodedModel = decodeCustomModelValue(params.modelValue);
    if (decodedModel?.modelName) {
      // Historic names are display-only; never backfill candidates nor alter save/dispatch.
      return decodedModel.modelName;
    }

    const separator = params.modelValue.indexOf("/");
    return separator > 0
      ? params.modelValue.slice(separator + 1)
      : params.modelValue.trim() || params.fallbackLabel;
  }

  const selectedModel = decodeCustomModelValue(selectedItem.value);
  const providerId = selectedModel?.providerId;
  const providerName =
    params.modelSelectionView?.providers.find((provider) => provider.providerId === providerId)
      ?.providerName ?? undefined;

  // Automations once truncated provider/model protocol values to the last segment,
  // diverging identity copy between session and scheduled sides. Reuse the session rule,
  // keeping the unified trim for builtin families and dead values.
  return resolveV4ModelTriggerLabel({
    modelGroups: params.modelGroups,
    normalizedValue: selectedItem.value,
    fallbackLabel: params.fallbackLabel,
    providerId,
    providerName,
  });
}

export function buildAutomationThoughtLevelOption(
  runtimeOption: ZCodeConfigOption | undefined,
  currentValue: string,
): ZCodeConfigOption | null {
  const options = runtimeOption?.options ?? [];
  if (options.length === 0) return null;
  const validCurrentValue = options.some((option) => option.value === currentValue);
  // Candidate refresh is not a user choice; never rewrite a dead level to default/highest and save.
  const resolvedValue = validCurrentValue ? currentValue : "";

  return {
    id: "thought_level",
    name: runtimeOption?.name ?? "Effort",
    category: "thought_level",
    type: "select",
    currentValue: resolvedValue,
    options: options.map((option) => ({ ...option })),
  };
}

/**
 * 更新已有定时任务时必须用 null 显式清掉不支持 Think 的目标模型旧值；
 * undefined 在 update 协议里表示“不修改”，会把源模型的档位残留到下次派发。
 */
export function resolveAutomationThoughtLevelUpdate(params: {
  editing: boolean;
  explicitlyChanged: boolean;
  modelChanged: boolean;
  persistedReasoningLevel?: string;
  resolvedThoughtLevel: string;
  thoughtLevel: string;
}): string | null | undefined {
  if (params.resolvedThoughtLevel) {
    if (params.explicitlyChanged) return params.thoughtLevel;
    if (params.editing && !params.modelChanged) {
      return params.persistedReasoningLevel?.trim() || params.resolvedThoughtLevel;
    }
    return params.resolvedThoughtLevel;
  }
  return params.editing ? null : undefined;
}

/** Automation 只持久化模型选择；输出预算由执行链按本次请求决定。 */
export function buildAutomationModelSelection(params: {
  selected: ModelSelection;
  reasoningLevel?: string | null;
  previous?: ModelSelection;
}): ModelSelection {
  const reasoningLevel = params.reasoningLevel?.trim();
  const options = reasoningLevel ? { reasoningLevel } : {};
  return {
    providerId: params.selected.providerId,
    modelId: params.selected.modelId,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}
