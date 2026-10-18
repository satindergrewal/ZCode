import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function resolveReorderedModelIds(params: {
  activeModelId: string;
  overModelId: string;
  modelIds: readonly string[];
}): string[] {
  const activeIndex = params.modelIds.indexOf(params.activeModelId);
  const overIndex = params.modelIds.indexOf(params.overModelId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.modelIds];
  }
  return arrayMove([...params.modelIds], activeIndex, overIndex);
}

class ModelRowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) =>
        !isInteractiveModelDragTarget(nativeEvent.target),
    },
  ];
}

export function isInteractiveModelDragTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, textarea, select, a, [contenteditable]:not([contenteditable=false]), [data-no-model-drag], [data-slot=dialog-content], [data-slot=dialog-overlay]",
    ) !== null
  );
}

export function resolveSortableProviderModelRowClassName({
  isDragging,
  isLast,
}: {
  isDragging: boolean;
  isLast: boolean;
}): string {
  // The dragging state keeps the normal row's visible bottom divider, which reads as an underline once lifted.
  // A transparent border keeps the existing 1px slot so row height never jitters on drag-state flips.
  const dividerClassName = isDragging
    ? "border-b border-transparent"
    : isLast
      ? "border-b-0"
      : "border-b border-input-border";
  return `min-w-0 cursor-grab touch-pan-y select-none active:cursor-grabbing ${dividerClassName} ${isDragging ? "relative z-10 bg-card shadow-md" : ""}`;
}

function SortableProviderModelRow({
  modelId,
  children,
  isLast,
}: {
  modelId: string;
  children: ReactNode;
  isLast: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: modelId,
  });
  const dragLabel = intl.formatMessage({
    id: "settings.modelProvider.reorderModel",
  });
  return (
    <div
      ref={setNodeRef}
      data-model-provider-model-id={modelId}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={resolveSortableProviderModelRowClassName({ isDragging, isLast })}
      aria-label={dragLabel}
      title={dragLabel}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        // Space in the portal dialog bubbles to the model row, starting keyboard sort and writing a version first.
        // Reuse the pointer interaction's target isolation; do not preventDefault, the row stays with its own keyboard sensor.
        if (!isInteractiveModelDragTarget(event.target)) listeners?.onKeyDown?.(event);
      }}
    >
      {/* Bug rationale: useSortable adds role=button to the row. The old sensor treated the nearest
          [role=button] as the handle, so dragging from the model name or blank space never started. */}
      {children}
    </div>
  );
}

export function SortableProviderModelList({
  modelIds,
  sortableModelIds,
  onReorder,
  renderModel,
}: {
  modelIds: readonly string[];
  sortableModelIds?: readonly string[];
  onReorder?: (modelIds: string[]) => void;
  renderModel: (modelId: string, index: number) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(ModelRowPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortableIds = sortableModelIds ?? modelIds;
  const sortableSet = new Set(sortableIds);
  const content = modelIds.map((modelId, index) => {
    const row = renderModel(modelId, index);
    const isLast = index === modelIds.length - 1;
    return onReorder && sortableSet.has(modelId) ? (
      <SortableProviderModelRow key={modelId} modelId={modelId} isLast={isLast}>
        {row}
      </SortableProviderModelRow>
    ) : (
      <div key={modelId} className={isLast ? "border-b-0" : "border-b border-input-border"}>
        {row}
      </div>
    );
  });
  if (!onReorder) return content;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        if (!event.over) return;
        onReorder(
          resolveReorderedModelIds({
            activeModelId: String(event.active.id),
            overModelId: String(event.over.id),
            modelIds,
          }),
        );
      }}
    >
      <SortableContext items={[...sortableIds]} strategy={verticalListSortingStrategy}>
        {content}
      </SortableContext>
    </DndContext>
  );
}
