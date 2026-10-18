import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import type {
  PluginSandboxRecord,
  PluginSandboxRegisterInput,
  PluginSandboxRegistryPort,
} from "./contract.js";
import {
  PluginSandboxQuotaError,
  buildPluginSandboxPartition,
  buildPluginSandboxShellUrl,
} from "./contract.js";
import { buildPluginSandboxCsp } from "./csp.js";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;
/** Mirrors HTML transient activation: one input event buys a 5s window, consumed once. */
export const PLUGIN_SANDBOX_USER_GESTURE_TTL_MS = 5_000;

export interface CreatePluginSandboxRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  createId?: () => string;
  /** Notifies the host to finalize on dispose (close ports; the partition is persistent per trusted app identity — keep protocol and storage). */
  onDispose?: (record: PluginSandboxRecord) => void;
}

interface RegistryEntry {
  record: PluginSandboxRecord;
  expiresAt: number;
  lastUsedAt: number;
  gestureAt: number | null;
  /** Live guest count; > 0 exempts from TTL expiry. */
  pinned: number;
}

/**
 * Sandbox registry: the single owner of plugin UI sandbox content and lifecycle in the main process.
 * Precedent: `createLocalMediaPreviewPathRegistry` — also host-validated registration with
 * TTL/maxEntries cleanup.
 */
export function createPluginSandboxRegistry(
  options: CreatePluginSandboxRegistryOptions = {},
): PluginSandboxRegistryPort & {
  /** Idempotency key → sandboxId, for tests and diagnostics. */
  size(): number;
  clear(): void;
} {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // sandboxId enters resource paths; the origin derives from the trusted appIdentity. Historic
  // IDs stay within the legal host charset. CSP host-source allows only ALPHA/DIGIT/"-": a
  // source with underscores is ignored wholesale by Chromium, frame-ancestors degrades to 'none',
  // and the plugin iframe gets blanked by ERR_BLOCKED_BY_RESPONSE.
  const createId = options.createId ?? (() => `sb-${randomUUID().replaceAll("-", "")}`);
  const entries = new Map<string, RegistryEntry>();
  const idByIdempotencyKey = new Map<string, string>();

  // Fix: different plugins may declare same-named surfaces; missing plugin/workspace would reuse
  // and overwrite another plugin's HTML.
  const idempotencyKey = (
    input: Pick<
      PluginSandboxRegisterInput,
      | "ownerWebContentsId"
      | "workspacePath"
      | "workspaceIdentity"
      | "sessionId"
      | "contentKind"
      | "pluginId"
      | "scopeId"
      | "serverName"
      | "instance"
    >,
  ) =>
    JSON.stringify([
      input.ownerWebContentsId,
      input.workspaceIdentity?.trim() || input.workspacePath || "",
      input.sessionId,
      input.contentKind ?? "mcp-app",
      input.pluginId,
      input.scopeId,
      input.serverName,
      input.instance.token,
    ]);

  const remove = (sandboxId: string, notify: boolean) => {
    const entry = entries.get(sandboxId);
    if (!entry) return;
    entries.delete(sandboxId);
    idByIdempotencyKey.delete(idempotencyKey(entry.record));
    if (notify) options.onDispose?.(entry.record);
  };

  const pruneExpired = (observedAt: number) => {
    for (const [sandboxId, entry] of entries) {
      if (entry.pinned === 0 && entry.expiresAt <= observedAt) remove(sandboxId, true);
    }
  };

  // The handle carries only presentation fields declared in registration input (the host bridge
  // already merged resource-level-first, tool-level-fallback); prefersBorder defaults to false on
  // the record, so "declared" is judged from input, not the record.
  const resourceMetaOf = (
    input: Pick<
      PluginSandboxRegisterInput,
      "prefersBorder" | "heightHint" | "minFrameHeight" | "showInline" | "permissions"
    >,
  ): PluginSandboxHandle["resourceMeta"] => {
    const meta = {
      ...(input.permissions?.length ? { permissions: [...input.permissions] } : {}),
      ...(input.prefersBorder !== undefined ? { prefersBorder: input.prefersBorder } : {}),
      ...(input.heightHint !== undefined ? { heightHint: input.heightHint } : {}),
      ...(input.minFrameHeight !== undefined ? { minFrameHeight: input.minFrameHeight } : {}),
      ...(input.showInline !== undefined ? { showInline: input.showInline } : {}),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
  };

  const toHandle = (record: PluginSandboxRecord): PluginSandboxHandle => ({
    instance: record.instance,
    sandboxId: record.sandboxId,
    initId: record.initId,
    shellUrl: record.shellUrl,
    partition: record.partition,
    ...(record.resourceMeta ? { resourceMeta: record.resourceMeta } : {}),
  });

  return {
    register(input: PluginSandboxRegisterInput): PluginSandboxHandle {
      if (input.contentKind !== "gen-ui" && (!input.pluginId || !input.serverName))
        throw new Error("Missing MCP App provenance");
      if (
        input.contentKind === "gen-ui" &&
        (input.pluginId || input.serverName || input.permissions?.length)
      )
        throw new Error("Invalid Gen UI capabilities");
      const observedAt = now();
      pruneExpired(observedAt);
      const key = idempotencyKey(input);
      const existingId = idByIdempotencyKey.get(key);
      const existing = existingId ? entries.get(existingId) : undefined;
      if (existing) return toHandle(existing.record);
      // Unattached prepares may still be in transport; reclamation belongs to the page owner —
      // Main never hijacks another window's registration.
      if (entries.size >= maxEntries) throw new PluginSandboxQuotaError(maxEntries);
      const sandboxId = createId();
      const record: PluginSandboxRecord = {
        instance: input.instance,
        sandboxId,
        initId: 1,
        shellUrl: buildPluginSandboxShellUrl(sandboxId, input.instance.appIdentity),
        partition:
          input.contentKind === "gen-ui"
            ? `gen-ui-${input.instance.appIdentity}`
            : buildPluginSandboxPartition({
                appIdentity: input.instance.appIdentity,
              }),
        ownerWebContentsId: input.ownerWebContentsId,
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        sessionId: input.sessionId,
        contentKind: input.contentKind,
        pluginId: input.pluginId,
        serverName: input.serverName,
        scopeId: input.scopeId,
        html: input.html,
        cspHeader: buildPluginSandboxCsp({
          csp: input.csp,
          cspRelaxations: input.cspRelaxations,
          sandboxId,
          appIdentity: input.instance.appIdentity,
        }),
        ...(input.cspRelaxations ? { cspRelaxations: input.cspRelaxations } : {}),
        ...(input.permissions?.length ? { permissions: [...input.permissions] } : {}),
        prefersBorder: input.prefersBorder ?? false,
        ...(resourceMetaOf(input) ? { resourceMeta: resourceMetaOf(input) } : {}),
      };
      entries.set(sandboxId, {
        record,
        expiresAt: observedAt + ttlMs,
        lastUsedAt: observedAt,
        gestureAt: null,
        pinned: 0,
      });
      idByIdempotencyKey.set(key, sandboxId);
      return toHandle(record);
    },
    get(sandboxId) {
      const observedAt = now();
      pruneExpired(observedAt);
      const entry = entries.get(sandboxId);
      if (!entry) return null;
      entry.lastUsedAt = observedAt;
      return entry.record;
    },
    dispose(sandboxId, initId) {
      if (initId !== undefined && entries.get(sandboxId)?.record.initId !== initId) return;
      remove(sandboxId, true);
    },
    disposeOwner(ownerWebContentsId) {
      for (const [sandboxId, entry] of entries) {
        if (entry.record.ownerWebContentsId === ownerWebContentsId) remove(sandboxId, true);
      }
    },
    pin(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry) entry.pinned += 1;
    },
    unpin(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry && entry.pinned > 0) entry.pinned -= 1;
    },
    markUserGesture(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry) entry.gestureAt = now();
    },
    consumeUserGesture(sandboxId) {
      const entry = entries.get(sandboxId);
      if (!entry || entry.gestureAt === null) return false;
      const fresh = now() - entry.gestureAt <= PLUGIN_SANDBOX_USER_GESTURE_TTL_MS;
      entry.gestureAt = null;
      return fresh;
    },
    size: () => entries.size,
    clear() {
      // Deleting the current entry inside Map.forEach is safe; no need to copy keys first.
      entries.forEach((_entry, sandboxId) => remove(sandboxId, true));
    },
  };
}
