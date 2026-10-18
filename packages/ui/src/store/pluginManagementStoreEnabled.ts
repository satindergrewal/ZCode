import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import { loadInto } from "@/store/pluginManagementStoreLoading.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let nextToggleRequestId = 0;
const activeToggleRequests = new Map<string, number>();

function buildToggleRequestKey(input: {
  workspacePath: string;
  workspaceIdentity: string | null;
  configScope: ZCodePluginScope | null;
  pluginId: string;
}): string {
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  return `${workspaceKey}\u0000${input.configScope ?? "effective"}\u0000${input.pluginId}`;
}

export async function setPluginEnabledOptimistically(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginId: string,
  enabled: boolean,
  pluginService: IPluginManagementService,
  scope: ZCodePluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, configScope } = get();
  if (!workspacePath) return false;

  const requestKey = buildToggleRequestKey({
    workspacePath,
    workspaceIdentity,
    configScope,
    pluginId,
  });
  const requestId = ++nextToggleRequestId;
  activeToggleRequests.set(requestKey, requestId);
  const isCurrentRequest = (): boolean => {
    const current = get();
    return (
      activeToggleRequests.get(requestKey) === requestId &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.configScope === configScope &&
      current.togglingPluginId === pluginId
    );
  };

  const previousPlugin = get().plugins.find((plugin) => plugin.id === pluginId);
  // The enable/disable RPC and the follow-up list refresh have perceptible latency.
  // Project the final state first so the toggle reacts instantly; on failure restore the
  // snapshot in catch so a normal async write is not misread as "the click did nothing".
  set({
    togglingPluginId: pluginId,
    error: null,
    lastFailedPluginId: null,
    ...(previousPlugin
      ? {
          plugins: get().plugins.map((plugin) =>
            plugin.id === pluginId ? { ...plugin, enabled, enabledSource: scope } : plugin,
          ),
        }
      : {}),
  });

  try {
    const result = await pluginService.setPluginEnabled({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginId,
      enabled,
      scope,
    });
    if (!isCurrentRequest()) return false;
    set({
      plugins: get().plugins.map((plugin) =>
        plugin.id === pluginId ? { ...plugin, ...result.plugin, enabled: result.enabled } : plugin,
      ),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
    return isCurrentRequest();
  } catch (error) {
    // On toggle failure, return false and restore the optimistic projection so the caller
    // does not keep refreshing other capabilities and the UI does not report a failed
    // toggle as success.
    logger.error("[plugins] setEnabled failed", { pluginId, enabled, error: toMessage(error) });
    if (isCurrentRequest()) {
      set({
        error: toMessage(error),
        lastFailedPluginId: pluginId,
        ...(previousPlugin
          ? {
              plugins: get().plugins.map((plugin) =>
                plugin.id === pluginId ? previousPlugin : plugin,
              ),
            }
          : {}),
      });
    }
    return false;
  } finally {
    if (isCurrentRequest()) {
      set({ togglingPluginId: null });
    }
    if (activeToggleRequests.get(requestKey) === requestId) {
      activeToggleRequests.delete(requestKey);
    }
  }
}
