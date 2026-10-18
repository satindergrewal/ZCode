/** Geometry constraints of the share-selection panel; content itself stays CSS-driven. */
const CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX = 24;
const CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX = 16;
/** Two candidate rows (48px each, 8px gap) plus 16px vertical padding; below this the panel is unusable. */
const CONVERSATION_SHARE_SELECTION_PANEL_MIN_HEIGHT_PX = 120;
export const CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY =
  "--conversation-share-selection-panel-max-height";
export const CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY =
  "--conversation-share-selection-panel-center-y";

interface ConversationShareSelectionPanelLayoutInput {
  /** Conversation content container height, WorkspaceHeader excluded. */
  containerHeightPx: number;
  /** Top of the bottom composer/share dock, in content-container coordinates. */
  dockStartPx: number;
}

interface ConversationShareSelectionPanelLayout {
  centerYPx: number;
  maxHeightPx: number;
  topPx: number;
  bottomPx: number;
}

function normalizeSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Computes the panel max visible height and vertical anchor.
 *
 * Content measurement decides the real height when content is short; this only caps max-height so a
 * tall panel never covers the input above the bottom dock. The top baseline stays in the safe margin;
 * bottom collisions compress visible height only, scrolling stays with the ScrollArea.
 *
 * A plain min(container-available, above-dock) height is not enough; on short viewports or tall docks
 * else it collapses into an unusable zero-height sliver. Keep a minimum height:
 * reclaim the top safe padding first; only then eat into the dock gap, never beyond the container.
 */
function resolveConversationShareSelectionPanelLayout({
  containerHeightPx,
  dockStartPx,
}: ConversationShareSelectionPanelLayoutInput): ConversationShareSelectionPanelLayout {
  const containerHeight = normalizeSize(containerHeightPx);
  const dockStart = Math.min(containerHeight, normalizeSize(dockStartPx));
  const unconstrainedMaxHeight = Math.max(
    0,
    containerHeight - CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX * 2,
  );
  const minHeight = Math.min(
    unconstrainedMaxHeight,
    CONVERSATION_SHARE_SELECTION_PANEL_MIN_HEIGHT_PX,
  );
  const top = Math.max(
    0,
    Math.min(
      CONVERSATION_SHARE_SELECTION_PANEL_EDGE_INSET_PX,
      dockStart - CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX - minHeight,
    ),
  );
  const availableHeight = Math.max(
    0,
    dockStart - CONVERSATION_SHARE_SELECTION_PANEL_DOCK_GAP_PX - top,
  );
  const maxHeight = Math.max(minHeight, Math.min(unconstrainedMaxHeight, availableHeight));

  return {
    centerYPx: top + maxHeight / 2,
    maxHeightPx: maxHeight,
    topPx: top,
    bottomPx: top + maxHeight,
  };
}

/** Writes the layout result into the shared parent, so panel and Timeline share one coordinate space. */
export function syncConversationShareSelectionPanelLayout(
  container: HTMLElement,
  dock: HTMLElement,
): ConversationShareSelectionPanelLayout {
  const containerRect = container.getBoundingClientRect();
  const dockRect = dock.getBoundingClientRect();
  const layout = resolveConversationShareSelectionPanelLayout({
    containerHeightPx: containerRect.height,
    dockStartPx: dockRect.top - containerRect.top,
  });
  const maxHeight = `${layout.maxHeightPx}px`;
  const centerY = `${layout.centerYPx}px`;

  if (
    container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY) !==
    maxHeight
  ) {
    container.style.setProperty(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY, maxHeight);
  }
  if (
    container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY) !==
    centerY
  ) {
    container.style.setProperty(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY, centerY);
  }

  return layout;
}
