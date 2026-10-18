export interface E2ETestBridgeEnvironment {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
  ZCODE_E2E_RUN_ID?: string;
}

/**
 * Main/preload E2E capabilities require both the dedicated build flag and a real runner run id.
 * ZCODE_ENV=test is a product environment only; never widen the renderer-readable surface by it.
 */
export function shouldEnableE2ETestBridge(env: E2ETestBridgeEnvironment): boolean {
  return env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" && Boolean(env.ZCODE_E2E_RUN_ID?.trim());
}
