import { useCallback } from "react";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import type {
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

/** The project a run-history row belongs to (constant for project workflows; reverse-looked-up from run.cwd for global ones). */
interface SavedWorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * The two open gates and args builders behind hub run-history rows.
 *
 * Terminology: artifact here is what the script published via artifact.*, not its top-level return value.
 *
 * One hook instead of a copy per group: the only project-vs-global difference is how the target
 * project is computed (constant vs reverse lookup by run.cwd), and the two gates must agree - written
 * twice, artifacts-need-no-toolCallId would inevitably become same-as-view-instance in one of them.
 *
 * ```
 *                       parentSessionId?   toolCallId?   project openable?
 * view-instance            required          required       required
 * artifact chip            required          -              required
 * ```
 *
 * toolCallId serves only the static causality graph on the run detail page (it hangs off that
 * CreateWorkflow tool row's display). The artifact tab draws no graph, so legacy rows without
 * toolCallId still open artifacts.
 */
export function useSavedWorkflowRunOpeners(options: {
  /** The row's owning project; null closes both entries (the cwd's project is not open, global case). */
  resolveTarget: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunOpenTarget | null;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
}): {
  handleOpenRun: (run: ZCodeSavedWorkflowRun, workflowName: string) => void;
  handleOpenArtifact: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
} {
  const { onOpenWorkflowArtifact, onOpenWorkflowRun, resolveTarget } = options;

  const handleOpenRun = useCallback(
    (run: ZCodeSavedWorkflowRun, workflowName: string) => {
      if (!run.parentSessionId || !run.toolCallId) return;
      const target = resolveTarget(run);
      if (!target) return;
      onOpenWorkflowRun?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        toolCallId: run.toolCallId,
        workflowName,
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowRun, resolveTarget],
  );

  const handleOpenArtifact = useCallback(
    (run: ZCodeSavedWorkflowRun, artifactId: string) => {
      if (!run.parentSessionId) return;
      const target = resolveTarget(run);
      if (!target) return;
      // The row's chip payload (ZCodeSavedWorkflowRun.artifacts) carries the latest version's
      // contentType: the destination opens html artifacts straight into a browser tab. Legacy rows
      // lack artifacts entirely; a missing key is degradation, not an error.
      const artifact = run.artifacts?.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowArtifact, resolveTarget],
  );

  return { handleOpenArtifact, handleOpenRun };
}
