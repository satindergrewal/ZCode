/**
 * * Geometry for the permission drag panel.
 *
 * Deliberately Electron-free pure functions: snapping needs System Settings bounds, an input that can vanish
 * (helper missing/killed, Settings closed). Separating geometry from acquisition makes the fail-open
 * behavior exhaustively testable: snapping is cosmetic, so no-bounds must land somewhere usable.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

export interface ResolvePanelBoundsInput {
  /* /** System Settings main-window bounds; null when unavailable (fail-open to screen bottom). */
  settings: Rect | null;
  /** WorkArea of the target display (menu bar/Dock excluded). */
  display: Rect;
  panel: PanelSize;
}

/** Slight overlap with the Settings bottom edge so panel and window read as one. */
const ANCHOR_OVERLAP_PX = 6;
/** Bottom margin in the fail-open layout. */
const SCREEN_BOTTOM_INSET_PX = 28;

function clamp(value: number, min: number, max: number): number {
  // When max < min (panel larger than the workarea), clamp to top/left first.
  return Math.max(min, Math.min(value, max));
}

function isUsableRect(rect: Rect | null): rect is Rect {
  // CGWindowList sometimes reports 0x0 transitional windows; treat them as unusable or the panel teleports to a corner.
  return rect !== null && rect.width > 0 && rect.height > 0;
}

export function resolvePanelBounds(input: ResolvePanelBoundsInput): Rect {
  const { settings, display, panel } = input;

  const anchored = isUsableRect(settings);
  const rawX = anchored
    ? settings.x + (settings.width - panel.width) / 2
    : display.x + (display.width - panel.width) / 2;
  const rawY = anchored
    ? settings.y + settings.height - ANCHOR_OVERLAP_PX
    : display.y + display.height - panel.height - SCREEN_BOTTOM_INSET_PX;

  return {
    x: Math.round(clamp(rawX, display.x, display.x + display.width - panel.width)),
    y: Math.round(clamp(rawY, display.y, display.y + display.height - panel.height)),
    width: Math.round(panel.width),
    height: Math.round(panel.height),
  };
}
