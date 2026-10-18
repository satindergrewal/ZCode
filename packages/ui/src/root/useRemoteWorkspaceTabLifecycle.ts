import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  unbindRemoteWorkspaceIdentity,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

function remoteWorkspaceKey(tab: WorkspaceTabState): string | null {
  if (!tab.workspaceIdentity?.trim() && !tab.remoteSessionId && !tab.remoteTarget) {
    return null;
  }

  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

function collectClosedRemoteWorkspaceKeys(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
): string[] {
  const nextRemoteWorkspaceKeys = new Set(
    nextWorkspaceTabs.flatMap((tab) => {
      const workspaceKey = remoteWorkspaceKey(tab);
      return workspaceKey ? [workspaceKey] : [];
    }),
  );
  const closedRemoteWorkspaceKeys = new Set<string>();

  for (const previousTab of previousWorkspaceTabs) {
    const workspaceKey = remoteWorkspaceKey(previousTab);
    if (!workspaceKey || nextRemoteWorkspaceKeys.has(workspaceKey)) {
      continue;
    }
    closedRemoteWorkspaceKeys.add(workspaceKey);
  }

  return [...closedRemoteWorkspaceKeys];
}

function collectClosedRemoteWorkspaceSessionIds(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
  rememberedSessionIdsByWorkspaceKey: ReadonlyMap<string, string>,
): string[] {
  const previousLiveSessionIds = new Set(
    previousWorkspaceTabs
      .map((tab) => tab.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  return collectClosedRemoteWorkspaceKeys(previousWorkspaceTabs, nextWorkspaceTabs).flatMap(
    (workspaceKey) => {
      const sessionId = rememberedSessionIdsByWorkspaceKey.get(workspaceKey);
      // Tabs still carrying remoteSessionId are released by the normal removal flow below;
      // this only covers sessions whose tab field was cleared after disconnect, avoiding a double dispose.
      return sessionId && !previousLiveSessionIds.has(sessionId) ? [sessionId] : [];
    },
  );
}

export function useRemoteWorkspaceTabLifecycle({
  tabs,
  activeWorkspaceTab,
  platform,
  onRemoteWorkspaceTabsClosed,
}: {
  tabs: WindowTabState[];
  activeWorkspaceTab: WorkspaceTabState | null;
  platform: IPlatformService;
  onRemoteWorkspaceTabsClosed?: (workspaceKeys: string[]) => void;
}) {
  const previousWorkspaceTabsRef = useRef<WindowTabState[]>([]);
  const rememberedSessionIdsByWorkspaceKeyRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const previousWorkspaceTabs = previousWorkspaceTabsRef.current.filter(isWorkspaceTab);
    const nextWorkspaceTabs = tabs.filter(isWorkspaceTab);
    const closedRemoteWorkspaceKeys = collectClosedRemoteWorkspaceKeys(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
    );
    const closedRemoteSessionIds = collectClosedRemoteWorkspaceSessionIds(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
      rememberedSessionIdsByWorkspaceKeyRef.current,
    );
    if (closedRemoteWorkspaceKeys.length > 0) {
      onRemoteWorkspaceTabsClosed?.(closedRemoteWorkspaceKeys);
      for (const workspaceKey of closedRemoteWorkspaceKeys) {
        rememberedSessionIdsByWorkspaceKeyRef.current.delete(workspaceKey);
      }
    }
    for (const tab of nextWorkspaceTabs) {
      const workspaceKey = remoteWorkspaceKey(tab);
      if (workspaceKey && tab.remoteSessionId) {
        rememberedSessionIdsByWorkspaceKeyRef.current.set(workspaceKey, tab.remoteSessionId);
      }
    }

    for (const sessionId of closedRemoteSessionIds) {
      void (async () => {
        try {
          // Disconnect clears remoteSessionId from the tab first, so the normal removal flow
          // below cannot release the session; use the remembered sessionId to cover close-after-disconnect.
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] Failed to release disconnected remote session:", { sessionId, error });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    const nextRemoteSessionIds = new Set(
      nextWorkspaceTabs
        .map((tab) => tab.remoteSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );

    for (const previousTab of previousWorkspaceTabs) {
      const stillExists = nextWorkspaceTabs.some((nextTab) => nextTab.id === previousTab.id);
      if (stillExists) {
        continue;
      }

      if (!previousTab.remoteSessionId) {
        continue;
      }

      const survivingRemoteTab = nextWorkspaceTabs.find((nextTab) => {
        if (!nextTab.remoteSessionId) {
          return false;
        }

        if (previousTab.workspaceIdentity && nextTab.workspaceIdentity) {
          return nextTab.workspaceIdentity === previousTab.workspaceIdentity;
        }

        return nextTab.workspacePath === previousTab.workspacePath;
      });

      if (survivingRemoteTab?.remoteSessionId) {
        // The map used to be keyed by workspacePath only, so closing one same-path remote tab unbound the other too.
        // Reuse the surviving tab's binding and refresh the workspaceIdentity map so later RPCs hit the right session.
        bindRemoteWorkspacePath(
          survivingRemoteTab.workspacePath,
          survivingRemoteTab.remoteSessionId,
        );
        if (survivingRemoteTab.workspaceIdentity) {
          bindRemoteWorkspaceIdentity(
            survivingRemoteTab.workspaceIdentity,
            survivingRemoteTab.remoteSessionId,
          );
        }
      } else {
        unbindRemoteWorkspacePath(previousTab.workspacePath);
        if (previousTab.workspaceIdentity) {
          unbindRemoteWorkspaceIdentity(previousTab.workspaceIdentity);
        }
      }
    }

    const disposedSessionIds = new Set<string>();
    for (const previousTab of previousWorkspaceTabs) {
      const sessionId = previousTab.remoteSessionId;
      if (!sessionId || nextRemoteSessionIds.has(sessionId) || disposedSessionIds.has(sessionId)) {
        continue;
      }

      disposedSessionIds.add(sessionId);
      const workspacePath = previousTab.workspacePath;
      void (async () => {
        try {
          logger.info("[Root] remote workspace tab removed; releasing remote session", {
            workspacePath,
            workspaceIdentity: previousTab.workspaceIdentity,
            sessionId,
          });
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] Failed to release remote session:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    previousWorkspaceTabsRef.current = nextWorkspaceTabs;
  }, [onRemoteWorkspaceTabsClosed, platform, tabs]);

  useEffect(() => {
    if (!activeWorkspaceTab?.remoteSessionId) {
      return;
    }

    // Switching between same-path remote tabs must not rely on the one-time path binding made at connect:
    // the map would keep pointing at the old tab and path-resolved hooks could hit a stale session.
    // Refresh the path/workspaceIdentity mapping to the active tab so workspace-level RPCs follow it.
    bindRemoteWorkspacePath(activeWorkspaceTab.workspacePath, activeWorkspaceTab.remoteSessionId);
    if (activeWorkspaceTab.workspaceIdentity) {
      bindRemoteWorkspaceIdentity(
        activeWorkspaceTab.workspaceIdentity,
        activeWorkspaceTab.remoteSessionId,
      );
    }
  }, [
    activeWorkspaceTab?.remoteSessionId,
    activeWorkspaceTab?.workspaceIdentity,
    activeWorkspaceTab?.workspacePath,
  ]);
}
