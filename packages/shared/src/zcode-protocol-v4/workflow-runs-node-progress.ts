// ============================================================
// One ask's **task and progress readings**: node-queued's instructionsHead plus node-progress' three counters
// ============================================================
// Outside the main reducer for the same reason as workflow-runs-phases.ts: the main file's max-lines gate.
//
// These keys answer what phases cannot: an ask can sit on `executing` for ten minutes, and the phase alone cannot tell
// "long job in progress" from "already dead". `turn` / `toolCalls` / `lastTool` are that line,
// and `instructionsHead` answers "what was this subagent sent to do".
//
// Two structural facts easy to trip on:
//   1. The reduction **rebuilds** the node object whole on every `node-*` event (only kind / actor ref / phaseName ride
//      forward via previousNode). These four keys must therefore be carried explicitly--or the next
//      node-progress lifecycle event wipes the readings just landed.
//   2. An ask has **two** birth events: `node-queued`, and the `node-settled { cached: true }` emitted directly on replay
//      hits (that node has no queued; it is the birth event--verbatim the same precedent as phaseName in the main file).
//      The same site instance re-queued during a resume is a brand-new ask, rounds restarting at 1; a cache-hit settle never ran at all.
//      So **birth events clear** the previous life's three counters rather than inherit them--inheritance would show a node that
//      took no step this life as "round 9, 40 tool calls", exactly the artifact these readings exist to rule out.
//      calls"--exactly the artifact these readings exist to rule out.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunNodeLastTool,
  type WorkflowRunState,
} from "./workflow-runs.js";

/** One ask's task/progress readings--the four keys this module owns. */
type NodeProgressFields = Pick<
  WorkflowRunNode,
  "instructionsHead" | "turn" | "toolCalls" | "lastTool"
>;

/**
 * The four keys' values across lifecycle events (`node-queued` ... `node-settled`).
 *
 * The three counters only carry forward (written by {@link reduceNodeProgress}) and are **cleared on both birth events**--see header
 * fact 2. `instructionsHead` arrives only on the `node-queued` payload (the instructions then are the author's original text;
 * the engine footer is appended by the driver later); other events carry it forward.
 *
 * Task summary and the three counters are **deliberately out of sync** on cache-hit settles: the completion cache hits by input hash, so that
 * ask's instructions are verbatim the previous life's and inheriting the summary says the same thing; the counters instead describe an execution
 * that **did not happen this life**. A re-queue trusts only the new payload for the summary too: possibly a revised instruction.
 */
export function carryNodeProgress(
  eventType: string,
  payload: Record<string, unknown>,
  previousNode: WorkflowRunNode | undefined,
): Partial<NodeProgressFields> {
  const requeued = eventType === "node-queued";
  const born = requeued || (eventType === "node-settled" && payload.cached === true);
  const carried = born ? undefined : previousNode;
  const head = boundedText(
    payload.instructionsHead,
    WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength,
  );
  const instructionsHead = requeued ? head : (head ?? previousNode?.instructionsHead);
  return {
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
    ...(carried?.turn === undefined ? {} : { turn: carried.turn }),
    ...(carried?.toolCalls === undefined ? {} : { toolCalls: carried.toolCalls }),
    ...(carried?.lastTool === undefined ? {} : { lastTool: carried.lastTool }),
  };
}

/**
 * The `node-progress` reduction: one resolved round's readings land on the **already-tabled** node.
 *
 * **Touches only these three keys**--no phase, no step count, no actor state: a round resolving is not a lifecycle transition;
 * the phase stays governed by the `node-executing` / `node-waiting` events. Instances not in the table (cap-rejected,
 * or progress preceding their `node-queued`) are ignored whole, no entry created--the same family as other node events' unknown instances.
 *
 * An unreadable single field **keeps the known value** instead of wiping: an event carrying only toolCalls must not erase the round count.
 * Writes are last-wins, not max (the opposite of `phases[].rounds`); rationale in header fact 2.
 */
export function reduceNodeProgress(
  run: WorkflowRunState,
  ref: { siteId: string; ordinal: number },
  payload: Record<string, unknown>,
): WorkflowRunState {
  const index = run.nodes.findIndex(
    (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
  );
  if (index < 0) return run;
  const node = run.nodes[index]!;
  const turn = readPositiveInt(payload.turn) ?? node.turn;
  const toolCalls = readNonNegativeInt(payload.toolCalls) ?? node.toolCalls;
  const lastTool = readLastTool(payload.lastTool) ?? node.lastTool;
  const nodes = [...run.nodes];
  nodes[index] = {
    ...node,
    ...(turn === undefined ? {} : { turn }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(lastTool === undefined ? {} : { lastTool }),
  };
  return { ...run, nodes };
}

/** Rounds are 1-based positive integers: there is no "round 0"; 0 / fractions / NaN all count as unreadable. */
function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Tool-call count may be 0--"called no tool" is a fact, not an absence. */
function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The tool name is the record's reason to exist; unreadable drops the whole entry (only target's lastTool can say nothing). */
function readLastTool(value: unknown): WorkflowRunNodeLastTool | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = boundedText(record.name, WORKFLOW_RUNS_LIMITS.maxLastToolNameLength);
  if (name === undefined) return undefined;
  const target = boundedText(record.target, WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength);
  return { name, ...(target === undefined ? {} : { target }) };
}

/**
 * Clip to the wire caps; empty string counts as absent.
 *
 * The producer side already clipped (the engine's `INSTRUCTIONS_HEAD_MAX_CHARS` / `LAST_TOOL_TARGET_MAX_CHARS`);
 * this is the second gate, kin of `boundedActorName` / `boundedPhaseName` for the same reason: an over-cap string would make the renderer
 * reject every later frame of the parent session. **Hard truncate, no ellipsis**--
 * the summary is a head; continuation markers are renderer business; this layer guarantees validity only.
 */
function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, limit);
  return text.length > 0 ? text : undefined;
}
