import { describe, expect, it } from "vitest";

import {
  createSessionEventRetentionPolicy,
  isTransientSessionEvent,
  SessionEventType,
  TRANSIENT_SESSION_EVENT_TYPES,
} from "../src/index.js";

const ev = (type: SessionEventType, turnId?: string) => ({ type, turnId });

describe("session event retention policy", () => {
  it("RET-001 turn-window: turn end only seals; the next turn's start evicts the previous", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.ModelStreaming, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.ModelComplete, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0)).toEqual([]);
    // Still inside the lag window: no eviction.
    expect(policy.onAppend(ev(SessionEventType.SessionTitleUpdated, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0)).toEqual(["t1"]);
    expect(policy.onAppend(ev(SessionEventType.TurnError, "t2"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t3"), 0)).toEqual(["t2"]);
  });

  it("RET-001 several ended turns evicted together; rewind triggers none; turnId-less events untouched", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t2"), 0);
    expect(policy.onAppend(ev(SessionEventType.RewindTriggered, "t2"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t3"), 0)).toEqual(["t2"]);
  });

  it("unbounded never evicts", () => {
    const policy = createSessionEventRetentionPolicy("unbounded");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0)).toEqual([]);
  });

  it("the transient set is the four message-frequency kinds, unconsumed by the reducer", () => {
    expect([...TRANSIENT_SESSION_EVENT_TYPES].sort()).toEqual(
      [
        SessionEventType.ModelStreaming,
        SessionEventType.ToolCallProgress,
        SessionEventType.StreamingToolLedgerUpdated,
        SessionEventType.ModelNetworkStatus,
      ].sort(),
    );
    expect(isTransientSessionEvent({ type: SessionEventType.ModelStreaming })).toBe(true);
    expect(isTransientSessionEvent({ type: SessionEventType.ModelComplete })).toBe(false);
  });
});

describe("session event retention policy: time backstop", () => {
  it("RET-008 sealed turn past grace with no successor handed out by collectExpired; one-shot subagent child session case", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "child"), 0);
    policy.onAppend(ev(SessionEventType.ModelStreaming, "child"), 1_000);
    policy.onAppend(ev(SessionEventType.TurnComplete, "child"), 10_000);
    expect(policy.collectExpired(60_000, 120_000)).toEqual([]);
    expect(policy.collectExpired(130_000, 120_000)).toEqual(["child"]);
    // Handed out once, never again.
    expect(policy.collectExpired(200_000, 120_000)).toEqual([]);
  });

  it("RET-008 with a successor turn present, turn-window eviction applies and the backstop does not repeat it", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 5_000);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 6_000)).toEqual(["t1"]);
    expect(policy.collectExpired(500_000, 120_000)).toEqual([]);
  });

  it("unbounded time backstop is always empty", () => {
    const policy = createSessionEventRetentionPolicy("unbounded");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 1);
    expect(policy.collectExpired(1_000_000, 0)).toEqual([]);
  });
});
