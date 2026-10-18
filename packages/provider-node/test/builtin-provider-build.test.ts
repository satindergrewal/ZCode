import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("build config contract: builtin-provider-config-build", async () => {
  // The build tool runs on plain Node; do not let Vitest's transforms mask import/path issues in the packaged entry.
  const result = await promisify(execFile)(
    process.execPath,
    ["--test", "scripts/test/builtin-provider-config-build.test.mjs"],
    { cwd: resolve(import.meta.dirname, "../../.."), timeout: 25_000 },
  );
  expect(result.stdout).toContain("fail 0");
});
