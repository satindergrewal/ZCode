import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunArtifactSummary,
  WorkflowRunPendingQuestion,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowSubagentModelCardLabel } from "@/components/workflow-timeline/subagent-model-label.js";
import { workflowSummaryParts } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowRunArtifactsSection } from "@/app-shell/WorkflowRunArtifactsSection.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { WorkflowRunProvenance } from "@/app-shell/WorkflowRunProvenance.js";
import {
  WorkflowRunResultSections,
  WorkflowRunStatusHeader,
} from "@/app-shell/WorkflowRunSidePaneSections.js";
import {
  useWorkflowRunPaneSettings,
  workflowRunTabScope,
} from "@/app-shell/useWorkflowRunPaneSettings.js";
import { WorkflowRunSettingsPopover } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { resolveWorkflowLaunchProvenance } from "@/app-shell/workflowRunLaunchProvenance.js";
import {
  describeWorkflowRunActionRejection,
  workflowRunActionRejectionMessageId,
  type WorkflowRunAction,
  type WorkflowRunActionRejection,
} from "@/app-shell/workflowRunActionRejection.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  isWorkflowRunCancellable,
  isWorkflowRunResumable,
  workflowRunResultView,
  type WorkflowActorInstance,
} from "@/app-shell/workflowRunPanel.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useWorkflowRunArtifacts } from "@/hooks/useWorkflowRunArtifacts.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  buildWorkflowGraphByToolCallId,
  resolveWorkflowRunGraph,
} from "@/v4/workflowRunCardJoin.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * Stable empty list: the pendingQuestions key comes and goes (answering a question removes the
 * whole key), so the empty reference must be stable or memoized children re-render for nothing every
 * render.
 */
const EMPTY_QUESTIONS: readonly WorkflowRunPendingQuestion[] = [];
/** Same reasoning. The `artifacts` key is absent at zero artifacts, and it is one of the artifact hook's journal re-query dependencies. */
const EMPTY_ARTIFACTS: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowRunContent = memo(function WorkflowRunContent({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** "Superseded by run X" -> the successor run's detail tab. */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** The spine's script row -> script transcript tab, landed on that station. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  // The detail page re-subscribes to the **parent session's** projection (like PlanDetailSidePane):
  // running state is the parent session's authoritative projection, not this pane's local query
  // cache.
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // The workspace scope of the open request (actor / script / artifact / successor tabs all carry
  // the same one).
  const { remoteSessionId, workspaceIdentity, workspacePath } = tab;
  const tabScope = useMemo(
    () => workflowRunTabScope({ remoteSessionId, workspaceIdentity, workspacePath }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );

  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  // The successor (`run.supersededBy`) opens only when it is in the projection AND carries its own
  // launch-row id: the open request's toolCallId is the detail page's key to the graph -- a wrong one
  // lands the successor's page on "no such graph in history".
  const successor = useMemo(() => {
    const supersededBy = run?.supersededBy;
    if (supersededBy === undefined) return undefined;
    const candidate = snapshot?.workflowRuns?.runs.find((item) => item.runId === supersededBy);
    return candidate?.toolCallId === undefined ? undefined : candidate;
  }, [run?.supersededBy, snapshot?.workflowRuns]);
  const handleOpenSuccessor = useCallback(() => {
    if (successor?.toolCallId === undefined) return;
    onOpenWorkflowRun?.({
      ...tabScope,
      parentSessionId: tab.parentSessionId,
      toolCallId: successor.toolCallId,
      runId: successor.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
    });
  }, [onOpenWorkflowRun, successor, tab.parentSessionId, tab.workflowName, tabScope]);

  // The static graph is taken by **launch toolCallId**: the same table as the round-tail run card
  // and the script transcript -- whichever of the CreateWorkflow tool row or direct-launch round
  // carries the graph. The row window is bounded; not finding the launch row in an old conversation
  // is normal, not an error -- there is simply no graph to show.
  // A settings-amended run borrows its predecessor's graph until the settings round lands (rule and
  // rationale in resolveWorkflowRunGraph).
  const graph = useMemo<WorkflowCausalityGraphData | undefined>(
    () =>
      resolveWorkflowRunGraph(
        buildWorkflowGraphByToolCallId(snapshot?.rows.window),
        tab.toolCallId,
        snapshot?.workflowRuns?.runs,
      ),
    [snapshot?.rows.window, snapshot?.workflowRuns, tab.toolCallId],
  );

  // Direct-launch provenance: scope, description, args, and "started by you from the workflow hub".
  // Present only for hub-launched runs; tool-path runs have no such section.
  const provenance = useMemo(
    () => resolveWorkflowLaunchProvenance(snapshot?.rows.window, tab.toolCallId),
    [snapshot?.rows.window, tab.toolCallId],
  );

  // One model, three consumers: the phase list and summary row both derive from it.
  const model = useMemo(
    () => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run)),
    [graph, run],
  );
  // Subagent model: the status header's first row no longer carries a chip -- the model name became
  // the summary row's first segment (that row is already "this run's numbers"). Strength and spec
  // string go into the tooltip.
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    tab.workspacePath,
    tab.workspaceIdentity,
  );
  const subagentModel = useMemo(
    () =>
      workflowSubagentModelCardLabel(run?.subagentModel, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(subagentModelProviderName === undefined
          ? {}
          : { providerName: subagentModelProviderName }),
      }),
    [intl, run?.subagentModel, subagentModelProviderName],
  );
  const summaryParts = useMemo(
    () =>
      model === undefined || run === undefined
        ? undefined
        : workflowSummaryParts(
            intl.formatMessage.bind(intl),
            model,
            run,
            subagentModel === undefined ? {} : { subagentModelName: subagentModel.name },
          ),
    [intl, model, run, subagentModel],
  );

  const cancellable = isWorkflowRunCancellable(run);
  // The most recent rejected Cancel / Resume. Once run status changes (truly cancelled / truly
  // resumed / cold replay backfilled the settlement) the notice no longer applies and is cleared on
  // change -- "changed", not "different from back then": when status loops back to the original
  // value, the stale notice must not resurface either.
  const [rejection, setRejection] = useState<WorkflowRunActionRejection | undefined>(undefined);
  const runStatus = run?.status;
  useEffect(() => {
    setRejection(undefined);
  }, [runStatus]);
  const recordAck = useCallback(
    (action: WorkflowRunAction, ack: Parameters<typeof describeWorkflowRunActionRejection>[1]) => {
      const next = describeWorkflowRunActionRejection(action, ack);
      setRejection(next);
      if (next !== undefined) {
        logger.warn(`[workflow-run] ${action} rejected`, {
          reasonCode: ack.reasonCode,
          runId: tab.runId,
          status: ack.status,
        });
      }
    },
    [tab.runId],
  );
  const rejectionView = useMemo(() => {
    if (rejection === undefined) return undefined;
    return {
      text: intl.formatMessage(
        { id: workflowRunActionRejectionMessageId(rejection) },
        { code: rejection.code },
      ),
      ...(rejection.message === undefined ? {} : { detail: rejection.message }),
    };
  }, [intl, rejection]);

  const handleCancel = useCallback(() => {
    // Cancellation has exactly one path: the existing v4 cancelBackgroundWork {workId === runId}.
    void sendCommand(
      createCommandEnvelope({
        type: "cancelBackgroundWork",
        payload: { workId: tab.runId },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => recordAck("cancel", ack));
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId]);

  // Resume availability reads only the projection's `resumable` bit: after restart the projection is
  // backfilled by the CLI's cold replay; no separate journal summary query here.
  //
  // Plus one gradual-rollout gate: existing runs render as usual -- status header, timeline,
  // artifacts, everything -- with only Resume folded away, because pressing it truly boots an engine.
  // While the snapshot is not ready, enabled is false and it is treated as a miss: better a button
  // half a beat late than one that could vanish any moment.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  const resumable = isWorkflowRunResumable(run) && dynamicWorkflowEnabled;
  // "Configure": the same gradual-rollout gate as Resume; once accepted the pane follows the
  // workflow onto the new run (useWorkflowRunPaneSettings).
  const settings = useWorkflowRunPaneSettings({
    enabled: dynamicWorkflowEnabled,
    run,
    runs: snapshot?.workflowRuns?.runs,
    sendCommand,
    sessionConfig: snapshot?.sessionId === tab.parentSessionId ? snapshot?.config : undefined,
    tab,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
  });
  const handleResume = useCallback(() => {
    // resume is a new v4 command (no baseRevision, same class as cancel); workId === runId.
    // `name` feeds the restored completion notification's subject -- after restart the original tool
    // input is gone, and the tab's display name is the only surviving source.
    void sendCommand(
      createCommandEnvelope({
        type: "resumeWorkflowRun",
        payload: {
          workId: tab.runId,
          ...(tab.workflowName?.trim() ? { name: tab.workflowName.trim() } : {}),
        },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => {
      recordAck("resume", ack);
      // On acceptance the live projection flips back to running via run-started, the reducer strips
      // resumable, and the button retracts by itself.
    });
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId, tab.workflowName]);

  const handleOpenActor = useCallback(
    (instance: WorkflowActorInstance) => {
      onOpenWorkflowActorSession?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        ...(instance.sessionId ? { actorSessionId: instance.sessionId } : {}),
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        ...(instance.name ? { actorName: instance.name } : {}),
      });
    },
    [onOpenWorkflowActorSession, tab.parentSessionId, tab.runId, tabScope],
  );

  // Script transcript: isomorphic to actor; the row yields only the phase id, scope and run identity
  // are filled in here.
  const handleOpenWorkspace = useCallback(
    (phaseId: string) => {
      onOpenWorkflowWorkspace?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        toolCallId: tab.toolCallId,
        runId: tab.runId,
        ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
        phaseId,
      });
    },
    [
      onOpenWorkflowWorkspace,
      tab.parentSessionId,
      tab.runId,
      tab.toolCallId,
      tab.workflowName,
      tabScope,
    ],
  );

  // Landing: re-landed on every open -- `openedAt` refreshes per open, so clicking the same station
  // again changes the key and the list lands once more.
  const landing = useMemo(
    () =>
      tab.focusPhaseId === undefined
        ? undefined
        : { key: `${tab.focusPhaseId}@${tab.openedAt ?? 0}`, phaseId: tab.focusPhaseId },
    [tab.focusPhaseId, tab.openedAt],
  );

  // Artifacts. The live projection carries latest-version metadata only; spec and version history
  // live in the journal, so the hook reads both -- when `run` is absent from the projection (cold
  // recovery / evicted by the 8-run cap) `live` is absent and the whole list comes from the journal.
  const { artifacts } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { live: run.artifacts ?? EMPTY_ARTIFACTS }),
  });
  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      // The card emits intent only (which artifact); session and workspace identity are filled in
      // here -- the same argument as the actor transcript: the card is scope-unaware. **No version**:
      // opening means latest.
      //
      // This list is the live projection + journal merge, so both `contentType` and `sourcePath` are
      // available: the former lets the host open html artifacts directly as browser tabs, the latter
      // saves the host a journal lookup.
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
      });
    },
    [artifacts, onOpenWorkflowArtifact, tab.parentSessionId, tab.runId, tabScope],
  );

  const result = workflowRunResultView(run);
  const pendingQuestions = run?.pendingQuestions ?? EMPTY_QUESTIONS;
  const runTitle = tab.workflowName?.trim() || intl.formatMessage({ id: "sidePane.workflowRun" });

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-workflow-run-id={tab.runId}
      data-workflow-run-status={run?.status ?? "absent"}
    >
      <WorkflowRunStatusHeader
        cancellable={cancellable}
        configureOpen={settings.popover.open}
        onCancel={handleCancel}
        {...(settings.configurable ? { onConfigureFrom: settings.popover.toggleFrom } : {})}
        {...(onOpenWorkflowRun === undefined || successor === undefined
          ? {}
          : { onOpenSuccessor: handleOpenSuccessor })}
        onResume={handleResume}
        {...(rejectionView === undefined ? {} : { rejection: rejectionView })}
        resumable={resumable}
        run={run}
        {...(subagentModel === undefined ? {} : { subagentModel })}
        summaryParts={summaryParts}
        title={runTitle}
        usage={run?.usage}
      />

      {run === undefined || !settings.configurable ? null : (
        <WorkflowRunSettingsPopover
          anchorRef={settings.popover.anchorRef}
          host={settings.host}
          onAccepted={settings.onAccepted}
          onOpenChange={settings.popover.setOpen}
          open={settings.popover.open}
          run={run}
        />
      )}

      {provenance === undefined ? null : (
        <WorkflowRunProvenance
          meta={provenance.meta}
          {...(subagentModelProviderName === undefined
            ? {}
            : { providerName: subagentModelProviderName })}
          {...(provenance.startedAt === undefined ? {} : { startedAt: provenance.startedAt })}
        />
      )}

      <WorkflowRunResultSections result={result} />

      {/*
       * Phase list: the timeline read as a vertical list,
       *           with escalated questions under the asker's row. When the graph is unavailable (old
       *           conversations without the launch row) it says "graph unavailable".
       */}
      {graph !== undefined && model !== undefined ? (
        <WorkflowRunPhaseList
          graph={graph}
          model={model}
          pendingQuestions={pendingQuestions}
          run={run}
          {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenActor: handleOpenActor })}
          {...(onOpenWorkflowWorkspace === undefined
            ? {}
            : { onOpenWorkspace: handleOpenWorkspace })}
          {...(landing === undefined ? {} : { landing })}
        />
      ) : (
        <p
          className="flex-1 px-4 py-3 text-ui-xs text-foreground-subtle"
          data-testid="workflow-run-graph-unavailable"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.graph.unavailable" })}
        </p>
      )}

      {/*
       * Artifacts section: what the script delivered to the **user** via `artifact.*`. The pane's last
       *           section, expanded by default -- it is the run's deliverable and the most common
       *           reason to open this pane. Absent entirely when empty; failed and cancelled runs
       *           render the same (a run that died at step 12 may still have delivered a pdf). The
       *           `report` entries, event log, and script source sections are retired: technical
       *           detail whose readers are the model and CLI.
       */}
      {artifacts.length === 0 ? null : (
        <WorkflowRunArtifactsSection
          artifacts={artifacts}
          runId={tab.runId}
          sessionId={tab.parentSessionId}
          {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
        />
      )}
    </div>
  );
});

/**
 * The workflow run detail page.
 *
 * The detail page owns usage, controls, and deliverables; the graph itself returned to the chat's
 * tool card, and this renders the same timeline model as a vertical list. It does **not** replicate
 * the card's bounded display -- everything but the graph reads the authoritative `workflowRuns`
 * projection, and the artifact list reads the journal directly.
 *
 * The pane shows only what the **user** needs. The `report` entries, event log, and script source
 * sections are retired -- technical detail for the model and CLI, not the person at this pane. None
 * of the journal read surface changed (event queries and report rows remain); only their display
 * here was removed.
 */
export const WorkflowRunSidePane = memo(function WorkflowRunSidePane({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  /** Subagent row -> actor transcript tab. Absent means the row is not clickable. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** Artifact card -> full-size viewer tab. Absent means the card is not clickable. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** "Superseded by run X" -> successor run's detail tab. Absent renders that row as static text. */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** Script row -> script transcript tab, landed on that station. Absent means the row is not clickable. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
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
      <WorkflowRunContent
        tab={tab}
        {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenWorkflowActorSession })}
        {...(onOpenWorkflowWorkspace === undefined ? {} : { onOpenWorkflowWorkspace })}
        {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact })}
        {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
      />
    </V4PaneConversationProvider>
  );
});
