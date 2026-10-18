import { ensureTelemetryDeviceMid } from "@zcode/services/node";

export interface EnsureRemoteServerDeviceMidOptions {
  /** Test-only injection; production always uses the services ensureTelemetryDeviceMid. */
  ensureDeviceMid?: () => Promise<string>;
  log: (...args: unknown[]) => void;
}

/**
 * Ensure the host machine owns its deviceMid when the remote server starts.
 *
 * Remote workspaces (SSH/WSL/Docker) have no Desktop main process, and historically nothing wrote the device
 * identity file on the remote host, while buildZCodeSourceHeaders() only reads. Since 3.12.0 Start Plan entitlements are
 * queried by the remote itself; billing/balance requests without X-Device-Mid were rejected as parameter errors, leaving remote workspaces
 * without Start Plan models. Desktop main owns this locally via ensureDesktopDeviceMidSync; here the
 * remote stdio entry takes the same duty, reusing the same file, field and lock as the on-host zcode-cli device identity.
 *
 * Failure never blocks startup: a missing device id only drops one header on ZCode endpoint requests (same as before the fix),
 * nothing else on the remote server depends on it; log a warn with the cause, never fabricate a device id.
 */
export async function ensureRemoteServerDeviceMid(
  options: EnsureRemoteServerDeviceMidOptions,
): Promise<string | undefined> {
  const ensureDeviceMid = options.ensureDeviceMid ?? ensureTelemetryDeviceMid;
  try {
    return await ensureDeviceMid();
  } catch (error) {
    options.log(
      "telemetry deviceMid init failed, ZCode endpoint requests will omit X-Device-Mid:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
