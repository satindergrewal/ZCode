// Unified parsing of remote workspace identities (Workspace Identity rule: construction and parsing
// must reuse these utilities; business code never hand-rolls the formats).
// Construction (the dual): buildRemoteWorkspaceIdentity in
// packages/ui/src/lib/remoteWorkspaceHistory.ts -- the format contract:
//   remote:ssh:<host>:<port>:<username>:<posixPath>
//   remote:wsl:<distro>[:<user>]:<posixPath>
//   remote:docker:<container>:<posixPath>
// The path segment normalizes via normalizeWorkspacePathForIdentity (separators -> /, trailing slashes stripped,
// empty -> /), so it always starts with /; authority segments contain no / (host lowercased, port numeric, and the legal
// alphabets of docker container/wsl distro names have neither : nor /).
// Consumer: the CLI v4 createSession workspaceId (remote pane's workspaceKey = identity) needs the real
// workspacePath back as the session workingDirectory.
import type { RemoteTarget } from "./remoteTarget.js";

export type RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  /// The remote's real path (posix-normalized).
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

/** Mandatory authority segment count (excluding kind): ssh = host/port/username, other remote kinds = one. */
const AUTHORITY_SEGMENTS: Record<RemoteWorkspaceIdentityKind, number> = {
  ssh: 3,
  wsl: 1,
  docker: 1,
};

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh" || value === "wsl" || value === "docker";
}

function normalizeWorkspacePathForIdentity(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

/**
 * The single constructor of remote workspace identities. Host, main, and UI never concat authorities themselves;
 * workspacePath enters the identity key only after normalization here, while actual IO keeps the caller's original path.
 */
export function buildRemoteWorkspaceIdentity(workspacePath: string, target: RemoteTarget): string {
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  switch (target.kind) {
    case "ssh":
      return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
    case "wsl": {
      const distro = target.distro?.trim() || "default";
      const user = target.user?.trim();
      return user
        ? `remote:wsl:${distro}:${user}:${normalizedPath}`
        : `remote:wsl:${distro}:${normalizedPath}`;
    }
    case "docker":
      return `remote:docker:${target.container}:${normalizedPath}`;
  }
}

/**
 * Parse a remote workspace identity; null for invalid/non-remote (callers fall back to
 * by-local-workspacePath handling). Extracts workspacePath only--authority details
 *(host/port...) are meaningless to consumers (the CLI runs on the remote) and are not exposed.
 */
export function parseRemoteWorkspaceIdentity(
  identity: string,
): ParsedRemoteWorkspaceIdentity | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    return null;
  }
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) {
    return null;
  }
  const kind = rest.slice(0, kindEnd);
  if (!isRemoteWorkspaceIdentityKind(kind)) {
    return null;
  }
  // Consume the authority segment by segment; the path may contain : (legal in posix paths),
  // so no whole-string split--advance per segment and take the remainder as the path.
  let cursor = kindEnd + 1;
  for (let i = 0; i < AUTHORITY_SEGMENTS[kind]; i++) {
    const next = rest.indexOf(":", cursor);
    if (next <= cursor) {
      return null;
    }
    cursor = next + 1;
  }
  // WSL identity added an optional user segment to tell default from explicit users; the legacy
  // parser consumed only the distro, misreading user as path and failing the whole identity. Remote paths
  // always start with /, so legacy no-user and explicit-user forms separate unambiguously.
  if (kind === "wsl" && rest[cursor] !== "/") {
    const userEnd = rest.indexOf(":", cursor);
    if (userEnd <= cursor) {
      return null;
    }
    cursor = userEnd + 1;
  }
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) {
    return null;
  }
  return { kind, workspacePath };
}

/** Is this a remote workspace identity (parseable by parseRemoteWorkspaceIdentity)? */
export function isRemoteWorkspaceIdentity(identity: string): boolean {
  return parseRemoteWorkspaceIdentity(identity) !== null;
}
