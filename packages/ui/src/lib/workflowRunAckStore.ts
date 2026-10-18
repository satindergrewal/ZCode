// Acknowledged workflow runs.
// A settled run line stays visible until the user opens that session -- no timers, no settledAt;
// just this bounded, persisted runId set: opening a session bulk-inserts every then-settled run.
// Desktop uses localStorage; phone-remote runs the same code against its own browser storage.
import { useMemo, useSyncExternalStore } from "react";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const WORKFLOW_RUN_ACK_STORAGE_KEY = "zcode-workflow-run-acknowledged";
/** Set cap; evict the earliest-acknowledged when full. 256 dwarfs any session list's concurrent settled runs. */
export const WORKFLOW_RUN_ACK_LIMIT = 256;

export interface WorkflowRunAckStore {
  isAcknowledged(runId: string): boolean;
  acknowledge(runIds: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  /** Version snapshot: +1 on every set change, for useSyncExternalStore equality. */
  getVersion(): number;
}

function readStored(storage: StorageLike | null): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(WORKFLOW_RUN_ACK_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export function createWorkflowRunAckStore(storage: StorageLike | null): WorkflowRunAckStore {
  // Insertion order = acknowledgment order; Set iteration evicts the oldest first.
  const acknowledged = new Set<string>(readStored(storage).slice(-WORKFLOW_RUN_ACK_LIMIT));
  const listeners = new Set<() => void>();
  let version = 0;
  const persist = () => {
    if (storage === null) return;
    try {
      storage.setItem(WORKFLOW_RUN_ACK_STORAGE_KEY, JSON.stringify([...acknowledged]));
    } catch {
      // Storage unavailable (private mode, quota): still effective this session, just not across restarts.
    }
  };
  return {
    isAcknowledged: (runId) => acknowledged.has(runId),
    acknowledge: (runIds) => {
      let changed = false;
      for (const runId of runIds) {
        if (acknowledged.has(runId)) continue;
        acknowledged.add(runId);
        changed = true;
      }
      if (!changed) return;
      while (acknowledged.size > WORKFLOW_RUN_ACK_LIMIT) {
        const oldest = acknowledged.values().next().value;
        if (oldest === undefined) break;
        acknowledged.delete(oldest);
      }
      version += 1;
      persist();
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let defaultStore: WorkflowRunAckStore | null = null;

export function getWorkflowRunAckStore(): WorkflowRunAckStore {
  defaultStore ??= createWorkflowRunAckStore(getBrowserStorage());
  return defaultStore;
}

/** 测试用：换掉单例（含 `null` 复位）。 */
export function setWorkflowRunAckStoreForTesting(store: WorkflowRunAckStore | null): void {
  defaultStore = store;
}

/** Subscribe to the acknowledged-set version; the returned predicate is re-created per version so callers recompute row selection. */
export function useWorkflowRunAcknowledged(): (runId: string) => boolean {
  const store = getWorkflowRunAckStore();
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // New predicate reference per version: callers put it in useMemo deps so row selection recomputes on any set change.
  return useMemo(() => (runId: string) => store.isAcknowledged(runId), [store, version]);
}
