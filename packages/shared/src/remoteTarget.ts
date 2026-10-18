import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
}

export interface WSLConnectOptions {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerConnectOptions {
  kind: "docker";
  container: string;
}

export interface ServerConnectOptions {
  kind: "server";
  /** An already-running zcode-server HTTP(S)/WS(S) endpoint. */
  url: string;
  /** Human-readable name, display only. */
  name?: string;
  /** Ephemeral connection secret; must be turned into a credential key when persisted. */
  token?: string;
  /** Server default workspace path; the connection flow may override it via workspacePath. */
  workspacePath?: string;
  /** Stable remote instance id, used as the workspaceIdentity authority. */
  serverId?: string;
}

export type RemoteTarget =
  | SSHConnectOptions
  | WSLConnectOptions
  | DockerConnectOptions
  | ServerConnectOptions;

/** Removes secrets that only exist within the current connection flow, for long-lived memory state and cross-process replies. */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  if (target.kind === "ssh") {
    const {
      password: _password,
      privateKeyPassphrase: _privateKeyPassphrase,
      ...sanitized
    } = target;
    return sanitized;
  }

  if (target.kind === "server") {
    const { token: _token, ...sanitized } = target;
    return sanitized;
  }

  return target;
}
