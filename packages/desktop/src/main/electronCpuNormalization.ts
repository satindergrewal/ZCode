/**
 * Normalize Electron's `percentCPUUsage` to a whole-machine scale.
 *
 * All machine-wide CPU figures shown in the resource manager UI go through this single
 * normalization: on darwin/win32 Chromium already normalizes per machine; on linux the
 * value is single-core scale and must be divided by the logical core count.
 */

import os from "node:os";

export function normalizeElectronCpuToMachinePercent(
  cpu: number | null | undefined,
  options: { platform?: NodeJS.Platform; logicalCpuCount?: number } = {},
): number {
  const normalizedCpu = typeof cpu === "number" && Number.isFinite(cpu) ? cpu : 0;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return normalizedCpu;
  }
  const logicalCpuCount = options.logicalCpuCount ?? os.cpus().length;
  const scale = Number.isFinite(logicalCpuCount) && logicalCpuCount > 0 ? logicalCpuCount : 1;
  return normalizedCpu / scale;
}
