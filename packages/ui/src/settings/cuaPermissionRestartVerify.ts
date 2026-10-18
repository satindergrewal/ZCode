// Post-helper-restart accessibility verification: absorb tccd propagation lag and decide whether to escalate to the restart-ZCode fallback.
//
// Background: after the macOS Accessibility grant, the running helper's AXIsProcessTrusted is cached per process; a fresh
// helper process is required to see it. When restartHelper returns, the new broker socket is healthy but AX may still read
// stale (tccd propagation lags seconds). A single refresh likely reads stale again and looks like a failed restart.
//
// This helper polls accessibility after the restart: leaving stale (granted/denied/unknown) resolves and returns false;
// only still-stale at timeout (or persistent unavailable/errors) returns true and escalates to the restart-ZCode fallback.
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";

export interface WaitForAccessibilityNotStaleOptions {
  /** Total timeout (default 6s) covering tccd lag; the first poll usually grants immediately. */
  timeoutMs?: number;
  /** Poll interval (default 500ms). */
  intervalMs?: number;
}

export type GetCuaPermissionStatusFn = () => Promise<CuaPermissionStatusResult>;

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll accessibility after the helper restart to decide whether the stale state cleared.
 *
 * @returns false -- accessibility left stale (granted/denied/unknown) within the timeout; no escalation.
 *          true -- still stale at timeout (or persistent unavailable/errors); escalate to restart-ZCode.
 *
 * Semantics:
 *  - granted: the restart picked up the grant; resolved.
 *  - denied/unknown: a real permission gap (never granted), not a restart failure; no escalation, guidance handles it.
 *  - persistent stale: tccd cache never refreshed or the restart stuck; escalate.
 *  - unavailable / thrown: transient mid-restart state, keep polling; still down at timeout, escalate.
 */
export async function waitForAccessibilityNotStale(
  getStatus: GetCuaPermissionStatusFn,
  options: WaitForAccessibilityNotStaleOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await getStatus();
      if (isCuaPermissionStatusAvailable(result) && result.accessibility !== "stale") {
        return false;
      }
    } catch {
      // Mid-restart getStatus can fail transiently (socket handover, helper just booted). Treat as unresolved, keep polling.
    }
    if (Date.now() >= deadline) return true;
    await sleep(intervalMs);
  }
}
