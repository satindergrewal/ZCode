/**
 * Device identifier -- singleton cache inside the renderer process.
 *
 * Generation strategy:
 * - Desktop: deviceMid provided by the main process (SHA-256 over the userData path; stable and unique).
 * - Phone (web remote control): physical-property fingerprint (browserPlatform + screen width/height + colorDepth);
 *   robust to browser/network/language/timezone changes, only a new device changes it.
 */
import { createUuid } from "@zcode/shared";

let cachedStreamClientId: string | null = null;

/**
 * Set the stable device ID (provided by platform.getDeviceId()).
 * Must be called before the first getStreamClientId().
 */
export function setStreamClientId(deviceId: string): void {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    // If a broken injection would write an empty string, every instance would share "renderer:" and
    // owner/observer filters would misread them as one client. Fall back to a stable in-process random id.
    cachedStreamClientId = cachedStreamClientId ?? `renderer:fallback-${createUuid()}`;
    return;
  }
  cachedStreamClientId = `renderer:${normalizedDeviceId}`;
}

/**
 * Build the phone-side physical-property fingerprint.
 * Lets the phone derive a stable device ID before platform.getDeviceId() is available.
 */
export function generateMobileDeviceFingerprint(): string {
  const nav = globalThis.navigator as Navigator & { platform?: string };
  const platform = nav?.platform ?? "";
  const screenWidth = globalThis.screen?.width;
  const screenHeight = globalThis.screen?.height;
  const colorDepth = globalThis.screen?.colorDepth;
  const parts = [
    platform,
    screenWidth !== undefined ? String(screenWidth) : "",
    screenHeight !== undefined ? String(screenHeight) : "",
    colorDepth !== undefined ? String(colorDepth) : "",
  ];
  return parts.filter(Boolean).join("|");
}
