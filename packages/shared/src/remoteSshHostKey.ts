import type { RemoteTargetSnapshot } from "./protocol.js";
import type { SSHConnectOptions } from "./remoteTarget.js";

type SshRemoteHostKeyTarget = SSHConnectOptions | Extract<RemoteTargetSnapshot, { kind: "ssh" }>;

interface PrivateKeyPathRoot {
  prefix: string;
  body: string;
  blocksParentTraversal: boolean;
}

function splitPrivateKeyPathRoot(value: string): PrivateKeyPathRoot {
  const windowsDriveRoot = value.match(/^([A-Z]:)\/(.*)$/);
  if (windowsDriveRoot) {
    return {
      prefix: `${windowsDriveRoot[1]}/`,
      body: windowsDriveRoot[2] ?? "",
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("//")) {
    const segments = value.slice(2).split("/").filter(Boolean);
    if (segments.length >= 2) {
      const [server, share, ...bodySegments] = segments;
      return {
        prefix: `//${server}/${share}/`,
        body: bodySegments.join("/"),
        blocksParentTraversal: true,
      };
    }
    return {
      prefix: "//",
      body: segments.join("/"),
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("/")) {
    return {
      prefix: "/",
      body: value.replace(/^\/+/, ""),
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("~/")) {
    return {
      prefix: "~/",
      body: value.slice(2),
      blocksParentTraversal: false,
    };
  }

  const windowsDriveRelative = value.match(/^([A-Z]:)(.*)$/);
  if (windowsDriveRelative) {
    return {
      prefix: windowsDriveRelative[1] ?? "",
      body: windowsDriveRelative[2] ?? "",
      blocksParentTraversal: false,
    };
  }

  return {
    prefix: "",
    body: value,
    blocksParentTraversal: false,
  };
}

function normalizePrivateKeyPath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  const normalizedSeparators = trimmed.replace(/\\/g, "/");
  const driveNormalized = normalizedSeparators.replace(
    /^([a-z]):/i,
    (_, drive: string) => `${drive.toUpperCase()}:`,
  );
  const root = splitPrivateKeyPathRoot(driveNormalized);
  const segments: string[] = [];

  for (const segment of root.body.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
        continue;
      }
      // Drive letters, UNC shares, and POSIX roots are not plain segments; `..` must not pop the root;
      // relative paths and `~` cannot be safely evaluated browser-side, so keep unresolved parents rather than misreuse.
      if (root.blocksParentTraversal) {
        continue;
      }
      segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  return `${root.prefix}${segments.join("/")}` || root.prefix;
}

function resolveSshAuthKind(target: SshRemoteHostKeyTarget): "agent" | "password" | "private-key" {
  if (target.privateKeyPath?.trim()) {
    return "private-key";
  }
  if (
    ("password" in target && typeof target.password === "string") ||
    ("passwordCredentialKey" in target && Boolean(target.passwordCredentialKey?.trim()))
  ) {
    return "password";
  }
  return "agent";
}

/**
 * Builds the in-window SSH remote host's shared identity.
 * Passwords and key passphrases serve connection only; never enter the shared key or logs.
 */
export function buildSshRemoteHostKey(target: SshRemoteHostKeyTarget): string {
  return JSON.stringify([
    "ssh:v1",
    target.host.trim().toLowerCase(),
    target.port ?? 22,
    target.username.trim(),
    resolveSshAuthKind(target),
    normalizePrivateKeyPath(target.privateKeyPath),
  ]);
}
