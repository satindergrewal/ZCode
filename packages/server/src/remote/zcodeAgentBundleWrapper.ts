// The remote ZCode Agent runs as "standalone node + compiled zcode.cjs", not as a
// native binary with an embedded per-platform node. The remote deploy already
// ships a standalone node (for zcode-server.cjs); the agent reuses it to run zcode.cjs.
//
// Deploy layout: place zcode.cjs at agents/<provider>/zcode.cjs and write a
// same-named wrapper -- the executable entry the resolver expects (e.g.
// agents/glm/zcode-agent) -- which runs zcode.cjs via the remote node. Provider
// runtime resolvers then need no native/JS distinction and keep looking for the
// zcode-agent executable. Dev and production share one wrapper semantic.

export const REMOTE_AGENT_BUNDLE_NAME = "zcode.cjs";

export function buildRemoteAgentBundleWrapper(runtimeResourceDir: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'runtime_root="${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}"',
    `exec "$runtime_root/node" "$HOME/.zcode/server/agents/${runtimeResourceDir}/${REMOTE_AGENT_BUNDLE_NAME}" "$@"`,
    "",
  ].join("\n");
}

export function isRemoteAgentBundleWrapperCurrent(
  content: string,
  runtimeResourceDir: string,
): boolean {
  return content.replace(/\r\n/g, "\n") === buildRemoteAgentBundleWrapper(runtimeResourceDir);
}
