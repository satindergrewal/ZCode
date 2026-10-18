import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { type DeployLoggers, waitForClose } from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";

export async function repairLegacyRemoteOfficialPluginDirectoryPermissions(params: {
  backend: IRemoteBackend;
  loggers: DeployLoggers;
  remoteOfficialPluginDir: string;
}): Promise<boolean> {
  // Legacy Windows repacks of the packages tar wrote dir mode 0666, which after the remote umask
  // became a non-traversable 0644. Upgrading 3.3.3 to 3.3.4 may have intact files yet still replace
  // packages on version change, so the permission repair must bind to the about-to-replace-packages
  // deploy path, not the healthy-remote incremental skip path. IRemoteBackend.exists only promises a
  // file check (SSH/Docker use test -f), so dir existence and chmod must be decided in one remote shell command.
  params.loggers.logWarn(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: checking and repairing legacy builtin plugin dir permissions ${params.remoteOfficialPluginDir}`,
  );
  const quotedRemoteOfficialPluginDir = quotePosixPathArg(params.remoteOfficialPluginDir);
  const stream = await params.backend.exec(
    `if [ -d ${quotedRemoteOfficialPluginDir} ]; then command chmod -R u+rwX ${quotedRemoteOfficialPluginDir}; fi`,
  );
  try {
    await waitForClose(stream);
    return true;
  } catch (error) {
    // chmod only pre-repairs legacy WSL broken-permission dirs; real deploy success is decided by the
    // later packages replacement. Some SSH/Docker mounted volumes or ACL setups reject chmod, yet the
    // rm/tar replace path can still succeed.
    params.loggers.logWarn(
      `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: failed to repair legacy builtin plugin dir permissions, still trying to replace packages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
