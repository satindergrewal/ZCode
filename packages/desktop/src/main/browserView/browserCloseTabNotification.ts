import type { BrowserViewCloseTabNotification } from "@zcode/shared";
import type { BrowserGuestExecutionContext } from "./browserGuestManager.js";

/* /** Builds the owner-scope subset for main-to-renderer close notifications; the rest of the execution context never concerns the renderer. */
type BrowserCloseTabNotificationOwner = Pick<
  BrowserGuestExecutionContext,
  "workspaceKey" | "sessionId" | "remoteSessionId"
>;

/**
 * * Folds the main-side tab owner into a renderer-routable close notice.
 *
 * The old payload carried tabId only, so the renderer searched just the active workspace's side pane;
 * # a workspace switch silently dropped the notice, leaving an unclosable ghost tab in the original workspace.
 * With owner scope the renderer targets the right workspace's side pane and deletes the tab.
 *
 * A pure function so tests cover the field mapping; inlined in index.ts's manager callback, Electron entry points
 * escape unit tests and closeTabFromRenderer bypasses it via notifyRenderer=false,
 * leaving the whole Agent close-notice chain untested.
 *
 * owner is optional: recovery-orphan paths carry tabId only, and the renderer falls back to active-workspace semantics.
 */
export function buildBrowserViewCloseTabNotification(
  tabId: string,
  owner?: BrowserCloseTabNotificationOwner,
): BrowserViewCloseTabNotification {
  if (!owner) return { tabId };
  return {
    tabId,
    workspaceKey: owner.workspaceKey,
    sessionId: owner.sessionId,
    // Only remote workspaces have remoteSessionId; local ones must omit it, not set explicit undefined,
    // since the renderer branches scope on presence of payload.remoteSessionId.
    ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
  };
}
