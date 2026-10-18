export function isCoarseTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function shouldRestoreChatInputFocusAfterPickerClose({
  isCoarseTouchDevice: coarseTouch,
}: {
  isCoarseTouchDevice: boolean;
}): boolean {
  // On touch devices, refocusing the contenteditable after closing the toolbar popover
  // re-opens the soft keyboard over the remote-control view; desktop keeps type-after-close.
  return !coarseTouch;
}
