import armsRum from "@arms/rum-electron/browser";
import type { ZCodeRuntimeEnv } from "@zcode/shared";
import { buildArmsBrowserInitConfig } from "./armsRumShared.js";

let bootstrapped = false;

/**
 * Initialize the Browser SDK as early as possible in preload or the renderer entry.
 * Why: Vite `type="module"` main.tsx often runs after window.load, and perf-collector only sends
 * perf in the load callback - renderer-entry-only init keeps beforeReport at perf=0. Call at the
 * end of preload (after the ARMS frame preload injected the Bridge).
 */
export function initArmsBrowserRumOnce(runtimeEnv: ZCodeRuntimeEnv): boolean {
  if (bootstrapped) {
    return true;
  }

  const bridge =
    typeof globalThis !== "undefined" &&
    (globalThis as { ArmsEventBridge?: { send?: unknown } }).ArmsEventBridge;
  const winBridge =
    typeof window !== "undefined" &&
    (window as { ArmsEventBridge?: { send?: (payload: string) => void } }).ArmsEventBridge;
  const resolved = bridge || winBridge;
  if (!resolved || typeof resolved.send !== "function") {
    return false;
  }

  bootstrapped = true;
  try {
    // Bugfix: Vite define does not write a same-named globalThis property; the entry injects the
    // runtime value explicitly so local-dev events in production builds stay out of ARMS prod.
    armsRum.init(buildArmsBrowserInitConfig(runtimeEnv));
  } catch (error) {
    bootstrapped = false;
    console.warn("[arms] renderer RUM init failed:", error);
    return false;
  }

  // Edge race: readyState complete at init time; re-dispatch load to trigger sendPerf.
  if (typeof document !== "undefined" && document.readyState === "complete") {
    window.dispatchEvent(new Event("load"));
  }
  return true;
}

/** In preload the ARMS frame preload may run one tick later; brief retries cover a missing Bridge. */
export function scheduleArmsBrowserRumInit(runtimeEnv: ZCodeRuntimeEnv, maxAttempts = 50): void {
  let attempts = 0;
  const tick = (): void => {
    if (initArmsBrowserRumOnce(runtimeEnv)) {
      return;
    }
    attempts += 1;
    if (attempts < maxAttempts) {
      setTimeout(tick, 0);
    } else {
      console.warn("[arms] ArmsEventBridge unavailable; skipping renderer RUM init");
    }
  };
  tick();
}
