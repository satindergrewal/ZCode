import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

interface SshConnectionHistorySuggestions {
  hosts: string[];
  ports: string[];
  usernames: string[];
  privateKeyPaths: string[];
}

function dedupeSuggestions(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const normalizedValue = value.trim();
    if (!normalizedValue || seen.has(normalizedValue)) {
      return [];
    }

    seen.add(normalizedValue);
    return [normalizedValue];
  });
}

export function buildSshConnectionHistorySuggestions(
  remoteWorkspaceSessions: readonly RemoteWorkspaceSessionEntry[],
): SshConnectionHistorySuggestions {
  const sshSnapshots = remoteWorkspaceSessions.flatMap((entry) =>
    entry.target.kind === "ssh" ? [entry.target] : [],
  );

  return {
    // Dedupe history candidates by most-recent connection; otherwise repeated connections stack
    // the same host/user entries and the dropdown hides the actually-latest one.
    hosts: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.host)),
    ports: dedupeSuggestions(sshSnapshots.map((snapshot) => String(snapshot.port ?? 22))),
    usernames: dedupeSuggestions(sshSnapshots.map((snapshot) => snapshot.username)),
    privateKeyPaths: dedupeSuggestions(
      sshSnapshots.map((snapshot) => snapshot.privateKeyPath ?? ""),
    ),
  };
}
