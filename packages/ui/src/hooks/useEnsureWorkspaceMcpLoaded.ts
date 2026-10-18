import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { setMcpStoreDirectoryService, useMcpStore } from "@/store/mcpStore.js";

export function useEnsureWorkspaceMcpLoaded(
  workspaceAbsPath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
) {
  const services = useServices();

  useEffect(() => {
    if (!rpcReady) {
      return;
    }
    setMcpStoreDirectoryService(services.mcpSyncService);
    return () => {
      setMcpStoreDirectoryService(null);
    };
  }, [rpcReady, services.mcpSyncService]);

  useEffect(() => {
    if (!rpcReady) {
      // On remote tab restore the App first holds a disconnected proxy; reading the MCP
      // directory right away would only swallow the disconnect inside the store and breach
      // the workspace RPC isolation boundary. Wait for real services to register; no
      // caching, no cross-transport replay.
      return;
    }
    void useMcpStore
      .getState()
      .ensureLoadedForWorkspace(workspaceAbsPath, services.mcpSyncService, workspaceIdentity);
  }, [rpcReady, services.mcpSyncService, workspaceAbsPath, workspaceIdentity]);
}
