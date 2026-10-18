import type { LaunchMarks } from "@zcode/shared";

// Launch timings (epoch ms): T0 process creation / T1 main JS / T2 whenReady. T3 is recorded in loadWindow.
// Kept in its own module so it is not dragged into index.js's bootstrap side-effect chain
// (e.g. desktopHostProcess also reads these marks).
// process.getCreationTime is an Electron extension to process; it does not exist in plain
// node environments (including unit tests), so it needs a guard.
const launchCreatedAt =
  (typeof process.getCreationTime === "function" ? process.getCreationTime() : null) ?? Date.now();
const launchMainStart = Date.now();
let launchAppReady = launchMainStart;

export function markMainLaunchAppReady(): void {
  launchAppReady = Date.now();
}

export function getMainLaunchPartialMarks(): Omit<LaunchMarks, "loadUrl"> {
  return { createdAt: launchCreatedAt, mainStart: launchMainStart, appReady: launchAppReady };
}
