import { describe, expect, it } from "vitest";
import {
  OffPeakCreateInputJsonSchema,
  OffPeakCreateInputSchema,
  OffPeakCreateOutputSchema,
  OffPeakListInputSchema,
  OffPeakTaskSummarySchema,
} from "../src/tools/off-peak.js";

describe("OffPeakCreateInputSchema (D49-4 input surface)", () => {
  it("title/prompt required, rest optional", () => {
    expect(OffPeakCreateInputSchema.safeParse({ title: "t", prompt: "p" }).success).toBe(true);
    expect(OffPeakCreateInputSchema.safeParse({ title: "t" }).success).toBe(false);
    expect(OffPeakCreateInputSchema.safeParse({ prompt: "p" }).success).toBe(false);
    expect(OffPeakCreateInputSchema.safeParse({ title: "  ", prompt: "p" }).success).toBe(false);
  });

  it("prompt description reaches the model-visible schema as D50 bound-session semantics (review CR-01)", () => {
    const properties = (
      OffPeakCreateInputJsonSchema as { properties: Record<string, { description?: string }> }
    ).properties;
    const description = properties.prompt?.description ?? "";
    expect(description).toContain("continues THIS conversation");
    expect(description).not.toMatch(/fresh|without relying|self-contained|NEW session/);
  });

  it("permissionMode accepts only the four-value product vocabulary", () => {
    for (const mode of ["build", "edit", "plan", "yolo"]) {
      expect(
        OffPeakCreateInputSchema.safeParse({ title: "t", prompt: "p", permissionMode: mode })
          .success,
      ).toBe(true);
    }
    expect(
      OffPeakCreateInputSchema.safeParse({
        title: "t",
        prompt: "p",
        permissionMode: "bypassPermissions",
      }).success,
    ).toBe(false);
  });

  it("strict: unknown keys refused (workspace/credentials are not model input)", () => {
    expect(
      OffPeakCreateInputSchema.safeParse({
        title: "t",
        prompt: "p",
        workspacePath: "/tmp",
      }).success,
    ).toBe(false);
  });
});

describe("OffPeak output and list schemas", () => {
  it("task snapshot minimal surface: no cross-boundary fields like serverTicketId", () => {
    const parsed = OffPeakTaskSummarySchema.safeParse({
      offPeakTaskId: "offpeak-1",
      title: "t",
      status: "queued",
      queuePosition: 3,
      createdAt: 1,
      serverTicketId: "ticket-1",
    });
    expect(parsed.success).toBe(false);
  });

  it("create output = task + message", () => {
    expect(
      OffPeakCreateOutputSchema.safeParse({
        task: { offPeakTaskId: "offpeak-1", title: "t", status: "queued", createdAt: 1 },
        message: "Created idle-time task offpeak-1.",
      }).success,
    ).toBe(true);
  });

  it("list takes no arguments", () => {
    expect(OffPeakListInputSchema.safeParse({}).success).toBe(true);
    expect(OffPeakListInputSchema.safeParse({ status: "queued" }).success).toBe(false);
  });
});
