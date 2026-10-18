import { useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  createWorkerWorkspaceFileSearchFilterBackend,
  type WorkspaceFileSearchFilterBackend,
} from "./workspaceFileSearchFilterBackend.js";

interface UseWorkspaceFileSearchFilterOptions {
  requireQuery?: boolean;
  limit?: number;
}

interface WorkspaceFileSearchFilterState {
  /** Entries filtered by query and mapped back to the originals (ordered). */
  items: WorkspaceFileEntry[];
  /**
   * Whether filtering for the current query is still in flight (async via Worker). Callers in
   * miss-detection paths must treat in-flight as "result unknown", never act on the momentary
   * empty list.
   */
  filtering: boolean;
}

/**
 * Shared entry point for workspace file search filtering: candidate scoring runs in a Web Worker
 * (falling back to synchronous main-thread execution) and results map back to entries. @ file
 * mentions and file tree search share the same semantics.
 *
 * Timing contract:
 * - entries changes (index rebuild) clear items first, then filter async, so stale results never
 *   leak into the new index;
 * - stale results from query changes are dropped via the backend seq mechanism (resolve null);
 * - the main thread never builds the full candidate map (measured ~630ms sync block at 370k
 *   entries; all moved into the worker); the worker is disposed on unmount.
 */
export function useWorkspaceFileSearchFilterEntries(
  packed: string,
  query: string,
  options: UseWorkspaceFileSearchFilterOptions,
  rootPath: string,
): WorkspaceFileSearchFilterState {
  const backendRef = useRef<WorkspaceFileSearchFilterBackend | null>(null);
  if (backendRef.current === null) {
    backendRef.current = createWorkerWorkspaceFileSearchFilterBackend();
  }
  const [items, setItems] = useState<WorkspaceFileEntry[]>([]);
  const [filtering, setFiltering] = useState(false);

  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) {
      return;
    }
    // Index rebuild: clear old results (the new index has not been filtered yet), then push all candidates (packed passthrough).
    setItems([]);
    backend.setPacked(packed, rootPath);
  }, [backendRef, packed, rootPath]);

  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) {
      return;
    }
    let cancelled = false;
    setFiltering(true);
    void backend.filter(query, options).then((result) => {
      if (cancelled) {
        return;
      }
      setFiltering(false);
      if (result === null) {
        // Stale result (newer index rebuild or filter ran); keep current items untouched.
        return;
      }
      setItems(result);
    });
    return () => {
      cancelled = true;
    };
    // entries must be a dependency: after an index rebuild (setEntries) filtering must rerun,
    // or results stay an empty list from the old index (this trigger was once lost in a refactor).
    // options is a fresh object literal each render; expanding its fields avoids per-frame refilters.
  }, [backendRef, options.limit, options.requireQuery, packed, query, rootPath]);

  useEffect(() => {
    return () => {
      backendRef.current?.dispose();
      backendRef.current = null;
    };
  }, [backendRef]);

  return { items, filtering };
}
