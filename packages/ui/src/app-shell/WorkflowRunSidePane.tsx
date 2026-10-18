import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunArtifactSummary,
  WorkflowRunPendingQuestion,
} from "@zcode/shared/zcode-protocol-v4";
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
import { WorkflowRunPaneSaveSlots } from "@/app-shell/WorkflowRunPaneSaveSlots.js";
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
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
  resolveWorkflowRunGraphForRun,
} from "@/v4/workflowRunCardJoin.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * Stable empty list: the pendingQuestions key comes and goes (one answer removes it whole), so the empty
 * reference must be stable or memoized children re-render for nothing every pass.
 */
const EMPTY_QUESTIONS: readonly WorkflowRunPendingQuestion[] = [];
/** Same idea: the artifacts key is absent at zero artifacts yet is a dependency of the artifact hook's journal re-query. */
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
  /** Superseded-by-run-X to the successor run's detail tab. */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** The spine's script row to the script transcript tab, anchored to that site. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  // The detail page re-subscribes the PARENT session's projection (mirroring PlanDetailSidePane): run state
  // is the parent's authoritative projection, not this pane's local query cache.
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // Workspace scope on the open request (actor / script / artifact / successor tabs all carry the same one).
  const { remoteSessionId, workspaceIdentity, workspacePath } = tab;
  const tabScope = useMemo(
    () => workflowRunTabScope({ remoteSessionId, workspaceIdentity, workspacePath }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );

  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  // A successor (run.supersededBy) opens only when projected AND carrying its own origin-row id: the open
  // request's toolCallId is the detail page's graph key; a wrong one lands on graph-not-in-history.
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

  // The static graph keys on the ORIGINATING toolCallId: the same table as the turn-end run card and the
  // script transcript, the CreateWorkflow tool row's or direct-launch turn's metadata, whichever carries the
  // graph. Row windows are bounded, so missing the origin row in old conversations is normal, not an error;
  // there is simply no graph to show. A Configure-revised run borrows its predecessor's graph until the
  // settings round lands (rules and rationale in resolveWorkflowRunGraph); a run with completions takes the
  // latest completion's valid script graph (docs/dynamic-workflow/presentation.md Holes on the timeline).
  const { graph, holeLabels } = useMemo(() => {
    const fills = buildWorkflowFillGraphByRunId(snapshot?.rows.window);
    const graphs = buildWorkflowGraphByToolCallId(snapshot?.rows.window);
    const runs = snapshot?.workflowRuns?.runs;
    return {
      graph: resolveWorkflowRunGraphForRun(graphs, fills, tab.toolCallId, tab.runId, runs),
      holeLabels: fills.get(tab.runId)?.holeLabels,
    };
  }, [snapshot?.rows.window, snapshot?.workflowRuns, tab.runId, tab.toolCallId]);

  // Direct-launch provenance: scope, note, args and the launched-from-hub note. Hub-launched runs only;
  // tool-path runs have no such section.
  const provenance = useMemo(
    () => resolveWorkflowLaunchProvenance(snapshot?.rows.window, tab.toolCallId),
    [snapshot?.rows.window, tab.toolCallId],
  );

  // One model, three consumers: the phase list and the summary row both derive from it.
  const model = useMemo(
    () => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run, holeLabels)),
    [graph, holeLabels, run],
  );
  // Subagent model: the status header's first row no longer carries a chip; the model name is the summary
  // row's leading span (that row was always this run's vital numbers). Strength and canonical id live in the tooltip.
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
  // The most recent rejected Cancel / Resume. Any run-status change (really cancelled, really resumed, or a
  // cold-replay settle arriving) invalidates the note and it is cleared on change, on CHANGE not on
  // differing-from-then: a status that comes full circle must not resurface the stale note either.
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
    // Cancellation has one path: the existing v4 cancelBackgroundWork {workId == runId}.
    void sendCommand(
      createCommandEnvelope({
        type: "cancelBackgroundWork",
        payload: { workId: tab.runId },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => recordAck("cancel", ack));
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId]);

  // Resume availability reads only the projection's resumable flag; after a restart the projection is
  // cold-replayed by the CLI, no extra journal summary query here.
  //
  // A second gray gate on top: existing runs render untouched, status header, timeline, artifacts all
  // present, with only Resume tucked away until pressing it would truly boot an engine. While the snapshot
  // is not ready, enabled is false and it reads as a miss: a late button beats one that can vanish.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  const resumable = isWorkflowRunResumable(run) && dynamicWorkflowEnabled;
  // Configure: same gray gate as Resume; once accepted the pane follows the workflow to the new run
  // (useWorkflowRunPaneSettings).
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
    // Resume is a new v4 command (no baseRevision, same family as cancel); workId == runId. name feeds
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
      // After acceptance the live projection flips back to running via run-started and the reducer strips
      // resumable, collapsing the button on its own.
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

  // Script transcript: isomorphic to the actor path; the row hands over the phase id and scope/run identity are filled here.
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

  // Landing: re-lands on every open. openedAt refreshes per open, so clicking the same site again changes the key and the list lands once more.
  const landing = useMemo(
    () =>
      tab.focusPhaseId === undefined
        ? undefined
        : { key: `${tab.focusPhaseId}@${tab.openedAt ?? 0}`, phaseId: tab.focusPhaseId },
    [tab.focusPhaseId, tab.openedAt],
  );

  // Artifacts. The live projection carries only latest-version metadata; spec and version history live in the
  // journal, so the hook reads both. With the run absent from the projection (cold restore / evicted by the
  // 8-run cap) there is no live list and the whole list comes from the journal.
  const { artifacts } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { live: run.artifacts ?? EMPTY_ARTIFACTS }),
  });
  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      // Cards emit intent only (which artifact); session and workspace identity are filled here, the same argument
      // as the actor path: cards never know scope. No version pin: open means latest.
      // This list merges live projection + journal, so both contentType and sourcePath are present: the former
      // lets the host open html artifacts straight into a browser tab, the latter saves a journal re-lookup.
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
      {/* Save / run-again (docs/dynamic-workflow/transcript-and-notifications.md Saving the run,
          and running it again): one controller with the completion card, so the same run says the same
          thing in both places. */}
      <WorkflowRunPaneSaveSlots rows={snapshot?.rows.window} run={run} tab={tab}>
        {(slots) => (
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
            saveSlots={slots}
            {...(subagentModel === undefined ? {} : { subagentModel })}
            summaryParts={summaryParts}
            title={runTitle}
            usage={run?.usage}
          />
        )}
      </WorkflowRunPaneSaveSlots>

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
       // Phase list: the timeline read as a vertical list, escalation questions indented under their asker.
       // Without a graph (old conversations miss the origin row) it says graph unavailable.
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
          {...(subagentModelProviderName === undefined ? {} : { subagentModelProviderName })}
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
       // Artifacts section: what the script delivered to the USER via artifact.*. The pane's last section and
       // expanded by default, it is the run's deliverables and the most common reason to open this pane.
       // Absent entirely while mounting; failed and cancelled runs render the same (a run that died at step
       // 12 may still have delivered a pdf). The report-entries, event-log and raw-script sections are gone:
       // technical detail, written for models and CLIs.
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
 * The workflow run's detail page.
 *
 * The detail page owns usage, controls and deliverables; the graph itself returned to the chat tool card and
 * this draws the same timeline model as a vertical list. It does NOT replicate the card's bounded display:
 * everything but the graph reads the authoritative workflowRuns projection, the artifact list reads the journal.
 *
 * The pane shows only what a USER needs. report entries, the event log and raw script sections are gone, they
 * served models and CLIs, not the human at this pane. The journal's read surface is untouched (event queries
 * and report rows remain); only their display here was removed.
 */
export const WorkflowRunSidePane = memo(function WorkflowRunSidePane({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  /** Subagent row to actor transcript tab; absent leaves the row inert. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** Artifact card to full-size viewer tab; absent leaves the card inert. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** Superseded-by-X to the successor's detail tab; absent leaves the row plain text. */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** Script row to the script transcript, anchored to the site; absent leaves the row inert. */
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
