import { create } from "zustand";
import type {
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginScope,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { logger } from "@/logger.js";
import { loadInto, runWorkspaceOperation } from "@/store/pluginManagementStoreLoading.js";
import { setPluginEnabledOptimistically } from "@/store/pluginManagementStoreEnabled.js";

// On-demand plugin detail (name+description) cache keyed by pluginId with loading/data/error, deduping requests and switch flicker.
export interface PluginDescribeEntry {
  status: "loading" | "loaded" | "error";
  data?: ZCodePluginsDescribeResult;
  error?: string;
}

// Data source of the settings Plugins page: via the thin IPluginManagementService backed by zcode-cli (list + enable/disable).
// The UI no longer touches IZcodeAgentService; legacy plugins/* protocol wording lives in one service implementation.
// Unrelated to the retired marketplace pluginStore, hence this separate minimal store.
export interface PluginManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  configScope: ZCodePluginScope | null;
  plugins: ZCodePluginInfo[];
  marketplaces: ZCodePluginMarketplaceSummary[];
  /** Whether the last overview succeeded; false means source existence unknown, never derive orphan state. */
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
  diagnostics: ZCodePluginDiagnostic[];
  loading: boolean;
  error: string | null;
  /**
   * The plugin owning the last failed action: plugin-carrying operations (setEnabled) write their id;
   * target-less operations (marketplace add/update/validate, list load, refresh) write null.
   * Consumers (CUA input buttons) treat only own-target errors as theirs, so the shared
   * error field never maps unrelated failures onto themselves.
   */
  lastFailedPluginId: string | null;
  togglingPluginId: string | null;
  operationId: string | null;
  operationVersion: number;
  describeCache: Record<string, PluginDescribeEntry>;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    configScope?: ZCodePluginScope;
    pluginService: IPluginManagementService;
  }) => Promise<void>;
  refresh: (pluginService: IPluginManagementService) => Promise<void>;
  addMarketplace: (source: string, pluginService: IPluginManagementService) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginService: IPluginManagementService,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginService: IPluginManagementService,
  ) => Promise<void>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<void>;
  uninstallPlugin: (
    pluginId: string,
    pluginService: IPluginManagementService,
    removeCache?: boolean,
  ) => Promise<void>;
  updatePlugin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  restoreBuiltin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  configurePlugin: (
    pluginId: string,
    options: Record<string, string | number | boolean>,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
    clearOptionKeys?: string[],
  ) => Promise<boolean>;
  resetPluginConfig: (
    pluginId: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  validateSource: (source: string, pluginService: IPluginManagementService) => Promise<void>;
  setEnabled: (
    pluginId: string,
    enabled: boolean,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  // Fetch the plugin component list on demand (name+description); force skips the cache and retries.
  describePlugin: (
    pluginId: string,
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    force?: boolean,
  ) => Promise<void>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwForErrorDiagnostic(diagnostics: ZCodePluginDiagnostic[]): void {
  const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (blockingDiagnostic) {
    throw new Error(blockingDiagnostic.message);
  }
}

export const usePluginManagementStore = create<PluginManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  configScope: null,
  plugins: [],
  marketplaces: [],
  marketplaceAvailabilityKnown: false,
  availablePlugins: [],
  installedPlugins: [],
  restorableBuiltins: [],
  diagnostics: [],
  loading: false,
  error: null,
  lastFailedPluginId: null,
  togglingPluginId: null,
  operationId: null,
  operationVersion: 0,
  describeCache: {},

  async initialize({ workspacePath, workspaceIdentity, configScope, pluginService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const normalizedConfigScope = configScope ?? null;
    const current = get();
    const contextChanged =
      current.workspacePath !== workspacePath ||
      current.workspaceIdentity !== normalizedIdentity ||
      current.configScope !== normalizedConfigScope;
    const hasCache =
      current.plugins.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity &&
      current.configScope === normalizedConfigScope;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      // With a cached list, refresh in the background and keep it, avoiding switch flicker; blocking loading only without cache.
      loading: !hasCache,
      marketplaceAvailabilityKnown: hasCache ? current.marketplaceAvailabilityKnown : false,
      error: null,
      lastFailedPluginId: null,
      // The post-save overview refresh may still be running when the user moves to another config layer;
      // the old layer operationId must not keep greying the new layer inputs. Version guards stop a finishing
      // old operation from clearing a same-name operation the new layer started later.
      ...(contextChanged ? { operationId: null } : {}),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      pluginService,
    });
  },

  async refresh(pluginService) {
    const { workspacePath, workspaceIdentity, configScope } = get();
    if (!workspacePath) {
      return;
    }
    set({ error: null, lastFailedPluginId: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
  },

  async addMarketplace(source, pluginService) {
    return runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:add:${source}`,
      async (workspace) => {
        await pluginService.addPluginMarketplace({
          ...workspace,
          source,
        });
      },
    );
  },

  async updateMarketplace(marketplace, pluginService) {
    let refreshError: string | null = null;
    const succeeded = await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:update:${marketplace ?? "__all__"}`,
      async (workspace) => {
        const result = await pluginService.updatePluginMarketplace({
          ...workspace,
          ...(marketplace ? { marketplace } : {}),
        });
        // Refresh allows partial success, so still reload the overview to keep the working source; but only warning
        // and returning true would report stale snapshots as refreshed on desktop and mobile web. Remember the error, and after reload
        // write the shared-store visible error and return false, giving every entry the same partial-failure semantic.
        const blockingDiagnostic = result.diagnostics?.find(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (blockingDiagnostic) {
          refreshError = blockingDiagnostic.message;
          logger.warn("[plugins] marketplace refresh partially failed", {
            diagnostics: result.diagnostics,
          });
        }
      },
    );
    if (succeeded && refreshError) {
      // A failed list refresh has no plugin target; clear the attribution.
      set({ error: refreshError, lastFailedPluginId: null });
      return false;
    }
    return succeeded;
  },

  async removeMarketplace(marketplace, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:remove:${marketplace}`,
      async (workspace) => {
        await pluginService.removePluginMarketplace({
          ...workspace,
          marketplace,
        });
      },
    );
  },

  async installPlugin(pluginName, marketplace, pluginService, scope = "user") {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:install:${pluginName}@${marketplace}`,
      async (workspace) => {
        const result = await pluginService.installPlugin({
          ...workspace,
          pluginName,
          marketplace,
          scope,
        });
        // To keep structured diagnostics, the CLI returns a successful RPC envelope on install failure
        // with the real error in diagnostics. The legacy UI ignored it, refreshed anyway, looked dead,
        // and offered no error or retry; fold error diagnostics into the existing operation error state.
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async uninstallPlugin(pluginId, pluginService, removeCache = true) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:uninstall:${pluginId}`,
      async (workspace) => {
        await pluginService.uninstallPlugin({
          ...workspace,
          pluginId,
          removeCache,
        });
      },
    );
  },

  async updatePlugin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:update:${pluginId}`,
      async (workspace) => {
        const result = await pluginService.updatePlugin({ ...workspace, pluginId });
        // update shares the install diagnostic-failure contract. Thrown into runWorkspaceOperation it never
        // overwrites the current overview, so the old version and update badge persist until a retry succeeds.
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async restoreBuiltin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:restore:${pluginId}`,
      async (workspace) => {
        await pluginService.restoreBuiltinPlugin({ ...workspace, pluginId });
      },
    );
  },

  async configurePlugin(pluginId, options, pluginService, scope = "user", clearOptionKeys = []) {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:configure:${pluginId}`,
      async (workspace) => {
        await pluginService.configurePlugin({
          ...workspace,
          pluginId,
          options,
          scope,
          ...(clearOptionKeys.length > 0 ? { clearOptionKeys } : {}),
        });
      },
    );
  },

  async resetPluginConfig(pluginId, pluginService, scope = "workspace") {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:reset-config:${pluginId}`,
      async (workspace) => {
        await pluginService.resetPluginConfig({
          ...workspace,
          pluginId,
          scope,
        });
      },
    );
  },

  async validateSource(source, pluginService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    set({ operationId: `marketplace:validate:${source}`, error: null });
    try {
      const result = await pluginService.validatePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        source,
      });
      set({ diagnostics: result.diagnostics });
    } catch (error) {
      logger.error("[plugins] validate source failed", { source, error: toMessage(error) });
      set({ error: toMessage(error), lastFailedPluginId: null });
    } finally {
      set({ operationId: null });
    }
  },

  async setEnabled(pluginId, enabled, pluginService, scope = "user") {
    return setPluginEnabledOptimistically(set, get, pluginId, enabled, pluginService, scope);
  },

  async describePlugin(pluginId, pluginName, marketplace, pluginService, force = false) {
    const { workspacePath, workspaceIdentity, describeCache } = get();
    if (!workspacePath) return;
    const cached = describeCache[pluginId];
    // Loaded or loading hits the cache, no duplicate request; force retries.
    if (!force && cached && cached.status !== "error") return;
    set({
      describeCache: { ...get().describeCache, [pluginId]: { status: "loading" } },
    });
    try {
      const data = await pluginService.describePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        marketplace,
        pluginName,
      });
      const blockingDiagnostic = data.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (data.components.length === 0 && blockingDiagnostic) {
        // CLI describe answers unresolvable sources with a diagnostics payload, not an RPC reject.
        // The legacy UI cached it as loaded: blank details, no retry ever. Map a component-less
        // error diagnostic to a recoverable error state while keeping normal partial-success payloads.
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "error", error: blockingDiagnostic.message },
          },
        });
        return;
      }
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "loaded", data },
        },
      });
    } catch (error) {
      logger.error("[plugins] describe failed", {
        pluginId,
        marketplace,
        error: toMessage(error),
      });
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "error", error: toMessage(error) },
        },
      });
    }
  },
}));
