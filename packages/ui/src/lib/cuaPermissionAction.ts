import type { CuaAccessibilitySettingsResult } from "@zcode/shared";

function normalizeToolName(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/_/g, "-") ?? "";
}

export function isZCodeCuaToolName(value: string | null | undefined): boolean {
  const normalized = normalizeToolName(value);
  // The server key segment is computer-use, e.g. mcp__computer-use__*.
  // main 3.5.3 plugin MCP naming namespaces plugin servers:
  // mcp__plugin_zcode-cua_computer-use__* (normalized, single hyphen cua-computer-use before the
  // server segment, not double). Both forms contain computer-use, so match via includes; otherwise main
  // namespacing breaks cua tool detection into fallback rendering. The string is specific enough:
  // only the cua server uses this key, so android-emulator or browser-use cannot false-positive.
  return normalized === "computer-use" || normalized.includes("computer-use");
}

export function didReturnFromCuaPermissionSettings(
  result: CuaAccessibilitySettingsResult | null | undefined,
): boolean {
  // main sets this only once every staged pane finished and the ZCode app regained focus. Renderer
  // focus alone can come from the TCC prompt, another window or plain switching; not a grant signal.
  return (
    result?.success === true &&
    result.returnedFromSettings === true &&
    typeof result.sessionId === "string" &&
    result.sessionId.length > 0
  );
}

export function shouldRestartHelperAfterCuaPermissionReturn(
  result: CuaAccessibilitySettingsResult | null | undefined,
): boolean {
  // restartHelperAfterReturn is additive main ABI. Older main omits it and keeps the legacy single-window
  // owner; newer main returns false only for duplicate joins of the same renderer or host, so per-window Helpers resume.
  return didReturnFromCuaPermissionSettings(result) && result?.restartHelperAfterReturn !== false;
}

export interface CuaPermissionReturnRecoveryState {
  /** Monotonically unique across open and workspace resets; a local epoch alone is no async operation id. */
  generation: number;
  contextKey: string;
  epoch: number;
  pending: boolean;
  automaticAttempted: boolean;
}

export interface CuaPermissionReturnRecoveryClaim {
  readonly state: CuaPermissionReturnRecoveryState;
  readonly generation: number;
  readonly contextKey: string;
  readonly epoch: number;
}

let nextCuaPermissionRecoveryGeneration = 0;

export function createCuaPermissionReturnRecoveryState(
  contextKey = "",
): CuaPermissionReturnRecoveryState {
  nextCuaPermissionRecoveryGeneration += 1;
  return {
    generation: nextCuaPermissionRecoveryGeneration,
    contextKey,
    epoch: 0,
    pending: false,
    automaticAttempted: false,
  };
}

function recoveryClaim(state: CuaPermissionReturnRecoveryState): CuaPermissionReturnRecoveryClaim {
  return {
    state,
    generation: state.generation,
    contextKey: state.contextKey,
    epoch: state.epoch,
  };
}

export function markCuaPermissionOnboardingOpened(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim {
  state.epoch += 1;
  state.pending = true;
  state.automaticAttempted = false;
  return recoveryClaim(state);
}

export function claimCuaPermissionReturnRecovery(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim | null {
  // Plain focus, mid-prompt focus and repeated focus of the same grant are all side-effect free.
  if (!state.pending || state.automaticAttempted) return null;
  state.automaticAttempted = true;
  return recoveryClaim(state);
}

export function captureCuaPermissionReturnRecovery(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim | null {
  return state.pending ? recoveryClaim(state) : null;
}

export function isCuaPermissionReturnRecoveryCurrent(
  current: CuaPermissionReturnRecoveryState,
  claim: CuaPermissionReturnRecoveryClaim,
): boolean {
  return (
    current === claim.state &&
    current.generation === claim.generation &&
    current.contextKey === claim.contextKey &&
    current.epoch === claim.epoch &&
    current.pending
  );
}

export function completeCuaPermissionReturnRecovery(
  claim: CuaPermissionReturnRecoveryClaim,
  restartSucceeded: boolean,
): void {
  // On workspace or open switches the ref points at new state and the local epoch restarts at 0; a
  // restart keyed on ref.current plus epoch would clear same-numbered events in the new workspace.
  // Claims bind the originating state and context; completions touch only that old object, and
  // failures keep the claim pending for manual retry in the same context.
  const state = claim.state;
  if (
    restartSucceeded &&
    state.pending &&
    state.generation === claim.generation &&
    state.contextKey === claim.contextKey &&
    state.epoch === claim.epoch
  ) {
    state.pending = false;
  }
}
