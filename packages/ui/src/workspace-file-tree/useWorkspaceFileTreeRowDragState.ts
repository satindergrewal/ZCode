import { useEffect, useState } from "react";

export function useWorkspaceFileTreeRowDragState() {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    // dragend is not guaranteed on the source row when the drag leaves the window. Also listen
    // for the global end signal so the drop indicator never hides permanently after a odd drag.
    const resetDragging = () => setIsDragging(false);
    window.addEventListener("dragend", resetDragging);
    window.addEventListener("drop", resetDragging);
    window.addEventListener("blur", resetDragging);
    return () => {
      window.removeEventListener("dragend", resetDragging);
      window.removeEventListener("drop", resetDragging);
      window.removeEventListener("blur", resetDragging);
    };
  }, [isDragging]);

  return { isDragging, setIsDragging };
}
