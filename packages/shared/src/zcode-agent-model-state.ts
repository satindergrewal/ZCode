// -- Legacy protocol compat surface (transition) ----------------------------------------
// Remaining 5 exports: legacy configOptions projections (formatModelPickerValue/normalizeAvailableZCodeMode/
// getZCodeAgentModeSelectOptions/getZCodeAgentAvailableModes/
// zcodeSessionSettingsToZCodeConfigOptions; class B, removal in wave 3).
// Consumers: services zcodeConfigOptions/botsService, UI zcodeSessionProjection, and other legacy stacks.
// Since the 2026-09 Guarded wrap-up, ZCODE_AGENT_MODE_OPTIONS is the single mode catalog shared by the
// Desktop/mobile Composer and Automation/OffPeak forms (consumed directly by UI zcodeSessionProjection /
// getZCodeAgentAvailableModes / getZCodeAgentModeSelectOptions / normalizeAvailableZCodeMode）。
// Before wave 3 removes these exports, migrate the mode catalog off legacy; never delete the catalog itself.
import { formatModelPickerValue } from "./model-selection.js";
import type { ZCodeSessionMode, ZCodeSessionSettingsState } from "./zcode-protocol/index.js";
import type { ZCodeConfigOption, ZCodeTaskModeInfo } from "./zcode-task-types-core.js";
const MODEL_CONFIG_ID = "model";
const MODEL_CONFIG_CATEGORY = "model";
const MODE_CONFIG_ID = "mode";
const MODE_CONFIG_CATEGORY = "mode";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const THOUGHT_LEVEL_CONFIG_CATEGORY = "thought_level";
const ZCODE_AGENT_MODE_OPTIONS = [
  {
    id: "build",
    name: "Ask before changes",
    description: "Ask before each file changes.",
  },
  {
    id: "guarded",
    name: "Autonomous mode",
    description: "Ask when there’s risk",
  },
  {
    id: "plan",
    name: "Plan mode",
    description: "Inspect the code and present a plan before editing.",
  },
  {
    id: "yolo",
    name: "Full access",
    description: "Edit and run commands with fewer confirmations.",
  },
] as const satisfies readonly ZCodeTaskModeInfo[];
// Hiding Edit from the menu is not deleting the historical value; restore/projection must not downgrade an old edit to build just because candidates changed.
const ZCODE_AGENT_MODE_ID_SET = new Set<string>([
  ...ZCODE_AGENT_MODE_OPTIONS.map((mode) => mode.id),
  "edit",
]);

// OpenRouter keeps `:free` as part of the model id. The UI/configOptions display state
// can no longer split thought levels on a colon, or draft selection silently truncates the real modelId.
export function normalizeAvailableZCodeMode(mode: ZCodeSessionMode): string {
  return ZCODE_AGENT_MODE_ID_SET.has(mode) ? mode : "build";
}

export function getZCodeAgentModeSelectOptions(): NonNullable<ZCodeConfigOption["options"]> {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

export function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({ ...mode }));
}

export function zcodeSessionSettingsToZCodeConfigOptions(
  settings: ZCodeSessionSettingsState,
): ZCodeConfigOption[] {
  const configOptions: ZCodeConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: MODEL_CONFIG_CATEGORY,
      type: "select",
      currentValue: formatModelPickerValue(settings.model.current),
      options: settings.model.available.map((model) => {
        const modelThoughtLevels = model.reasoning?.levels.map((level) => level.value);
        const modelDefaultThoughtLevel =
          model.reasoning?.defaultLevel &&
          modelThoughtLevels?.includes(model.reasoning.defaultLevel)
            ? model.reasoning.defaultLevel
            : undefined;
        return {
          value: formatModelPickerValue(model.ref),
          name: model.label,
          description: model.description,
          modelProviderId: model.ref.providerId,
          modelProviderName: model.providerLabel ?? model.ref.providerId,
          ...(modelThoughtLevels ? { modelThoughtLevels } : {}),
          ...(modelDefaultThoughtLevel ? { modelDefaultThoughtLevel } : {}),
        };
      }),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: MODE_CONFIG_CATEGORY,
      type: "select",
      currentValue: normalizeAvailableZCodeMode(settings.mode.current),
      options: getZCodeAgentModeSelectOptions(),
    },
  ];
  if (settings.thoughtLevel.enabled) {
    const thoughtLevelValues = new Set(settings.thoughtLevel.available.map((level) => level.value));
    const defaultThoughtLevel =
      settings.thoughtLevel.defaultLevel &&
      thoughtLevelValues.has(settings.thoughtLevel.defaultLevel)
        ? settings.thoughtLevel.defaultLevel
        : undefined;
    configOptions.push({
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought Level",
      category: THOUGHT_LEVEL_CONFIG_CATEGORY,
      type: "select",
      currentValue:
        settings.thoughtLevel.current ??
        defaultThoughtLevel ??
        settings.thoughtLevel.available[0]?.value ??
        "",
      options: settings.thoughtLevel.available.map((level) => ({
        value: level.value,
        name: level.label,
        description: level.description,
      })),
    });
  }
  return configOptions;
}
