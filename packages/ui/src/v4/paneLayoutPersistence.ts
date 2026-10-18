// Split-pane Layout persistence (localStorage): try/catch silent degradation; corrupt data is
// dropped wholesale back to the initial layout, never partially recovered. Reads legacy v1
// (single-value splitPane) for compat, migrating only when the v1 workspaceKey is a trusted
// local path.
import {
  clampSplitRatio,
  leafPaneIds,
  MAX_WORKBENCH_PANES,
  PRIMARY_LEAF,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneLayoutNode,
  type PaneLayoutSnapshot,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

const PANE_LAYOUT_STORAGE_KEY = "zcode-v4-pane-layout:v2";
/** Legacy single-value split key (read-only during migration, never written). */
const PANE_LAYOUT_STORAGE_KEY_V1 = "zcode-v4-pane-layout:v1";

/** Reserved pane id for the v1 migration (the legacy split pane fixed id; e2e/testid contracts keep it). */
const V4_LEGACY_SPLIT_PANE_ID = "split";

interface PersistedScopeV2 {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface PersistedBindingV2 {
  workspaceScope: PersistedScopeV2;
  sessionId: string | null;
}

type PersistedNodeV2 =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: PersistedNodeV2;
      second: PersistedNodeV2;
    };

interface PersistedPaneLayoutV2 {
  root: PersistedNodeV2;
  panes: Record<string, PersistedBindingV2>;
  focusedPaneId: string;
}

function sanitizeNode(raw: unknown): PaneLayoutNode | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedNodeV2> & Record<string, unknown>;
  if (record.type === "leaf") {
    return typeof record.paneId === "string" && record.paneId.length > 0
      ? { type: "leaf", paneId: record.paneId }
      : null;
  }
  if (record.type === "split") {
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      (record.direction !== "row" && record.direction !== "column")
    ) {
      return null;
    }
    const first = sanitizeNode(record.first);
    const second = sanitizeNode(record.second);
    if (!first || !second) {
      return null;
    }
    return {
      type: "split",
      id: record.id,
      direction: record.direction,
      ratio: clampSplitRatio(typeof record.ratio === "number" ? record.ratio : Number.NaN),
      first,
      second,
    };
  }
  return null;
}

function sanitizeScope(raw: unknown): PaneWorkspaceScope | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedScopeV2>;
  if (typeof record.workspacePath !== "string" || record.workspacePath.length === 0) {
    return null;
  }
  return {
    workspacePath: record.workspacePath,
    ...(typeof record.workspaceIdentity === "string" && record.workspaceIdentity.trim().length > 0
      ? { workspaceIdentity: record.workspaceIdentity }
      : {}),
    ...(typeof record.remoteSessionId === "string" && record.remoteSessionId.length > 0
      ? { remoteSessionId: record.remoteSessionId }
      : {}),
  };
}

/**
 * Normalizes any (possibly corrupt) v2 persisted value into a legal layout snapshot; unfixable
 * -> null (caller falls back to the initial layout). Integrity requirements - any miss drops
 * the whole thing: valid tree, unique leaf ids, exactly one primary, leaf count within the cap,
 * every non-primary leaf legally bound. Restored session bindings get restoredUnvalidated
 * (pending sessions-index verification); an absent focusedPaneId falls back to primary.
 */
function sanitizePersistedPaneLayout(raw: unknown): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedPaneLayoutV2>;
  const root = sanitizeNode(record.root);
  if (!root) {
    return null;
  }
  const paneIds = leafPaneIds(root);
  if (
    paneIds.length > MAX_WORKBENCH_PANES ||
    new Set(paneIds).size !== paneIds.length ||
    paneIds.filter((paneId) => paneId === V4_PRIMARY_PANE_ID).length !== 1
  ) {
    return null;
  }
  const rawPanes =
    typeof record.panes === "object" && record.panes !== null
      ? (record.panes as Record<string, unknown>)
      : {};
  const panes: Record<string, PaneBinding> = {};
  for (const paneId of paneIds) {
    if (paneId === V4_PRIMARY_PANE_ID) {
      continue;
    }
    const rawBinding = rawPanes[paneId];
    if (typeof rawBinding !== "object" || rawBinding === null) {
      return null;
    }
    const scope = sanitizeScope((rawBinding as Partial<PersistedBindingV2>).workspaceScope);
    if (!scope) {
      return null;
    }
    const rawSessionId = (rawBinding as Partial<PersistedBindingV2>).sessionId;
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : null;
    panes[paneId] = {
      workspaceScope: scope,
      sessionId,
      ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
    };
  }
  const focusedPaneId =
    typeof record.focusedPaneId === "string" && paneIds.includes(record.focusedPaneId)
      ? record.focusedPaneId
      : V4_PRIMARY_PANE_ID;
  return { root, panes, focusedPaneId };
}

/** A v1 workspaceKey migrates as workspacePath only when it is a trusted local absolute path (POSIX / Windows drive letter). */
function isPlausibleLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Legacy v1 (single-value splitPane) -> v2 migration: v1 stored only the workspaceKey
 * (identity ?? path) and cannot reconstruct a remote scope, so migrate to the two-leaf tree
 * only for trusted local paths; otherwise drop to single pane (null).
 */
function migratePersistedPaneLayoutV1(raw: unknown): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as {
    splitPane?: { workspaceKey?: unknown; sessionId?: unknown } | null;
    focusedPaneId?: unknown;
    splitRatio?: unknown;
  };
  const workspaceKey = record.splitPane?.workspaceKey;
  if (
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
    !isPlausibleLocalPath(workspaceKey)
  ) {
    return null;
  }
  const rawSessionId = record.splitPane?.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : null;
  return {
    root: {
      type: "split",
      id: "n1",
      direction: "row",
      ratio: clampSplitRatio(
        typeof record.splitRatio === "number" ? record.splitRatio : Number.NaN,
      ),
      first: PRIMARY_LEAF,
      second: { type: "leaf", paneId: V4_LEGACY_SPLIT_PANE_ID },
    },
    panes: {
      [V4_LEGACY_SPLIT_PANE_ID]: {
        workspaceScope: { workspacePath: workspaceKey },
        sessionId,
        ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
      },
    },
    focusedPaneId:
      record.focusedPaneId === V4_LEGACY_SPLIT_PANE_ID
        ? V4_LEGACY_SPLIT_PANE_ID
        : V4_PRIMARY_PANE_ID,
  };
}

/** Reads the persisted layout (v2 first, v1 migration on absence); null for no record/corrupt/no-storage. */
export function readPersistedPaneLayout(): PaneLayoutSnapshot | null {
  try {
    const rawV2 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    if (rawV2) {
      return sanitizePersistedPaneLayout(JSON.parse(rawV2));
    }
    const rawV1 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY_V1);
    if (rawV1) {
      return migratePersistedPaneLayoutV1(JSON.parse(rawV1));
    }
    return null;
  } catch {
    return null;
  }
}

function serializeNode(node: PaneLayoutNode): PersistedNodeV2 {
  if (node.type === "leaf") {
    return { type: "leaf", paneId: node.paneId };
  }
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: serializeNode(node.first),
    second: serializeNode(node.second),
  };
}

// Dedup writes: subscribe fires on any state change; skip setItem when the serialization is
// unchanged (e.g. restoredUnvalidated clearing, which never persists).
let lastPersistedPaneLayout: string | null = null;

export function persistPaneLayout(snapshot: PaneLayoutSnapshot): void {
  const panes: Record<string, PersistedBindingV2> = {};
  for (const [paneId, binding] of Object.entries(snapshot.panes)) {
    panes[paneId] = {
      workspaceScope: {
        workspacePath: binding.workspaceScope.workspacePath,
        ...(binding.workspaceScope.workspaceIdentity
          ? { workspaceIdentity: binding.workspaceScope.workspaceIdentity }
          : {}),
        ...(binding.workspaceScope.remoteSessionId
          ? { remoteSessionId: binding.workspaceScope.remoteSessionId }
          : {}),
      },
      sessionId: binding.sessionId,
    };
  }
  const payload: PersistedPaneLayoutV2 = {
    root: serializeNode(snapshot.root),
    panes,
    focusedPaneId: snapshot.focusedPaneId,
  };
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === lastPersistedPaneLayout) {
      return;
    }
    localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, serialized);
    lastPersistedPaneLayout = serialized;
  } catch {
    // No-storage environments (tests/private mode) degrade silently: no refresh-restore, splits unaffected.
  }
}
