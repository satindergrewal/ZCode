import { useMemo } from "react";
import type { ZCodeConfigOption } from "@zcode/shared";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * Where the subagent model's provider name comes from: the session's model list (the
 * workspace configOptions entry with category === "model") already carries
 * `modelProviderId` / `modelProviderName`; no second provider catalog for one label.
 *
 * Names only, never ids: without a providerLabel, `modelProviderName` falls back to the
 * providerId itself (see zcodeSessionSettingsToConfigOptions); treat that as "no name" —
 * a providerId must never reach the screen (for team plans it is a UUID).
 */
function workflowSubagentProviderNameLookup(
  configOptions: readonly ZCodeConfigOption[] | null | undefined,
): ((providerId: string) => string | undefined) | undefined {
  const entries = configOptions?.find((option) => option.category === "model")?.options;
  if (entries === undefined) {
    return undefined;
  }
  const names = new Map<string, string>();
  for (const entry of entries) {
    const providerId = entry.modelProviderId?.trim();
    const providerName = entry.modelProviderName?.trim();
    if (!providerId || !providerName || providerName === providerId) {
      continue;
    }
    if (!names.has(providerId)) {
      names.set(providerId, providerName);
    }
  }
  return names.size === 0 ? undefined : (providerId: string) => names.get(providerId);
}

/**
 * Hook form of the table above. A missing workspacePath (host cannot scope) means no
 * lookup: name building falls back to the bare modelId — a deliberate backstop, not a bug.
 */
export function useWorkflowSubagentModelProviderName(
  workspacePath: string | undefined,
  workspaceIdentity?: string,
): ((providerId: string) => string | undefined) | undefined {
  const configOptions = useZCodeSessionStore((state) =>
    workspacePath === undefined
      ? undefined
      : selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).configOptions,
  );
  return useMemo(() => workflowSubagentProviderNameLookup(configOptions), [configOptions]);
}
