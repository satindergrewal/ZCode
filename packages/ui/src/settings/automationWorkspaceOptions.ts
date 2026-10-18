import { resolveWorkspaceKey, type RemoteTarget, type WorkspacePurpose } from "@zcode/shared";
import { isWorkspaceTab, isWorkspaceTabReadOnly, type WindowTabState } from "@/store/tabStore.js";

export interface AutomationWorkspaceOption {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  label: string;
  workspacePurpose?: WorkspacePurpose;
}

export function resolveAutomationWorkspaceSelectionKey(
  workspace: Pick<AutomationWorkspaceOption, "workspacePath" | "workspaceIdentity">,
): string {
  return resolveWorkspaceKey(workspace);
}

export function findAutomationWorkspaceOptionByKey(
  options: readonly AutomationWorkspaceOption[],
  workspaceKey: string | null,
): AutomationWorkspaceOption | undefined {
  return options.find((option) => resolveAutomationWorkspaceSelectionKey(option) === workspaceKey);
}

/**
 * The create form's project choice may only land on currently valid candidates.
 * Keep a still-valid choice across candidate changes; else fall back to the valid default, first valid, or null.
 */
export function reconcileAutomationWorkspaceSelectionKey(
  options: readonly AutomationWorkspaceOption[],
  currentWorkspaceKey: string | null,
  preferredWorkspace?: Pick<AutomationWorkspaceOption, "workspacePath" | "workspaceIdentity">,
): string | null {
  const current = findAutomationWorkspaceOptionByKey(options, currentWorkspaceKey);
  if (current) return resolveAutomationWorkspaceSelectionKey(current);

  const preferredKey = preferredWorkspace
    ? resolveAutomationWorkspaceSelectionKey(preferredWorkspace)
    : null;
  const preferred = findAutomationWorkspaceOptionByKey(options, preferredKey);
  if (preferred) return resolveAutomationWorkspaceSelectionKey(preferred);

  const first = options[0];
  return first ? resolveAutomationWorkspaceSelectionKey(first) : null;
}

function workspaceLabelFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

/**
 * Build pure project candidates for boundaries that disallow project-less sessions.
 * The single no-project session target shown by the scheduled form is merged in explicitly by useAutomationProjectOptions;
 * recentProjects, conversation backings and dead dirs never mix in here as plain projects.
 */
export function buildAutomationWorkspaceOptions(
  tabs: readonly WindowTabState[],
): AutomationWorkspaceOption[] {
  const byKey = new Map<string, AutomationWorkspaceOption>();
  for (const tab of tabs) {
    if (
      !isWorkspaceTab(tab) ||
      tab.workspacePurpose === "conversation" ||
      isWorkspaceTabReadOnly(tab)
    ) {
      continue;
    }
    const key = resolveWorkspaceKey({
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
    });
    if (byKey.has(key)) continue;
    byKey.set(key, {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      ...(tab.remoteTarget ? { remoteTarget: tab.remoteTarget } : {}),
      label: tab.label || workspaceLabelFromPath(tab.workspacePath),
    });
  }
  return [...byKey.values()];
}
