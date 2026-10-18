import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type FilterWorkspaceFileSearchCandidatesOptions,
} from "./workspaceFileSearch.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";

/**
 * Workspace file-search filter worker: holds the full candidate set, scores queries and picks
 * the top-K off the main thread, returning ≤limit mapped entries so scoring and data movement
 * for hundreds of thousands of candidates never block the UI. Logic reuses the main-thread pure
 * functions (workspaceFileSearch.ts) so behavior matches the fallback path; entries travel as
 * column-packed strings (see the backend comment).
 */

let entries: WorkspaceFileEntry[] = [];
let candidates: ReturnType<typeof mapWorkspaceFileEntriesToSearchCandidates> = [];
let byId: Map<string, WorkspaceFileEntry> = new Map();

self.onmessage = (
  event: MessageEvent<{
    type: string;
    seq?: number;
    query?: string;
    options?: FilterWorkspaceFileSearchCandidatesOptions;
    packed?: string;
    rootPath?: string;
  }>,
) => {
  const data = event.data;
  if (data.type === "entries" && typeof data.packed === "string") {
    entries = unpackWorkspaceFileEntries(
      data.packed,
      typeof data.rootPath === "string" ? data.rootPath : "",
    );
    candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
    byId = new Map(entries.map((entry) => [entry.relativePath, entry]));
    return;
  }
  if (data.type === "filter" && typeof data.seq === "number" && typeof data.query === "string") {
    const result = filterWorkspaceFileSearchCandidates(candidates, data.query, data.options ?? {})
      .map((candidate) => byId.get(candidate.id) ?? null)
      .filter((entry): entry is WorkspaceFileEntry => entry !== null);
    (self as unknown as Worker).postMessage({ type: "result", seq: data.seq, entries: result });
  }
};
