import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createUuid } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

export interface EnsureDesktopDeviceMidSyncOptions {
  /** Directory of the state file, default getAppConfigDir() (~/.zcode/v2). Test injection only. */
  configDir?: string;
  /** UUID generator, default createUuid. Test injection only. */
  createId?: () => string;
}

/**
 * Ensures the device identity file (same telemetry-state.json shared with CLI/remote server) holds deviceMid, and returns it.
 *
 * Shares the file's deviceMid field with warehouse reporting (telemetryCore) so ARMS and warehouse
 * device_mid are one persisted UUID. ARMS needs the value synchronously before window creation
 * (via the preload --device-id= arg), hence sync node:fs here.
 *
 * Race avoidance:
 * - A valid existing deviceMid returns as-is, never writing (zero writes for existing users/restarts).
 * - When missing, read the full state, patch only deviceMid, write back -- never clobber telemetryCore's
 *   lastDailyActiveDate / dailyActiveInFlight fields.
 * - Atomic write (temp file + renameSync) so concurrent readers never see partial JSON.
 *
 * Any fs/JSON error is swallowed: return the in-memory UUID and retry the write next launch, so the
 * value always exists by window creation time.
 */
export function ensureDesktopDeviceMidSync(options?: EnsureDesktopDeviceMidSyncOptions): string {
  const createId = options?.createId ?? createUuid;
  try {
    const configDir = options?.configDir ?? getAppConfigDir();
    const stateFile = join(configDir, "telemetry-state.json");

    const state = readTelemetryStateSync(stateFile);
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      return state.deviceMid;
    }

    const deviceMid = createId();
    state.deviceMid = deviceMid;
    writeTelemetryStateSync(stateFile, state);
    return deviceMid;
  } catch {
    // fs/JSON backstop: always return a value; window creation never blocks on this.
    return createId();
  }
}

function readTelemetryStateSync(stateFile: string): Record<string, unknown> {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeTelemetryStateSync(stateFile: string, state: Record<string, unknown>): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempFile, stateFile);
}
