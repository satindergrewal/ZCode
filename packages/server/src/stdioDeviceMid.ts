import { ensureDeviceMid as ensureSharedDeviceMid } from "@zcode/services/node";

interface EnsureRemoteServerDeviceMidOptions {
  /** Test injection only; production always uses the services ensureDeviceMid. */
  ensureDeviceMid?: () => Promise<string>;
  log: (...args: unknown[]) => void;
}

/**
 * Ensures at remote-server startup that the host owns its own deviceMid.
 *
 * Remote workspaces (SSH/WSL/Docker) have no Desktop main process, and
 * historically nothing wrote the device identity file on the remote host while
 * buildZCodeSourceHeaders() is read-only. Since 3.12.0 the Start Plan entitlement
 * is queried by the remote itself, so billing/balance requests without
 * X-Device-Mid were rejected by the server as parameter errors and remote
 * workspaces could not see Start Plan models. Desktop main owns this locally via
 * ensureDesktopDeviceMidSync; the remote stdio entry owns the same duty here,
 * reusing the same file, fields, and lock, sharing one device identity with a
 * co-located zcode-cli.
 *
 * Failure never blocks startup: a missing device identity only drops one header
 * on ZCode endpoint requests (same as before the fix) and nothing else on the
 * remote server depends on it. Log a warn with the cause; never fabricate an ID.
 */
export async function ensureRemoteServerDeviceMid(
  options: EnsureRemoteServerDeviceMidOptions,
): Promise<string | undefined> {
  const ensureDeviceMid = options.ensureDeviceMid ?? ensureSharedDeviceMid;
  try {
    return await ensureDeviceMid();
  } catch (error) {
    options.log(
      "deviceMid initialization failed; ZCode endpoint requests will omit X-Device-Mid:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
