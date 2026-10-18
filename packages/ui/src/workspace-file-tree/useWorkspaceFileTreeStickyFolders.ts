import { useMemo } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import type { WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";
import type { WorkspaceFileTreeStickyFolderItem } from "@/workspace-file-tree/types.js";

function getWorkspaceFileTreeStickyFolders({
  rows,
  virtualItems,
  scrollOffset,
  enabled = true,
}: {
  rows: WorkspaceFileTreeRow[];
  virtualItems: VirtualItem[];
  scrollDirection: "forward" | "backward" | null;
  scrollOffset: number;
  enabled?: boolean;
}): WorkspaceFileTreeStickyFolderItem[] {
  if (!enabled) {
    return [];
  }
  if (virtualItems.length === 0 || rows.length === 0 || scrollOffset <= 0.5) {
    return [];
  }

  let stickyItems: WorkspaceFileTreeStickyFolderItem[] = [];
  for (let iteration = 0; iteration <= rows.length; iteration += 1) {
    const probeOffset =
      scrollOffset + stickyItems.length * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
    const probeIndex = Math.min(
      rows.length - 1,
      Math.floor(probeOffset / WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX),
    );
    const probeRow = rows[probeIndex];
    if (!probeRow) {
      return [];
    }

    const ancestorItems: WorkspaceFileTreeStickyFolderItem[] = [];
    const canStickProbeRow = probeRow.type === "directory" && probeRow.expanded;
    let stickyDepth = canStickProbeRow ? probeRow.depth : probeRow.depth - 1;
    for (
      let index = canStickProbeRow ? probeIndex : probeIndex - 1;
      index >= 0 && stickyDepth >= 0;
      index -= 1
    ) {
      const row = rows[index];
      if (!row || row.type !== "directory" || !row.expanded) {
        continue;
      }
      if (row.depth === stickyDepth) {
        ancestorItems.push({ row, index });
        stickyDepth = row.depth - 1;
      }
    }
    ancestorItems.reverse();

    const nextStickyItems = ancestorItems.filter((item, stickyIndex) => {
      const rowStart = item.index * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      const stickyBoundary = scrollOffset + stickyIndex * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      return rowStart <= stickyBoundary + 0.5;
    });
    if (nextStickyItems.length === stickyItems.length) {
      return nextStickyItems;
    }
    stickyItems = nextStickyItems;
  }
  return stickyItems;
}

export function useWorkspaceFileTreeStickyFolders({
  rows,
  virtualItems,
  scrollDirection,
  scrollOffset,
  enabled,
}: {
  rows: WorkspaceFileTreeRow[];
  virtualItems: VirtualItem[];
  scrollDirection: "forward" | "backward" | null;
  scrollOffset: number;
  enabled: boolean;
}) {
  const stickyFolderItems = useMemo<WorkspaceFileTreeStickyFolderItem[]>(() => {
    // Each sticky row pushes the next trigger line down 28px; comparing every level against
    // scrollTop alone makes subdirectories stick late. Probe the row below the sticky stack so
    // the computed trigger line and the CSS top share the same accumulated offset.
    return getWorkspaceFileTreeStickyFolders({
      rows,
      virtualItems,
      scrollDirection,
      scrollOffset,
      enabled,
    });
  }, [enabled, rows, scrollDirection, scrollOffset, virtualItems]);

  // Sticky rows used to be lifted out of the virtual list, rewriting scrollTop and racing the
  // native scrollbar drag. The original row now stays in place; CSS sticky only overlays visually.
  return stickyFolderItems;
}
