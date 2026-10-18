import { useEffect, useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { pendingCommandRegistry, type PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { isPendingCommandForWorkspace } from "@/v4/pendingCommandWorkspace.js";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";

interface UsePendingCommandRecoveryOptions {
  layer: SessionDataLayer;
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  status: "connecting" | "live" | "error" | "closed";
  subscriptionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * React seam of the pending registry: projection settles via queue/guided/transcript anchors;
 * the remote query runs only when the subscription generation goes live, never per streaming
 * snapshot.
 */
export function usePendingCommandRecovery({
  layer,
  sessionId,
  snapshot,
  status,
  subscriptionId,
  workspacePath,
  workspaceIdentity,
}: UsePendingCommandRecoveryOptions): readonly PendingCommandEntry[] {
  const [version, setVersion] = useState(0);

  useEffect(() => pendingCommandRegistry.subscribe(() => setVersion((current) => current + 1)), []);

  useEffect(() => {
    if (snapshot) pendingCommandRegistry.reconcileSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (status !== "live" || subscriptionId === null) return;
    // The current session and createSession (null bucket) query in parallel; the registry single-flights each.
    const targets: Array<string | null> = sessionId === null ? [null] : [sessionId, null];
    void Promise.all(
      targets.map((target) =>
        pendingCommandRegistry.reconcileSession(target, (params) => layer.queryCommands(params)),
      ),
    ).catch((error) => {
      logger.warn(
        "[v4-pending-command] reconnect reconciliation failed; ledger kept for the next connection",
        error,
      );
    });
  }, [layer, sessionId, status, subscriptionId]);

  // version is the registry's narrow subscription signal; never copy the whole ledger into React state.
  void version;
  const scoped = pendingCommandRegistry.listRecoverable(sessionId);
  const recoverableCreates = pendingCommandRegistry
    .listRecoverable(null)
    .filter((entry) => isPendingCommandForWorkspace(entry, workspacePath, workspaceIdentity));
  // A null bucket only means createSession has no session yet, never that it lacks a workspace.
  // Every pane subscribes to the same registry; isolate by workspace identity before display/consumption.
  return sessionId === null ? recoverableCreates : [...scoped, ...recoverableCreates];
}
