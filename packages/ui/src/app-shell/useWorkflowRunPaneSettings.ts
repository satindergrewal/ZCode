// ============================================================
// The detail page's Configure popover
// ============================================================
// Split out of WorkflowRunSidePane.tsx (max-lines gate): popover host, toggle and anchor, plus the
// post-Apply follow-the-workflow behavior, once the new run enters the projection this tab is swapped
// in place for the new run's tab (same position, same name, no re-expanding a collapsed sidebar).
// The wait is on the new run appearing in the projection, never a timeout.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionConfigState, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  useWorkflowRunSettingsPopoverState,
  type WorkflowRunSettingsAccepted,
  type WorkflowRunSettingsHost,
} from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import {
  isWorkflowRunConfigurable,
  workflowSessionModelOf,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { useV4Conversation } from "@/v4/V4ConversationContext.js";

/** The run tab's workspace scope: carried verbatim when opening other tabs (actor, script, artifact, successor). */
export function workflowRunTabScope(
  tab: Pick<WorkflowRunSidePaneTab, "workspacePath" | "workspaceIdentity" | "remoteSessionId">,
): Pick<
  OpenScopedWorkflowRunSideTabRequest,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId"
> {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
  };
}

export function useWorkflowRunPaneSettings({
  enabled,
  onOpenWorkflowRun,
  run,
  runs,
  sendCommand,
  sessionConfig,
  tab,
}: {
  /** Gray-release gate (same one as Resume). */
  enabled: boolean;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  run: WorkflowRunState | undefined;
  runs: readonly WorkflowRunState[] | undefined;
  sendCommand: ReturnType<typeof useV4Conversation>["sendCommand"];
  sessionConfig: SessionConfigState | undefined;
  tab: WorkflowRunSidePaneTab;
}) {
  const configurable = enabled && isWorkflowRunConfigurable(run);
  const popover = useWorkflowRunSettingsPopoverState();
  // When the run becomes non-configurable while the popover is open (completed, superseded) the popover
  // unmounts and the toggle must close with it, or it would pop back up on the next configurable state.
  // setOpen(false) is a noop when already closed; no update loop.
  const { setOpen } = popover;
  useEffect(() => {
    if (!configurable) setOpen(false);
  }, [configurable, setOpen]);
  const sessionModel = useMemo(() => workflowSessionModelOf(sessionConfig), [sessionConfig]);
  const host = useMemo<WorkflowRunSettingsHost>(
    () => ({
      ...workflowRunTabScope(tab),
      ...(sessionModel === undefined ? {} : { sessionModel }),
      // Same family as Stop / Resume: no baseRevision, workId == runId.
      apply: (change) =>
        sendCommand(
          createCommandEnvelope({
            type: "amendWorkflowRunSettings",
            payload: { workId: tab.runId, ...change },
            sessionId: tab.parentSessionId,
          }),
        ),
    }),
    [
      sendCommand,
      sessionModel,
      tab.parentSessionId,
      tab.remoteSessionId,
      tab.runId,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );

  // Follow-through: at acceptance the new run may not be in the projection yet (run-started comes later),
  // so record the intent and swap the tab when it appears.
  const [follow, setFollow] = useState<WorkflowRunSettingsAccepted | undefined>(undefined);
  // An in-place revision (concurrency cap only, run still in flight: docs/dynamic-workflow/concurrency.md)
  // has no successor; the result's runId is this tab's own run. Nothing to follow, recording it would only
  // ask to swap the tab to itself.
  const onAccepted = useCallback(
    (accepted: WorkflowRunSettingsAccepted) => {
      if (accepted.runId !== tab.runId) setFollow(accepted);
    },
    [tab.runId],
  );
  const successorArrived =
    follow !== undefined && (runs ?? []).some((candidate) => candidate.runId === follow.runId);
  useEffect(() => {
    if (follow === undefined || !successorArrived) return;
    setFollow(undefined);
    onOpenWorkflowRun?.({
      ...workflowRunTabScope(tab),
      parentSessionId: tab.parentSessionId,
      toolCallId: follow.toolCallId,
      runId: follow.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
      replaceRunId: tab.runId,
    });
  }, [
    follow,
    onOpenWorkflowRun,
    successorArrived,
    tab.parentSessionId,
    tab.remoteSessionId,
    tab.runId,
    tab.workflowName,
    tab.workspaceIdentity,
    tab.workspacePath,
  ]);

  return {
    configurable,
    host,
    onAccepted,
    popover,
  };
}
