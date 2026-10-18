import { memo, useEffect, useMemo } from "react";
import { HourglassIcon } from "lucide-react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkflowActorSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { workflowActorStartState } from "@/app-shell/workflowRunPanel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

interface WorkflowActorSessionSidePaneProps {
  tab: WorkflowActorSessionSidePaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}

/**
 * Not-started placeholder: the landing tab of a not-yet-started pill clicked on the card.
 *
 * The copy only says not started yet and that it will appear on its own - true (the gate reads the live projection) - and steers users away
 * from a retry that does not exist. State never rides on color alone: icon, title and body all say it.
 */
function WorkflowActorNotStarted() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex h-full flex-col items-center justify-center px-6 text-center"
      data-testid="workflow-actor-not-started"
    >
      <HourglassIcon className="size-8 text-foreground-subtlest" />
      <p className="mt-3 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.title" })}
      </p>
      <p className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.body" })}
      </p>
    </div>
  );
}

/**
 * Gate + nested read-only SessionPane.
 *
 * The gate input is the **parent session** workflowRuns projection (as in WorkflowRunSidePane: run state is the
 * parent session authoritative projection, not a local cache of this pane). The lease is refcounted and the parent
 * is usually already subscribed by the main pane, so this read adds no connection.
 *
 * On notStarted the **whole SessionPane stays unmounted** - never a hidden render. Subscription happens in
 * the SessionPane-internal layer.acquire(actorSessionId); only unmounting truly avoids a failing subscription
 * and the error-parked projection store waiting for a manual retry.
 */
const WorkflowActorSessionContent = memo(function WorkflowActorSessionContent({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
  const { layer } = useV4Conversation();

  // The parent lease connects synchronously during render (useMemo, as ReadyV4PaneConversationProvider),
  // not the WorkflowRunSidePane effect + setLease. The difference matters: the effect version has no
  // projection on the first frame, the gate reads unknown, SessionPane mounts once, subscribes to a absent session and fails.
  // The failed store then lives in the SessionDataLayer keep-warm for 30s with status error,
  // and the later acquire reuses it (refCount++, no connect) - exactly the dead pane this fixes.
  // The detail page tolerates a late frame (empty state first); this gate does not.
  const lease = useMemo(() => layer.acquire(tab.parentSessionId), [layer, tab.parentSessionId]);
  useEffect(() => () => lease.release(), [lease]);

  const snapshot = useConversationProjection(lease).snapshot;
  const gate = useMemo(
    () =>
      workflowActorStartState(snapshot?.workflowRuns?.runs, {
        runId: tab.runId,
        siteId: tab.siteId,
        ordinal: tab.ordinal,
        ...(tab.actorSessionId === undefined ? {} : { actorSessionId: tab.actorSessionId }),
      }),
    [snapshot?.workflowRuns, tab.actorSessionId, tab.ordinal, tab.runId, tab.siteId],
  );

  // unknown and started both subscribe as before: unknown is the norm after eviction/cold restore,
  // subscribing is the only way to the transcript, and real failures keep the existing error + manual retry panel.
  // A slot without a session id (tab opened from an unstarted pill) stays a placeholder; the gate reads the live projection and self-heals when the actor appears.
  if (gate.state === "notStarted" || gate.sessionId === undefined) {
    return <WorkflowActorNotStarted />;
  }

  return (
    <SessionPane
      paneId={tab.id}
      sessionId={gate.sessionId}
      readOnly
      allowWorkspaceFileRewind
      focused={focused}
      telemetryVisible={focused}
      workspacePath={tab.workspacePath}
      workspaceIdentity={tab.workspaceIdentity}
      remoteSessionId={tab.remoteSessionId}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenCodeViewer={onOpenCodeViewer}
      onOpenFileLink={onOpenFileLink}
    />
  );
});

/**
 * The transcript of one dwf actor instance.
 *
 * Composed as SubagentSessionSidePane: pane scope + nested read-only SessionPane. Apart from the not-started
 * gate there is no data logic here, which is exactly what turning actor sessions into real persisted sessions buys -
 * live streaming, cold restore and post-run review all ride the existing SessionPane chain.
 *
 * Two deliberate differences from the subagent pane:
 *
 * - no onOpenSubagentSession: the actor tool surface disables subagents (engine spec),
 *   there is no nested drill-down to click, so no entry is shown.
 * - no rootSessionId: an actor session is in no subagent tree; a made-up root would
 *   make this read-only pane subscribe to an unrelated session.
 */
export const WorkflowActorSessionSidePane = memo(function WorkflowActorSessionSidePane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowActorSessionContent
        tab={tab}
        focused={focused}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
