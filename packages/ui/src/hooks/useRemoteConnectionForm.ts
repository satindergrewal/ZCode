import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  loadRemoteConnectionDockerOptions,
  resolveDockerContainerSelectionAfterRefresh,
} from "@/lib/remoteConnectionDockerOptions.js";

type RemoteKind = RemoteTarget["kind"];
export type SSHAuthMethod = "password" | "privateKey";

export function buildAvailableKinds(options: {
  isWindowsDesktop: boolean;
  isLocalDevelopmentRuntime: boolean;
}): RemoteKind[] {
  const kinds: RemoteKind[] = ["ssh"];
  // Bugfix: server remote is a dev-only capability; unconditional listing
  // leaked the entry into production builds.
  if (options.isLocalDevelopmentRuntime) {
    kinds.push("server");
  }
  // Bugfix: WSL and SSH are both host-type connections.
  // WSL before Docker on Windows keeps it near SSH in the picker.
  if (options.isWindowsDesktop) {
    kinds.push("wsl");
  }
  // Docker entry used to appear only on probe success, vanishing when
  // probes were unavailable or Docker unselected, hiding the capability.
  // Always show; probe lazily after switching.
  kinds.push("docker");
  return kinds;
}

export function useRemoteConnectionForm({
  open,
  isWindowsDesktop,
  preferredKind,
  preferredWslDistro,
}: {
  open: boolean;
  isWindowsDesktop: boolean;
  preferredKind?: RemoteKind;
  preferredWslDistro?: string;
}) {
  const platform = usePlatform();
  const [kind, setKind] = useState<RemoteKind>("ssh");
  const [host, setHostState] = useState("");
  const [port, setPortState] = useState("22");
  const [username, setUsernameState] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SSHAuthMethod>("password");
  const [assetInstallMode, setAssetInstallMode] = useState<RemoteAssetInstallMode>(
    DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  );
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPathState] = useState("");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
  const [wslDistro, setWslDistro] = useState("");
  const [wslUser, setWslUser] = useState("");
  const [dockerContainer, setDockerContainer] = useState("");
  const [manualDockerContainer, setManualDockerContainer] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [serverWorkspacePath, setServerWorkspacePath] = useState("");
  const [sshConfigAliases, setSshConfigAliases] = useState<SSHConfigAliasOption[]>([]);
  const [sshConfigAliasesLoading, setSshConfigAliasesLoading] = useState(false);
  const [sshConfigAliasesLoaded, setSshConfigAliasesLoaded] = useState(false);
  const [sshConfigAliasesError, setSshConfigAliasesError] = useState("");
  const [selectedSshConfigAlias, setSelectedSshConfigAlias] = useState<string | null>(null);
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [wslDistros, setWslDistros] = useState<WSLDistro[]>([]);
  const [dockerContainers, setDockerContainers] = useState<DockerContainerInfo[]>([]);
  const [wslOptionsLoading, setWslOptionsLoading] = useState(false);
  const [wslOptionsLoaded, setWslOptionsLoaded] = useState(false);
  const [wslOptionsError, setWslOptionsError] = useState("");
  const [dockerOptionsLoading, setDockerOptionsLoading] = useState(false);
  const [dockerOptionsLoaded, setDockerOptionsLoaded] = useState(false);
  const [dockerOptionsError, setDockerOptionsError] = useState("");
  const applyingSshAliasRef = useRef(false);
  const dockerOptionsActiveLoadIdRef = useRef(0);
  const dockerOptionsInFlightLoadIdRef = useRef<number | null>(null);
  const isLocalDevelopmentRuntime =
    platform.isLocalDevelopmentRuntime === true || import.meta.env.DEV === true;

  const availableKinds = useMemo(
    () => buildAvailableKinds({ isWindowsDesktop, isLocalDevelopmentRuntime }),
    [isLocalDevelopmentRuntime, isWindowsDesktop],
  );

  useEffect(() => {
    if (availableKinds.includes(kind)) {
      return;
    }

    setKind(availableKinds[0] ?? "ssh");
  }, [availableKinds, kind]);

  useEffect(() => {
    dockerOptionsActiveLoadIdRef.current += 1;
    dockerOptionsInFlightLoadIdRef.current = null;

    if (!open) {
      return;
    }

    setSshConfigAliases([]);
    setSshConfigAliasesLoading(false);
    setSshConfigAliasesLoaded(false);
    setSshConfigAliasesError("");
    setSelectedSshConfigAlias(null);
    setWslOptionsLoaded(false);
    setWslOptionsLoading(false);
    setWslOptionsError("");
    setWslDistros([]);
    setDockerAvailable(null);
    setDockerOptionsLoaded(false);
    setDockerOptionsLoading(false);
    setDockerOptionsError("");
    setDockerContainers([]);
    if (preferredKind && availableKinds.includes(preferredKind)) {
      setKind(preferredKind);
    }
    if (preferredWslDistro !== undefined) {
      setWslDistro(preferredWslDistro);
    }
  }, [availableKinds, open, preferredKind, preferredWslDistro]);

  const refreshDockerContainers = useCallback(
    ({ clearContainersOnError = true }: { clearContainersOnError?: boolean } = {}) => {
      if (
        dockerOptionsInFlightLoadIdRef.current != null &&
        dockerOptionsInFlightLoadIdRef.current === dockerOptionsActiveLoadIdRef.current
      ) {
        return;
      }

      const loadId = dockerOptionsActiveLoadIdRef.current + 1;
      dockerOptionsActiveLoadIdRef.current = loadId;
      dockerOptionsInFlightLoadIdRef.current = loadId;
      setDockerOptionsLoading(true);
      setDockerOptionsError("");

      void (async () => {
        const result = await loadRemoteConnectionDockerOptions(platform);
        if (dockerOptionsActiveLoadIdRef.current !== loadId) {
          return;
        }

        setDockerAvailable(result.dockerAvailable);
        setDockerOptionsLoaded(true);
        setDockerOptionsError(result.error);

        if (!result.error) {
          setDockerContainers(result.dockerContainers);
          // After refresh, stopped containers may be gone; keeping the old selection
          // left a phantom name on the trigger. Restrain it to the running list.
          setDockerContainer((currentContainer) =>
            resolveDockerContainerSelectionAfterRefresh({
              currentContainer,
              dockerContainers: result.dockerContainers,
            }),
          );
          return;
        }

        if (clearContainersOnError) {
          setDockerContainers(result.dockerContainers);
        }
      })().finally(() => {
        if (dockerOptionsInFlightLoadIdRef.current === loadId) {
          dockerOptionsInFlightLoadIdRef.current = null;
        }
        if (dockerOptionsActiveLoadIdRef.current === loadId) {
          setDockerOptionsLoading(false);
        }
      });
    },
    [platform],
  );

  useEffect(() => {
    if (!open || kind !== "ssh" || sshConfigAliasesLoaded) {
      return;
    }

    let cancelled = false;
    setSshConfigAliasesLoading(true);
    setSshConfigAliasesError("");

    void (async () => {
      try {
        const aliases = await platform.listSSHConfigAliases();
        if (cancelled) {
          return;
        }

        setSshConfigAliases(aliases);
        setSshConfigAliasesLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setSshConfigAliases([]);
        setSshConfigAliasesLoaded(true);
        setSshConfigAliasesError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setSshConfigAliasesLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [kind, open, platform, sshConfigAliasesLoaded]);

  useEffect(() => {
    if (!selectedSshConfigAlias) {
      return;
    }

    if (sshConfigAliases.some((option) => option.alias === selectedSshConfigAlias)) {
      return;
    }

    setSelectedSshConfigAlias(null);
  }, [selectedSshConfigAlias, sshConfigAliases]);

  useEffect(() => {
    if (!open || kind !== "wsl" || !isWindowsDesktop || wslOptionsLoaded) {
      return;
    }

    let cancelled = false;
    setWslOptionsLoading(true);
    setWslOptionsError("");

    void (async () => {
      try {
        const nextWslDistros = await platform.listWSLDistros();
        if (cancelled) {
          return;
        }

        setWslDistros(nextWslDistros);
        setWslOptionsLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setWslDistros([]);
        setWslOptionsLoaded(true);
        setWslOptionsError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setWslOptionsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isWindowsDesktop, kind, open, platform, wslOptionsLoaded]);

  useEffect(() => {
    if (!open || kind !== "docker" || dockerOptionsLoaded) {
      return;
    }

    refreshDockerContainers({ clearContainersOnError: true });
  }, [dockerOptionsLoaded, kind, open, refreshDockerContainers]);

  const setHost = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== host) {
      setSelectedSshConfigAlias(null);
    }
    setHostState(value);
  };

  const setPort = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== port) {
      setSelectedSshConfigAlias(null);
    }
    setPortState(value);
  };

  const setUsername = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== username) {
      setSelectedSshConfigAlias(null);
    }
    setUsernameState(value);
  };

  const setPrivateKeyPath = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== privateKeyPath) {
      setSelectedSshConfigAlias(null);
    }
    setPrivateKeyPathState(value);
  };

  const applySshConfigAlias = (aliasOption: SSHConfigAliasOption) => {
    applyingSshAliasRef.current = true;
    try {
      setSelectedSshConfigAlias(aliasOption.alias);
      const nextHost = aliasOption.host?.trim() || aliasOption.alias;
      const nextPort =
        aliasOption.port != null && Number.isFinite(aliasOption.port)
          ? String(aliasOption.port)
          : "";
      const nextUsername = aliasOption.username?.trim() ?? "";
      const nextPrivateKeyPath = aliasOption.privateKeyPath?.trim() ?? "";

      // Alias switch used to overwrite filled fields only, leaking the previous
      // alias/manual values. Rebuild all SSH fields per alias, emptying gaps.
      setHostState(nextHost);
      setPortState(nextPort);
      setUsernameState(nextUsername);
      setPassword("");
      setPrivateKeyPathState(nextPrivateKeyPath);
      setPrivateKeyPassphrase("");
      setSshAuthMethod(nextPrivateKeyPath ? "privateKey" : "password");
    } finally {
      applyingSshAliasRef.current = false;
    }
  };

  const clearSelectedSshConfigAlias = () => {
    setSelectedSshConfigAlias(null);
  };

  return {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    // Bugfix: container lists are runtime data; the entry-time fetch went stale.
    // Refresh on every dropdown open.
    refreshDockerContainers: () => refreshDockerContainers({ clearContainersOnError: false }),
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading:
      kind === "wsl" ? wslOptionsLoading : kind === "docker" ? dockerOptionsLoading : false,
    currentRuntimeOptionsError:
      kind === "wsl" ? wslOptionsError : kind === "docker" ? dockerOptionsError : "",
  };
}
