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

function buildAvailableKinds(options: { isWindowsDesktop: boolean }): RemoteKind[] {
  const kinds: RemoteKind[] = ["ssh"];
  // In the remote-connection entry, WSL and SSH are both host-style connections.
  // On Windows, put WSL before Docker so WSL does not appear far from SSH on the picker
  // once Docker separates them.
  if (options.isWindowsDesktop) {
    kinds.push("wsl");
  }
  // The Docker entry used to show up only when pre-probing succeeded, so it vanished
  // whenever probing was temporarily unavailable or the user had not switched to Docker yet,
  // hiding that Docker is supported at all. Always show the entry; lazy-load probe results
  // after switching.
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
  const availableKinds = useMemo(
    () => buildAvailableKinds({ isWindowsDesktop }),
    [isWindowsDesktop],
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
          // Containers may have stopped since the last refresh; the previous code updated the
          // list without clearing the selection, leaving the trigger showing a gone container.
          // After a successful refresh, constrain the selection to the latest running list.
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

      // Switching aliases used to overwrite only the populated fields, leaving stale values
      // from the previous alias or manual input in missing ones. Rebuild every SSH field from
      // the current alias and blank out missing values to avoid cross-seeding state.
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
    // The Docker container list is runtime data and used to be fetched once on entry.
    // Refresh on demand through this callback each time the dropdown opens so the user never
    // sees a stale container list.
    refreshDockerContainers: () => refreshDockerContainers({ clearContainersOnError: false }),
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading:
      kind === "wsl" ? wslOptionsLoading : kind === "docker" ? dockerOptionsLoading : false,
    currentRuntimeOptionsError:
      kind === "wsl" ? wslOptionsError : kind === "docker" ? dockerOptionsError : "",
  };
}
