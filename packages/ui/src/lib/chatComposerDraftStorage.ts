/**
 * Cleanup of legacy composer-draft localStorage persistence.
 *
 * Store cleanup: the in-memory composer draft state (composerDraftByScopeId) and persistence writes
 * (persistComposerDraft/readPersistedComposerDraft) were removed with the legacy ChatView/composer,
 * and the v4 composer does not persist locally. Only the janitor that clears stale draft keys of
 * deleted tasks survives here, so upgraded installs do not keep drafts forever.
 */
import { logger } from "@/logger.js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedComposerDraftFile {
  version: 1;
  scopes: Record<string, unknown>;
}

const STORAGE_KEY_PREFIX = "zcode-chat-composer-drafts:v1:";
const ROOT_COMPOSER_DRAFT_SCOPE_ID = "__draft__";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getComposerDraftStorageKey(workspacePath: string, workspaceIdentity?: string) {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function readPersistedDraftFile(
  storage: StorageLike | null,
  key: string,
): PersistedComposerDraftFile | null {
  let rawValue: string | null = null;
  try {
    rawValue = storage?.getItem(key) ?? null;
  } catch (error) {
    logger.warn("[chatComposerDraftStorage] Failed to read persisted composer drafts", {
      error: error instanceof Error ? error.message : String(error),
      key,
    });
  }
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<PersistedComposerDraftFile>;
    if (parsed.version !== 1 || typeof parsed.scopes !== "object" || parsed.scopes === null) {
      return null;
    }
    return { version: 1, scopes: parsed.scopes };
  } catch {
    return null;
  }
}

export function clearPersistedComposerDraft(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
  storage: StorageLike | null = getBrowserStorage(),
) {
  const key = getComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readPersistedDraftFile(storage, key);
  if (!file) {
    return;
  }
  delete file.scopes[taskId ?? ROOT_COMPOSER_DRAFT_SCOPE_ID];
  try {
    if (Object.keys(file.scopes).length === 0) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, JSON.stringify(file));
    }
  } catch (error) {
    logger.warn("[chatComposerDraftStorage] Failed to clean up persisted composer drafts", {
      error: error instanceof Error ? error.message : String(error),
      key,
    });
  }
}
