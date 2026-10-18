import { release } from "node:os";
import type { CuaOsSupport } from "@zcode/shared";

// Promised floor = max(Helper Info.plist LSMinimumSystemVersion 12.0, SEA binary minos 11.0).
// 2026-08 incident: with the floor check missing, users on older macOS only saw authorization
// hang repeatedly (the real cause was LaunchServices -10825 refusing to launch the Helper).
const CUA_MINIMUM_MACOS_VERSION = "12.0";
// This floor is coupled to the upstream zcode-cua helperAppBundle.ts Info.plist
// LSMinimumSystemVersion (12.0); bumping either side requires syncing the other constants.
const CUA_MINIMUM_DARWIN_MAJOR = 21; // Darwin major - 9 = macOS major (21↔12, 22↔13)

function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
