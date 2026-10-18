import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import type { IZCodeTaskService } from "@zcode/services";

interface WorkspaceProviderConfigFileState {
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

const INITIAL_STATE: WorkspaceProviderConfigFileState = {
  path: null,
  exists: false,
  loading: true,
  error: null,
};

type WorkspaceProviderConfigServiceScope = "workspace" | "base";

export function resolveWorkspaceProviderConfigZCodeService(params: {
  configuredServiceScope: WorkspaceProviderConfigServiceScope;
  workspaceZCodeService: IZCodeTaskService;
  baseZCodeService: IZCodeTaskService | null;
  remoteSessionId: string | null;
}): IZCodeTaskService | null {
  if (params.configuredServiceScope === "workspace") {
    return params.workspaceZCodeService;
  }

  if (params.baseZCodeService) {
    return params.baseZCodeService;
  }

  // Bugfix: falling back to workspaceZCodeService on remote workspaces
  // yields remote absolute paths (/root/...) the local machine cannot open.
  // Remote sessions require baseZCodeService and wait until ready; no risky fallback.
  if (params.remoteSessionId) {
    return null;
  }

  return params.workspaceZCodeService;
}

/**
 * Reads the main config path for the active workspace + provider.
 *
 * Path rules come from zcodeTaskService; the UI never assembles provider paths.
 */
export function useWorkspaceProviderConfigFile(
  workspacePath: string,
  provider: ZCodeProvider,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  options?: {
    serviceScope?: "workspace" | "base";
    enabled?: boolean;
  },
) {
  const workspaceZCodeService = useZCodeTaskService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const configuredServiceScope = options?.serviceScope ?? "workspace";
  const enabled = options?.enabled ?? true;
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const baseZCodeService = useRemoteWorkspaceSessionStore(
    (state) => state.baseServices?.zcodeTaskService ?? null,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
  });
  const zcodeTaskService = resolveWorkspaceProviderConfigZCodeService({
    configuredServiceScope,
    workspaceZCodeService,
    baseZCodeService,
    remoteSessionId,
  });
  const zcodeServiceScope =
    configuredServiceScope === "base"
      ? "base"
      : remoteSessionId && workspaceZCodeService !== baseZCodeService
        ? "remote"
        : "base";
  const [state, setState] = useState<WorkspaceProviderConfigFileState>(INITIAL_STATE);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let disposed = false;

    if (!workspacePath || !enabled || !workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      // Bugfix: while restoring a disconnected remote, path reads must wait for the
      // session binding; the disconnect proxy would log as a config-read failure.
      setState({
        path: null,
        exists: false,
        loading: false,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    if (!zcodeTaskService) {
      requestVersionRef.current += 1;
      setState({
        path: null,
        exists: false,
        loading: true,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    // Bugfix: keeping the old path across provider switches lets users open the
    // previous provider's file. Clear path/exists at request time; requestVersion gates latest.
    setState({
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    logger.info(
      `[useWorkspaceProviderConfigFile] reading provider config path workspace=${workspacePath} provider=${provider} scope=${zcodeServiceScope} session=${remoteSessionId ?? "none"}`,
    );

    void zcodeTaskService
      .getWorkspaceProviderConfigFile({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        provider,
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        logger.info(
          `[useWorkspaceProviderConfigFile] provider config path read workspace=${workspacePath} provider=${provider} scope=${zcodeServiceScope} session=${remoteSessionId ?? "none"} exists=${result.exists} path=${result.path}`,
        );

        setState({
          path: result.path,
          exists: result.exists,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useWorkspaceProviderConfigFile] failed to read provider config path", {
          workspacePath,
          provider,
          scope: zcodeServiceScope,
          remoteSessionId,
          error: message,
        });
        setState({
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [
    zcodeTaskService,
    zcodeServiceScope,
    enabled,
    provider,
    refreshVersion,
    remoteSessionId,
    workspaceIdentity,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  // Bugfix: provider config state props flow into Shell/Header/Menu; reuse the result
  // object when fields match, or parent rerenders read as config changes downstream.
  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
