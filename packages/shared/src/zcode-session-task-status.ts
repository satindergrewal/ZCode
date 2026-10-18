// -- Legacy protocol compat surface (transition) ------------------------------
// Remaining 1 export: deriveZCodeTaskStatusFromSessionSnapshot.
// Consumers: zcodeTaskServiceAdapter / zcodeTaskIndexSyncer / zcodeSessionProjection (legacy projection stack).
import type { ZCodeSessionStateSnapshot } from "./zcode-protocol/index.js";
import { getZCodeUserVisibleMessages } from "./zcode-session-visible-content.js";
import type { ZCodeTaskMeta } from "./zcode-task-types-core.js";
type ZCodeTaskStatus = ZCodeTaskMeta["status"];

function statusFromZCodeSession(
  status: ZCodeSessionStateSnapshot["session"]["status"],
): ZCodeTaskStatus {
  if (status === "running" || status === "waiting" || status === "paused") {
    return "running";
  }
  if (status === "error") return "error";
  if (status === "completed") return "completed";
  return undefined;
}

function hasBlockingActiveSnapshotRuntime(snapshot: ZCodeSessionStateSnapshot): boolean {
  if (snapshot.runtime.activeTurnId || snapshot.runtime.activeTurnKind) {
    return true;
  }
  // projection.currentTurnId is the last projected turn boundary and survives completion;
  // only runtime active fields, permissions, or tool calls prove a real blocked-running state now.
  if ((snapshot.projection.pendingPermissions ?? []).length > 0) {
    return true;
  }
  return (snapshot.projection.activeToolCalls ?? []).some(
    (toolCall) => toolCall.status === "pending" || toolCall.status === "running",
  );
}

function hasActiveSnapshotRuntime(snapshot: ZCodeSessionStateSnapshot): boolean {
  return hasBlockingActiveSnapshotRuntime(snapshot);
}

function isToolCallContinuationFinish(finish: string | undefined): boolean {
  const normalized = finish?.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "tool-calls";
}

function hasCompletedVisibleAssistantTurn(snapshot: ZCodeSessionStateSnapshot): boolean {
  const visibleMessages = getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  });
  const latestVisibleMessage = visibleMessages.at(-1);
  if (latestVisibleMessage?.info.role !== "assistant") {
    return false;
  }
  if (isToolCallContinuationFinish(latestVisibleMessage.info.finish)) {
    return false;
  }
  return typeof latestVisibleMessage.info.time.completed === "number";
}

export function deriveZCodeTaskStatusFromSessionSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeTaskStatus {
  if (snapshot.projection.lastError) {
    return "error";
  }

  const status = statusFromZCodeSession(snapshot.session.status);
  if (status === "error" || status === "completed") {
    return status;
  }
  if (hasCompletedVisibleAssistantTurn(snapshot) && !hasBlockingActiveSnapshotRuntime(snapshot)) {
    // The desktop continuous session/read leans on the runtime projection.
    // Legacy projections may replay only to model_streaming finish, missing turn_complete, leaving currentTurnId
    // stale briefly or forever. The persisted assistant's completed time is more authoritative then.
    return "completed";
  }
  if (hasActiveSnapshotRuntime(snapshot)) {
    return status ?? "running";
  }
  return status;
}
