import type { IPlatformService } from "@zcode/shared";

// Only macOS has TCC permissions, the onboarding flow, and Helper status polling; the
// Windows desktop merely reuses the zcode-cua plugin master switch and never reads TCC or
// Helper state. Linux, plain web, and phone remote control show no computer-control
// settings. The permission dialog, preflight, and Helper polling must therefore first
// establish that this is a macOS desktop, decided via navigator.userAgent with iOS
// excluded explicitly (iPhone/iPad UAs contain the Macintosh substring).
//
// Converted from a module-level constant to a lazy function. The constant was evaluated at
// import time, so UA-branching unit tests could not cover multiple platforms in one
// process (mutating navigator.userAgent cannot affect an already-evaluated constant).
// Runtime behavior is identical: a real UA never changes mid-session.
function isMacOsDesktopUserAgent(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/.test(navigator.userAgent) &&
    !/iPhone|iPad|iPod/.test(navigator.userAgent)
  );
}

function isWindowsDesktopUserAgent(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/**
 * Real platform-capability gate for the CUA permission UI.
 *
 * Relying on the UA alone misclassifies macOS Safari/web as desktop and opens a permission
 * dialog that cannot perform any native IPC. The desktop preload injects the onboarding
 * methods only when the capability exists, so UA and capability must both hold.
 */
export function supportsLocalMacCuaPermissionOnboarding(
  platform: Pick<IPlatformService, "openCuaPermissionOnboarding"> | null | undefined,
): boolean {
  return isMacOsDesktopUserAgent() && typeof platform?.openCuaPermissionOnboarding === "function";
}

/**
 * CUA capability gate for the Windows desktop (mirror of the mac gate above).
 *
 * Windows has no TCC and no Helper permission reads, so openCuaPermissionOnboarding cannot
 * serve as the capability check; executeDesktopCommand is used instead -- it is injected
 * only by the desktop preload, which excludes plain browsers on Windows.
 */
export function supportsLocalWindowsCuaEntry(
  platform: Pick<IPlatformService, "executeDesktopCommand"> | null | undefined,
): boolean {
  return isWindowsDesktopUserAgent() && typeof platform?.executeDesktopCommand === "function";
}
