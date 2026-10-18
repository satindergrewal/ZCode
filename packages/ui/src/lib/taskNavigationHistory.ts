/**
 * Workspace navigation history - a browser-style back/forward stack
 *
 * Pure data structure + immutable updates, no React dependency.
 * Owned by zcodeSessionStore, which drives the UI state from it.
 */

interface WorkspaceNavEntryBase {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskNavEntry extends WorkspaceNavEntryBase {
  kind: "task";
  taskId: string;
}

// "workflow" is the top-level workflow tab of the Automations page;
// scheduled / idle remain pills inside the Automations tab.
export type AutomationsNavigationTab = "scheduled" | "idle" | "workflow";

export type OpenAutomationsMain = (
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
) => void;

export interface AutomationsNavEntry extends WorkspaceNavEntryBase {
  kind: "automations";
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export interface PluginStoreNavEntry extends WorkspaceNavEntryBase {
  kind: "plugin-store";
}

export type WorkspaceNavEntry = TaskNavEntry | AutomationsNavEntry | PluginStoreNavEntry;

export interface TaskNavigationHistory {
  entries: WorkspaceNavEntry[];
  /** Current pointer, an index into entries; -1 means empty */
  cursor: number;
}

const MAX_HISTORY = 50;

export function createTaskNavigationHistory(): TaskNavigationHistory {
  return { entries: [], cursor: -1 };
}

export function isTaskNavEntry(
  entry: WorkspaceNavEntry,
): entry is TaskNavEntry {
  return entry.kind === "task";
}

export function isAutomationsNavEntry(
  entry: WorkspaceNavEntry,
): entry is AutomationsNavEntry {
  return entry.kind === "automations";
}

export function isPluginStoreNavEntry(entry: WorkspaceNavEntry): entry is PluginStoreNavEntry {
  return entry.kind === "plugin-store";
}

function isSameNavEntry(
  left: WorkspaceNavEntry,
  right: WorkspaceNavEntry,
): boolean {
  if (
    left.kind !== right.kind ||
    left.workspacePath !== right.workspacePath ||
    left.workspaceIdentity !== right.workspaceIdentity
  ) {
    return false;
  }

  if (left.kind === "task") return left.taskId === (right as TaskNavEntry).taskId;
  if (left.kind === "automations") {
    const rightAutomations = right as AutomationsNavEntry;
    return (
      left.automationId === rightAutomations.automationId &&
      left.automationTab === rightAutomations.automationTab
    );
  }
  return true;
}

function pushEntry(
  history: TaskNavigationHistory,
  entry: WorkspaceNavEntry,
): TaskNavigationHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;

  // Adjacent dedupe: history replay or repeated opens of the same target do not re-push.
  if (current && isSameNavEntry(current, entry)) {
    return history;
  }

  // Truncate the forward history after the cursor, keeping browser-style navigation semantics.
  const next = [...history.entries.slice(0, history.cursor + 1), entry];
  if (next.length > MAX_HISTORY) {
    const overflow = next.length - MAX_HISTORY;
    return {
      entries: next.slice(overflow),
      cursor: next.length - overflow - 1,
    };
  }

  return { entries: next, cursor: next.length - 1 };
}

/** Called when the user actively selects or creates a task. */
export function pushNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  // Remote-workspace navigation must not record the path alone:
  // the same path can exist locally and on several remote machines; push the identity key too.
  return pushEntry(history, {
    kind: "task",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    taskId,
  });
}

/** Called when the user opens the Automations root view or a given detail. */
export function pushAutomationsNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "automations",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(automationId ? { automationId } : {}),
    ...(automationTab ? { automationTab } : {}),
  });
}

export function pushPluginStoreNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "plugin-store",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

export function canGoBack(history: TaskNavigationHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: TaskNavigationHistory): boolean {
  return history.cursor < history.entries.length - 1;
}

/** One step back; returns the new history and target entry. */
export function goBack(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoBack(history)) {
    return null;
  }

  const nextCursor = history.cursor - 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/** One step forward; returns the new history and target entry. */
export function goForward(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoForward(history)) {
    return null;
  }

  const nextCursor = history.cursor + 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/**
 * Removes every task entry for the given taskId (on task deletion).
 * Automations entries live outside the task lifecycle and must be kept as-is.
 */
export function removeTaskFromHistory(
  history: TaskNavigationHistory,
  taskId: string,
): TaskNavigationHistory {
  const currentEntry =
    history.cursor >= 0 ? history.entries[history.cursor] : null;
  const filtered = history.entries.filter(
    (entry) => !isTaskNavEntry(entry) || entry.taskId !== taskId,
  );

  if (filtered.length === history.entries.length) {
    return history;
  }

  if (filtered.length === 0) {
    return createTaskNavigationHistory();
  }

  // Keep pointing at the entry while it survives; on deletion, reuse the old position to pick the nearest target.
  const currentEntryIndex = currentEntry ? filtered.indexOf(currentEntry) : -1;
  const cursor =
    currentEntryIndex >= 0
      ? currentEntryIndex
      : Math.min(history.cursor, filtered.length - 1);

  return { entries: filtered, cursor };
}
