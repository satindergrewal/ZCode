// Cross-component type contract for the saved-workflows hub.
// A separate file so the page (Section) and groups never import each other into a cycle.

/** The owning project's coordinates: used for conversation commands (run / revise / create) and instance opening; never the active project. */
export type SavedWorkflowProjectTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
};

/** Run-history view-instance: switch to the originating session and open the instance detail page; the page lists all projects, so the owning workspace is required. */
export interface SavedWorkflowsOpenRunParams {
  sessionId: string;
  runId: string;
  toolCallId: string;
  workflowName: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Hub artifact chip -> the workflow-artifact tab.
 *
 * Terminology: artifact = the output the script published via artifact.*.
 *
 * One field fewer than {@link SavedWorkflowsOpenRunParams}: no `toolCallId`, because the artifact
 * tab draws no causality graph and never returns to that CreateWorkflow tool row. The gate is
 * simply a present parentSessionId.
 */
export interface SavedWorkflowsOpenArtifactParams {
  sessionId: string;
  runId: string;
  artifactId: string;
  title?: string;
  /**
   * Latest version's contentType (available on run-history chip payloads). The destination's
   * handleOpenWorkflowArtifact uses it to open html artifacts straight into a browser tab vs the
   * artifact tab; absent (legacy rows without an artifact list) means the artifact tab.
   */
  contentType?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** A group's loading report to the page; the page derives the total count, empty states and the first-paint spinner from it. */
export interface SavedWorkflowGroupState {
  loaded: boolean;
  empty: boolean;
  /** Valid workflow rows in this group (0 before load); the page sums loaded groups for the count beside the title. */
  count: number;
}

/** The group's two modes: list / single-workflow detail. Shared by project and global groups. */
export type SavedWorkflowGroupMode = { kind: "list" } | { kind: "detail"; name: string };
