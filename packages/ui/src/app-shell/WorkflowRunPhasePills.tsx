import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type {
  TimelinePill,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";
import { pillActivity } from "@/components/workflow-timeline/timeline-pill-activity.js";
import { pillInstanceKey } from "@/components/workflow-timeline/roster-model.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  SpinePillTrailer,
  type useWorkflowActorModelLabels,
} from "@/app-shell/WorkflowRunSpineParts.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";

/**
 * Wiring for the pills on the detail page's spine (docs/dynamic-workflow/presentation.md "The spine").
 * Split out of WorkflowRunPhaseList.tsx (max-lines gate): that file owns section open/close, anchoring and
 * spacing; pill naming, opening, and the tail slot live here. Pure function factory: the list calls it once
 * per frame to get three closures; no state of its own.
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface PhasePillRenderers {
  nameOf: (pill: TimelinePill) => string;
  pillProps: (pill: TimelinePill) => Parameters<typeof WorkflowAgentPill>[0];
  renderPill: (pill: TimelinePill) => JSX.Element;
}

export function phasePillRenderers({
  actorModels,
  format,
  graph,
  model,
  now,
  onOpenActor,
  onOpenWorkspace,
  questionsByInstance,
  run,
}: {
  model: WorkflowTimelineModel;
  graph: WorkflowCausalityGraphData;
  run: WorkflowRunState | undefined;
  format: FormatMessage;
  actorModels: ReturnType<typeof useWorkflowActorModelLabels>;
  questionsByInstance: ReadonlyMap<string, WorkflowRunPendingQuestion[]>;
  now: number;
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  onOpenWorkspace?: (phaseId: string) => void;
}): PhasePillRenderers {
  const pillKey = pillInstanceKey;
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const phaseNameOf = (phaseId: string) => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };

  // The row hands over slot identity: session id included when present, else a placeholder tab opens.
  const openActor = (pill: TimelinePill) => {
    const slot = pill.slot;
    if (onOpenActor === undefined || slot === undefined) return;
    const sessionId = pill.instance?.sessionId;
    onOpenActor({
      ordinal: slot.ordinal,
      ...(sessionId === undefined ? {} : { sessionId }),
      siteId: slot.siteId,
      status:
        pill.status === "running"
          ? "running"
          : pill.status === "done" || pill.status === "failed"
            ? "completed"
            : "waiting",
      ...(pill.runtimeName === undefined ? {} : { name: pill.runtimeName }),
    });
  };

  /** Shared pill wiring (name, status, openability); used by both the per-row pill and the dense list-all pills. */
  const pillProps = (pill: TimelinePill) => {
    const label = nameOf(pill);
    const openable = onOpenActor !== undefined && pill.slot !== undefined;
    // Same open grammar as the script row: open the whole run's script transcript, anchored to this site's first card.
    const workspacePhaseId = onOpenWorkspace === undefined ? undefined : pill.workspace?.phaseId;
    const open: WorkflowAgentPillOpen | undefined = openable
      ? {
          data: {
            "data-agent-key": pillKey(pill) ?? "",
            "data-agent-session-id": pill.instance?.sessionId ?? "",
            "data-agent-status": pill.status ?? "pending",
          },
          label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
          onOpen: () => openActor(pill),
          testId: "workflow-run-agent-open",
        }
      : workspacePhaseId !== undefined
        ? {
            data: { "data-phase-id": workspacePhaseId },
            label: format(
              { id: "chat.toolCall.workflow.timeline.openScript" },
              { phase: phaseNameOf(workspacePhaseId) },
            ),
            onOpen: () => onOpenWorkspace?.(workspacePhaseId),
            testId: "workflow-run-workspace-open",
          }
        : undefined;
    const actorModel = actorModels.get(pillKey(pill) ?? "");
    return {
      avatarIndex: pill.avatarIndex,
      laneClass: pill.laneClass,
      name: label,
      status: pill.status,
      title: actorModel === undefined ? label : `${label}\n${actorModel.canonical}`,
      ...(open === undefined ? {} : { open }),
    };
  };

  const renderPill = (pill: TimelinePill) => {
    const activity = pillActivity(graph, run, pill);
    const key = pillKey(pill);
    const questions = key === undefined ? [] : (questionsByInstance.get(key) ?? []);
    const counts: string[] = [];
    if (activity.asks > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.tasks" }, { count: activity.asks }),
      );
    }
    if (activity.reads > 0) {
      counts.push(
        format({ id: "chat.toolCall.workflow.graph.card.reads" }, { count: activity.reads }),
      );
    }
    // Openable pills are <button>: inside a block parent it only wraps its content, so row widths vary with name length.
    // A column flex container stretches every row to the full column width (same mechanism as the pill column under cards).
    return (
      <div className="flex min-w-0 flex-col" key={pill.key}>
        <WorkflowAgentPill {...pillProps(pill)}>
          <SpinePillTrailer counts={counts} modelName={actorModels.get(key ?? "")?.name} />
        </WorkflowAgentPill>
        {/* Questions indent under their asker, one step further (26px): they belong to the row, not the site. */}
        {questions.map((question) => (
          <WorkflowRunQuestionRow
            className="ml-[26px]"
            key={question.qid}
            now={now}
            question={question}
          />
        ))}
      </div>
    );
  };

  return { nameOf, pillProps, renderPill };
}
