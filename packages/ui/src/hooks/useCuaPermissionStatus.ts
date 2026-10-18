// macOS permission state for the Computer Use Helper. The state comes from the Helper's
// current-runtime preflight; historical TCC rows never decide. Presentation semantics: see
// isCuaPermissionTccGranted in cuaPermissionStatusStore.
//
// Refresh policy is event-driven, NOT polled. Exactly one fetch per trigger:
// - mount (settings page / composer entry first render);
// - window refocus (user just granted in macOS System Settings and came back);
// - explicit caller refresh (plugin toggles, Helper restart, post-grant recovery flows).
//
// Why no polling: permission changes are rare; second-level polling would press the host RPC
// and keep the UI jittering — every query start flips fresh back to false, so the settings
// button would oscillate between "Open System Settings" and "Verifying...". The state lives
// in lib/cuaPermissionStatusStore's in-process shared cache; both entry points read the same
// copy, so re-entering the page renders the last known state instead of flashing from
// "unknown".
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CuaPermissionStatusQueryOptions, CuaPermissionStatusResult } from "@zcode/services";
import {
  cuaPermissionStatusKey,
  fetchCuaPermissionStatus,
  getCuaPermissionStatusSnapshot,
  subscribeCuaPermissionStatus,
} from "@/lib/cuaPermissionStatusStore.js";
import { useOptionalServices } from "./useServices.js";

export function useCuaPermissionStatus(
  workspacePath: string | null,
  workspaceIdentity?: string,
): {
  status: CuaPermissionStatusResult | null;
  fresh: boolean;
  /** Presentation-stable flag: true once there is anything to show; never falls back per query. See the store comment. */
  settled: boolean;
  refresh: (options?: CuaPermissionStatusQueryOptions) => void;
} {
  const services = useOptionalServices();
  // cuaPermissionService is optional on main (remote hosts have no CUA). Without it, never
  // query and keep the snapshot empty — callers show "unknown".
  const cuaPermissionService = services?.cuaPermissionService;
  const key =
    workspacePath && cuaPermissionService
      ? cuaPermissionStatusKey(workspacePath, workspaceIdentity)
      : null;

  const snapshot = useSyncExternalStore(
    subscribeCuaPermissionStatus,
    useCallback(() => getCuaPermissionStatusSnapshot(key), [key]),
  );

  const query = useCallback(
    (mode: "refresh" | "ensure", options?: CuaPermissionStatusQueryOptions): void => {
      if (!workspacePath || !cuaPermissionService) return;
      fetchCuaPermissionStatus({
        service: cuaPermissionService,
        workspacePath,
        mode,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(options ? { options } : {}),
      });
    },
    [cuaPermissionService, workspaceIdentity, workspacePath],
  );

  const refresh = useCallback(
    (options?: CuaPermissionStatusQueryOptions): void => query("refresh", options),
    [query],
  );

  useEffect(() => {
    if (!workspacePath || !cuaPermissionService) return;
    // One fetch on entry. The settings page and composer entry may mount in either order;
    // ensure lets the later one ride the earlier's in-flight query.
    query("ensure");
    // Returning right after granting in macOS System Settings may have changed the state; this must be a forced refresh.
    const onFocus = (): void => query("refresh");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cuaPermissionService, query, workspacePath]);

  return {
    status: snapshot.status,
    fresh: snapshot.fresh,
    settled: snapshot.settled,
    refresh,
  };
}
