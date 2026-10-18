/**
 * Data orchestration for the always-present CUA composer entry button.
 *
 * Does exactly three things: aggregates the three data sources, gates the permission query,
 * and hands the results to a pure function. All decision rules live in
 * lib/cuaComposerEntryState.ts; none are duplicated here.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isRemoteWorkspaceIdentity, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import {
  resolveCuaComposerEntryView,
  type CuaComposerEntryView,
} from "@/lib/cuaComposerEntryState.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getVisibleTaskMetas, getWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

/** Same semantics as isRunningStatus in zcodeSessionStoreTaskSlice. */
const RUNNING_TASK_STATUSES = new Set(["creating", "restoring", "streaming"]);

export interface UseCuaComposerEntryParams {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Phone web-remote shell; remote-control constraints render no local CUA entry. */
  /** The composer's v4 snapshot.control.canStop -- the low-latency runtime authority. */
  currentSessionBusy?: boolean;
}

interface CuaComposerEntryController {
  view: CuaComposerEntryView;
  /** Button click; side effects only when view.clickAction === "open-settings". */
  onActivate: () => void;
}

export function useCuaComposerEntry({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  currentSessionBusy = false,
}: UseCuaComposerEntryParams): CuaComposerEntryController {
  const platform = usePlatform();
  const services = useServices();
  const { settings } = useSettings();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);

  const macLocalDesktop = supportsLocalMacCuaPermissionOnboarding(platform);
  const windowsLocalDesktop = supportsLocalWindowsCuaEntry(platform);
  // Same local-workspace rule as ComputerUseSection: a remote workspace's CUA would drive
  // the remote machine's screen, which the product does not offer.
  const isLocalWorkspace =
    !remoteSessionId &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));

  // Hidden by default: show only when an explicit false was stored.
  // Use !== false rather than === true so unloaded settings (null) and legacy users missing
  // the field both count as hidden -- defaulting to visible would flash the button for new
  // users before hiding it and burn a permission query in the background.
  const hiddenBySettings = settings?.computerUseComposerEntryHidden !== false;

  const plugins = usePluginManagementStore((state) => state.plugins);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const pluginStoreError = usePluginManagementStore((state) => state.error);
  // store.error is a plugin-surface shared field (marketplace/validate/load and any plugin
  // setEnabled failure write it). Map it to this button's error state only when the failed
  // operation targeted zcode-cua; attribution comes from the store's lastFailedPluginId.
  const lastFailedPluginId = usePluginManagementStore((state) => state.lastFailedPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const pluginEnabled = cuaPlugin?.enabled === true;

  const pluginManagementService = services.pluginManagementService;
  const platformSupported = (macLocalDesktop || windowsLocalDesktop) && isLocalWorkspace;
  // The plugin list is a required input for the button state. The store is a global singleton
  // and initialize dedupes in-flight calls per workspaceKey with cache reuse, so sharing the
  // initialization path with the settings page does not amplify plugins/list requests.
  const initializedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!platformSupported || hiddenBySettings || !workspacePath || !pluginManagementService) {
      return;
    }
    const key = `${workspacePath}\0${workspaceIdentity ?? ""}`;
    if (initializedKeyRef.current === key) return;
    initializedKeyRef.current = key;
    void initializePlugins({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginService: pluginManagementService,
    });
  }, [
    hiddenBySettings,
    initializePlugins,
    platformSupported,
    pluginManagementService,
    workspaceIdentity,
    workspacePath,
  ]);

  // The composer entry carries no status display (no color dot, fixed jump to settings), so
  // it never queries permissions at all -- a permission query starts the Helper on demand
  // (the getStatus launch chain), and querying on mount would mean "launch the Helper by
  // opening the app", breaking lazy-start semantics. Even gating on "button visible + mac +
  // plugin enabled" would not change that: having the plugin enabled does not mean the user
  // should pay the Helper startup cost right now. The permission truth is read in exactly two
  // places: the settings page (queried on open) and the explicit grant flow.
  // permissionStatus stays null; resolveUiState maps null to the idle neutral state (not error).
  const { status: permissionStatus } = useCuaPermissionStatus(null, workspaceIdentity);

  // session-busy granularity is the workspace: switching plugins changes the toolset for
  // every session in that workspace and invalidates prompt caches, so the affected surface
  // and the disabled surface must match -- looking at the current task alone is not enough.
  // Reuse getWorkspaceState's identity->path fallback instead of duplicating workspaceKey rules.
  const workspaceSessionBusy = useZCodeSessionStore((state) => {
    const workspaceState = getWorkspaceState(state, workspacePath, workspaceIdentity);
    const runtimeBusy = Object.values(workspaceState.taskRuntimeByTaskId ?? {}).some(
      (runtime) =>
        RUNNING_TASK_STATUSES.has(runtime.status) || Boolean(runtime.activeInputId?.trim()),
    );
    if (runtimeBusy) return true;
    // Root cause: once a V4 snapshot enters a stoppable model turn, the workspace runtime
    // projection can briefly flip back to ready while the task index still authoritatively
    // records persist status=running. Runtime alone would keep the CUA entry clickable
    // mid-execution. Merge both existing truth sources; either running state locks the button.
    return getVisibleTaskMetas(workspaceState).some((task) => task.status === "running");
  });
  // This pane's snapshot.control.canStop arrives before the workspace projection; OR-ing the
  // two locks this composer immediately while keeping the shared lock for other composers in
  // the same workspace.
  const sessionBusy = currentSessionBusy || workspaceSessionBusy;

  const view = useMemo(
    () =>
      resolveCuaComposerEntryView({
        macLocalDesktop: macLocalDesktop && isLocalWorkspace,
        windowsLocalDesktop: windowsLocalDesktop && isLocalWorkspace,
        hiddenBySettings,
        permissionServiceAvailable: Boolean(services.cuaPermissionService),
        pluginEnabled,
        pluginToggling: togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        pluginError:
          Boolean(pluginStoreError) && lastFailedPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        permissionStatus: permissionStatus ?? null,
        sessionBusy,
      }),
    [
      cuaPlugin,
      hiddenBySettings,
      lastFailedPluginId,
      isLocalWorkspace,
      macLocalDesktop,
      permissionStatus,
      pluginEnabled,
      pluginStoreError,
      sessionBusy,
      services.cuaPermissionService,
      togglingPluginId,
      windowsLocalDesktop,
    ],
  );

  const onActivate = useCallback(() => {
    if (!view.visible || view.clickAction !== "open-settings") return;
    setPendingSettingsSectionIntent("computerUse");
    openSettingsTab();
  }, [openSettingsTab, view]);

  return { view, onActivate };
}
