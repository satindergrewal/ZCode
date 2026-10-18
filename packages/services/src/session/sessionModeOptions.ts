import type { ZCodeConfigOption, ZCodeProvider, ZCodeTaskMode } from "@zcode/shared";

const CANONICAL_SESSION_MODES = new Set<ZCodeTaskMode>([
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getModeConfigOption(options: readonly ZCodeConfigOption[]): ZCodeConfigOption | undefined {
  return options.find((option) => option.category === "mode" && option.type === "select");
}

function normalizePersistedSessionMode(
  modeId: string | null | undefined,
  _provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  const trimmedModeId = readTrimmedString(modeId);
  if (!trimmedModeId) {
    return undefined;
  }

  if (CANONICAL_SESSION_MODES.has(trimmedModeId as ZCodeTaskMode)) {
    return trimmedModeId as ZCodeTaskMode;
  }

  switch (trimmedModeId) {
    // Bugfix: provider-native modeIds and the locally persisted session mode are different enums.
    // Map local semantics back onto values that really exist in the provider options before sending.
    case "read-only":
    case "read_only":
      return "plan";
    case "auto_edit":
    case "auto-edit":
    case "autoEdit":
    case "accept_edits":
    case "accept-edits":
      return "acceptEdits";
    case "full-auto":
    case "full_auto":
      return "yolo";
    case "agent":
      // 该 modeId 专属于已下线的第三方 provider；不再映射到任何本地 mode。
      return undefined;
    case "agent-full-access":
    case "agent_full_access":
    case "full-access":
    case "full_access":
      return "bypassPermissions";
    default:
      return undefined;
  }
}

export function resolveProviderModeIdFromConfigOptions(params: {
  configOptions: readonly ZCodeConfigOption[];
  modeId: string | null | undefined;
  provider?: ZCodeProvider;
}): string | undefined {
  const requestedMode = readTrimmedString(params.modeId);
  if (!requestedMode) {
    return undefined;
  }

  const modeOption = getModeConfigOption(params.configOptions);
  const candidates = modeOption?.options ?? [];
  const exactMatch = candidates.find((candidate) => candidate.value === requestedMode);
  if (exactMatch) {
    return exactMatch.value;
  }

  const requestedPersistedMode = normalizePersistedSessionMode(requestedMode, params.provider);
  if (!requestedPersistedMode) {
    return undefined;
  }

  const semanticMatch = candidates.find(
    (candidate) =>
      normalizePersistedSessionMode(candidate.value, params.provider) === requestedPersistedMode,
  );

  return semanticMatch?.value;
}
