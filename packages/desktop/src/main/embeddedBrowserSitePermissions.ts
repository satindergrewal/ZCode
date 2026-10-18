import type {
  EmbeddedBrowserSitePermissionRecord,
  EmbeddedBrowserSitePermissionStore,
} from "./embeddedBrowserPermissionPolicy.js";

/**
 * Module-level manager for embedded-browser site consent records:
 * - permission check/request handlers need synchronous reads (Electron check handlers have no
 *   async form), so records stay in memory and the store persists asynchronously on the write path;
 * - settings "site permissions" and "clear browser data" read/write through this same module,
 *   keeping decision semantics consistent.
 * Module singleton, same pattern as getPluginSandboxHost: one instance in main, no concurrent
 * write races.
 */
let record: EmbeddedBrowserSitePermissionRecord = {};
let store: EmbeddedBrowserSitePermissionStore | null = null;
let logger: { warn: (...args: unknown[]) => void } | null = null;

export async function initEmbeddedBrowserSitePermissions(input: {
  store?: EmbeddedBrowserSitePermissionStore;
  logger: { warn: (...args: unknown[]) => void };
}): Promise<void> {
  store = input.store ?? null;
  logger = input.logger;
  record = {};
  if (store) {
    try {
      record = await store.load();
    } catch (error) {
      input.logger.warn("[embedded-browser-permission] site permission store load failed:", error);
    }
  }
}

export function getEmbeddedBrowserSitePermission(
  origin: string,
  permission: string,
): "allow" | "deny" | undefined {
  return record[origin]?.[permission];
}

export function getEmbeddedBrowserSitePermissionSnapshot(): EmbeddedBrowserSitePermissionRecord {
  return structuredClone(record);
}

export async function writeEmbeddedBrowserSitePermission(
  origin: string,
  permission: string,
  state: "allow" | "deny",
): Promise<void> {
  record[origin] = { ...record[origin], [permission]: state };
  await persist();
}

/** state "ask" deletes the record (back to asking every time). */
export async function removeEmbeddedBrowserSitePermission(
  origin: string,
  permission: string,
): Promise<void> {
  const permissions = record[origin];
  if (!permissions) return;
  const next = { ...permissions };
  delete next[permission];
  if (Object.keys(next).length === 0) delete record[origin];
  else record[origin] = next;
  await persist();
}

export async function removeEmbeddedBrowserSitePermissionOrigin(origin: string): Promise<void> {
  delete record[origin];
  await persist();
}

export async function clearEmbeddedBrowserSitePermissions(): Promise<void> {
  record = {};
  await persist();
}

async function persist(): Promise<void> {
  if (!store) return;
  try {
    await store.persist(record);
  } catch (error) {
    // The in-memory record is already effective; a persist failure only degrades to "ask every
    // time" after restart and never blocks the decision.
    logger?.warn("[embedded-browser-permission] site permission store persist failed:", error);
  }
}

/** Test-only: isolates module-level state. */
export function resetEmbeddedBrowserSitePermissionsForTest(): void {
  record = {};
  store = null;
  logger = null;
}
