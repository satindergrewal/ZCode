// ============================================================
// Driver-side tool-activity observation: subagent about to mutate the workspace -> engine closes the import cache
// ============================================================
// Same posture as workflow-driver-concurrency.ts's model-activity face: read the actor runtime's session event stream, never touch turn
// orchestration. One event matters here -- `ToolCallStarted`, emitted by the executor after the permission verdict and before the handler acts, its payload carrying
// argument-derived `readOnly` / `sideEffectScope` (Bash's read-only determination is settled). The test is contracts'
// `isWorkspaceMutatingToolCall`; the same payload also counts world-touching calls via `isWorldTouchingToolCall`,
// which decides whether a cache entry counts as pure (below).
//
// The same subscription also **counts** this ask's tool calls (total and writes): AskStats needs it and
// `TurnResult.events` carries no tool events -- counting there, `toolCalls` is constant 0 (measured: all 2097 ask rows
// in the production journal, including subagents that clearly wrote files). The count resets at startAsk and accumulates across repair / nudge rounds,
// so the final askStats reports the ask's full total.
//
// The two counts differ: `toolCalls` is every call (an honest audit face); `worldToolCalls` counts only calls that saw or touched the outside world
// -- protocol tools (`submit_result`, `escalate`) excluded, or every typed ask would look world-touching just by delivering its result
// and the pure-ask exemption would never apply.
//
// At most one closing report per ask: engine-side closing is idempotent; fewer reports just save event traffic. Reset on ask change.
//
// The same subscription records the **latest** tool call's name plus one bounded target hint (`node-progress`'s `lastTool`). The name rides `ToolCallStarted`; args do not --
// they only ride the earlier `ToolCallScheduled`, so subscribe to both: scheduled stashes args by toolCallId,
// started claims, compresses to the hint, and drops the stash. `lastTool` lands only on started, the same instant as both counts,
// so permission-rejected calls that never started cannot pose as "what it is doing".

import {
  isWorkspaceMutatingToolCall,
  isWorldTouchingToolCall,
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type ToolCallScheduledPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { AskLastTool } from "@zcode/dynamic-workflow";
import { summarizeToolCall } from "./workflow-driver-tool-target.js";

/**
  * At most this many unclaimed scheduled-arg stashes. Normally each is claimed by its started, but permission-
  * rejected, cancelled, or bulk-skipped calls are not -- unbounded, one long ask turns them into a memory leak.
  * On overflow drop the oldest (Map iterates in insertion order): the newest call is the answer to "what is it doing".
 */
const MAX_PENDING_SCHEDULED_CALLS = 64;

/** Tool-call counts observed within one ask (two fields of `AskStats`). */
export interface ActorToolCounts {
    /** Every call, protocol tools such as `submit_result` / `escalate` included. */
  toolCalls: number;
    /** Those that saw or touched the outside world (read files, run commands, network); 0 = the ask is pure. */
  worldToolCalls: number;
}

interface ActorToolActivity {
    /** Zeroed on ask change: counting restarts, and the next ask's first write must be reported once more. */
  reset(): void;
    /** Tool calls observed in this ask so far. */
  counts(): ActorToolCounts;
  /**
      * Tool calls **still running** (started minus result / error, deduped by toolCallId, so four parallel
      * WebSearches in one round count as 4).
   *
      * The only reader is the seat gate (workflow-seat-gate.ts): admission calls carry only `{model}`, unable to tell a model request
      * for this subagent's next turn step from one inside its tools -- and **tool-side requests never park**. Any tool
      * running means tool-side; none means the next turn step. Pair started/ended instead of "the last event":
      * with parallel calls the latter misreads idle at the first tool's return.
   */
  inFlight(): number;
    /** The **latest** tool call that actually started in this ask; absent when none. */
  lastTool(): AskLastTool | undefined;
    /** Subscribes runtime `ToolCallStarted` session events; a noop on minimal stub runtimes without subscribeEvents. */
  observe(runtime: AgentRuntime, sessionId: SessionId): void;
  unsubscribe(): void;
}

export function createActorToolActivity(handlers: {
    /** A subagent of the current ask is about to run a workspace-mutating tool (at most once per ask). */
  onMutating(): void;
}): ActorToolActivity {
  let reported = false;
  let toolCalls = 0;
  let worldToolCalls = 0;
  let lastTool: AskLastTool | undefined;
    /** toolCallId -> name and args at scheduled time, awaiting the started claim. */
  const scheduled = new Map<string, ToolCallSummaryHold>();
    /** toolCallIds started but still awaiting result / error (see {@link ActorToolActivity.inFlight}). */
  const running = new Set<string>();
  let unsubscribeEvents: (() => void) | undefined;
  return {
    reset: () => {
      reported = false;
      toolCalls = 0;
      worldToolCalls = 0;
      lastTool = undefined;
      scheduled.clear();
            // No tool should be running at an ask boundary (the previous ask's turn landed or was aborted); zeroing just keeps
            // one abnormal path from carrying leftovers into the next ask -- the gate would admit them as tool-side requests forever.
      running.clear();
    },
    counts: () => ({ toolCalls, worldToolCalls }),
    inFlight: () => running.size,
    lastTool: () => lastTool,
    observe: (runtime, sessionId) => {
      if (typeof (runtime as Partial<AgentRuntime>).subscribeEvents !== "function") return;
      unsubscribeEvents = runtime.subscribeEvents({
        onSessionEvent: (event: SessionEvent) => {
          if (event.sessionId !== sessionId) return;
          if (event.type === SessionEventType.ToolCallScheduled) {
            holdScheduled(scheduled, event.payload as ToolCallScheduledPayload);
            return;
          }
                    // One call's end: the executor emits on both arms of the post-started try/catch, so a started always has its pair
                    // (permission rejects, schema failures, registry misses happen before started and emit error only -- pairing unaffected).
          if (
            event.type === SessionEventType.ToolCallResult ||
            event.type === SessionEventType.ToolCallError
          ) {
            running.delete(String((event.payload as { toolCallId: unknown }).toolCallId));
            return;
          }
          if (event.type !== SessionEventType.ToolCallStarted) return;
          const capability = event.payload as ToolCallStartedPayload;
          running.add(String(capability.toolCallId));
          const hold = scheduled.get(String(capability.toolCallId));
          scheduled.delete(String(capability.toolCallId));
          lastTool =
            summarizeToolCall({
              ...(hold === undefined ? {} : { input: hold.input }),
              toolName: capability.toolName ?? hold?.toolName,
            }) ?? lastTool;
          toolCalls++;
          if (isWorldTouchingToolCall(capability)) worldToolCalls++;
          if (!isWorkspaceMutatingToolCall(capability)) return;
          if (reported) return;
          reported = true;
          handlers.onMutating();
        },
      });
    },
    unsubscribe: () => {
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
    },
  };
}

/** The stash from a scheduled event (name + args), claimed by its matching started. */
interface ToolCallSummaryHold {
  toolName?: string;
  input?: unknown;
}

/** Stores one scheduled-args entry, keeping the table within {@link MAX_PENDING_SCHEDULED_CALLS} (oldest dropped). */
function holdScheduled(
  scheduled: Map<string, ToolCallSummaryHold>,
  payload: ToolCallScheduledPayload,
): void {
  scheduled.set(String(payload.toolCallId), { toolName: payload.toolName, input: payload.input });
  while (scheduled.size > MAX_PENDING_SCHEDULED_CALLS) {
    const oldest = scheduled.keys().next();
    if (oldest.done === true) return;
    scheduled.delete(oldest.value);
  }
}
