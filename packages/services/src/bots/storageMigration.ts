import {
  decodeCustomModelValue,
  migrateLegacyModelProviderId,
  migrateLegacyOfficialGlmModelId,
  modelSelectionSchema,
  ZCODE_AGENT_PROVIDER,
  type ModelSelection,
} from "@zcode/shared";
import { normalizeBotCurrentOptions, normalizeBotDraftOptions } from "./config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Called only when the v3 file is absent; not a compatibility reader for current Bot Options. */
function migrateSelection(options: Record<string, unknown>): ModelSelection | undefined {
  if (Object.hasOwn(options, "modelSelection")) {
    // Bug root cause: the legacy thoughtLevel overwrote the saved new level; never read the old field when the new one exists.
    const parsed = modelSelectionSchema.safeParse(options.modelSelection);
    if (!parsed.success) return undefined;
    const selection = parsed.data;
    if (!selection.providerId.startsWith("builtin:")) return selection;
    const providerId = migrateLegacyModelProviderId(selection.providerId);
    return providerId
      ? {
          ...selection,
          providerId,
          modelId: migrateLegacyOfficialGlmModelId(selection.providerId, selection.modelId),
        }
      : undefined;
  }
  const value = typeof options.model === "string" ? options.model.trim() : "";
  const custom = decodeCustomModelValue(value);
  const separator = value.indexOf("/");
  const oldProviderId =
    custom?.providerId ?? (separator > 0 ? value.slice(0, separator) : undefined);
  const modelId = custom?.modelName ?? (separator > 0 ? value.slice(separator + 1) : undefined);
  if (!oldProviderId || !modelId) return undefined;
  const providerId = migrateLegacyModelProviderId(oldProviderId);
  // Accept explicit identity only: no unique model-name matching against other providers, and no
  // bare-model-name-as-Agent-Provider interpretation.
  // Bug root cause: with no candidates, an explicit legacy choice was permanently blanked in v3;
  // migration carries intent only and must not check current availability.
  if (!providerId) return undefined;
  const reasoningLevel =
    typeof options.thoughtLevel === "string" ? options.thoughtLevel.trim() : "";
  return {
    providerId,
    modelId: migrateLegacyOfficialGlmModelId(oldProviderId, modelId),
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export function importLegacyBotConfig(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.bots)) return value;
  return {
    ...value,
    version: 3,
    bots: value.bots.map((bot) => {
      if (!isRecord(bot)) return bot;
      const options = isRecord(bot.currentOptions) ? bot.currentOptions : {};
      return {
        ...bot,
        currentOptions: normalizeBotCurrentOptions({
          ...options,
          modelSelection: migrateSelection(options),
        }),
      };
    }),
  };
}

export function importLegacyBotState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.bots)) return value;
  const bots = Object.entries(value.bots).map(([id, state]) => {
    if (!isRecord(state) || !isRecord(state.draftOptions)) return [id, state];
    const options = state.draftOptions;
    return [
      id,
      {
        ...state,
        draftOptions: normalizeBotDraftOptions({
          provider: ZCODE_AGENT_PROVIDER,
          modelSelection: migrateSelection(options),
          ...(typeof options.mode === "string" ? { mode: options.mode } : {}),
        }),
      },
    ];
  });
  return { ...value, version: 3, bots: Object.fromEntries(bots) };
}
