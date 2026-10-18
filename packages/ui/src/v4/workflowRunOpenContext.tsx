// Entry for sidebar run-row click -> select session + open the run pane. Same jump as the composer badge, decided in one place by WorkspaceShellLayout;
// context instead of prop drilling: run rows exist in five task-row variants (default / timeline / pinned / archived / grouped).
// Without the provider (phone remote-control home, unit tests) the run row is plain text, not a button.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { SessionWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";

export interface WorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  run: SessionWorkflowRunSummary;
}

type WorkflowRunOpenHandler = (target: WorkflowRunOpenTarget) => void;

const WorkflowRunOpenContext = createContext<WorkflowRunOpenHandler | null>(null);

export function WorkflowRunOpenProvider({
  onOpenRun,
  children,
}: {
  onOpenRun: WorkflowRunOpenHandler;
  children: ReactNode;
}) {
  const handlerRef = useRef(onOpenRun);
  handlerRef.current = onOpenRun;
  const stable = useMemo<WorkflowRunOpenHandler>(() => (target) => handlerRef.current(target), []);
  return (
    <WorkflowRunOpenContext.Provider value={stable}>{children}</WorkflowRunOpenContext.Provider>
  );
}

export function useWorkflowRunOpen(): WorkflowRunOpenHandler | null {
  return useContext(WorkflowRunOpenContext);
}
