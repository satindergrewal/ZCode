export function resolveConversationSelectionTooltipEnabled({
  selectionActionsEnabled,
  partialShareActive,
}: {
  selectionActionsEnabled: boolean;
  partialShareActive: boolean;
}): boolean {
  // The partial-selection scrim only raises visual layering and never closes the global Selection listener,
  // so underlying messages can still summon the cross-feature toolbar. Selection mode must own message selection exclusively.
  return selectionActionsEnabled && !partialShareActive;
}

export function resolveConversationShareBackgroundScrollLocked({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // The selection-panel scrim blocks body pointer events only; the timeline stays
  // overflow-y-auto, so the background scrollbar and keyboard scrolling still move scrollTop.
  return resolveConversationShareSelectionPanelVisible({ partialShareActive, stage, view });
}

export function resolveConversationShareSelectionPanelVisible({
  partialShareActive,
  stage = "selection",
  view,
}: {
  partialShareActive: boolean;
  stage?: "selection" | "configuration";
  view: "selection" | "timeline" | undefined;
}): boolean {
  // The visual mask used to bind to the whole partial scope and outlive the panel,
  // faking anchored completion by locally raising target text. The mask must live and die with panel visibility.
  return partialShareActive && stage === "selection" && view === "selection";
}
