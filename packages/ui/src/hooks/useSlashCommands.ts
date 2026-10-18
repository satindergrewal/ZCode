/**
 * Convenience hook for ZCode Agent slash commands.
 *
 * Returns the slash commands advertised by the Agent for the current workspace.
 */
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "../store/zcodeSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useZCodeSessionStore(
    (state) => selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
