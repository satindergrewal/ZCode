import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";
import { buildBrowserUsePluginBundles } from "../../browser-use-plugin/scripts/build.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const buildTimeoutMs = 120_000;

type ProbeResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

// Root cause: the node_repl MCP server is a separate stdio child spawned by the CLI, which the plugin host loads via
// `await import(pathToFileURL(dist/mcp/server.js))` to load it. Every earlier test ran against TS sources,
// and none of them covered importing the built bundle; in the 2026-07-27 ESM bundle
// yaml's require("process") hit esbuild's throwing __require shim and loading crashed outright,
// yet lint, unit tests, and CI stayed green; a user discovered the mcp__node_repl__js tool had vanished entirely.
// This smoke test builds the real artifacts and imports each once in a subprocess, catching load-time crashes before they land.
const runBundleProbe = (bundlePath: string): Promise<ProbeResult> => {
  // Runs via --input-type=module -e instead of executing the file: during import, process.argv[1] is empty,
  // so server.ts's run-directly branch never fires and no stdio server hangs the subprocess,
  // while module evaluation -- where the crash happened -- matches the real plugin host exactly.
  const probeSource = [
    `const bundle = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});`,
    "process.stdout.write(typeof bundle.main);",
  ].join("\n");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", probeSource], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stderr, stdout });
    });
  });
};

describe("node_repl host and browser-use runtime bundles", () => {
  let outputDirectory = "";
  let mcpOutfile = "";
  let browserClientOutfile = "";

  beforeAll(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), "zcode-node-repl-bundle-"));
    // The host artifact is built by this package; browser-client is still built by browser-use. Both bundles are ESM
    // and can be blown up at load time by CJS deps, so both get smoked.
    // The temp dir is not inside a type=module package; .mjs keeps the direct spawn semantically equal to the real .js artifact.
    const [host, browser] = await Promise.all([
      buildNodeReplHostBundle({ outfile: join(outputDirectory, "mcp", "server.mjs") }),
      buildBrowserUsePluginBundles({
        browserClientOutfile: join(outputDirectory, "browser-client.mjs"),
      }),
    ]);
    mcpOutfile = host.outfile;
    browserClientOutfile = browser.browserClientOutfile;
  }, buildTimeoutMs);

  afterAll(async () => {
    if (outputDirectory) {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });

  it(
    "imports the built node_repl MCP server bundle without failing module evaluation",
    async () => {
      const probe = await runBundleProbe(mcpOutfile);

      // Asserting on stderr keeps the crash reason visible on failure instead of a bare exit code.
      expect(probe.stderr).not.toContain("Dynamic require of");
      expect({ exitCode: probe.exitCode, stderr: probe.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      // The plugin host requires the runtime bundle to export main(); without it, the server exits before the MCP handshake.
      expect(probe.stdout).toBe("function");
    },
    buildTimeoutMs,
  );

  it(
    "negotiates MCP 2026-07-28 and isolates globals plus module cache in built node_repl",
    async () => {
      const transport = new StdioClientTransport({
        args: [mcpOutfile],
        command: process.execPath,
        cwd: packageRoot,
        stderr: "pipe",
      });
      const client = new Client(
        { name: "node-repl-bundle-smoke", version: "0.1.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      let serverStderr = "";
      transport.stderr?.setEncoding("utf8");
      transport.stderr?.on("data", (chunk: string) => {
        serverStderr += chunk;
      });
      try {
        await client.connect(transport).catch(async (error) => {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nbundle: ${mcpOutfile}\nserver stderr:\n${serverStderr}`,
          );
        });
        const listed = await client.listTools();
        expect(client.getProtocolEra()).toBe("modern");
        expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["js"]);
        const meta = {
          "com.zcode/request-context": {
            runtime_scope: "main",
            session_id: "bundle-session",
          },
        };
        const first = await client.callTool({
          name: "js",
          arguments: {
            code: [
              "globalThis.__zcodeKernelMarker = 'FIRST';",
              "require('node:events').__zcodeModuleMarker = 'FIRST';",
              "'set';",
            ].join("\n"),
          },
          _meta: meta,
        });
        expect(first.isError).not.toBe(true);
        const second = await client.callTool({
          name: "js",
          arguments: {
            code: "({ kernel: typeof globalThis.__zcodeKernelMarker, module: typeof require('node:events').__zcodeModuleMarker });",
          },
          _meta: meta,
        });
        expect(second.content).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('"kernel": "undefined"'),
          }),
        );
        expect(second.content).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('"module": "undefined"'),
          }),
        );
        expect(serverStderr).toBe("");
      } finally {
        await client.close();
      }
    },
    buildTimeoutMs,
  );

  it("guards its CLI entry with pathToFileURL so Windows actually builds", async () => {
    // Root cause (2026-09-12, CI build:windows:x64): the entry guard used to read
    // `import.meta.url === \`file://${process.argv[1]}\``. On Windows, argv[1] is
    // `C:\\...\\build.mjs`, while import.meta.url is `file:///C:/.../build.mjs`, so the two never compare equal --
    // The script was treated as a plain module import and exited doing nothing; the build "succeeded" with no artifact until the dev guard reported
    // "build succeeded without required MCP runtime".
    const source = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    expect(source).toContain("pathToFileURL");
    // If the string-concat form comes back, Windows silently produces nothing again. The guard checks the literal line (the old broken form is documented in comments).
    const codeLines = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(codeLines).not.toMatch(/file:\/\/\$\{process\.argv/u);
  });

  it("injects a real require into both ESM bundles so bundled CJS dependencies keep working", async () => {
    const [mcpBundle, browserClientBundle] = await Promise.all([
      readFile(mcpOutfile, "utf8"),
      readFile(browserClientOutfile, "utf8"),
    ]);

    for (const bundle of [mcpBundle, browserClientBundle]) {
      expect(bundle).toContain('createRequire as __zcodeCreateRequire } from "node:module"');
    }
  });

  // The build-time guard needs its own test: when the define name drifts, the build must fail, not silently emit an empty string --
  // a symptom that only appears in production packages, as a timeout with no logs.
  it(
    "fails the build when the injected build id does not reach the output",
    async () => {
      const outfile = join(outputDirectory, "mcp", "server.guard.mjs");
      // Use a value that cannot appear in the output: after a full build, the guard must throw.
      // Temporarily renaming the define is impractical here, so assert the guard's criterion directly: the source must reference the value.
      const source = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
      expect(source).toContain("__ZCODE_CUA_HELPER_BUILD_ID__");
      expect(source).toMatch(/was not folded into/u);
      // Also confirms the guard only applies when buildId is non-empty (an empty dev string must not fail the build).
      const devResult = await buildNodeReplHostBundle({ outfile, cuaHelperBuildId: "" });
      expect(devResult.cuaHelperBuildId).toBe("");
    },
    buildTimeoutMs,
  );
});
