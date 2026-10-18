// Pure logic for the global workflow group. Split from the component to honor max-lines 400 and keep
// these React-free decisions unit-testable.
import { resolveWorkspaceKey, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import type { ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowRunProject } from "@/settings/saved-workflows/SavedWorkflowRunHistoryPanel.js";

/** RPC target constant for the global scope: no workspace; the services layer picks the local runtime. */
export const GLOBAL_SAVED_WORKFLOW_TARGET: ZCodeAgentSavedWorkflowTarget = { scope: "global" };

/** Final path segment (across `/` and `\\`); fallback label for run rows of not-open projects. */
function basenameOfPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .filter(Boolean)
      .pop() ?? path
  );
}

/** Target for "revise"/"create via conversation": the active local project, else the first local project; null with neither. */
export function resolveGlobalActionTarget(
  localProjects: readonly AutomationWorkspaceOption[],
  activeProjectKey: string | null,
): SavedWorkflowProjectTarget | null {
  const active = localProjects.find((project) => resolveWorkspaceKey(project) === activeProjectKey);
  const target = active ?? localProjects[0];
  if (!target) return null;
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

/** Which open local project a run row's cwd hits (literal absolute-path comparison). */
export function findProjectByCwd(
  localProjects: readonly AutomationWorkspaceOption[],
  cwd: string | undefined,
): AutomationWorkspaceOption | null {
  if (!cwd) return null;
  return localProjects.find((project) => project.workspacePath === cwd) ?? null;
}

/**
 * Per-row project column of the detail page's run history (global scope spans cwds): a cwd matching an
 * open project shows that label and enables "open instance"; otherwise fall back to `basename(cwd)`,
 * full path in the title, no "open instance"; rows without cwd render no project column.
 */
export function buildGlobalRunProjectResolver(
  localProjects: readonly AutomationWorkspaceOption[],
): (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null {
  return (run) => {
    if (!run.cwd) return null;
    const project = findProjectByCwd(localProjects, run.cwd);
    if (project) {
      return { label: project.label, title: run.cwd, canOpen: true };
    }
    return { label: basenameOfPath(run.cwd), title: run.cwd, canOpen: false };
  };
}
