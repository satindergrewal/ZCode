interface TaskWorkbenchDragPreviewParams {
  clientX: number;
  clientY: number;
  dataTransfer: Pick<DataTransfer, "setDragImage">;
  source: HTMLElement;
}

function createTaskWorkbenchDragPreview({
  clientX,
  clientY,
  dataTransfer,
  source,
}: TaskWorkbenchDragPreviewParams): () => void {
  const document = source.ownerDocument;
  const sourceRect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  preview.dataset.taskWorkbenchDragPreview = "true";
  // The default drag preview's transparent background leaves the Project task borderless in the overlay;
  // keep the row content and add the same surface styles the Grouped drag overlay already uses.
  preview.classList.add("border", "border-border", "bg-background", "shadow-lg");
  preview.style.position = "fixed";
  preview.style.left = "-10000px";
  preview.style.top = "-10000px";
  preview.style.pointerEvents = "none";
  preview.style.width = `${sourceRect.width}px`;
  document.body.append(preview);

  dataTransfer.setDragImage(
    preview,
    Math.max(0, Math.min(clientX - sourceRect.left, sourceRect.width)),
    Math.max(0, Math.min(clientY - sourceRect.top, sourceRect.height)),
  );

  return () => preview.remove();
}

export { createTaskWorkbenchDragPreview };
