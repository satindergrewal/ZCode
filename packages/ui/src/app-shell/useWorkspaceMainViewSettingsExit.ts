import { useCallback, useLayoutEffect, useRef } from "react";
import type { WorkspaceMainView } from "@/app-shell/types.js";

export function useWorkspaceMainViewSettingsExit({
  isWorkspaceVisible,
  workspaceMainView,
  onExitSettings,
}: {
  isWorkspaceVisible: boolean;
  workspaceMainView: WorkspaceMainView;
  onExitSettings: () => void;
}) {
  const wasWorkspaceVisibleRef = useRef(isWorkspaceVisible);
  const settingsEntryMainViewRef = useRef(workspaceMainView);
  const preserveNextSettingsExitRef = useRef(false);

  const preserveNextSettingsExit = useCallback(() => {
    if (!wasWorkspaceVisibleRef.current) {
      preserveNextSettingsExitRef.current = true;
    }
  }, []);

  useLayoutEffect(() => {
    const wasWorkspaceVisible = wasWorkspaceVisibleRef.current;
    wasWorkspaceVisibleRef.current = isWorkspaceVisible;

    if (wasWorkspaceVisible && !isWorkspaceVisible) {
      settingsEntryMainViewRef.current = workspaceMainView;
      preserveNextSettingsExitRef.current = false;
      return;
    }

    if (!wasWorkspaceVisible && isWorkspaceVisible) {
      if (preserveNextSettingsExitRef.current) {
        // With the plugin market already open, clicking "New" again from settings leaves
        // the main view value at plugin-store; before/after alone cannot tell that this is
        // an explicit navigation. Consume this one-shot flag so the settings-exit flow does
        // not close the market; the flag may only be written while settings is open.
        preserveNextSettingsExitRef.current = false;
        return;
      }

      if (workspaceMainView === settingsEntryMainViewRef.current) {
        // Settings only overlays the workspace; the underlying App stays mounted, so the
        // pre-settings main view (e.g. automations) survives. Exiting settings always
        // returns to the conversation so Back, plugin prompts, create-Skill, and the
        // settings shortcuts share one navigation semantic.
        onExitSettings();
      }
    }
  }, [isWorkspaceVisible, onExitSettings, workspaceMainView]);

  return { preserveNextSettingsExit };
}
