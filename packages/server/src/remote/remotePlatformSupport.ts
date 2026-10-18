import type { RemoteEnvironment } from "@zcode/server/remote/backend.js";

export function assertSupportedRemoteEnvironment(env: RemoteEnvironment): void {
  if (env.platform !== "win32") {
    return;
  }

  // deploy/connect used to hard-code the Windows rejection separately, inviting
  // skipDeploy bypasses and inconsistent messages. Remote backends and launch
  // commands still require a POSIX shell; centralize the capability boundary here
  // until the Windows shell strategy lands.
  throw new Error(
    "Remote mode requires a POSIX shell; Windows native remote hosts are not supported yet",
  );
}
