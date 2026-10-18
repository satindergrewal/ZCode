import type {
  ZCodeConfigOption,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeSessionMode,
  ZCodeSessionSettingsState,
  ZCodeSessionStateSnapshot,
  ZCodeTaskModeInfo,
} from "@zcode/shared";
import {
  formatModelPickerValue as formatSharedModelSelection,
  getZCodeAgentAvailableModes as getSharedZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode as normalizeSharedAvailableZCodeMode,
  zcodeSessionSettingsToZCodeConfigOptions,
} from "@zcode/shared";

export const MODEL_CONFIG_ID = "model";
export const MODE_CONFIG_ID = "mode";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

function resolveLatestMessageModelSelection(
  messages: readonly ZCodeMessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}

function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): ModelSelection | undefined {
  // Legacy resume could overwrite settings.current with the app default model, while
  // message info.model keeps the truly used one. Task meta is a restore hint:
  // record the latest message's model so a wrong snapshot cannot pollute the index.
  return resolveLatestMessageModelSelection(snapshot.messages) ?? snapshot.settings.model.current;
}

export function formatTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): string {
  return formatModelPickerValue(resolveTaskMetaModelSelectionFromSnapshot(snapshot));
}

export function normalizeAvailableZCodeMode(mode: ZCodeSessionMode): string {
  return normalizeSharedAvailableZCodeMode(mode);
}

export function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return getSharedZCodeAgentAvailableModes();
}

export function settingsToConfigOptions(settings: ZCodeSessionSettingsState): ZCodeConfigOption[] {
  // The service once kept its own three-mode allowlist and missed the edit mode, so
  // mode_update rewrote the UI menu to build/plan/yolo. Reuse the shared source of truth.
  return zcodeSessionSettingsToZCodeConfigOptions(settings);
}
