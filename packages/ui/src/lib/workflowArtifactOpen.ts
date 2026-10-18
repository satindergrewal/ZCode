/**
 * Click-target decision for html artifacts.
 *
 * An html artifact pill means "show me this page", not "show me the metadata card, then click
 * again to reach the page". So whenever the embedded browser **can** open directly, open it;
 * the artifact tab is the fallback. Criteria mirror `shouldOpenAssistantHtmlInBrowser`
 * (lib/assistantPreviewCards.ts):
 *
 * - `text/html` strict equality -- the same gate that draws the html card in `WorkflowArtifactBody`.
 *   Loosening to `text/html; charset=utf-8` would fork "open directly" from "button on the card".
 * - Without an embedded browser (web / phone-remote) `handleOpenBrowserUrl` only `window.open`s,
 *   and `file://` does not open there -- fall back to the artifact tab.
 * - Remote workspaces (SSH / WSL / Docker) and phone-remote `sourcePath` do not exist locally; same as `canRevealArtifactInWorkspace`.
 *
 * Missing `contentType` (old CLI, cold restore, or surfaces without summaries) always falls back
 * to the artifact tab: when in doubt, take the original path -- never guess.
 */
export function shouldOpenWorkflowArtifactInBrowser(params: {
  contentType?: string;
  supportsEmbeddedBrowser: boolean;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): boolean {
  return (
    params.contentType === "text/html" &&
    params.supportsEmbeddedBrowser &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId
  );
}
