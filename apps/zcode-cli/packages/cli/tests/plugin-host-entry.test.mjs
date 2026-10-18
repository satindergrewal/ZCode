import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  createZodDedupePlugin,
  readZodBuildVersion,
  resolveBuildAliases,
  resolveBuildExternal,
} from "../scripts/build.mjs";

const execFileAsync = promisify(execFile);
const cliRoot = resolve(import.meta.dirname, "..");
const forbiddenEvaluation = "AGENT_ENTRY_EVALUATED";
const processTimeoutMs = 10_000;

for (const minify of [false, true]) {
  test(`plugin host avoids Agent initialization in ${minify ? "desktop" : "Node"} bundles`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-entry-"));
    const outfile = join(directory, "zcode.cjs");
    const serverPath = join(directory, "server.mjs");
    const blockedModules = new Set([
      resolve(cliRoot, "src/run.ts"),
      resolve(cliRoot, "src/provider-runtime-env.ts"),
      resolve(cliRoot, "../core/dist/runtime.js"),
      resolve(cliRoot, "../contracts/dist/index.js"),
      resolve(cliRoot, "../../../../packages/shared/src/index.ts"),
    ]);

    try {
      await writeFile(
        serverPath,
        `const socketVisibleAtImport = process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET !== undefined;
export async function main() {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    nodeEnvRemoved: process.env.NODE_ENV === undefined,
    socketVisibleAtImport,
    socketVisibleAtMain: process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET !== undefined,
    tokenVisibleAtMain: process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN !== undefined,
  }));
}`,
      );
      await build({
        alias: resolveBuildAliases(),
        bundle: true,
        entryPoints: [join(cliRoot, "src/main.ts")],
        external: resolveBuildExternal(),
        format: "cjs",
        keepNames: minify,
        minify,
        metafile: true,
        outfile,
        platform: "node",
        target: "node22",
        plugins: [
          createZodDedupePlugin({ expectedV4Version: await readZodBuildVersion() }),
          {
            name: "reject-agent-initialization",
            setup(builder) {
              builder.onLoad({ filter: /\.[jt]s$/ }, async ({ path }) => {
                if (!blockedModules.has(path)) return undefined;
                // The regression must block module evaluation, not merely check bundle size; the build keeps what the plain CLI needs.
                return {
                  contents: `throw new Error(${JSON.stringify(forbiddenEvaluation)});\n${await readFile(path, "utf8")}`,
                  loader: path.endsWith(".ts") ? "ts" : "js",
                };
              });
            },
          },
        ],
      });

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [outfile, "__zcode-plugin-host", serverPath, "--prompt", "plugin argument"],
        { env: { ...process.env, NODE_ENV: "untrusted" }, timeout: processTimeoutMs },
      );
      assert.equal(stderr, "");
      assert.deepEqual(JSON.parse(stdout), {
        args: ["--prompt", "plugin argument"],
        nodeEnvRemoved: true,
        socketVisibleAtImport: false,
        socketVisibleAtMain: false,
        tokenVisibleAtMain: false,
      });

      const brokerSocket = join(directory, "broker.sock");
      const authorizedEnv = {
        ...process.env,
        NODE_ENV: "untrusted",
        ZCODE_PLUGIN_ID: "computer-use@zcode-plugins-official",
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: brokerSocket,
        ZCODE_CUA_PERMISSION_BROKER_TOKEN: "test-scoped-token",
        ZCODE_CUA_PLUGIN_AUTHORITY: "test-official-authority",
        // The broker moved to identity mode (the Helper admits connections by peer code signature), leaving the credential set with socket +
        // pluginAuthority only; the captured credentials may start just the shared node_repl host, declared by this marker.
        ZCODE_CUA_NODE_REPL_HOST: "1",
      };
      const authorized = await execFileAsync(
        process.execPath,
        [outfile, "__zcode-plugin-host", serverPath, "--permission-broker-socket", brokerSocket],
        { env: authorizedEnv, timeout: processTimeoutMs },
      );
      assert.equal(authorized.stderr, "");
      assert.deepEqual(JSON.parse(authorized.stdout), {
        args: ["--permission-broker-socket", brokerSocket],
        nodeEnvRemoved: true,
        // The socket is sanitized into the capture and unreadable during plugin module evaluation; only the plugin host
        // restores it to env after verifying the trusted node_repl host, for the broker bridge to read.
        socketVisibleAtImport: false,
        socketVisibleAtMain: true,
        // The token was removed from the credential set and is no longer restored by the host.
        tokenVisibleAtMain: false,
      });

      // Non-node_repl hosts must be rejected before the plugin import; early entry branching must not bypass product auth.
      // The old contract compared the argv socket value; identity mode requires the host marker instead. The interception timing requirement is unchanged.
      await writeFile(serverPath, 'throw new Error("UNAUTHORIZED_PLUGIN_IMPORTED");');
      const { ZCODE_CUA_NODE_REPL_HOST: _hostMarker, ...unauthorizedEnv } = authorizedEnv;
      await assert.rejects(
        execFileAsync(
          process.execPath,
          [outfile, "__zcode-plugin-host", serverPath, "--permission-broker-socket", brokerSocket],
          { env: unauthorizedEnv, timeout: processTimeoutMs },
        ),
        (error) =>
          error.stdout === "" &&
          error.stderr.includes("Captured ZCode CUA broker credentials may only launch") &&
          !error.stderr.includes("UNAUTHORIZED_PLUGIN_IMPORTED"),
      );

      // Proves the probe is live: a plain command still reaches the business branch and triggers the injected evaluation error.
      await assert.rejects(
        execFileAsync(process.execPath, [outfile, "--version"], { timeout: processTimeoutMs }),
        (error) => error.stderr.includes(forbiddenEvaluation),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}
