import { describe, expect, it } from "vitest";
import { ToolExecutionTelemetrySchema } from "../src/tools/performance.js";

describe("ToolExecutionTelemetrySchema", () => {
  it("command detail accepts real exit codes", () => {
    expect(
      ToolExecutionTelemetrySchema.parse({
        detail: {
          kind: "command",
          command: {
            exitCode: 2,
            name: "git",
            status: "failed",
          },
        },
        totalMs: 20,
      }),
    ).toMatchObject({
      detail: {
        kind: "command",
        command: {
          exitCode: 2,
        },
      },
    });
  });

  it("file detail accepts no exit code, in type and runtime schema", () => {
    expect(() =>
      ToolExecutionTelemetrySchema.parse({
        detail: {
          kind: "filesystem",
          filesystem: {
            exitCode: 0,
            readMs: 10,
          },
        },
      }),
    ).toThrow();
  });

  it("top level no longer accepts the legacy exitCode", () => {
    expect(() =>
      ToolExecutionTelemetrySchema.parse({
        exitCode: 0,
      }),
    ).toThrow();
  });
});
