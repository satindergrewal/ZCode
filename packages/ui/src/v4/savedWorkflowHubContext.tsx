// The two **shell-level** targets from the completed card (docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）：
//
//   openWorkflow -- the saved chip -> that page in the workflow hub;
//   navigateToRun -- a successful run-again -> switch to the newly created session.
//
// Same reasoning as WorkflowRunOpenProvider for context over prop drilling: only the shell knows how,
// and the card lives in both the conversation timeline and the run side pane, layers away from either;
// no layer needs where-the-hub-is. Without a provider (mobile shell, tests, static replay) the chip is text and run-again never switches --
// the mobile shell has no hub to begin with.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

export interface SavedWorkflowHubTarget {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  /** The project a project-scoped entry belongs to; global entries ignore it (the hub's global group is not per-project). */
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface SavedWorkflowHubHandlers {
  openWorkflow: (target: SavedWorkflowHubTarget) => void;
  navigateToRun: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}

const SavedWorkflowHubContext = createContext<SavedWorkflowHubHandlers | null>(null);

export function SavedWorkflowHubProvider({
  children,
  navigateToRun,
  openWorkflow,
}: SavedWorkflowHubHandlers & { children: ReactNode }) {
  const ref = useRef({ openWorkflow, navigateToRun });
  ref.current = { openWorkflow, navigateToRun };
  // Stable identity: the chip hangs on a virtualized card; a new callback reference re-renders the whole list.
  const stable = useMemo<SavedWorkflowHubHandlers>(
    () => ({
      openWorkflow: (target) => ref.current.openWorkflow(target),
      navigateToRun: (target, sessionId) => ref.current.navigateToRun(target, sessionId),
    }),
    [],
  );
  return (
    <SavedWorkflowHubContext.Provider value={stable}>{children}</SavedWorkflowHubContext.Provider>
  );
}

export function useSavedWorkflowHub(): SavedWorkflowHubHandlers | null {
  return useContext(SavedWorkflowHubContext);
}
