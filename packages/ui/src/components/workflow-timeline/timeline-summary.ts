import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { workflowSubagentModelCardLabel } from "./subagent-model-label.js";
import type { WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Copy material for the card header detail and footer summary line. The sidebar status header's summary reads here too — one run, one sentence on every surface.
 *
 * Pure functions + injected formatMessage: this repo's slim intl has no ICU plurals, so singular/plinal take distinct keys.
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface TimelineCounts {
  phases: number;
  /** Distinct subagent lanes (synthetic lanes excluded). */
  agents: number;
  steps: number;
}

export function timelineCounts(
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): TimelineCounts {
  const lanes = new Set<string>();
  for (const station of model.stations) {
    for (const pill of station.pills) if (pill.laneClass === "agent") lanes.add(pill.lane.id);
  }
  // Drafts draw no pills; the scanner supplies the agent count directly.
  const agents = model.draft?.agents ?? lanes.size;
  return { agents, phases: model.stations.length, steps: graph?.steps.length ?? 0 };
}

/** Highest round reached by a looped station; 0 without a loop or before first arrival. */
export function timelineRounds(model: WorkflowTimelineModel): number {
  let rounds = 0;
  for (const station of model.stations) {
    if (station.onLoop && station.rounds > rounds) rounds = station.rounds;
  }
  return rounds;
}

function count(format: FormatMessage, one: string, many: string, value: number): string {
  return format({ id: value === 1 ? one : many }, { count: value.toLocaleString() });
}

/**
 * The confirm dialog's header right side names phases only — agent and step counts are
 * visible in the timeline below; repeating them up top is noise.
 */
export function workflowPhasesDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): string {
  const counts = timelineCounts(model, graph);
  // 还开着的留白不算阶段（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：「2 个阶段 · 2 处留白」。
  const holes = model.stations.filter(
    (station) => station.hole !== undefined && station.hole.state !== "filled",
  ).length;
  const phases = count(
    format,
    "chat.toolCall.workflow.card.phase",
    "chat.toolCall.workflow.card.phases",
    counts.phases - holes,
  );
  return holes === 0
    ? phases
    : `${phases} · ${count(format, "chat.toolCall.workflow.card.hole", "chat.toolCall.workflow.card.holes", holes)}`;
}

/** The subagents segment: while running count workers, when finished the total (max of projection and static graph). */
function agentsPart(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  run: WorkflowRunState | undefined,
): string {
  if (run !== undefined && (run.status === "pending" || run.status === "running")) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    return count(
      format,
      "chat.toolCall.workflow.card.agentWorking",
      "chat.toolCall.workflow.card.agentsWorking",
      working,
    );
  }
  const agents = Math.max(run?.actors.length ?? 0, timelineCounts(model, undefined).agents);
  return count(
    format,
    "chat.toolCall.workflow.card.agent",
    "chat.toolCall.workflow.card.agents",
    agents,
  );
}

/**
 * Card header right detail: **phase and subagent counts only** (no "steps" on the card).
 * While drafting/pending, static-graph counts; once joined to a run, phases stay and
 * subagents become "n working" (running) or the total (finished). Steps, tokens, rounds,
 * and artifacts left the header — they live in the run detail's summary row
 * (`workflowSummaryParts`).
 */
export function workflowHeaderDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /**
   * Subagent model name (resolved, see subagent-model-label.ts): the detail already says
   * how many subagents; the model name trails as the final muted segment — no chip, no
   * prefix. Level and canonical string stay in the tooltip. Absent when the run never
   * set a model.
   */
  subagentModelName?: string,
): string {
  const parts = [workflowPhasesDetail(format, model, graph), agentsPart(format, model, run)];
  if (subagentModelName !== undefined) {
    parts.push(subagentModelName);
  }
  return parts.join(" · ");
}

/**
 * Header detail string + tooltip, computed once: both cards (v4 tail digest, legacy host
 * run card) must agree, so "include the model?" and "what goes in the tooltip" have
 * exactly one implementation here. Absent entirely when no timeline model builds.
 */
export function workflowCardDetail(
  format: FormatMessage,
  model: WorkflowTimelineModel | undefined,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /** providerId -> provider name; missing falls back to the bare modelId (never show the provider id). */
  providerName?: (providerId: string) => string | undefined,
): { detail: string; title?: string } | undefined {
  if (model === undefined) {
    return undefined;
  }
  const subagentModel = workflowSubagentModelCardLabel(run?.subagentModel, {
    formatMessage: format,
    ...(providerName === undefined ? {} : { providerName }),
  });
  return {
    detail: workflowHeaderDetail(format, model, graph, run, subagentModel?.name),
    ...(subagentModel === undefined ? {} : { title: subagentModel.title }),
  };
}

/**
 * Run detail summary segments: `1 agent working - 4/7 steps - 42,118 tokens - round 2`;
 * terminal states switch to `3 agents - 11/11 steps - ... - 3 rounds - 2 artifacts`.
 * Strings only; the renderer draws separators. The last segment counts **artifacts**
 * (outputs delivered via `artifact.*`), not `report` entries: the Results section is
 * gone and "results" has no home on screen.
 * Chat cards (tool footer, tail digest) no longer use it — cards speak phases and
 * subagents only (`workflowHeaderDetail`); the run detail page is the last reader.
 */
export function workflowSummaryParts(
  format: FormatMessage,
  model: WorkflowTimelineModel,
  run: WorkflowRunState,
  options: {
    tokens?: boolean;
    /**
     * Subagent model name (resolved, see subagent-model-label.ts): when present it is the
     * summary's **first** segment — this row is "this run's numbers", and the model is its
     * first word. Hence no model chip in the status header.
     */
    subagentModelName?: string;
  } = {},
): string[] {
  const parts: string[] = [];
  if (options.subagentModelName !== undefined) {
    parts.push(
      format(
        { id: "chat.toolCall.workflow.run.subagentModel.label" },
        { model: options.subagentModelName },
      ),
    );
  }
  const active = run.status === "pending" || run.status === "running";
  if (active) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.agentWorking",
        "chat.toolCall.workflow.card.agentsWorking",
        working,
      ),
    );
  } else {
    const agents = Math.max(run.actors.length, timelineCounts(model, undefined).agents);
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.agent",
        "chat.toolCall.workflow.card.agents",
        agents,
      ),
    );
  }
  // Step counts come from the single @zcode/shared implementation: tabulated plus
  // unlisted (instances past the cap still count).
  const { settled, total } = workflowRunStepCounts(run);
  parts.push(format({ id: "chat.toolCall.workflow.card.steps" }, { done: settled, total }));
  if (options.tokens !== false) {
    parts.push(
      format(
        { id: "chat.toolCall.workflow.card.tokens" },
        { count: run.usage.spentTokens.toLocaleString() },
      ),
    );
  }
  const rounds = timelineRounds(model);
  if (rounds >= 2) {
    parts.push(
      active
        ? format({ id: "chat.toolCall.workflow.card.round" }, { count: rounds })
        : format({ id: "chat.toolCall.workflow.card.rounds" }, { count: rounds }),
    );
  }
  const artifacts = run.artifacts?.length ?? 0;
  if (artifacts > 0) {
    parts.push(
      count(
        format,
        "chat.toolCall.workflow.card.artifact",
        "chat.toolCall.workflow.card.artifacts",
        artifacts,
      ),
    );
  }
  return parts;
}
