// Authoritative version counter for tasks-index rows/membership.
// sessions-index carries only list liveness and detail; task create/delete plus organizational
// state (pin/archive/unread...) persists in tasks-index.sqlite, so derived lists cannot sense
// new rows or membership changes from session events alone. Bump this after each mutation so
// every task-row left table + session-detail join refetches and refilters.
import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

/** Call after any task-row/membership mutation: tells every sessions-index-derived list to refetch its left table. */
export function bumpTaskListMembershipVersion(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeTaskListMembershipVersion(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTaskListMembershipVersion(): number {
  return version;
}

// One workspace_task_list_changed arrives over several subscription paths (the useGlobalTaskList
// shared fan-out plus useWorkspaceTaskLists's own subscription, distinct object identities after
// RPC deserialization) and bumps once per path, so one membership mutation triggers repeated
// global membership refetches. Dedup by event content over a short window: the key includes the
// meta time fields (updatedAt/unreadAt) so only redeliveries of the same event merge; rapid
// real mutations (pin->unpin etc.) differ in reason/timestamp and pass through. Events without
// meta (bulk archive/group ops) have no reliable key and are never deduped.
const BUMP_DEDUPE_WINDOW_MS = 500;
const BUMP_DEDUPE_MAX_KEYS = 256;
const recentBumpAtByKey = new Map<string, number>();

interface MembershipBumpEventLike {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
  reason: string;
  taskMeta?: {
    updatedAt: number;
    unreadAt?: number;
  };
}

export function bumpTaskListMembershipVersionForWorkspaceEvent(
  event: MembershipBumpEventLike,
): void {
  if (!event.taskMeta || !event.taskId) {
    bumpTaskListMembershipVersion();
    return;
  }
  const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
  const dedupeKey = [
    workspaceKey,
    event.taskId,
    event.reason,
    event.taskMeta.updatedAt,
    event.taskMeta.unreadAt ?? "",
  ].join("::");
  const now = Date.now();
  const lastBumpAt = recentBumpAtByKey.get(dedupeKey);
  if (lastBumpAt !== undefined && now - lastBumpAt < BUMP_DEDUPE_WINDOW_MS) {
    return;
  }
  for (const [key, bumpedAt] of recentBumpAtByKey) {
    if (now - bumpedAt >= BUMP_DEDUPE_WINDOW_MS) {
      recentBumpAtByKey.delete(key);
    }
  }
  if (recentBumpAtByKey.size < BUMP_DEDUPE_MAX_KEYS) {
    recentBumpAtByKey.set(dedupeKey, now);
  }
  bumpTaskListMembershipVersion();
}

/** React binding: version bumps re-render (subscribe/get are module-level, stable references). */
export function useTaskListMembershipVersion(): number {
  return useSyncExternalStore(
    subscribeTaskListMembershipVersion,
    getTaskListMembershipVersion,
  );
}
