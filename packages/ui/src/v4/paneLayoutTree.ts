// Model and pure state machine for the split-pane layout's binary split tree.
// Alignment: Focus points at a Layout pane; a pane points at (workspaceScope, sessionId);
// SessionDataLayer knows nothing about either layer.
//
// Design bounds:
// - Layout is a binary split tree (VS Code editor-groups model): any pane splits right/down,
//   nesting yields 2x2-style grids; leaves cap at MAX_WORKBENCH_PANES (perf baseline 4).
// - A pane binding is { workspaceScope, sessionId }: the pane carries its workspace (including remote
//   remoteSessionId) with no same-workspace restriction; the old only-render-splits-of-same-workspace
//   rule is gone -- panes persist across workspace tabs.
// - workspaceScope means the session's primary workspace -- the connection routing key --
//   not every path the session can reach (future cross-workspace aux paths are a session
//   property, never layout state).
// - The primary pane (workspace-main) is a reserved leaf: not in panes; its binding follows the existing
//   selection state (activeTaskId -> shell props) to avoid dual-writing zcodeSessionStore/tabStore;
//   tabStore (workspace-tab semantics) is untouched.
// All transitions are pure; unchanged input returns the same reference (no zustand re-render).

/** Fixed primary-pane id (legacy constant; testid contract unchanged). */
export const V4_PRIMARY_PANE_ID = "workspace-main";

/** Leaf-pane cap (perf gate: 4 panes streaming without dropped frames; also the soft CLI child-process cap). */
export const MAX_WORKBENCH_PANES = 4;

/** Split-ratio bounds: first subtree 25%-75% (one clamp shared by drag and persistence). */
export const SPLIT_RATIO_MIN = 0.25;
export const SPLIT_RATIO_MAX = 0.75;
export const DEFAULT_SPLIT_RATIO = 0.5;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_SPLIT_RATIO;
  }
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

/**
 * The pane's workspace ownership (= the session's primary workspace, the connection-routing key).
 * - Local: workspacePath only.
 * - Remote (SSH/WSL/Docker): workspaceIdentity required (Workspace Identity constraint);
 *   remoteSessionId points into remoteWorkspaceSessionStore (resolved by identity when absent).
 */
export interface PaneWorkspaceScope {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
}

/** Canonical identity/isolation key: workspaceKey = workspaceIdentity?.trim() || workspacePath. */
export function paneWorkspaceKey(scope: PaneWorkspaceScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

export function paneBindingMatchesSession(
  binding: PaneBinding | null | undefined,
  scope: PaneWorkspaceScope,
  sessionId: string,
): boolean {
  return Boolean(
    binding?.sessionId === sessionId &&
    paneWorkspaceKey(binding.workspaceScope) === paneWorkspaceKey(scope),
  );
}

export interface PaneBinding {
  /** The session's primary workspace (connection-routing key); auxiliary paths never appear here. */
  readonly workspaceScope: PaneWorkspaceScope;
  /** Bound CLI session; null = draft (the empty-pane flow binds in place after the first createSession). */
  readonly sessionId: string | null;
  /** Read-only panes render no composer/input; currently the child sessions opened inside subagent rows. */
  readonly readOnly?: boolean;
  /**
   * Binding restored from persistence whose existence is not yet verified against the scope's sessions-index (the flag itself never persists).
   * Present -> confirmRestoredPaneSession clears it; deleted -> closePane collapses gracefully.
   */
  readonly restoredUnvalidated?: boolean;
}

export type SplitDirection = "row" | "column";

/** IDE-style drag split sides: left/up insert before the anchor, right/down after. */
export type PaneSplitSide = "left" | "right" | "up" | "down";

export type PaneLayoutNode =
  | { readonly type: "leaf"; readonly paneId: string }
  | {
      readonly type: "split";
      /** Split-node id (lookup key for the drag CSS variable and setSplitRatio). */
      readonly id: string;
      readonly direction: SplitDirection;
      /** first-subtree ratio, clamped to [0.25, 0.75]. */
      readonly ratio: number;
      readonly first: PaneLayoutNode;
      readonly second: PaneLayoutNode;
    };

export interface PaneLayoutSnapshot {
  readonly root: PaneLayoutNode;
  /** Non-primary pane bindings; the primary binding follows shell props (activeTaskId) and never enters this map. */
  readonly panes: Readonly<Record<string, PaneBinding>>;
  /** The app-wide single current pane (Focus-layer singleton). */
  readonly focusedPaneId: string;
}

export const PRIMARY_LEAF: PaneLayoutNode = {
  type: "leaf",
  paneId: V4_PRIMARY_PANE_ID,
};

export const INITIAL_PANE_LAYOUT: PaneLayoutSnapshot = {
  root: PRIMARY_LEAF,
  panes: {},
  focusedPaneId: V4_PRIMARY_PANE_ID,
};

// ============================================================================
// Tree helpers (unchanged paths keep structural sharing = the original reference).
// ============================================================================

/** Collect leaf paneIds pre-order. */
export function leafPaneIds(node: PaneLayoutNode): string[] {
  if (node.type === "leaf") {
    return [node.paneId];
  }
  return [...leafPaneIds(node.first), ...leafPaneIds(node.second)];
}

export function countPanes(state: PaneLayoutSnapshot): number {
  return leafPaneIds(state.root).length;
}

/** Whether another pane can still be split out (leaves < MAX_WORKBENCH_PANES). */
export function canAddPane(state: PaneLayoutSnapshot): boolean {
  return countPanes(state) < MAX_WORKBENCH_PANES;
}

function leafExists(node: PaneLayoutNode, paneId: string): boolean {
  if (node.type === "leaf") {
    return node.paneId === paneId;
  }
  return leafExists(node.first, paneId) || leafExists(node.second, paneId);
}

/** Falls back to primary when the focused pane is absent from the tree (just closed, or broken restored data). */
export function effectiveFocusedPaneId(state: PaneLayoutSnapshot): string {
  return leafExists(state.root, state.focusedPaneId) ? state.focusedPaneId : V4_PRIMARY_PANE_ID;
}

/** New pane id pane-<n>, n = max existing ordinal + 1 (no collision with the workspace-main/split reserved ids). */
function allocatePaneId(root: PaneLayoutNode): string {
  let max = 0;
  for (const paneId of leafPaneIds(root)) {
    const match = /^pane-(\d+)$/.exec(paneId);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `pane-${max + 1}`;
}

function splitNodeIds(node: PaneLayoutNode): string[] {
  if (node.type === "leaf") {
    return [];
  }
  return [node.id, ...splitNodeIds(node.first), ...splitNodeIds(node.second)];
}

/** New split-node id n<k> (short; lands in the --v4-split-<id> CSS variable name). */
function allocateSplitNodeId(root: PaneLayoutNode): string {
  let max = 0;
  for (const id of splitNodeIds(root)) {
    const match = /^n(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `n${max + 1}`;
}

/** Replaces the paneId leaf with replacement; misses return the original reference. */
function replaceLeaf(
  node: PaneLayoutNode,
  paneId: string,
  replacement: PaneLayoutNode,
): PaneLayoutNode {
  if (node.type === "leaf") {
    return node.paneId === paneId ? replacement : node;
  }
  const first = replaceLeaf(node.first, paneId, replacement);
  const second = replaceLeaf(node.second, paneId, replacement);
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

/** Removes a leaf: the parent split node collapses to its sibling subtree; null means the whole tree went away (root was that leaf). */
function removeLeaf(node: PaneLayoutNode, paneId: string): PaneLayoutNode | null {
  if (node.type === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const first = removeLeaf(node.first, paneId);
  if (first === null) {
    return node.second;
  }
  const second = removeLeaf(node.second, paneId);
  if (second === null) {
    return node.first;
  }
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

function replaceSplitRatio(node: PaneLayoutNode, splitId: string, ratio: number): PaneLayoutNode {
  if (node.type === "leaf") {
    return node;
  }
  if (node.id === splitId) {
    return node.ratio === ratio ? node : { ...node, ratio };
  }
  const first = replaceSplitRatio(node.first, splitId, ratio);
  const second = replaceSplitRatio(node.second, splitId, ratio);
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

// ============================================================================
// Pure state machine (unit-test surface).
// ============================================================================

/**
 * Split at the anchor pane: the anchor leaf becomes the split node {anchor, new pane}; the
 * new pane takes binding (draft or existing session) and the focus.
 * anchor missing / leaf cap reached -> no-op (original reference).
 */
export function splitPaneAt(
  state: PaneLayoutSnapshot,
  anchorPaneId: string,
  direction: SplitDirection,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!leafExists(state.root, anchorPaneId) || !canAddPane(state)) {
    return state;
  }
  const newPaneId = allocatePaneId(state.root);
  const splitNode: PaneLayoutNode = {
    type: "split",
    id: allocateSplitNodeId(state.root),
    direction,
    ratio: DEFAULT_SPLIT_RATIO,
    first: { type: "leaf", paneId: anchorPaneId },
    second: { type: "leaf", paneId: newPaneId },
  };
  return {
    root: replaceLeaf(state.root, anchorPaneId, splitNode),
    panes: { ...state.panes, [newPaneId]: binding },
    focusedPaneId: newPaneId,
  };
}

/**
 * Split around the anchor: left/up place the new pane before it, right/down after.
 * Drag-splitting must preserve directional intent; legacy splitPaneAt keeps anchor-first,new-second.
 */
export function splitPaneAtSide(
  state: PaneLayoutSnapshot,
  anchorPaneId: string,
  side: PaneSplitSide,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!leafExists(state.root, anchorPaneId) || !canAddPane(state)) {
    return state;
  }
  const newPaneId = allocatePaneId(state.root);
  const anchorLeaf: PaneLayoutNode = { type: "leaf", paneId: anchorPaneId };
  const newLeaf: PaneLayoutNode = { type: "leaf", paneId: newPaneId };
  const before = side === "left" || side === "up";
  const splitNode: PaneLayoutNode = {
    type: "split",
    id: allocateSplitNodeId(state.root),
    direction: side === "left" || side === "right" ? "row" : "column",
    ratio: DEFAULT_SPLIT_RATIO,
    first: before ? newLeaf : anchorLeaf,
    second: before ? anchorLeaf : newLeaf,
  };
  return {
    root: replaceLeaf(state.root, anchorPaneId, splitNode),
    panes: { ...state.panes, [newPaneId]: binding },
    focusedPaneId: newPaneId,
  };
}

/**
 * Close a pane: remove the leaf, collapse the parent splitter to the sibling subtree, drop the binding.
 * primary is unclosable; unknown pane is a no-op. Focus returns to primary when closing the focused pane.
 * Closing a pane never stops the session: it unsubscribes the view; the CLI keeps running.
 */
export function closePane(state: PaneLayoutSnapshot, paneId: string): PaneLayoutSnapshot {
  if (paneId === V4_PRIMARY_PANE_ID || !leafExists(state.root, paneId)) {
    return state;
  }
  const root = removeLeaf(state.root, paneId) ?? PRIMARY_LEAF;
  const panes = { ...state.panes };
  delete panes[paneId];
  return {
    root,
    panes,
    focusedPaneId: state.focusedPaneId === paneId ? V4_PRIMARY_PANE_ID : state.focusedPaneId,
  };
}

/** After a draft pane's first createSession, bind the session in place. No-op when the pane is unbound/unchanged (and has no pending-verification flag). */
export function bindPaneSession(
  state: PaneLayoutSnapshot,
  paneId: string,
  sessionId: string,
): PaneLayoutSnapshot {
  const binding = state.panes[paneId];
  if (!binding || (binding.sessionId === sessionId && !binding.restoredUnvalidated)) {
    return state;
  }
  // A live binding is authoritative; no re-verification - rebuild without restoredUnvalidated.
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: { workspaceScope: binding.workspaceScope, sessionId },
    },
  };
}

/**
 * Replace a non-primary pane's full session binding in place.
 * After a draft split, clicking a plain session only moved shell activeTaskId, letting the primary
 * draft be overwritten; swap the focused secondary's scope + session owner first.
 */
export function replacePaneBinding(
  state: PaneLayoutSnapshot,
  paneId: string,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!state.panes[paneId] || paneId === V4_PRIMARY_PANE_ID) {
    return state;
  }
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: binding,
    },
    focusedPaneId: paneId,
  };
}

export function findPaneIdForSession(
  state: PaneLayoutSnapshot,
  scope: PaneWorkspaceScope,
  sessionId: string,
): string | null {
  for (const [paneId, binding] of Object.entries(state.panes)) {
    if (paneBindingMatchesSession(binding, scope, sessionId)) {
      return paneId;
    }
  }
  return null;
}

/** Commit a drag-resize: locate by split-node id, clamp to [25%, 75%]; unchanged returns the original reference. */
export function setSplitNodeRatio(
  state: PaneLayoutSnapshot,
  splitId: string,
  ratio: number,
): PaneLayoutSnapshot {
  const root = replaceSplitRatio(state.root, splitId, clampSplitRatio(ratio));
  if (root === state.root) {
    return state;
  }
  return { ...state, root };
}

/** Focus a pane: only leaves present in the current tree are accepted; otherwise no-op (original reference). */
export function focusPane(state: PaneLayoutSnapshot, paneId: string): PaneLayoutSnapshot {
  if (state.focusedPaneId === paneId || !leafExists(state.root, paneId)) {
    return state;
  }
  return { ...state, focusedPaneId: paneId };
}

/** Clears the pending-verification flag once a restored binding is confirmed in sessions-index. No flag, no-op. */
export function confirmRestoredPaneSession(
  state: PaneLayoutSnapshot,
  paneId: string,
): PaneLayoutSnapshot {
  const binding = state.panes[paneId];
  if (!binding?.restoredUnvalidated) {
    return state;
  }
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: {
        workspaceScope: binding.workspaceScope,
        sessionId: binding.sessionId,
      },
    },
  };
}

/**
 * Side-pane/drilldown open-in-split: if the session already lives in a pane (equal by workspaceKey + sessionId,
 * ownership/isolation semantics) focus it; else split the focused pane rightward. At cap with no existing pane: no-op.
 */
export function openSessionInNewPane(
  state: PaneLayoutSnapshot,
  scope: PaneWorkspaceScope,
  sessionId: string,
): PaneLayoutSnapshot {
  const workspaceKey = paneWorkspaceKey(scope);
  for (const [paneId, binding] of Object.entries(state.panes)) {
    if (
      binding.sessionId === sessionId &&
      paneWorkspaceKey(binding.workspaceScope) === workspaceKey
    ) {
      return focusPane(state, paneId);
    }
  }
  return splitPaneAt(state, effectiveFocusedPaneId(state), "row", {
    workspaceScope: scope,
    sessionId,
  });
}
