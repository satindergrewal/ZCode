// Contract surface of the progress projection: one engine RunEvent -> one
// dynamic_workflow_run_progress session event. This pins **bounding** and the vocabulary, not
// projection semantics (bootstrap's product-projection tests own those). See
// docs/dynamic-workflow/presentation.md "The run state the pane draws".
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS,
  SessionEventType,
  boundDynamicWorkflowRunEventPayload,
  type DynamicWorkflowRunProgressPayload,
} from "../src/index.js";

describe("dynamic workflow run progress session events", () => {
  it("event kind enters the SessionEventType vocabulary", () => {
    expect(SessionEventType.DynamicWorkflowRunProgress).toBe("dynamic_workflow_run_progress");
  });

  it("payload type carries runId / sequence / eventType and the port-shaped JSON payload", () => {
    const payload: DynamicWorkflowRunProgressPayload = {
      runId: "dwfrun-1",
      toolCallId: "tc-1",
      sequence: 7,
      eventType: "node-settled",
      payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
    };
    expect(payload.payload.outcome).toBe("ok");
  });
});

describe("boundDynamicWorkflowRunEventPayload", () => {
  it("small payloads pass verbatim without truncated", () => {
    const source = {
      instance: { siteId: "ask#1", ordinal: 2 },
      outcome: "failed",
      error: { code: "ValidationFailed", message: "field name missing" },
    };
    expect(boundDynamicWorkflowRunEventPayload(source)).toEqual({
      payload: source,
      truncated: false,
    });
  });

  it("oversize strings truncate at the cap and set truncated", () => {
    const long = "x".repeat(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength + 100);
    const { payload, truncated } = boundDynamicWorkflowRunEventPayload({ finalText: long });
    expect(truncated).toBe(true);
    expect((payload.finalText as string).length).toBe(
      DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength,
    );
  });

  it("truncation never splits a surrogate pair (surrogate-safe)", () => {
    // The cap lands mid-4-byte-emoji: prefer one char fewer over a lone surrogate.
    const emoji = "😀";
    const head = "a".repeat(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength - 1);
    const { payload } = boundDynamicWorkflowRunEventPayload({ text: `${head}${emoji}` });
    const text = payload.text as string;
    expect(text.length).toBe(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength - 1);
    expect(/[\uD800-\uDFFF]/.test(text)).toBe(false);
  });

  it("oversize arrays clip at the cap and set truncated", () => {
    const violations = Array.from(
      { length: DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxArrayItems + 5 },
      (_, index) => ({ path: `/a/${index}` }),
    );
    const { payload, truncated } = boundDynamicWorkflowRunEventPayload({ violations });
    expect(truncated).toBe(true);
    expect((payload.violations as unknown[]).length).toBe(
      DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxArrayItems,
    );
  });

  it("over-deep nesting clips at the cap and sets truncated", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (
      let level = 0;
      level < DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxDepth + 3;
      level += 1
    ) {
      deep = { nested: deep };
    }
    const { truncated } = boundDynamicWorkflowRunEventPayload(deep);
    expect(truncated).toBe(true);
  });

  it("non-JSON values (Infinity / undefined / functions) normalize; never an unserializable payload", () => {
    // Any non-finite number becomes null through JSON; fold once here so stored equals in-memory.
    const { payload } = boundDynamicWorkflowRunEventPayload({
      stats: { ratio: Number.POSITIVE_INFINITY, count: 98 },
      absent: undefined,
      fn: () => 1,
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect((payload.stats as Record<string, unknown>).ratio).toBeNull();
    expect(payload).not.toHaveProperty("absent");
    expect(payload).not.toHaveProperty("fn");
  });

  it("over-cap key counts keep only the first keys and set truncated", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxKeys + 4; index += 1) {
      wide[`k${index}`] = index;
    }
    const { payload, truncated } = boundDynamicWorkflowRunEventPayload(wide);
    expect(truncated).toBe(true);
    expect(Object.keys(payload).length).toBe(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxKeys);
  });
});
