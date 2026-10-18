import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EmbeddedBrowserSitePermissionRecord,
  EmbeddedBrowserSitePermissionStore,
} from "./embeddedBrowserPermissionPolicy.js";

/**
 * File persistence for embedded-browser site consents: a dedicated JSON under userData, written
 * atomically (tmp + rename). Kept out of global settings to avoid coupling with broadcast-synced
 * fields like theme; on structural corruption restart empty (fail-open to "ask every time",
 * never a wrong grant).
 */
export function createEmbeddedBrowserSitePermissionStore(
  filePath: string,
): EmbeddedBrowserSitePermissionStore {
  const tempPath = join(
    dirname(filePath),
    `.${Math.random().toString(36).slice(2)}-site-permissions.tmp`,
  );

  const parseRecord = (raw: string): EmbeddedBrowserSitePermissionRecord => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record: EmbeddedBrowserSitePermissionRecord = {};
    for (const [origin, permissions] of Object.entries(parsed as Record<string, unknown>)) {
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) continue;
      const normalized: Record<string, "allow" | "deny"> = {};
      for (const [permission, state] of Object.entries(permissions as Record<string, unknown>)) {
        if (state === "allow" || state === "deny") normalized[permission] = state;
      }
      if (Object.keys(normalized).length > 0) record[origin] = normalized;
    }
    return record;
  };

  return {
    async load() {
      try {
        return parseRecord(await readFile(filePath, "utf8"));
      } catch {
        return {};
      }
    },
    async persist(record) {
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        await rename(tempPath, filePath);
      } catch {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw new Error(`failed to persist embedded browser site permissions: ${filePath}`);
      }
    },
  };
}
