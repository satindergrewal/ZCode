import type { ZCodeConfigOption, ZCodeTaskMeta } from "@zcode/shared";
import { getZCodeAgentModeSelectOptions } from "@zcode/shared";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

function parseProviderQualifiedModel(
  model: string,
): { providerId: string; modelName: string } | null {
  const normalizedModel = model.trim();
  const separatorIndex = normalizedModel.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalizedModel.length - 1) {
    return null;
  }

  const providerId = normalizedModel.slice(0, separatorIndex).trim();
  const modelName = normalizedModel.slice(separatorIndex + 1).trim();
  if (!providerId || !modelName) {
    return null;
  }

  return { providerId, modelName };
}

function isSyntheticModelPlaceholder(model: string): boolean {
  return model.trim().toLocaleLowerCase() === "<synthetic>";
}

export function resolveGlmRecoveredTaskModelValue(taskModel: string | undefined): string | null {
  const normalizedTaskModel = taskModel?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedTaskModel);
  if (customModel?.providerId && customModel.modelName) {
    return normalizedTaskModel;
  }

  const providerQualifiedModel = parseProviderQualifiedModel(normalizedTaskModel);
  if (providerQualifiedModel) {
    return encodeCustomModelValue(
      providerQualifiedModel.providerId,
      providerQualifiedModel.modelName,
    );
  }

  return normalizedTaskModel;
}

export function resolveRecoveredTaskModelValue(
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">,
): string | null {
  const normalizedTaskModel = taskMeta.model?.trim();
  if (!normalizedTaskModel || isSyntheticModelPlaceholder(normalizedTaskModel)) {
    return null;
  }

  if (taskMeta.provider === "glm") {
    return resolveGlmRecoveredTaskModelValue(normalizedTaskModel);
  }

  return normalizedTaskModel;
}

function resolveModelOptionName(modelValue: string): string {
  const customModel = decodeCustomModelValue(modelValue);
  const providerQualifiedModel = parseProviderQualifiedModel(modelValue);
  return customModel?.modelName?.trim() || providerQualifiedModel?.modelName || modelValue;
}

function ensureModelOptionValue(option: ZCodeConfigOption, modelValue: string): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === modelValue);
  if (hasOption && option.currentValue === modelValue) {
    return option;
  }

  return {
    ...option,
    currentValue: modelValue,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: resolveModelOptionName(modelValue),
            value: modelValue,
          },
        ],
  };
}

function createRecoveredModelOption(modelValue: string): ZCodeConfigOption {
  return {
    category: "model",
    currentValue: modelValue,
    id: "model",
    name: "Model",
    options: [
      {
        name: resolveModelOptionName(modelValue),
        value: modelValue,
      },
    ],
    type: "select",
  };
}

function createRecoveredModeOption(modeValue: string): ZCodeConfigOption {
  return {
    category: "mode",
    currentValue: modeValue,
    id: "mode",
    name: "Mode",
    options: getZCodeAgentModeSelectOptions(),
    type: "select",
  };
}

function createRecoveredThoughtLevelOption(thoughtLevel: string): ZCodeConfigOption {
  return {
    category: "thought_level",
    currentValue: thoughtLevel,
    id: "thought_level",
    name: "Effort",
    options: [
      {
        name: thoughtLevel,
        value: thoughtLevel,
      },
    ],
    type: "select",
  };
}

function ensureSelectOptionCurrentValue(
  option: ZCodeConfigOption,
  value: string,
): ZCodeConfigOption {
  const options = option.options ?? [];
  const hasOption = options.some((candidate) => candidate.value === value);
  if (hasOption && option.currentValue === value) {
    return option;
  }

  return {
    ...option,
    currentValue: value,
    options: hasOption
      ? options
      : [
          ...options,
          {
            name: value,
            value,
          },
        ],
  };
}

export function mergeRecoveredTaskModelConfigOptions({
  taskMeta,
  configOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">;
  configOptions: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] | null {
  const recoveredModelValue = resolveRecoveredTaskModelValue(taskMeta);
  if (!recoveredModelValue) {
    return null;
  }

  let hasModelOption = false;
  let changed = false;
  const nextConfigOptions = configOptions.map((option) => {
    if (option.category !== "model" || option.type !== "select") {
      return option;
    }

    hasModelOption = true;
    const nextOption = ensureModelOptionValue(option, recoveredModelValue);
    changed = changed || nextOption !== option;
    return nextOption;
  });

  if (!hasModelOption) {
    // On historical-task restore, resume/config_option_update may lag the first frame.
    // Clearing the previous task config alone flashes the toolbar back to select-model; synthesize a minimal model
    // item from task.meta.model to hold the persisted choice, overwritten once real configOptions land.
    return [createRecoveredModelOption(recoveredModelValue), ...nextConfigOptions];
  }

  // On legacy-session restore the task config may already carry task.meta.model.
  // Returning a fresh array with no change would ping-pong setTaskConfigOptions against the toolbar restore effect.
  return changed ? nextConfigOptions : null;
}

export function resolveTaskRestorePreloadConfigOptions({
  taskMeta,
  cachedTaskConfigOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model"> &
    Partial<Pick<ZCodeTaskMeta, "mode" | "thoughtLevel">>;
  cachedTaskConfigOptions?: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] {
  let cachedOptions = [...(cachedTaskConfigOptions ?? [])];
  const recoveredOptions = mergeRecoveredTaskModelConfigOptions({
    taskMeta,
    configOptions: cachedOptions,
  });

  if (recoveredOptions) {
    cachedOptions = recoveredOptions;
  }

  const mode = taskMeta.mode?.trim();
  if (taskMeta.provider === "glm" && mode) {
    let hasModeOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "mode" || option.type !== "select") {
        return option;
      }
      hasModeOption = true;
      return ensureSelectOptionCurrentValue(option, mode);
    });
    if (!hasModeOption) {
      // Until real settings arrive, a cron-triggered task exposes only task meta in the composer:
      // synthesize the minimal mode option from meta so the permission entry never flashes the workspace default.
      cachedOptions = [createRecoveredModeOption(mode), ...cachedOptions];
    }
  }

  const thoughtLevel = taskMeta.thoughtLevel?.trim();
  if (taskMeta.provider === "glm" && thoughtLevel) {
    let hasThoughtOption = false;
    cachedOptions = cachedOptions.map((option) => {
      if (option.category !== "thought_level" || option.type !== "select") {
        return option;
      }
      hasThoughtOption = true;
      return ensureSelectOptionCurrentValue(option, thoughtLevel);
    });
    if (!hasThoughtOption) {
      // As with mode, an automation task-local thoughtLevel must echo from task meta first;
      // session settings later fill the full thought options the model supports.
      cachedOptions = [...cachedOptions, createRecoveredThoughtLevelOption(thoughtLevel)];
    }
  }

  // Once a historical task has been opened, taskConfigOptionsByTaskId holds the full
  // model/mode/thought_level. Clearing on a missing task.meta.model alone would hide mode/thought
  // until the new snapshot lands; keep the task-level cache and let
  // setTaskConfigOptions override and hide on real missing fields.
  return cachedOptions;
}

export function mergeGlmRecoveredTaskModelConfigOptions({
  taskMeta,
  configOptions,
}: {
  taskMeta: Pick<ZCodeTaskMeta, "provider" | "model">;
  configOptions: readonly ZCodeConfigOption[];
}): ZCodeConfigOption[] | null {
  if (taskMeta.provider !== "glm") {
    return null;
  }

  return mergeRecoveredTaskModelConfigOptions({ taskMeta, configOptions });
}
