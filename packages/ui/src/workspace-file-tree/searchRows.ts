import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  getWorkspaceFileAncestorDirectories,
  isWorkspaceFilePathInside,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";

export function createWorkspaceFileTreeRowsFromSearchEntries(
  entries: WorkspaceFileEntry[],
): WorkspaceFileTreeRow[] {
  return entries.map((entry) => ({
    path: entry.path,
    // Results come from the whole-workspace index and dirs may never have been expanded in the lazy tree; relative paths keep same-named files distinguishable.
    name: entry.relativePath,
    type: entry.type,
    depth: 0,
    expanded: false,
    loaded: false,
    loading: false,
    error: null,
  }));
}

export function getWorkspaceFileSearchDirectoryRevealPaths({
  workspacePath,
  directoryPath,
}: {
  workspacePath: string;
  directoryPath: string;
}): string[] {
  if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
    return [];
  }

  return [...getWorkspaceFileAncestorDirectories(workspacePath, directoryPath), directoryPath];
}
