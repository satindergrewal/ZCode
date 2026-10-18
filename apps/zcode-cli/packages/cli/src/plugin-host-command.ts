import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts/plugins";
import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
} from "@zcode/shared/runtime-env";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import type { RunContext } from "@zcode/shared-types";

const HOST_USAGE = `${ZCODE_PLUGIN_HOST_COMMAND} <server-path> [-- <server-arg>...]`;

type HostedPluginModule = {
  main?: unknown;
};

export function isPluginHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_PLUGIN_HOST_COMMAND;
}

// __zcode-plugin-host runs official plugins' MCP servers (server.js) inside an agent subprocess.
// main.ts's applyCliRuntimeEnvSanitization first moves the broker token out of process.env into an in-process
// capture; this is therefore the last host boundary that restores the bearer token. The capture only proves that
// some Agent process once received Helper credentials -- not that the server passed in now is the official zcode-cua:
// restoring the token to any server path on capture's mere existence would let third-party/replaced plugins gain the CUA
// broker's TCC powers. Also verify the plugin id written by the resolver authority, the complete captured credential set,
// and the canonical broker socket; any mismatch rejects before the import, never exposing the token after loading an untrusted module.
export async function runPluginHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  if (argv.length < 1) {
    ctx.stderr.write(`Usage: ${HOST_USAGE}\n`);
    return 1;
  }

  const [rawServerPath, ...serverArgs] = argv;

  try {
    if (rawServerPath === undefined) {
      throw new Error("Plugin server path is required.");
    }

    const serverPath = resolve(rawServerPath);
    if (!existsSync(serverPath)) {
      throw new Error("Plugin server file does not exist.");
    }
    const capturedBrokerCredentials = getCapturedZCodeCuaBrokerCredentials();
    assertCapturedBrokerLaunchIsAuthorized(capturedBrokerCredentials);
    const module = (await import(pathToFileURL(serverPath).href)) as HostedPluginModule;
    if (typeof module.main !== "function") {
      throw new Error("Plugin server does not export main().");
    }

    const originalArgv = process.argv;
    const originalBrokerSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
    // shared node_repl restores the same credential set into the environment for the broker bridge; the old standalone CUA
    // MCP no longer owns an execution entry.
    process.argv = [process.execPath, serverPath, ...serverArgs];
    if (capturedBrokerCredentials.socket && process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] === "1") {
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = capturedBrokerCredentials.socket;
    }
    try {
      await module.main();
    } finally {
      process.argv = originalArgv;
      if (originalBrokerSocket === undefined) {
        delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
      } else {
        process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = originalBrokerSocket;
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Plugin host failed: ${message}\n`);
    return 1;
  }
}

type CapturedBrokerCredentials = ReturnType<typeof getCapturedZCodeCuaBrokerCredentials>;

function assertCapturedBrokerLaunchIsAuthorized(credentials: CapturedBrokerCredentials): void {
  const hasCapturedCredentials = Boolean(credentials.socket || credentials.pluginAuthority);
  if (!hasCapturedCredentials) return;

  const pluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase();
  // The credential set no longer carries a token: the broker switched to identity mode on all platforms (the Helper adjudicates connections by peer code signature),
  // and shared/runtimeEnv.ts's CapturedCuaBrokerCredentials only has socket + pluginAuthority
  // (+ refreshMarker). Do not read credentials.token here; the token left the set,
  // and leftover readers surface only via the CLI's own typecheck (the root pnpm typecheck excludes apps/zcode-cli).
  // socket + pluginAuthority must be paired (the authority is a provenance nonce bootstrap writes into the node_repl config,
  // by which core recognizes the official server); the capture side only snapshots paired sets and clears half-sets fail-closed.
  // Validation must not require a token either -- identity-mode credentials have none, and strict checks would make the node_repl host
  // exit at startup (connection closed during the server/discover probe) with an empty tool surface.
  if (
    credentials.socket === undefined ||
    credentials.pluginAuthority === undefined ||
    pluginId !== ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] !== "1"
  ) {
    throw new Error(
      "Captured ZCode CUA broker credentials may only launch the trusted shared node_repl host",
    );
  }
}
