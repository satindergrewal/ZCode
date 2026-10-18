import { describe, expect, it, vi } from "vitest";

/**
 * CUA output policy: reference material is pulled on demand; the host does not push it.
 *
 * Bug (2026-09-11, on-device): before the first CUA call, the SDK auto-printed docs/computer-use.md into the output,
 * while the model had just received the largely overlapping SKILL via the Skill tool -- the same content entered context twice (13.1KB +
 * 13.8KB, over half the sections duplicated). The policy now matches Browser Use: the model fetches docs itself via
 * `nodeRepl.write(await agent.documentation.get("computer-use"))`.
 *
 * The SDK still auto-renders the observation (`Target`): v1 once made this a discipline in the SKILL,
 * and a forgotten call lost the whole observation; the rollback conclusion lives in the computer-use-client.mjs comments.
 */

const WRITTEN: string[] = [];

async function makeGlobals(bridgeOverrides: Record<string, unknown> = {}) {
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const clientUrl = fileURLToPath(
    new URL("../../zcode-cua-plugin/scripts/computer-use-client.mjs", import.meta.url),
  );
  const documentationRoot = join(dirname(clientUrl), "..", "docs");
  const bridge = {
    call: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    assertAvailable: () => {},
    documentationRoot,
    ...bridgeOverrides,
  };
  const globals = {
    [Symbol.for("zcode.node-repl.computer-use-bridge")]: bridge,
    nodeRepl: {
      write: (text: string) => {
        WRITTEN.push(text);
      },
    },
  };
  const mod = await import(clientUrl);
  await mod.setupComputerUseRuntime({ globals });
  return { globals, bridge, mod };
}

const referenceOf = (writes: readonly string[]) =>
  writes.find((text) => text.startsWith("# Computer Use"));

describe("computer-use output policy", () => {
  it("never pushes the reference, on the first call or any later one", async () => {
    WRITTEN.length = 0;
    const { globals } = await makeGlobals();
    await globals.agent.computerUse.computer.list_apps({});
    expect(referenceOf(WRITTEN)).toBeUndefined();
    await globals.agent.computerUse.computer.list_apps({});
    expect(referenceOf(WRITTEN)).toBeUndefined();
  });

  it("serves the reference through agent.documentation for the model to write", async () => {
    const { globals } = await makeGlobals();
    const doc = await (
      globals.agent as { documentation: { get: (name: string) => Promise<string> } }
    ).documentation.get("computer-use");
    expect(doc).toMatch(/^# Computer Use/u);
    // The on-demand copy remains the full reference: that token budget is paid only when the model needs parameter shapes.
    expect(doc).toMatch(/## Tool arguments/u);
  });
});
