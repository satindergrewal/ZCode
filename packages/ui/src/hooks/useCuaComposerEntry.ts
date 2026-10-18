/**
 * Data orchestration for the always-on CUA composer entry.
 *
 * Three jobs: merge three sources, gate the permission query, feed the pure derivations.
 * All rules live in lib/cuaComposerEntryState; no branch duplicated here.
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

/** Same rule as zcodeSessionStoreTaskSlice isRunningStatus. */
const RUNNING_TASK_STATUSES = new Set(["creating", "restoring", "streaming"]);

export interface UseCuaComposerEntryParams {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Phone web-remote shell; the remote guard hides the local CUA entry. */
  isWebRemoteControl?: boolean;
  /** This composer's v4 snapshot.control.canStop: low-latency running authority. */
  currentSessionBusy?: boolean;
}

export interface CuaComposerEntryController {
  view: CuaComposerEntryView;
  /** Click handler; side effects only when view.clickAction === "open-settings". */
  onActivate: () => void;
}

export function useCuaComposerEntry({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isWebRemoteControl = false,
  currentSessionBusy = false,
}: UseCuaComposerEntryParams): CuaComposerEntryController {
  const platform = usePlatform();
  const services = useServices();
  const { settings } = useSettings();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);

  const macLocalDesktop = supportsLocalMacCuaPermissionOnboarding(platform);
  const windowsLocalDesktop = supportsLocalWindowsCuaEntry(platform);
  // Same local-workspace test as ComputerUseSection: a remote CUA drives
  // a remote machine's screen, so it is not offered.
  const isLocalWorkspace =
    !isWebRemoteControl &&
    !remoteSessionId &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));

  // Hidden by default; show only on an explicitly stored false.
  // Use !== false, not === true: unloaded (null) or legacy rows count hidden;
  // the reverse flashes a button plus a wasted permission query.
  const hiddenBySettings = settings?.computerUseComposerEntryHidden !== false;

  const plugins = usePluginManagementStore((state) => state.plugins);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const pluginStoreError = usePluginManagementStore((state) => state.error);
  // store.error is shared across the plugin surface (marketplace/validate/load/setEnabled);
  // map it to this button only when the failed target was zcode-cua;
  // attribution lives in lastFailedPluginId.
  const lastFailedPluginId = usePluginManagementStore((state) => state.lastFailedPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const pluginEnabled = cuaPlugin?.enabled === true;

  const pluginManagementService = services.pluginManagementService;
  const platformSupported = (macLocalDesktop || windowsLocalDesktop) && isLocalWorkspace;
  // The plugin list gates the button. The store is a singleton with per-key
  // in-flight dedupe, so sharing the settings init adds no plugins/list calls.
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

  // The entry shows no state, so never query permissions: getStatus would
  // start the Helper on mount (app open = Helper start), against lazy-start semantics.
  // A visible+mac+enabled gate does not change that: enabled is not
  // a reason to pay startup cost; truth lives in settings-on-open and explicit grants.
  // permissionStatus stays null; resolveUiState maps null to idle-neutral, not error.
  const { status: permissionStatus } = useCuaPermissionStatus(null, workspaceIdentity);

  // Busy granularity is the workspace: switches change tool sets and invalidate
  // prompt caches for every session there; affected must equal disabled surface.
  // Reuse getWorkspaceState's identity->path fallback; no second key rule.
  const workspaceSessionBusy = useZCodeSessionStore((state) => {
    const workspaceState = getWorkspaceState(state, workspacePath, workspaceIdentity);
    const runtimeBusy = Object.values(workspaceState.taskRuntimeByTaskId ?? {}).some(
      (runtime) =>
        RUNNING_TASK_STATUSES.has(runtime.status) || Boolean(runtime.activeInputId?.trim()),
    );
    if (runtimeBusy) return true;
    // Why: mid-stoppable-turn the workspace projection can flap to ready while
    // the task index still holds running; runtime alone leaves the entry
    // clickable mid-run. OR the two facts; either running locks.
    return getVisibleTaskMetas(workspaceState).some((task) => task.status === "running");
  });
  // This pane's canStop lands before the workspace projection; ORing
  // locks this pane at once and keeps the workspace-wide lock.
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
