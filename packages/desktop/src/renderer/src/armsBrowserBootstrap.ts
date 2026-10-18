import { initArmsBrowserRumOnce } from "../../shared/armsBrowserInit.js";

/** Renderer-entry fallback (the main path inits in preload, since module scripts run after load). */
export function bootstrapArmsBrowserRum(): void {
  initArmsBrowserRumOnce(import.meta.env.DEV ? "development" : "production");
}
