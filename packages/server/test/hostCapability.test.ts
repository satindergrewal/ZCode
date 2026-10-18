import { describe, expect, it } from "vitest";

describe("desktop host websocket capability store", () => {
  it("gives capabilities a TTL, single successful redemption, and no grant for invalid values", async () => {
    const modulePromise = import("../src/hostCapability.js");
    await expect(modulePromise).resolves.toBeDefined();
    const { createHostCapabilityStore } = await modulePromise;
    let now = 1_000;
    let serial = 0;
    const store = createHostCapabilityStore({
      ttlMs: 100,
      now: () => now,
      createCapability: () => `capability-${++serial}`,
    });

    const first = store.issue();
    expect(first).toEqual({
      capability: "capability-1",
      expiresAt: 1_100,
    });
    expect(store.consume("unknown")).toBe(false);
    expect(store.consume(first.capability)).toBe(true);
    expect(store.consume(first.capability)).toBe(false);

    const expired = store.issue();
    now = expired.expiresAt + 1;
    expect(store.consume(expired.capability)).toBe(false);
    expect(store.consume(undefined)).toBe(false);
  });
});
