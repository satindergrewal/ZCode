import { describe, expect, it } from "vitest";
import {
  LIST_MODELS_TOOL_NAME,
  ListModelsInputJsonSchema,
  ListModelsInputSchema,
  ListModelsOutputSchema,
} from "../src/tools/list-models.js";

// docs/dynamic-workflow/launch.md: the discovery surface for dwf model selection. Read-only, no
// input; every output line pastes verbatim into \`subagent_model\`.
describe("ListModels contract", () => {
  it("names the tool exactly as it registers and takes no input", () => {
    expect(LIST_MODELS_TOOL_NAME).toBe("ListModels");
    expect(ListModelsInputSchema.parse({})).toEqual({});
    // No filter/paging knobs: each extra one is a new spot for the model to believe the list is incomplete.
    expect(ListModelsInputSchema.safeParse({ provider: "zhipu" }).success).toBe(false);
    const schema = ListModelsInputJsonSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("round-trips a catalog with a current model and keeps optional facts absent", () => {
    const output = {
      current: "zhipu/glm-5.3",
      models: [
        {
          id: "zhipu/glm-5.3",
          providerId: "zhipu",
          modelId: "glm-5.3",
          providerLabel: "Zhipu",
          reasoningLevels: ["low", "high"],
          defaultReasoningLevel: "high",
          contextWindow: 200_000,
        },
        // Models without reasoning levels are an **empty array**, not absent: readers learn that appending `$level` is wrong.
        { id: "anthropic/haiku", providerId: "anthropic", modelId: "haiku", reasoningLevels: [] },
      ],
    };
    const parsed = ListModelsOutputSchema.parse(output);
    expect(parsed).toEqual(output);
    expect("providerLabel" in parsed.models[1]!).toBe(false);
    expect("disabledReason" in parsed.models[1]!).toBe(false);
  });

  it("keeps current absent when nothing in the catalog matches the session model", () => {
    const parsed = ListModelsOutputSchema.parse({ models: [] });
    expect("current" in parsed).toBe(false);
  });

  it("stays strict about unknown keys on an entry", () => {
    expect(
      ListModelsOutputSchema.safeParse({
        models: [{ id: "a/b", providerId: "a", modelId: "b", reasoningLevels: [], tier: "lite" }],
      }).success,
    ).toBe(false);
  });
});
