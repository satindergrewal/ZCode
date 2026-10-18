import { access } from "node:fs/promises";
import { join } from "node:path";

export interface BundledAgentWiring {
  ZCODE_AGENT_SERVER_COMMAND: string;
  ZCODE_AGENT_SERVER_ARGS_JSON: string;
}

export function createReleaseAgentWiring(
  runtimeRoot: string,
  runtimeNode: string,
  env: Record<string, string | undefined>,
): BundledAgentWiring | null {
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) return null;
  return {
    ZCODE_AGENT_SERVER_COMMAND: runtimeNode,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
      join(runtimeRoot, "zcode.cjs"),
      "app-server",
      "--stdio",
    ]),
  };
}

/**
 * Inside the release, Core is neither in the monorepo nor has an Electron runtime, so
 * `zcodeAgentProcessManager`'s default resolution chain (monorepo dev -> Electron -> deployed remote
 * binary) finds nothing. Inject the bundled `zcode.cjs` as the agent command; the env override has the
 * highest priority in that chain, so an explicit `ZCODE_AGENT_SERVER_COMMAND` always wins, and dev
 * mode (no zcode.cjs next to the entry) is unaffected.
 */
export async function resolveBundledAgentWiring(
  entryDir: string,
  env: Record<string, string | undefined>,
): Promise<BundledAgentWiring | null> {
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) {
    return null;
  }
  const bundlePath = join(entryDir, "zcode.cjs");
  try {
    await access(bundlePath);
  } catch {
    return null;
  }
  return {
    ZCODE_AGENT_SERVER_COMMAND: process.execPath,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([bundlePath, "app-server", "--stdio"]),
  };
}
