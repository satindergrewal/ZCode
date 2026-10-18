import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_HTTP_DEFINES, SERVER_HTTP_EXTERNAL_DEPENDENCIES } from "../tsup.config.js";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";

describe("server tsup config", () => {
  it("embeds the selected environment's Built-in config used by the HTTP entry", async () => {
    const expected = await loadBuiltinProviderConfig();
    expect(JSON.parse(SERVER_HTTP_DEFINES.__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__)).toBe(
      expected.content,
    );
    expect(JSON.parse(SERVER_HTTP_DEFINES.__ZCODE_ENV__)).toBe(expected.environment);
  });

  it("externalizes CommonJS multipart dependencies for the ESM HTTP dev bundle", () => {
    expect(SERVER_HTTP_EXTERNAL_DEPENDENCIES).toEqual(
      expect.arrayContaining([
        "axios",
        "form-data",
        "combined-stream",
        "proxy-from-env",
        "follow-redirects",
        "yazl",
        "node-forge",
        "yaml",
      ]),
    );
  });

  it("declares external runtime dependencies in the server package", () => {
    const packageJsonPath = resolve(import.meta.dirname, "../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };

    // Bugfix: pnpm does not expose transitive deps to @zcode/server; once the HTTP bundle externalizes them they must resolve from the server itself.
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(
      expect.arrayContaining(SERVER_HTTP_EXTERNAL_DEPENDENCIES),
    );
  });
});
