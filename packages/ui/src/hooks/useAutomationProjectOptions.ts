import { useMemo } from "react";
import type { WorkspacePurpose } from "@zcode/shared";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";

export interface AutomationProjectOption {
  workspacePath: string;
  label: string;
  workspacePurpose?: WorkspacePurpose;
}

export function isRemoteAutomationWorkspace(tab: WorkspaceTabState | undefined): boolean {
  return Boolean(tab?.remoteSessionId || tab?.remoteTarget || tab?.workspaceIdentity);
}

export interface AutomationProjectOptionsConfig {
  includeConversationWorkspace?: boolean;
}

export function resolveAutomationProjectOptions(
  workspaceTabs: WorkspaceTabState[],
  config: AutomationProjectOptionsConfig = {},
): AutomationProjectOption[] {
  const result: AutomationProjectOption[] = [];
  let conversationWorkspaceIncluded = false;

  for (const tab of workspaceTabs) {
    if (tab.availability === "unavailable-local-directory") continue;

    if (tab.workspacePurpose === "conversation") {
      if (!config.includeConversationWorkspace || conversationWorkspaceIncluded) {
        continue;
      }
      // Legacy settings may keep several conversation backing paths, all denoting the same
      // "no-project session" logical target. Keep the purpose instead of sniffing the
      // default label, so the menu reuses the session side's fixed "not working in a
      // project" copy and icon while still binding exactly one canonical cwd.
      conversationWorkspaceIncluded = true;
      result.push({
        workspacePath: tab.workspacePath,
        label: "default",
        workspacePurpose: "conversation",
      });
      continue;
    }

    result.push({
      workspacePath: tab.workspacePath,
      label: tab.label || workspaceBasename(tab.workspacePath),
    });
  }

  return result;
}

/**
 * Automation creation reads only local workspaces already open and usable in this window.
 * Scheduled tasks may explicitly add the "no-project session" logical target; off-peak
 * tasks stay real-projects-only.
 *
 * Candidates keep only usable local workspace tabs, excluding recent projects and remote
 * tabs, so a remote identity is never handed to the local host and off-peak tasks never
 * inherit a remote workspace. Both task kinds share the entry filter, keeping project
 * isolation semantics consistent.
 */
export function useAutomationProjectOptions(
  config: AutomationProjectOptionsConfig = {},
): AutomationProjectOption[] {
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const localWorkspaceTabs = useLocalWorkspaceScopes({ workspaceTabs });
  const includeConversationWorkspace = config.includeConversationWorkspace === true;

  return useMemo(
    () =>
      resolveAutomationProjectOptions(localWorkspaceTabs, {
        includeConversationWorkspace,
      }),
    [includeConversationWorkspace, localWorkspaceTabs],
  );
}

function workspaceBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}
