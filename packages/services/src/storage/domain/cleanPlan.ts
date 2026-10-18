/**
 * Clean plan: given a category and candidate files, decide what is deletable. Pure; adapters delete.
 */
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  isProtectedStoragePath,
  type StorageCatalogContext,
} from "./storageCatalog.js";
import type { StorageCategoryId } from "@zcode/shared";

export interface StorageCleanCandidate {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

export interface StorageCleanPlan {
  targets: StorageCleanCandidate[];
  skippedCount: number;
}

/** Subagent products: skip the whole session dir when touched within 24h, sparing live subagent transcripts. */
export const SUBAGENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function planStorageClean(params: {
  categoryId: StorageCategoryId;
  candidates: StorageCleanCandidate[];
  context: StorageCatalogContext;
  now: number;
}): StorageCleanPlan {
  const { categoryId, candidates, context, now } = params;
  if (getStorageCategoryCleanability(categoryId) === "none") {
    return { targets: [], skippedCount: candidates.length };
  }
  // Prefix enumeration can mix categories (cache under cli/plugins); keep only same-category, unprotected entries.
  const owned = candidates.filter(
    (candidate) =>
      classifyStoragePath(candidate.relativePath, context).categoryId === categoryId &&
      !isProtectedStoragePath(candidate.relativePath),
  );
  let targets = owned;
  if (categoryId === "logs") {
    targets = owned.filter((candidate) => !isSameLocalDay(candidate.mtimeMs, now));
  } else if (categoryId === "subagentTranscripts") {
    // Activity judged on owned files only (category-filtered to transcript.jsonl) would miss
    // fresh metadata/output siblings and mark live transcripts inactive; use every candidate for recency.
    targets = filterInactiveSessionDirs(owned, candidates, now);
  }
  return { targets, skippedCount: candidates.length - targets.length };
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Session dir = first three segments (cli/agents/sess_x); any recent file skips the group. */
function filterInactiveSessionDirs(
  targets: StorageCleanCandidate[],
  allCandidates: StorageCleanCandidate[],
  now: number,
): StorageCleanCandidate[] {
  const latestBySession = new Map<string, number>();
  const sessionKey = (path: string) => path.split("/").slice(0, 3).join("/");
  for (const candidate of allCandidates) {
    const key = sessionKey(candidate.relativePath);
    latestBySession.set(key, Math.max(latestBySession.get(key) ?? 0, candidate.mtimeMs));
  }
  return targets.filter(
    (candidate) =>
      now - (latestBySession.get(sessionKey(candidate.relativePath)) ?? 0) >
      SUBAGENT_ACTIVE_WINDOW_MS,
  );
}
