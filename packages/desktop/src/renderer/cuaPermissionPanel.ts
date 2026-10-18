import type {
  CuaPermissionKind,
  Locale,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { resolveCuaPermissionPanelMessages } from "./cuaPermissionPanelMessages.js";

interface CuaPermissionPanelState {
  permission: CuaPermissionKind;
  locale: Locale;
  iconDataUrl: string | null;
}

declare global {
  interface Window {
    cuaPermissionPanel?: {
      prepareDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
      startDrag?(): void;
      notifyDragEnded?(): void;
      onState?(callback: (state: CuaPermissionPanelState) => void): () => void;
    };
  }
}

const bridge = window.cuaPermissionPanel;
const tile = document.getElementById("tile");
const hintPrefix = document.getElementById("hintPrefix");
const permissionLabel = document.getElementById("permissionLabel");
const hintSuffix = document.getElementById("hintSuffix");
const completion = document.getElementById("completion");
const icon = document.querySelector<HTMLElement>(".icon");

// Warm up at mount: install+verify is async and must finish before the drag starts,
// or dragstart cannot begin the drag synchronously (awaiting IO misses the gesture window).
// Also fetch the Helper's real display name: the tile must show it, not a hardcoded string,
// because the macOS permission row shows exactly that value (Dev-suffixed in dev);
// matching both sides confirms dragged-thing equals listed entry.
bridge
  ?.prepareDrag?.()
  .then((result) => {
    const appName = document.getElementById("appName");
    if (result?.helperDisplayName && appName) {
      appName.textContent = result.helperDisplayName;
    }
  })
  .catch(() => {});

bridge?.onState?.((state) => {
  const messages = resolveCuaPermissionPanelMessages(state.locale, state.permission);
  document.documentElement.lang = state.locale;
  document.title = messages.documentTitle;
  if (tile) tile.title = messages.dragTitle;
  if (hintPrefix) hintPrefix.textContent = messages.hintPrefix;
  if (permissionLabel) permissionLabel.textContent = messages.permissionLabel;
  if (hintSuffix) hintSuffix.textContent = messages.hintSuffix;
  if (completion) completion.textContent = messages.completion;
  // Swap the placeholder gradient for the real ZCode icon, matching the System Settings row.
  if (state.iconDataUrl && icon) {
    icon.style.backgroundImage = `url("${state.iconDataUrl}")`;
  }
});

let dragStarted = false;

tile?.addEventListener("dragstart", (event) => {
  // Block the HTML5 default drag; main starts the native file drag via webContents.startDrag,
  // the only kind System Settings' permission list accepts.
  event.preventDefault();
  dragStarted = true;
  bridge?.startDrag?.();
});

// Once dragged, the grant is done and the panel should yield. Hide on drag end, not in dragstart: startDrag only
// hands the session to the OS (nonblocking); removing the source instantly can break the drag.
const notifyDragEnded = () => {
  if (!dragStarted) return; // A click without a drag must not close the panel.
  dragStarted = false;
  bridge?.notifyDragEnded?.();
};

// After preventDefault, dragend firing is implementation-dependent, so mouseup backs it up
// (mouse events return to the page after the native session ends). Both gates check dragStarted, and main's
// hide is idempotent, so duplicates are harmless. freezePosition is the last resort if neither arrives: no wandering.
tile?.addEventListener("dragend", notifyDragEnded);
document.addEventListener("mouseup", notifyDragEnded);
