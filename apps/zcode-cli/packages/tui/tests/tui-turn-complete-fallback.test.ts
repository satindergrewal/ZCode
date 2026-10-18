import assert from "node:assert/strict";
import test from "node:test";
import type React from "react";
import { applyTurnCompleteFallbackResponse } from "../src/app-turn-complete.js";
import { appendAgentResult } from "../src/app-submit.js";
import type { Message } from "../src/app-model.js";

// turn_complete response fallback: notification-driven turns have no applyResult, and streaming may have drawn nothing
// (tool calls only, or the stream died midway). These tests pin three properties: append when owed, skip when already drawn,
// and symmetry with the appendAgentResult guard -- one answer never appears twice.

function dispatch(current: Message[], payload: Record<string, unknown>): Message[] {
  let next = current;
  const setMessages: React.Dispatch<React.SetStateAction<Message[]>> = (update) => {
    next = typeof update === "function" ? (update as (m: Message[]) => Message[])(next) : update;
  };
  applyTurnCompleteFallbackResponse(payload, setMessages);
  return next;
}

test("appends the authoritative response when nothing was streamed (tool-only turn)", () => {
  const result = dispatch([], { response: "Workflow settled: 3 findings." });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.role, "agent");
  assert.equal(result[0]?.content, "Workflow settled: 3 findings.");
});

test("does not append when the streamed transcript already carries the response", () => {
  const streamed: Message = {
    content: "Workflow settled: 3 findings.",
    role: "agent",
    streamProjected: true,
  };
  const result = dispatch([streamed], { response: "Workflow settled: 3 findings." });
  assert.equal(result.length, 1);
});

test("empty or missing response is a no-op", () => {
  assert.equal(dispatch([], { response: "" }).length, 0);
  assert.equal(dispatch([], { response: "   " }).length, 0);
  assert.equal(dispatch([], {}).length, 0);
});

test("re-delivery of the same response is idempotent", () => {
  const once = dispatch([], { response: "same answer" });
  const twice = dispatch(once, { response: "same answer" });
  assert.equal(twice.length, 1);
});

test("regression: fallback then applyResult must not duplicate the answer", () => {
  // Stream dying mid-user-turn: turn_complete lands first (the fallback appends), then submitPrompt settles and
  // appendAgentResult runs. The guard scans only streamProjected messages, so the fallback message must carry that flag
  // or this case would show a second copy of the same answer.
  const afterFallback = dispatch([], { response: "the one answer" });
  const afterResult = appendAgentResult(afterFallback, { response: "the one answer" });
  const occurrences = afterResult.filter((m) => m.content === "the one answer");
  assert.equal(occurrences.length, 1);
});
