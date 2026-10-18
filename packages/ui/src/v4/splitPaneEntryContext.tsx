// Availability switch for the sidebar session-item open-in-split / drag-to-split entries.
// Session workbench groups are enabled on desktop and ordinary web; phone and /remote
// web-remote are not. Context instead of prop drilling: the item context menu and drag source
// are shared by several sidebar sections, and the verdict lives only in WorkspaceShellLayout.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { WorkbenchSessionTarget } from "@/v4/workbenchSessionPlacement.js";

export type V4SplitPaneSessionTarget = WorkbenchSessionTarget;

interface V4SplitPaneEntryContextValue {
  readonly enabled: boolean;
  readonly canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  readonly openSession: (target: V4SplitPaneSessionTarget) => void;
}

const DEFAULT_SPLIT_PANE_ENTRY_CONTEXT: V4SplitPaneEntryContextValue = {
  enabled: false,
  canOpenSession: () => false,
  openSession: () => {},
};

const V4SplitPaneEntryContext = createContext<V4SplitPaneEntryContextValue>(
  DEFAULT_SPLIT_PANE_ENTRY_CONTEXT,
);

export function V4SplitPaneEntryProvider({
  enabled,
  canOpenSession,
  onOpenSession,
  children,
}: {
  enabled: boolean;
  canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  onOpenSession: (target: V4SplitPaneSessionTarget) => void;
  children: ReactNode;
}) {
  const controllerRef = useRef({ canOpenSession, onOpenSession });
  controllerRef.current = { canOpenSession, onOpenSession };
  const value = useMemo<V4SplitPaneEntryContextValue>(
    () => ({
      enabled,
      canOpenSession: (target) => enabled && controllerRef.current.canOpenSession(target),
      openSession: (target) => {
        if (enabled) controllerRef.current.onOpenSession(target);
      },
    }),
    [enabled],
  );
  return (
    <V4SplitPaneEntryContext.Provider value={value}>{children}</V4SplitPaneEntryContext.Provider>
  );
}

/** The context-menu entry is decided by the shell alone, so task rows never bypass the active group/draft-pane owner. */
export function useV4SplitPaneEntry(): V4SplitPaneEntryContextValue {
  return useContext(V4SplitPaneEntryContext);
}
