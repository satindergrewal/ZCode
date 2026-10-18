// ============================================================
// The situation snapshot's **subagent roster**: what each subagent is doing right now
// ============================================================
// One subagent = one actor instance, and its
// asks run sequentially by `actorSeq`, so "what it is doing now" = where its ask chain stands.
//
// Three sources, each with its own job, never standing in for each other:
//   - **actor rows / node rows** (journal): who exists, whether each ask succeeded, tokens spent. Rows are durable facts,
//     unbounded and never eaten by projection eviction.
//   - **reducer state**: the ask's task summary and progress readings (`instructionsHead` / `turn` / `toolCalls` /
//     `lastTool`) plus the node's phase coordinates -- those live only on events; rows carry no such columns.
//   - **event index**: every instant. See the -roster-events.ts header.

import type {
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunSubagentAsk,
  DynamicWorkflowRunSubagentState,
  DynamicWorkflowRunSubagentView,
} from "@zcode/contracts";
import type { ActorRecord, NodeRecord } from "@zcode/dynamic-workflow";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  instanceKey,
  laterOf,
  type RosterEventIndex,
  type RosterNodeTrace,
} from "./dynamic-workflow-run-roster-events.js";

/** A node row's not-yet-settled state; also the criterion for `unfinished` / `leftoverRunning`. */
export const NODE_ROW_RUNNING = "running";

/** The asks under one subagent, ascending `actorSeq` (legacy rows without the column sort first; order stable). */
function asksOf(
  nodes: readonly NodeRecord[],
  actor: Pick<ActorRecord, "siteId" | "ordinal">,
): NodeRecord[] {
  return nodes
    .filter((node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal)
    .sort((left, right) => (left.actorSeq ?? 0) - (right.actorSeq ?? 0));
}

/**
 * The roster, in actor-row order (= minting order). **Always returns an array**; no actors means an empty one:
 * "how many subagents does this run have" must always be answerable, and 0 is that answer.
 *
 * `pendingQuestions === undefined` means "this read cannot see the park table" (the run lives in another process); then
 * **no subagent is ever reported `parked`**, because "nobody waiting" and "unknown" cannot be told apart right now.
 */
export function buildSubagentViews(input: {
  actors: readonly ActorRecord[];
  nodes: readonly NodeRecord[];
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunSubagentView[] {
  const { actors, nodes, run, index, terminal, pendingQuestions } = input;
  const reduced = new Map<string, WorkflowRunNode>();
  for (const node of run?.nodes ?? []) reduced.set(instanceKey(node.siteId, node.ordinal), node);

  return actors.map((actor) => {
    const asks = asksOf(nodes, actor);
    const settled = asks.filter((ask) => ask.status !== NODE_ROW_RUNNING);
    // A subagent's asks are serial, so at most one is running; with several (should not happen), take the highest actorSeq --
    // the most recently dispatched.
    const runningAsk = asks.filter((ask) => ask.status === NODE_ROW_RUNNING).at(-1);
    const trace =
      runningAsk === undefined
        ? undefined
        : index.nodes.get(instanceKey(runningAsk.siteId, runningAsk.ordinal));
    const parkedOn = pendingQuestions?.find(
      (question) => question.actor === instanceKey(actor.siteId, actor.ordinal),
    )?.qid;
    const lastAskFailed = settled.at(-1)?.status === "failed";

    return {
      siteId: actor.siteId,
      ordinal: actor.ordinal,
      ...(actor.name === undefined ? {} : { name: actor.name }),
      state: subagentStateOf({
        terminal,
        running: runningAsk !== undefined,
        waiting: trace?.lastLifecycleType === "node-waiting",
        parked: parkedOn !== undefined,
        lastAskFailed,
      }),
      ...phaseNameField({ actor, runningAsk, settled, reduced, run }),
      ...(runningAsk === undefined ? {} : { currentAsk: currentAskOf(runningAsk, reduced, trace) }),
      ...(trace?.wait === undefined ? {} : { wait: trace.wait }),
      ...(parkedOn === undefined ? {} : { parkedOn }),
      stepsSettled: settled.length,
      stepsFailed: settled.filter((ask) => ask.status === "failed").length,
      // Count tokens from settled asks only; the in-flight one has no bill yet (`stats` is backfilled by the driver at settlement).
      tokens: settled.reduce((total, ask) => total + (ask.stats?.tokens ?? 0), 0),
      ...lastProgressField(asks, index),
    };
  });
}

/**
 * A subagent's situation. **The check order is this code's order**; the first match decides -- the order is part of the contract:
 * a subagent parked waiting for an answer is also "has an ask running"; reporting `executing` would hide the very thing that needs a human.
 */
function subagentStateOf(input: {
  terminal: boolean;
  running: boolean;
  waiting: boolean;
  parked: boolean;
  lastAskFailed: boolean;
}): DynamicWorkflowRunSubagentState {
  const { terminal, running, waiting, parked, lastAskFailed } = input;
  if (terminal) {
    // On a terminal run all three live words retire: a row still marked running only means the process died under it.
    if (running) return "unfinished";
    return lastAskFailed ? "failed" : "done";
  }
  if (parked) return "parked";
  if (running) return waiting ? "waiting" : "executing";
  return lastAskFailed ? "failed" : "idle";
}

/** The current ask's snapshot: identity from rows, task/progress from reducer state, instants from the event index. */
function currentAskOf(
  ask: NodeRecord,
  reduced: ReadonlyMap<string, WorkflowRunNode>,
  trace: RosterNodeTrace | undefined,
): DynamicWorkflowRunSubagentAsk {
  const node = reduced.get(instanceKey(ask.siteId, ask.ordinal));
  const lastTool = node?.lastTool;
  return {
    siteId: ask.siteId,
    ordinal: ask.ordinal,
    ...(ask.actorSeq === undefined ? {} : { actorSeq: ask.actorSeq }),
    ...(node?.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
    ...(trace?.dispatchedAt === undefined ? {} : { startedAt: trace.dispatchedAt }),
    ...(node?.turn === undefined ? {} : { turn: node.turn }),
    ...(node?.toolCalls === undefined ? {} : { toolCalls: node.toolCalls }),
    ...(lastTool === undefined
      ? {}
      : {
          lastTool: {
            name: lastTool.name,
            ...(lastTool.target === undefined ? {} : { target: lastTool.target }),
            ...(trace?.lastToolAt === undefined ? {} : { at: trace.lastToolAt }),
          },
        }),
  };
}

/**
 * The phase where its current (or last) ask was born; when neither ask can be read, fall back to the actor's own birth phase.
 * Phase coordinates live only in reducer state, so this queries reducer nodes, not rows.
 */
function phaseNameField(input: {
  actor: Pick<ActorRecord, "siteId" | "ordinal">;
  runningAsk: NodeRecord | undefined;
  settled: readonly NodeRecord[];
  reduced: ReadonlyMap<string, WorkflowRunNode>;
  run: WorkflowRunState | undefined;
}): Pick<DynamicWorkflowRunSubagentView, "phaseName"> {
  const { actor, runningAsk, settled, reduced, run } = input;
  const candidates = [runningAsk, settled.at(-1)];
  for (const ask of candidates) {
    if (ask === undefined) continue;
    const phaseName = reduced.get(instanceKey(ask.siteId, ask.ordinal))?.phaseName;
    if (phaseName !== undefined) return { phaseName };
  }
  const born = run?.actors.find(
    (entry) => entry.siteId === actor.siteId && entry.ordinal === actor.ordinal,
  )?.phaseName;
  return born === undefined ? {} : { phaseName: born };
}

/** The last moment it was seen moving: the latest progress-like event under any of its asks. */
function lastProgressField(
  asks: readonly NodeRecord[],
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunSubagentView, "lastProgressAt"> {
  let latest: number | undefined;
  for (const ask of asks) {
    latest = laterOf(latest, index.nodes.get(instanceKey(ask.siteId, ask.ordinal))?.lastActivityAt);
  }
  return latest === undefined ? {} : { lastProgressAt: latest };
}
