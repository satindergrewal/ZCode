import { describe, expect, it } from "vitest";
import {
  ModelRetryBudget,
  modelNetworkStatusEventJsonSchema,
  type ModelTextRequest,
} from "../src/model/index.js";
import {
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
} from "../src/model/invocation-context.js";

// docs/dynamic-workflow/concurrency.md "Unbounded retries for workflow traffic": retry budget tiers are a runtime-only field;
// status events express unbounded as maxAttempts = 0, hence the protocol schema's lower bound 0.
describe("ModelRetryBudget", () => {
  it("exposes the three budget tiers", () => {
    expect(ModelRetryBudget).toEqual({
      Default: "default",
      Unbounded: "unbounded",
      SingleAttempt: "single-attempt",
    });
  });

  it("is a runtime-only request field and stays out of the model request JSON schema", async () => {
    const request: ModelTextRequest = {
      model: "test/model",
      messages: [],
      modelRetryBudget: ModelRetryBudget.Unbounded,
    };
    expect(request.modelRetryBudget).toBe("unbounded");
    const { modelTextRequestJsonSchema } = await import("../src/model/index.js");
    const properties = (modelTextRequestJsonSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties).not.toHaveProperty("modelRetryBudget");
    expect(properties).not.toHaveProperty("modelRequestSessionType");
  });

  it("allows maxAttempts = 0 (unbounded marker) in the network status schema", () => {
    const properties = (
      modelNetworkStatusEventJsonSchema as { properties: Record<string, { minimum?: number }> }
    ).properties;
    expect(properties.maxAttempts?.minimum).toBe(0);
    // attempt still starts at 1: only the budget total carries the unbounded sentinel.
    expect(properties.attempt?.minimum).toBe(1);
  });

  it("travels with the model invocation context", () => {
    const seen = runWithModelInvocationContext(
      { modelRetryBudget: ModelRetryBudget.Unbounded },
      () => getCurrentModelInvocationContext()?.modelRetryBudget,
    );
    expect(seen).toBe("unbounded");
    expect(getCurrentModelInvocationContext()).toBeUndefined();
  });
});
