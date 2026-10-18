import type { CuaPermissionKind } from "@zcode/shared";
import type { CuaPermissionStatus } from "@zcode/services";

function isActionablePermissionState(state: CuaPermissionStatus["accessibility"]): boolean {
  return state === "denied" || state === "stale";
}

/**
 * After a modal or entry re-query, only definite gaps from a fresh TCC snapshot go to one-click grant.
 * Probe failures and unknown states only enter verify/retry; never infer missing system permissions from them.
 */
export function requiredCuaPermissionsForFreshStatus(
  status: CuaPermissionStatus | null,
): CuaPermissionKind[] {
  if (!status) return [];
  const required: CuaPermissionKind[] = [];
  if (isActionablePermissionState(status.accessibility)) {
    required.push("accessibility");
  }
  if (isActionablePermissionState(status.screenRecording)) {
    required.push("screen_recording");
  }
  return required;
}
