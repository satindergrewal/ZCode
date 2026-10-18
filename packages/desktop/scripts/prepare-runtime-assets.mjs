#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// The Windows Chrome import entry is disabled; still compiling the helper by default would add CI time and signing surface.
// The explicit flag remains so a future re-enable reuses the existing native implementation and supply-chain checks.
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// Snap data source for the CUA permission panel. macOS only; the build script self-degrades to skip without swiftc
// (the panel fail-opens to the screen bottom, still usable), so attaching it unconditionally on darwin keeps builds resilient.
const shouldPrepareMacosWindowBounds = target.os === "darwin";

// The local desktop package bundles the agent JS build (prepare:agent-bundle), run by the app's Electron Node runtime.
// Remote cross-platform native binaries still come from prepare:remote-assets above.
// native-search archives ship in the repo; prepare only verifies local unpacking, no download source config needed.
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

const shouldSkipRemoteAssets = process.env.ZCODE_SKIP_REMOTE_ASSETS === "1";

if (!shouldSkipRemoteAssets) {
  runTimedPnpmScript("prepare:remote-assets");
} else {
  // The Windows build job's desktop installer does not need mock-cdn remote assets.
  // prepare:remote-assets used to run unconditionally, serializing cross-platform download/pack inside the same job
  // and stretching CI toward the 1-hour cap. The explicit flag prepares remote assets only when needed.
  console.log("[prepare:runtime-assets] skip prepare:remote-assets (ZCODE_SKIP_REMOTE_ASSETS=1)");
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
