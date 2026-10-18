import { useEffect, useRef, useState } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { BrowserUseSidePaneTab, WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";

function matchesTab(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.browserId === payload.browserId &&
    tab.browserGeneration === payload.browserGeneration &&
    tab.tabId === payload.tabId
  );
}

/**
 * For browser tabs restored across processes (browser: prefix), the browserId /
 * browserGeneration in the renderer registry is the old process value; once the tab is adopted by a new scope round the
 * main-side owner is updated, but the renderer has no reliable sync channel (residency transitions carry the new value only
 * on state changes). If prepare/release insisted on strict 7-tuple matching, a restored tab screenshot
 * surface would never match: prepare silently ignored -> screenshot times out at 3s; release never hits
 * -> the pane gets stuck in a nearly transparent fixed overlay. Matching therefore degrades to
 * workspaceKey + sessionId + tabId: tabId is a globally unique uuid, and the first two prevent
 * cross-workspace/session crosstalk; stale protection stays with the main-side coordinator via the request generation.
 */
function matchesTabLoose(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.tabId === payload.tabId
  );
}

function matchesRequest(
  request: BrowserViewScreenshotSurfacePreparePayload,
  payload: BrowserViewScreenshotSurfaceReleasePayload,
): boolean {
  return (
    request.requestId === payload.requestId &&
    request.workspaceKey === payload.workspaceKey &&
    request.sessionId === payload.sessionId &&
    request.tabId === payload.tabId &&
    request.webContentsId === payload.webContentsId
  );
}

function findScreenshotSurfaceTab(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && matchesTab(tab, payload),
  );
}

/**
 * Once prepare is accepted by this renderer, browserGeneration may still change via attach/restore.
 * The same transient request must still reach the original tab; main does the final stale check with the request generation.
 */
export function findScreenshotSurfaceTabForRender(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return (
    findScreenshotSurfaceTab(tabs, payload) ??
    tabs.find(
      (tab): tab is BrowserUseSidePaneTab =>
        tab.type === "browser-use" && matchesTabLoose(tab, payload),
    )
  );
}

/**
 * prepare accept matching: strict scope hit first; a cross-process restored tab registry scope metadata
 * still holds old-process values (see matchesTabLoose), so degraded matching is required for prepare to arrive.
 */
function findScreenshotSurfaceTabForPrepare(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return findScreenshotSurfaceTabForRender(tabs, payload);
}

/**
 * Only transient prepare requests already matched to this renderer tab registry are kept. Requests never enter the workspace store,
 * so desktop compositing sync cannot leak into remote/replayable task state.
 */
export function useBrowserScreenshotSurfaceRequest(
  tabs: readonly WorkspaceSidePaneTab[],
): BrowserViewScreenshotSurfacePreparePayload | null {
  const platform = usePlatform();
  const [request, setRequest] = useState<BrowserViewScreenshotSurfacePreparePayload | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const disposePrepare = platform.onBrowserViewScreenshotSurfacePrepare?.((payload) => {
      // browser-use operations update the tab registry; the old effect keyed on tabs,
      // and a command landing during React effect cleanup briefly removed the IPC listener, so prepare messages
      // were lost for good and background screenshots waited the full 30s. The listener now lives with the platform lifetime and reads the latest tabs on match.
      if (!findScreenshotSurfaceTabForPrepare(tabsRef.current, payload)) {
        logger.debug("[browser-use] Ignoring screenshot surface prepare for a non-current renderer tab", {
          requestId: payload.requestId,
          tabId: payload.tabId,
        });
        return;
      }
        logger.debug("[browser-use] Accepted screenshot surface prepare", {
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
      });
      setRequest((current) => {
        if (current && current.requestId !== payload.requestId) {
          logger.debug("[browser-use] Keeping the still-preparing screenshot surface request", {
            requestId: current.requestId,
            tabId: current.tabId,
          });
          return current;
        }
        return payload;
      });
    });
    const disposeRelease = platform.onBrowserViewScreenshotSurfaceRelease?.((payload) => {
      setRequest((current) => {
        if (!current || !matchesRequest(current, payload)) {
          return current;
        }
        return null;
      });
    });
    return () => {
      disposePrepare?.();
      disposeRelease?.();
    };
  }, [platform]);

  return request;
}
