// Save / run-again wiring for the run side pane's status header
// (docs/dynamic-workflow/transcript-and-notifications.md "Saving the run, and running it again").
//
// Shares one controller with the completion card (mounted via WorkflowRunSaveSlotsBoundary) so the same run
// says the same thing in both places. The side pane adds two things: candidates build from the PARENT
// session's row window, and the user message is sent into the parent session. This file only builds the host
// descriptor and never calls the slots hook directly; the controller must query the agent, and a host without
// service context must not mount it. Split out of WorkflowRunSidePane.tsx (max-lines 400 gate).
import { useCallback, useMemo, type ReactNode } from "react";
import type { ConversationRow, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  WorkflowRunSaveSlotsBoundary,
  type WorkflowRunSaveSlots,
  type WorkflowRunSaveSlotsHost,
} from "@/components/workflow-timeline/WorkflowRunSaveControls.js";
import type { WorkflowRunSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { buildWorkflowSaveCandidatesByRunId } from "@/v4/workflowRunCardJoin.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

interface WorkflowRunPaneSaveParams {
  /** Parent session row window: SaveWorkflow candidates that claimed this run in the transcript read from here. */
  rows: readonly ConversationRow[] | undefined;
  run: WorkflowRunState | undefined;
  tab: WorkflowRunSidePaneTab;
}

/** The side pane status header's two slots: build the host descriptor and mount the controller via the service boundary (null without service context). */
export function WorkflowRunPaneSaveSlots({
  children,
  ...params
}: WorkflowRunPaneSaveParams & {
  children: (slots: WorkflowRunSaveSlots | null) => ReactNode;
}) {
  const host = useWorkflowRunPaneSaveHost(params);
  return <WorkflowRunSaveSlotsBoundary host={host}>{children}</WorkflowRunSaveSlotsBoundary>;
}

function useWorkflowRunPaneSaveHost(params: WorkflowRunPaneSaveParams): WorkflowRunSaveSlotsHost {
  const { rows, run, tab } = params;
  // Gray-release gate (docs/dynamic-workflow/launch.md "Gray release"), the same one as Resume; commands
  // travel the session connection this pane lives on (same sendCommand as Stop / Resume).
  const { enabled } = useDynamicWorkflowAvailability();
  const { sendCommand } = useV4Conversation();
  const candidates = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(rows).get(tab.runId),
    [rows, tab.runId],
  );
  const sendLead = useCallback(
    async (text: string) => {
      // Sent into the PARENT session: this run is an event of that conversation, so the distill-and-save round lands there too.
      const ack = await sendCommand(
        createCommandEnvelope({
          type: "sendText",
          payload: { text },
          sessionId: tab.parentSessionId,
        }),
      );
      if (ack.status !== "accepted") {
        logger.warn("[workflow-run] distill-save message rejected by ZCode", {
          reasonCode: ack.reasonCode ?? null,
          runId: tab.runId,
          status: ack.status,
        });
        // Rethrow into the dialog: it stays put and re-enables the button instead of pretending the handoff happened.
        throw new Error(ack.reasonCode ?? ack.status);
      }
    },
    [sendCommand, tab.parentSessionId, tab.runId],
  );
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity === undefined ? {} : { workspaceIdentity: tab.workspaceIdentity }),
    ...(tab.remoteSessionId === undefined ? {} : { remoteSessionId: tab.remoteSessionId }),
    runId: tab.runId,
    // Name is the display name frozen on the tab: with the projection missing (run evicted / cold start) it is the only source left.
    ...(tab.workflowName?.trim() ? { runName: tab.workflowName.trim() } : {}),
    ...(candidates === undefined ? {} : { candidates }),
    // The verb is for completed runs only: saved means this run produced something worth keeping, a running
    // run cannot conclude that. The chip ignores this gate: it reports whether the file exists on disk.
    canSave: enabled && run?.status === "completed",
    sendLead,
    // Every status-header button carries a word (Configure / Resume / Stop); so does this one.
    verbWord: "never",
  };
}
