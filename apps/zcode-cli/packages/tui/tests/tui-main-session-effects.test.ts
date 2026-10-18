// WP-F effect-level regression: raw actor/child-session events never enter the main transcript (user directive 2026-08-23).
//
// Division of labor with tui-main-session-filter.test.ts: that file pins the predicate, this one pins the pipeline's effects
// (gate -> dedupe -> applySessionEventToState). Some regressions are visible only at the effect level -- above all,
// whether an actor's turn_complete sneaks its answer into the main transcript as an agent message via
// applyTurnCompleteFallbackResponse.
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createSessionEvent, type SessionEvent } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import { applyMainSessionEvent } from "../src/app-session-event-handler.js";
import type { Message } from "../src/app-model.js";
import { EMPTY_TUI_WORKFLOW_MIRROR, type TuiWorkflowMirror } from "../src/app-workflow-mirror.js";

const COPY = getZCodeCopy("en-US").tui;
const MAIN = "session-main";
const ACTOR = "session-actor-1";

/**
 * Collects every observable side effect, to assert that nothing happened.
 *
 * Takes the getter, not an id: passing `undefined` explicitly would re-trigger default-parameter substitution,
 * so the unknown-main-session case would silently still filter by MAIN -- bitten once, pinned here.
 */
function harness(getMainSessionId: () => string | undefined = () => MAIN) {
  const state = {
    messages: [] as Message[],
    statuses: [] as string[],
    lastEvents: [] as string[],
    mirror: EMPTY_TUI_WORKFLOW_MIRROR as TuiWorkflowMirror,
  };
  const applied = new Set<string>();
  const input = {
    copy: COPY,
    getMainSessionId,
    setActiveTurnId: () => {},
    setCacheStats: () => {},
    setContextUsage: () => {},
    setLastError: () => {},
    setLastEvent: (value: string) => state.lastEvents.push(value),
    setLiveModelText: () => {},
    setMessages: (update: unknown) => {
      state.messages =
        typeof update === "function"
          ? (update as (current: Message[]) => Message[])(state.messages)
          : (update as Message[]);
    },
    setModel: () => {},
    setNetworkRequests: () => {},
    setStatus: (value: string) => state.statuses.push(value),
    setTodos: () => {},
    setUsage: () => {},
    setWorkflowMirror: (update: unknown) => {
      state.mirror =
        typeof update === "function"
          ? (update as (current: TuiWorkflowMirror) => TuiWorkflowMirror)(state.mirror)
          : (update as TuiWorkflowMirror);
    },
    assistantMessageIdsByToolCallId: new Map<string, string>(),
    toolNamesById: new Map<string, string>(),
  } as unknown as Parameters<typeof applyMainSessionEvent>[2];

  return {
    state,
    apply: (event: SessionEvent) => applyMainSessionEvent(event, applied, input),
  };
}

function event(sessionId: string, type: SessionEventType, payload: unknown = {}): SessionEvent {
  return { ...createSessionEvent(type, sessionId as never, payload), sessionId } as SessionEvent;
}

// -- The heaviest case: an actor's turn_complete never reaches the transcript via the fallback --

test("an actor turn_complete never appends its answer through the fallback", () => {
  const h = harness();
  const applied = h.apply(
    event(ACTOR, SessionEventType.TurnComplete, { response: "actor internal answer" }),
  );
  assert.equal(applied, false);
  // The most dangerous WP-F regression: the fallback appends any turn_complete.response as an agent message,
  // so without the gate, actor interim answers would land verbatim in the main transcript.
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.statuses, []);
});

test("a main-session turn_complete still appends through the fallback", () => {
  const h = harness();
  assert.equal(
    h.apply(event(MAIN, SessionEventType.TurnComplete, { response: "the real answer" })),
    true,
  );
  assert.equal(h.state.messages.length, 1);
  assert.equal(h.state.messages[0]?.content, "the real answer");
});

// -- Remaining actor noise: no transcript parts, no status-line changes ------------------------

test("actor submit_result / tool_call_* create no transcript parts and no status changes", () => {
  const h = harness();
  const toolEvents: readonly [SessionEventType, unknown][] = [
    [
      SessionEventType.ToolCallScheduled,
      { toolCallId: "tc-a", toolName: "submit_result", input: {} },
    ],
    [SessionEventType.ToolCallStarted, { toolCallId: "tc-a", toolName: "submit_result" }],
    [
      SessionEventType.ToolCallResult,
      { toolCallId: "tc-a", toolName: "submit_result", result: { content: "ok" } },
    ],
    [SessionEventType.ToolCallError, { toolCallId: "tc-a", toolName: "submit_result" }],
  ];
  for (const [type, payload] of toolEvents) {
    assert.equal(h.apply(event(ACTOR, type, payload)), false, `${type} passed the gate`);
  }
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.statuses, []);
  assert.deepEqual(h.state.lastEvents, []);
});

test("actor model_streaming and assistant_message never reach the transcript", () => {
  const h = harness();
  h.apply(event(ACTOR, SessionEventType.ModelStreaming, { delta: "half a thought" }));
  h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "actor prose" }));
  assert.deepEqual(h.state.messages, []);
});

test("actor turn lifecycle events do not touch the main status line", () => {
  const h = harness();
  h.apply(event(ACTOR, SessionEventType.TurnStarted, {}));
  h.apply(event(ACTOR, SessionEventType.ModelRequest, {}));
  assert.deepEqual(h.state.statuses, []);
});

// -- Not over-filtered: three surfaces that must stay alive -------------------------------------

test("dwf progress on the parent session still reduces into the mirror", () => {
  const h = harness();
  const applied = h.apply(
    event(MAIN, SessionEventType.DynamicWorkflowRunProgress, {
      runId: "dwfrun-1",
      toolCallId: "tc-1",
      sequence: 0,
      eventType: "run-started",
      payload: { caps: { maxConcurrency: 4 } },
    }),
  );
  assert.equal(applied, true);
  // The card's lifeline: an over-tight gate reverts tool cards to dead text projections.
  assert.equal(h.state.mirror.state.runs[0]?.runId, "dwfrun-1");
  assert.equal(h.state.mirror.state.runs[0]?.status, "running");
});

test("a mirrored subagent tool event still renders (it carries the parent sessionId)", () => {
  // mirrorSubagentToolEvent mints via createSessionEvent(type, parentSessionId, ...),
  // so Agent-tool rendering is untouched by WP-F.
  const h = harness();
  const applied = h.apply(
    event(MAIN, SessionEventType.ToolCallScheduled, {
      toolCallId: "tc-agent",
      toolName: "Agent",
      input: { description: "explore" },
    }),
  );
  assert.equal(applied, true);
  assert.equal(h.state.messages.length, 1);
});

test("the actor gate does not depend on event kind — only on session", () => {
  // Same event type: parent passes, child does not. The gate is per session, not a type blacklist.
  const h = harness();
  assert.equal(h.apply(event(MAIN, SessionEventType.AssistantMessage, { content: "main" })), true);
  assert.equal(
    h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "actor" })),
    false,
  );
  assert.deepEqual(
    h.state.messages.map((message) => message.content),
    ["main"],
  );
});

// -- Gate plus dedupe combined ------------------------------------------------------------------

test("the gate runs before dedup, so actor events never consume dedup slots", () => {
  const h = harness();
  const actorEvent = event(ACTOR, SessionEventType.AssistantMessage, { content: "noise" });
  h.apply(actorEvent);
  h.apply(actorEvent);
  // Main-session events still dedupe (first applies, duplicate dropped), proving the window survives actor events.
  const mainEvent = event(MAIN, SessionEventType.AssistantMessage, { content: "signal" });
  assert.equal(h.apply(mainEvent), true);
  assert.equal(h.apply(mainEvent), false);
  assert.deepEqual(
    h.state.messages.map((message) => message.content),
    ["signal"],
  );
});

test("an unknown main session id fails open so the transcript is never blank", () => {
  const h = harness(() => undefined);
  assert.equal(h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "x" })), true);
});
