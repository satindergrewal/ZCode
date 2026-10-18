/**
 * A deterministic model-side error stops the whole run (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "Terminal states"): the driver
 * reports it via stopRun(ProviderStop); the engine settles no node and the script never sees it (agent() does not reject as a model
 * failure); in-flight sibling asks are aborted, and the run settles stopped(provider) with the failure journalled (resumable).
 */

import { describe, expect, it } from "vitest";
import { WorkflowError } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const PROVIDER_STOP = new WorkflowError("ProviderStop", "Sign-in to BigModel expired.", {
  providerStop: {
    kind: "auth",
    reason: "auth_failed",
    providerId: "account:bigmodel-coding-plan",
    modelId: "GLM-5.3",
    providerCode: "1006",
    subagent: "ask#1@1",
    rawMessage: "[1006] token expired",
  },
});

describe("provider stop across the boundary", () => {
  it("stays outside the script's try/catch: the run stops stopped(provider) and sibling asks abort", async () => {
    const script = [
      'const a = agent("a", "You do things.");',
      'const b = agent("b", "You do things.");',
      "try {",
      '  await Promise.all([a.ask("go"), b.ask("go")]);',
      "} catch (e) {",
      '  return "caught";',
      "}",
      'return "done";',
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: {
        "ask#1": () => ({ type: "stop-run", error: PROVIDER_STOP }),
        // The sibling ask is never answered: only the run-level abort retires it.
        "ask#2": () => [],
      },
    });

    expect(settlement).toEqual({ status: "stopped", reason: "provider", error: PROVIDER_STOP });
    const run = journal.getRun("run");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("provider");
    expect(run?.failure).toEqual(PROVIDER_STOP.toJSON());
    // Both in-flight asks are cancelled driver-side; nodes keep their admission-time running rows (resume can retry from them).
    expect(driver.cancels.map((c) => c.siteId).sort()).toEqual(["ask#1", "ask#2"]);
    expect(journal.getNode("run", "ask#1", 1)?.status).toBe("running");
    expect(journal.getNode("run", "ask#2", 1)?.status).toBe("running");
    const settled = driver.eventsOfType("run-settled");
    expect(settled).toEqual([
      {
        type: "run-settled",
        status: "stopped",
        stopReason: "provider",
        error: PROVIDER_STOP.toJSON(),
      },
    ]);
  });
});
