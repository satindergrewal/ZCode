// The main-session gate (WP-F, user directive 2026-08-23).
//
// Raw actor/child events are delivered via notifyExternalChildSessionEvent into the same external
// sink set as the parent runtime, keeping the child's own sessionId. The TUI's resident subscription and per-turn onEvent hang off that set,
// so without the filter, actor streamed deltas, tool calls, submit_result, and turn_complete would be drawn into the main transcript.
//
// It must also prove no over-filtering: dwf progress is a parent-session event, and tool cards plus settled completion turns stay alive.
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createSessionEvent, type SessionEvent } from "@zcode/contracts";
import { isMainSessionEvent } from "../src/app-session-event-handler.js";

const MAIN = "session-main";
const ACTOR = "session-actor-1";

function eventFrom(sessionId: string, type: SessionEventType = SessionEventType.AssistantMessage) {
  return { ...createSessionEvent(type, sessionId as never, {}), sessionId } as SessionEvent;
}

test("main-session events pass the gate", () => {
  assert.equal(isMainSessionEvent(eventFrom(MAIN), MAIN), true);
});

test("actor/child-session events are dropped", () => {
  assert.equal(isMainSessionEvent(eventFrom(ACTOR), MAIN), false);
});

test("every noisy actor event kind is dropped, not just some", () => {
  // The user-visible noise is exactly these: streamed deltas, tool calls (submit_result rides tool_call_*), turn terminals.
  for (const type of [
    SessionEventType.ModelStreaming,
    SessionEventType.AssistantMessage,
    SessionEventType.ToolCallScheduled,
    SessionEventType.ToolCallResult,
    SessionEventType.ToolCallError,
    SessionEventType.TurnStarted,
    SessionEventType.TurnComplete,
  ]) {
    assert.equal(isMainSessionEvent(eventFrom(ACTOR, type), MAIN), false, `${type} leaked`);
    assert.equal(isMainSessionEvent(eventFrom(MAIN, type), MAIN), true, `${type} wrongly dropped`);
  }
});

test("dwf progress from the parent session survives the gate (the card must keep working)", () => {
  // Progress appends to the parent session (session.events.ts:134). Over-filtering reverts tool cards to dead text.
  const progress = eventFrom(MAIN, SessionEventType.DynamicWorkflowRunProgress);
  assert.equal(isMainSessionEvent(progress, MAIN), true);
});

test("an unknown main session id fails open rather than blanking the transcript", () => {
  // In the no-id window (app not yet built), prefer over-rendering to a blank transcript.
  assert.equal(isMainSessionEvent(eventFrom(ACTOR), undefined), true);
  assert.equal(isMainSessionEvent(eventFrom(MAIN), ""), true);
});

test("an event with no sessionId fails open", () => {
  const anonymous = { ...eventFrom(MAIN), sessionId: undefined } as unknown as SessionEvent;
  assert.equal(isMainSessionEvent(anonymous, MAIN), true);
});

test("the gate follows the session across a swap rather than pinning the first id", () => {
  // After /new /resume /fork the main session changed; the gate reads the live id, so the new session's events pass
  // while the old session's events (possibly still trailing in flight) count as foreign.
  const afterSwap = "session-main-2";
  assert.equal(isMainSessionEvent(eventFrom(afterSwap), afterSwap), true);
  assert.equal(isMainSessionEvent(eventFrom(MAIN), afterSwap), false);
});
