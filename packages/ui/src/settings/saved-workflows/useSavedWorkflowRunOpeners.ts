import { useCallback } from "react";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import type {
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

/** The run row's project (constant for project scope; resolved via run.cwd for global). */
export interface SavedWorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * The two Open gates and arg builders on the hub's run-history rows.
 *
 * Terminology: artifact here means output published to the user via artifact.*, never the script's top-level return.
 *
 * One hook, not two copies: project and global scope differ only in how the target project is computed
 * (fixed vs resolved from run.cwd), while both gates must share one criteria -- written twice,
 * artifacts-need-no-toolCallId would drift into same-as-view-instance in one of them.
 *
 * ```
 *                       parentSessionId?   toolCallId?   project openable?
 * view instance               required          required        required
 * artifact chip               required            --            required
 * ```
 *
 * `toolCallId` serves only the run detail's static causality graph (it hangs on that
 * CreateWorkflow row's display). The artifact tab draws no graph, so old rows without `toolCallId` still open artifacts.
 */
export function useSavedWorkflowRunOpeners(options: {
  /** The row's project; null closes both entries (global scope with the cwd's project not open). */
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
      // The row's chip payload (ZCodeSavedWorkflowRun.artifacts) carries the latest contentType:
      // the sink opens html artifacts straight into a browser tab. Old rows lack artifacts wholly; a missing key degrades, never errors.
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
