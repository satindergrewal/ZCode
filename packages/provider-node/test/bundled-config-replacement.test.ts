import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { materializeZCodeBuiltinProviderConfig } from "../src/index.js";
import * as persistence from "@zcode/shared/node";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function environmentRoot() {
  const root = await mkdtemp(join(tmpdir(), "todo104-bundled-"));
  roots.push(root);
  return root;
}
function release(revision: number) {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
}

it("reuses the pinned asset on concurrent same-content starts without rewriting the file", async () => {
  const environmentConfigRoot = await environmentRoot();
  const options = { environmentConfigRoot, content: release(1) };
  const file = await materializeZCodeBuiltinProviderConfig(options);
  const before = await stat(file, { bigint: true });
  expect(
    await Promise.all(
      Array.from({ length: 8 }, () => materializeZCodeBuiltinProviderConfig(options)),
    ),
  ).toEqual(Array(8).fill(file));
  expect((await stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});

it("lets concurrent reads see only a complete old or new version during swap, with no hash-history files", async () => {
  const environmentConfigRoot = await environmentRoot();
  const file = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot,
    content: release(1),
  });
  let finished = false;
  const writer = (async () => {
    try {
      for (let index = 0; index < 30; index++) {
        await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot,
          content: release((index % 2) + 1),
        });
      }
    } finally {
      finished = true;
    }
  })();
  const reader = (async () => {
    do {
      const fileContent = JSON.parse(await readFile(file, "utf8"));
      expect([1, 2]).toContain(fileContent.revision);
      expect(fileContent).toEqual(JSON.parse(release(fileContent.revision)));
    } while (!finished);
  })();
  await Promise.all([writer, reader]);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});

it("keeps the old content when validation or the atomic write fails and reports the error to the caller", async () => {
  const environmentConfigRoot = await environmentRoot();
  const file = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot,
    content: release(1),
  });
  const before = await readFile(file, "utf8");
  await expect(
    materializeZCodeBuiltinProviderConfig({ environmentConfigRoot, content: "{}" }),
  ).rejects.toThrow();
  vi.spyOn(persistence, "atomicWritePrivateTextFile").mockRejectedValueOnce(
    new Error("fixture write failure"),
  );
  await expect(
    materializeZCodeBuiltinProviderConfig({ environmentConfigRoot, content: release(2) }),
  ).rejects.toThrow("fixture write failure");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await readdir(dirname(file))).toEqual(["zcode-builtin.json"]);
});
