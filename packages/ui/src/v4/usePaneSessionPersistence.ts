// Local persistence of pane<->session bindings (pane binding is Layout-layer local UI state).
// Motivation: the old path restored the selected task via useTaskRestore (deleted). In v4 a
// renderer refresh zeroes the zustand selection; without persistence the refresh kicks the user
// to a draft pane and the streaming session "vanishes". CLI/host processes survive the renderer
// refresh, so restoring the selection lets the pane resubscribe and pick up snapshot+stream.
// Only the first workspace after the same renderer reload restores; app cold start and
// workspace-only entries stay drafts and never consume the previous run's bindings.
import { useEffect, useRef } from "react";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";

const STORAGE_PREFIX = "zcode-v4-last-session:v1:";

function storageKey(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

export function readPersistedPaneSession(workspaceKey: string): string | null {
  try {
    return localStorage.getItem(storageKey(workspaceKey));
  } catch {
    return null;
  }
}

export function persistPaneSession(
  workspaceKey: string,
  sessionId: string | null,
): void {
  try {
    if (sessionId) {
      localStorage.setItem(storageKey(workspaceKey), sessionId);
    } else {
      localStorage.removeItem(storageKey(workspaceKey));
    }
  } catch {
    // No-storage environments (tests/private mode) degrade silently: refresh-restore is unavailable, sessions unaffected.
  }
}

export interface UsePaneSessionPersistenceParams {
  workspaceKey: string;
  activeSessionId: string | null;
  /** startDraft explicit-user-intent generation; above 0, null means draft, not pending-restore. */
  draftFocusVersion: number;
  /** Mobile /remote never consumes desktop pane local-restore state. */
  enabled?: boolean;
  /** Restore entry: the same selection path as clicking the task list, keeping side effects (read-clearing etc.) identical. */
  selectSession: (sessionId: string) => void;
}

export function shouldRestorePersistedPaneSession(params: {
  activeSessionId: string | null;
  draftFocusVersion: number;
  enabled: boolean;
  rendererReload: boolean;
}): boolean {
  return (
    params.enabled &&
    params.rendererReload &&
    params.activeSessionId === null &&
    params.draftFocusVersion === 0
  );
}

/**
 * Restores the last bound session on mount; afterwards follows the selection state's
 * writes/clears. Restores once per workspaceKey mount: an explicit return to draft (new task)
 * is a selection change that clears the persisted key, so the old session never drags the
 * user back.
 */
export function usePaneSessionPersistence({
  workspaceKey,
  activeSessionId,
  draftFocusVersion,
  enabled = true,
  selectSession,
}: UsePaneSessionPersistenceParams): void {
  const restoredKeysRef = useRef<Set<string>>(new Set());
  // Only the first workspace after reload may consume pre-refresh pane bindings; later
  // workspaces are still workspace-only entries and must enter draft, not restore old sessions
  // one by one.
  const rendererReloadRestoreAvailableRef = useRef(isRendererReloadNavigation());
  const pendingRestoreRef = useRef<{
    workspaceKey: string;
    sessionId: string;
  } | null>(null);
  const selectSessionRef = useRef(selectSession);
  selectSessionRef.current = selectSession;

  useEffect(() => {
    if (!enabled) return;
    if (restoredKeysRef.current.has(workspaceKey)) return;
    restoredKeysRef.current.add(workspaceKey);
    const rendererReload = rendererReloadRestoreAvailableRef.current;
    rendererReloadRestoreAvailableRef.current = false;
    if (
      !shouldRestorePersistedPaneSession({
        activeSessionId,
        draftFocusVersion,
        enabled,
        rendererReload,
      })
    ) {
      // Cold starts and workspace-only entries must be drafts. A stale last-session, even from
      // the previous app run, must never write activeTaskId back on this mount.
      if (activeSessionId === null) {
        persistPaneSession(workspaceKey, null);
      }
      return;
    }
    const stored = readPersistedPaneSession(workspaceKey);
    if (stored) {
      pendingRestoreRef.current = { workspaceKey, sessionId: stored };
      selectSessionRef.current(stored);
    }
    // activeSessionId/draftFocusVersion are deliberately excluded: restore keys off the
    // workspace's first mount alone; later explicit new-task/selection changes flow through the
    // persistence effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    // Never persist the initial null before restore completes (it would overwrite the pending value).
    if (!restoredKeysRef.current.has(workspaceKey)) return;
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore?.workspaceKey === workspaceKey) {
      if (activeSessionId === null) {
        return;
      }
      // The restore and persist effects share one commit, and the latter's closure can still see
      // the pre-restore null. Allow writes only once the selection truly backfills, so the
      // reload-restore key is not deleted first.
      pendingRestoreRef.current = null;
    }
    persistPaneSession(workspaceKey, activeSessionId);
  }, [activeSessionId, enabled, workspaceKey]);
}
