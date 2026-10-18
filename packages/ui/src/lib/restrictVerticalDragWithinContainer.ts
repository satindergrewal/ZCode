import type { Modifier } from "@dnd-kit/core";

/* Vertical-list drag constraint: lock horizontal movement and clamp the dragged row inside its container (activeNode.parentElement)
   rect. A standalone lib, not inlined in SortableWorkspaceSidebar: idle-time sidebar group drag
   (spec off-peak) needs the same constraint, and SortableWorkspaceSidebar carries the whole
   WorkspaceSidebarItem dependency chain, unsuitable for direct import by presentational components; hence lifted out. */
export const restrictVerticalDragWithinContainer: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  const nodeRect = draggingNodeRect ?? activeNodeRect;
  const boundaryRect = containerNodeRect ?? windowRect;
  if (!nodeRect || !boundaryRect) {
    return {
      ...transform,
      x: 0,
    };
  }

  const minY = boundaryRect.top - nodeRect.top;
  const maxY = boundaryRect.bottom - nodeRect.bottom;
  const clampedY = Math.min(Math.max(transform.y, minY), maxY);

  return {
    ...transform,
    x: 0,
    y: clampedY,
  };
};
