/*
 * Post-helper-restart accessibility verification: absorb tccd propagation lag and decide whether to escalate to the restart-ZCode fallback.
 *
 * Background: after a macOS Accessibility grant, a running Helper's AXIsProcessTrusted is cached per process, so the Helper must restart
 * (new process) to pick it up. When restartHelper returns, the new Helper's broker socket is already healthy, but the AX state may still
 * read stale (tccd propagation lags a few seconds). A single refresh can therefore read stale again and make the restart look ineffective.
 *
 * This helper polls accessibility after the restart: leaving stale (granted/denied/unknown) counts as resolved and returns false;
 * only if it stays stale until the timeout (or keeps returning unavailable/throwing) does it return true, escalating the UI to the
 * "Restart ZCode" fallback.
 */
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";

interface WaitForAccessibilityNotStaleOptions {
  /** Total timeout (default 6s): covers tccd propagation lag; the first poll usually returns granted immediately. */
  timeoutMs?: number;
  /** Poll interval (default 500ms). */
  intervalMs?: number;
}

type GetCuaPermissionStatusFn = () => Promise<CuaPermissionStatusResult>;

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll accessibility after the Helper restarts and decide whether it has left the stale state.
 *
 * @returns `false` — accessibility left stale (granted/denied/unknown) within the timeout; no escalation needed.
 *          `true`  — still stale at timeout (or persistently unavailable/throwing); escalate to the "Restart ZCode" fallback.
 *
 * Semantics:
 *  - `granted` → the restart picked up the grant; resolved.
 *  - `denied`/`unknown` → a real permission gap (the user has not granted), not a failed restart; no escalation (left to the grant flow).
 *  - `stale` persists → tccd cache not refreshed / restart mechanism stuck → escalate.
 *  - unavailable / throws → transient mid-restart state, keep polling; if it persists past the timeout → escalate.
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
      // getStatus can fail transiently mid-restart (socket switch / Helper just started). Treat as unresolved and keep polling.
    }
    if (Date.now() >= deadline) return true;
    await sleep(intervalMs);
  }
}
