import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TerminalSession } from "@/terminal/TerminalSession.js";

export function SidePaneTerminalPane({
  services,
  sessionId,
  workspaceKey,
  cwd,
  isVisible,
  isWindowsDesktop = false,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  /**
   * Keep-alive: the sessionId reuses tab.id (stable across workspaces) and doubles as the
   * TerminalSession persistentKey. xterm+PTY ownership lives in the module-level
   * sidePaneTerminalSessionRegistry singleton; unmount only detaches, remounts reuse by key,
   * and scrollback survives across workspaces.
   */
  sessionId: string;
  /**
   * Workspace identity key (= workspaceIdentity?.trim() || workspacePath). Stored as
   * registry entry.workspaceKey; closing a workspace tab reaps its PTYs by this key.
   */
  workspaceKey?: string;
  cwd?: string;
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const handleShellLabelChange = useCallback(() => {
    // The outer side pane tab already carries the terminal title, so this pane hosts a single
    // shell and renders/syncs no second tab bar — no nested tabs.
  }, []);

  return (
    <section className="h-full min-h-0 overflow-hidden bg-background p-3">
      <TerminalSession
        sessionId={sessionId}
        persistentKey={sessionId}
        workspaceKey={workspaceKey}
        services={services}
        cwd={cwd}
        isVisible={isVisible}
        isWindowsDesktop={isWindowsDesktop}
        onShellLabelChange={handleShellLabelChange}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />
    </section>
  );
}
