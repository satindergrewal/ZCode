// ============================================================
// Port situation cross-section → GetWorkflowRun output cross-section
// ============================================================
//
// Same-named, same-meaning fields both sides — still copied field by field, not passed through: the output schema is strict, and a
// new port field would fail the call at runtimeOutputSchema. Copying pins
// what the model face sees in one place; port evolution cannot change it behind the call.
//
// Optional fields, always `...(x === undefined ? {} : { x })`: explicit `undefined` and absence differ in
// `toEqual` and JSON serialization; the model-face contract is absent-means-no-key.

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentAsk,
  DynamicWorkflowRunSubagentView,
  DynamicWorkflowRunSubagentWait,
  GetWorkflowRunHealth,
  GetWorkflowRunPhase,
  GetWorkflowRunSubagent,
  GetWorkflowRunSubagentAsk,
} from "@zcode/contracts";
import { GET_WORKFLOW_RUN_ROSTER_LIMITS } from "@zcode/contracts";

export function toGetWorkflowRunPhases(
  phases: readonly DynamicWorkflowRunPhaseView[] | undefined,
): GetWorkflowRunPhase[] | undefined {
  // No phases declared, none entered ⇒ field absent (an empty array reads phases-table-empty).
  if (phases === undefined || phases.length === 0) return undefined;
  return phases.slice(0, GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases).map((phase) => ({
    name: phase.name,
    state: phase.state,
    rounds: phase.rounds,
    nodesSettled: phase.nodesSettled,
    nodesRunning: phase.nodesRunning,
    ...(phase.enteredAt === undefined ? {} : { enteredAt: phase.enteredAt }),
    ...(phase.exitedAt === undefined ? {} : { exitedAt: phase.exitedAt }),
  }));
}

/**
 * The roster truncates at {@link GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents} and says so:
 * a roster silently tens of rows short reads this-run-has-64 — a falsehood.
 */
export function toGetWorkflowRunSubagents(subagents: readonly DynamicWorkflowRunSubagentView[]): {
  subagents: GetWorkflowRunSubagent[];
  truncated: boolean;
} {
  const kept = subagents.slice(0, GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents);
  return {
    subagents: kept.map((subagent) => ({
      siteId: subagent.siteId,
      ordinal: subagent.ordinal,
      ...(subagent.name === undefined ? {} : { name: subagent.name }),
      state: subagent.state,
      ...(subagent.phaseName === undefined ? {} : { phaseName: subagent.phaseName }),
      ...(subagent.currentAsk === undefined
        ? {}
        : { currentAsk: toCurrentAsk(subagent.currentAsk) }),
      ...(subagent.wait === undefined ? {} : { wait: toWait(subagent.wait) }),
      ...(subagent.parkedOn === undefined ? {} : { parkedOn: subagent.parkedOn }),
      stepsSettled: subagent.stepsSettled,
      stepsFailed: subagent.stepsFailed,
      tokens: subagent.tokens,
      ...(subagent.lastProgressAt === undefined ? {} : { lastProgressAt: subagent.lastProgressAt }),
    })),
    truncated: kept.length < subagents.length,
  };
}

function toCurrentAsk(ask: DynamicWorkflowRunSubagentAsk): GetWorkflowRunSubagentAsk {
  return {
    siteId: ask.siteId,
    ordinal: ask.ordinal,
    ...(ask.actorSeq === undefined ? {} : { actorSeq: ask.actorSeq }),
    ...(ask.instructionsHead === undefined ? {} : { instructionsHead: ask.instructionsHead }),
    ...(ask.startedAt === undefined ? {} : { startedAt: ask.startedAt }),
    // Absent turn / toolCalls reads unknown; `0` reads none-ever — old journals
    // lack node-progress; the two must stay distinguishable, hence never `?? 0`.
    ...(ask.turn === undefined ? {} : { turn: ask.turn }),
    ...(ask.toolCalls === undefined ? {} : { toolCalls: ask.toolCalls }),
    ...(ask.lastTool === undefined
      ? {}
      : {
          lastTool: {
            name: ask.lastTool.name,
            ...(ask.lastTool.target === undefined ? {} : { target: ask.lastTool.target }),
            ...(ask.lastTool.at === undefined ? {} : { at: ask.lastTool.at }),
          },
        }),
  };
}

function toWait(wait: DynamicWorkflowRunSubagentWait): NonNullable<GetWorkflowRunSubagent["wait"]> {
  return {
    cause: wait.cause,
    ...(wait.reason === undefined ? {} : { reason: wait.reason }),
    ...(wait.retryAfterMs === undefined ? {} : { retryAfterMs: wait.retryAfterMs }),
    ...(wait.since === undefined ? {} : { since: wait.since }),
  };
}

export function toGetWorkflowRunHealth(health: DynamicWorkflowRunHealth): GetWorkflowRunHealth {
  return {
    ...(health.lastProgressAt === undefined ? {} : { lastProgressAt: health.lastProgressAt }),
    ...(health.stalledSince === undefined ? {} : { stalledSince: health.stalledSince }),
    ...(health.concurrency === undefined
      ? {}
      : {
          concurrency: {
            effective: health.concurrency.effective,
            cap: health.concurrency.cap,
            ...(health.concurrency.reason === undefined
              ? {}
              : { reason: health.concurrency.reason }),
            ...(health.concurrency.since === undefined ? {} : { since: health.concurrency.since }),
          },
        }),
    consecutiveFailures: health.consecutiveFailures,
    cachedSteps: health.cachedSteps,
    // 0 → absent: no leftovers is the terminal norm; `leftover_running=0` reads like an event.
    ...(health.leftoverRunning === undefined || health.leftoverRunning === 0
      ? {}
      : { leftoverRunning: health.leftoverRunning }),
    pendingQuestionsKnown: health.pendingQuestionsKnown,
  };
}
