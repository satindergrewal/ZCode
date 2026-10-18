import type { WorkspaceFileEntry } from "@zcode/shared";
import { logger } from "@/logger.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type FilterWorkspaceFileSearchCandidatesOptions,
} from "./workspaceFileSearch.js";

/**
 * Workspace file search filter backend abstraction: where candidate scoring and top-K sorting run.
 *
 * Background: once directories like node_modules are included the candidate pool reaches hundreds
 * of thousands, and synchronous main-thread scoring costs 50-300ms per keystroke — scoring moved
 * into a Web Worker. Data transfer cannot use structured cloning either: postMessage-cloning 370k
 * entries measured ~471ms of main-thread block (a top cause of the @ panel freezing the window for
 * seconds), so the worker transfer uses columnar packed strings (~31ms measured) and the worker
 * decodes and builds candidates.
 *
 * The synchronous implementation remains for two uses: (1) the fallback when no Worker is
 * available or it fails, with historical behavior; (2) injection in unit tests (Node has no
 * Web Worker).
 */
export interface WorkspaceFileSearchFilterBackend {
  /** Full candidate update (columnar packed string + rootPath used to rebuild name/path); invalidates existing filter results. */
  setPacked(packed: string, rootPath: string): void;
  /**
   * Filter by query and return the ordered entry list (mapped back to originals, at most limit).
   * The promise never rejects: stale results (after setEntries or a newer filter) resolve null,
   * which callers treat as "discard".
   */
  filter(
    query: string,
    options: FilterWorkspaceFileSearchCandidatesOptions,
  ): Promise<WorkspaceFileEntry[] | null>;
  dispose(): void;
}

export function createSyncWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  let candidates: ReturnType<typeof mapWorkspaceFileEntriesToSearchCandidates> = [];
  let byId: Map<string, WorkspaceFileEntry> = new Map();
  return {
    setPacked(packed, rootPath) {
      const entries = unpackWorkspaceFileEntries(packed, rootPath);
      candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
      byId = new Map(entries.map((entry) => [entry.relativePath, entry]));
    },
    filter(query, options) {
      return Promise.resolve(
        filterWorkspaceFileSearchCandidates(candidates, query, options)
          .map((candidate) => byId.get(candidate.id) ?? null)
          .filter((entry): entry is WorkspaceFileEntry => entry !== null),
      );
    },
    dispose() {
      candidates = [];
      byId = new Map();
    },
  };
}

export function createWorkerWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  // Node test environments (vitest node project) have no module worker runtime: use the sync path.
  // Environments with document but no Worker implementation (jsdom etc.) fall back via try/catch below.
  if (typeof document === "undefined") {
    return createSyncWorkspaceFileSearchFilterBackend();
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./workspaceFileSearchFilter.worker.ts", import.meta.url), {
      type: "module",
      name: "zcode-workspace-file-search",
    });
  } catch (error) {
    // Fallback: very old event loops/test environments without module worker support sync scoring.
    logger.warn("[workspace-file-search] Worker creation failed, falling back to sync filtering", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createSyncWorkspaceFileSearchFilterBackend();
  }

  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (entries: WorkspaceFileEntry[] | null) => void }
  >();

  worker.onmessage = (
    event: MessageEvent<{ type: string; seq?: number; entries?: WorkspaceFileEntry[] }>,
  ) => {
    const data = event.data;
    if (data.type !== "result" || typeof data.seq !== "number") {
      return;
    }
    const waiter = pending.get(data.seq);
    if (!waiter) {
      return;
    }
    pending.delete(data.seq);
    waiter.resolve(Array.isArray(data.entries) ? data.entries : null);
  };

  worker.onerror = (event) => {
    // Runtime failure: expire all in-flight requests (null); later filters retry. Persistent
    // failure surfaces to callers as empty results and never blocks typing.
    logger.warn("[workspace-file-search] Worker runtime failure, discarding filter round", {
      message: event.message,
    });
    for (const [, waiter] of pending) {
      waiter.resolve(null);
    }
    pending.clear();
  };

  return {
    setPacked(packed, rootPath) {
      seq += 1;
      for (const [, waiter] of pending) {
        waiter.resolve(null);
      }
      pending.clear();
      // packed is produced directly by the Host-side listWorkspaceFiles (RPC returns the string,
      // memcpy-grade transfer); the renderer never materializes entry objects — saving 11-14s of
      // structured cloning measured at 370k entries.
      worker.postMessage({ type: "entries", packed, rootPath });
    },
    filter(query, options) {
      seq += 1;
      const currentSeq = seq;
      return new Promise<WorkspaceFileEntry[] | null>((resolve) => {
        pending.set(currentSeq, { resolve });
        worker.postMessage({
          type: "filter",
          seq: currentSeq,
          query,
          options,
        });
      });
    },
    dispose() {
      seq += 1;
      for (const [, waiter] of pending) {
        waiter.resolve(null);
      }
      pending.clear();
      worker.terminate();
    },
  };
}
