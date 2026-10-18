import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  acquireSessionsIndex,
  buildSessionsIndexEntryKey,
  releaseSessionsIndex,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import { logger } from "@/logger.js";

export interface WorkspaceSessionsIndexBinding {
  scope: SessionsIndexScope;
  agentService: SessionsIndexAgentService;
}

interface ActiveWorkspaceSessionsIndexEntry extends WorkspaceSessionsIndexBinding {
  store: SessionsIndexStore;
  unsubscribeStore: () => void;
}

function scopeLogKey(scope: SessionsIndexScope): string {
  return `${scope.endpointKey ?? "__base__"}:${scope.workspaceKey}`;
}

function isSameBinding(
  current: ActiveWorkspaceSessionsIndexEntry,
  next: WorkspaceSessionsIndexBinding,
): boolean {
  return (
    current.agentService === next.agentService &&
    current.scope.workspaceKey === next.scope.workspaceKey &&
    current.scope.workspacePath === next.scope.workspacePath &&
    current.scope.workspaceIdentity === next.scope.workspaceIdentity &&
    current.scope.endpointKey === next.scope.endpointKey
  );
}

/**
 * Holds sessions-index subscriptions by endpoint + workspaceKey.
 *
 * The legacy hook put the whole scopes array in one cleanup effect; removing a workspace made React
 * release every sibling subscription then re-acquire the rest, replacing live snapshots/watermarks with empty states.
 * Treat the scope array as a desired set; side-effect only truly added, removed, or generation-changed keys.
 */
export class WorkspaceSessionsIndexSubscriptionSet {
  private readonly active = new Map<string, ActiveWorkspaceSessionsIndexEntry>();

  constructor(private readonly onStoreChange: () => void) {}

  reconcile(bindings: readonly WorkspaceSessionsIndexBinding[]): boolean {
    const desired = new Map<string, WorkspaceSessionsIndexBinding>();
    for (const binding of bindings) {
      desired.set(buildSessionsIndexEntryKey(binding.scope), binding);
    }

    let changed = false;
    const releasedScopeKeys: string[] = [];
    const acquiredScopeKeys: string[] = [];
    for (const [entryKey, current] of this.active) {
      const next = desired.get(entryKey);
      if (next && isSameBinding(current, next)) {
        continue;
      }
      if (
        next &&
        current.agentService !== next.agentService &&
        (current.scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !==
          LOCAL_SESSIONS_INDEX_ENDPOINT
      ) {
        // If a remote service generation change released the only lease first, the registry would close the old store at once
        // and the later acquire would rebuild from empty. Acquire first so the registry rebinds the transport in place while the old entry lives,
        // then release the old lease; projection and consumer listeners never break.
        const store = acquireSessionsIndex(next.scope, next.agentService);
        const sameStore = store === current.store;
        const unsubscribeStore = sameStore
          ? current.unsubscribeStore
          : store.subscribe(this.onStoreChange);
        if (sameStore) {
          releaseSessionsIndex(current.scope, current.store);
        } else {
          this.disposeEntry(current);
        }
        this.active.set(entryKey, {
          ...next,
          store,
          unsubscribeStore,
        });
        releasedScopeKeys.push(scopeLogKey(current.scope));
        acquiredScopeKeys.push(scopeLogKey(next.scope));
        changed = true;
        continue;
      }
      releasedScopeKeys.push(scopeLogKey(current.scope));
      this.disposeEntry(current);
      this.active.delete(entryKey);
      changed = true;
    }

    for (const [entryKey, binding] of desired) {
      if (this.active.has(entryKey)) {
        continue;
      }
      const store = acquireSessionsIndex(binding.scope, binding.agentService);
      acquiredScopeKeys.push(scopeLogKey(binding.scope));
      this.active.set(entryKey, {
        ...binding,
        store,
        unsubscribeStore: store.subscribe(this.onStoreChange),
      });
      changed = true;
    }

    if (changed) {
      logger.info("[v4-sessions-index] workspace subscription set reconciled", {
        acquiredScopeKeys,
        releasedScopeKeys,
        activeCount: this.active.size,
      });
      this.onStoreChange();
    } else {
      logger.debug("[v4-sessions-index] workspace subscription set unchanged", {
        activeCount: this.active.size,
      });
    }
    return changed;
  }

  getStore(
    scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  ): SessionsIndexStore | undefined {
    return this.active.get(buildSessionsIndexEntryKey(scope))?.store;
  }

  size(): number {
    return this.active.size;
  }

  /** Released together when the hook truly unmounts (incl. StrictMode cleanup); later reconciles may re-establish. */
  dispose(): void {
    if (this.active.size > 0) {
      logger.info("[v4-sessions-index] workspace subscription set disposed", {
        releasedScopeKeys: [...this.active.values()].map((entry) => scopeLogKey(entry.scope)),
      });
    }
    for (const entry of this.active.values()) {
      this.disposeEntry(entry);
    }
    this.active.clear();
  }

  private disposeEntry(entry: ActiveWorkspaceSessionsIndexEntry): void {
    entry.unsubscribeStore();
    releaseSessionsIndex(entry.scope, entry.store);
  }
}
