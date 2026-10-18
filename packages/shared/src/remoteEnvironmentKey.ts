import type { RemoteTarget } from "./remoteTarget.js";
import { buildSshRemoteHostKey } from "./remoteSshHostKey.js";

/**
 * Stable identity for Environment-scoped state such as Provider Provisioning; never mixed with workspace/session identity.
 */
export function buildRemoteEnvironmentKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "<default>"}\0${target.user?.trim() || "<default>"}`;
    case "docker":
      return `docker:${target.container.trim()}`;
    case "server":
      return `server:${target.serverId?.trim() || normalizeServerEndpoint(target.url)}`;
  }
}

function normalizeServerEndpoint(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const path = parsed.pathname.replace(/\/+$/gu, "");
    parsed.pathname = path.endsWith("/ws") ? path.slice(0, -3) || "/" : path || "/";
    return parsed.toString().replace(/\/$/gu, "");
  } catch {
    return url.trim().replace(/\/+$/gu, "");
  }
}
