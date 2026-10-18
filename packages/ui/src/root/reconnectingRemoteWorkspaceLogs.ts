import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

interface ReconnectingRemoteWorkspaceEntry {
  workspaceKey?: string;
  id?: string;
  requestId?: string;
  target: RemoteWorkspaceSessionEntry["target"];
}

function sanitizeRemoteWorkspaceReconnectLogLabelSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "-");
}

function getRemoteWorkspaceReconnectLogTargetSuffix(
  target: RemoteWorkspaceSessionEntry["target"],
): string {
  switch (target.kind) {
    case "ssh":
      return target.host;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `${distro}-${user}` : distro;
    }
    case "docker":
      return target.container;
  }
}

function buildRemoteWorkspaceReconnectLogLabelPrefix(
  target: RemoteWorkspaceSessionEntry["target"],
): string {
  return `remote-workspace-${target.kind}-${sanitizeRemoteWorkspaceReconnectLogLabelSegment(getRemoteWorkspaceReconnectLogTargetSuffix(target))}-`;
}

export function resolveRemoteWorkspaceReconnectLogWorkspaceKeys({
  runtimeLabel,
  runtimeRequestId,
  reconnectingEntries,
}: {
  runtimeLabel: string;
  runtimeRequestId?: string;
  reconnectingEntries: ReconnectingRemoteWorkspaceEntry[];
}): string[] {
  const normalizedRuntimeRequestId = runtimeRequestId?.trim();
  if (normalizedRuntimeRequestId) {
    return reconnectingEntries
      .filter((entry) => entry.requestId?.trim() === normalizedRuntimeRequestId)
      .map((entry) => entry.workspaceKey ?? entry.id ?? "")
      .filter((workspaceKey) => workspaceKey.length > 0);
  }

  if (!runtimeLabel.startsWith("remote-workspace-")) {
    return [];
  }

  const matchedEntries = reconnectingEntries.filter((entry) =>
    runtimeLabel.startsWith(buildRemoteWorkspaceReconnectLogLabelPrefix(entry.target)),
  );
  // Legacy logs carry no requestId; the target label prefix is the only fallback.
  // Concurrent reconnects to one target share the prefix, so copying to every workspace threads diagnostics into the wrong tooltip.
  // Attribute by prefix only on a unique hit; with multiple hits, wait for requestId-routed logs instead of guessing.
  if (matchedEntries.length !== 1) {
    return [];
  }

  return matchedEntries
    .map((entry) => entry.workspaceKey ?? entry.id ?? "")
    .filter((workspaceKey) => workspaceKey.length > 0);
}
