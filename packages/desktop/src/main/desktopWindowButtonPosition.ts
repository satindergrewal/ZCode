import { nativeTheme, type BrowserWindow, type Point } from "electron";
import { PlatformChannels } from "@zcode/shared";
import {
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";

export const MACOS_TRAFFIC_LIGHT_BASE_POSITION = { x: 22, y: 23 } as const;
export const MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX = 96;
export const MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN = 1.5;
export const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
export const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX = 4;
const customWindowsControls = new WeakSet<BrowserWindow>();

export function registerCustomWindowsControls(window: BrowserWindow) {
  customWindowsControls.add(window);
}

export function hasCustomWindowsControls(window: BrowserWindow) {
  return customWindowsControls.has(window);
}

export function resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel: number): Point {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const resolveVerticalPosition = (base: number) =>
    Math.max(
      MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX,
      Math.round(base + (base * zoomFactor - base) * MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN),
    );
  return {
    x: MACOS_TRAFFIC_LIGHT_BASE_POSITION.x,
    y: resolveVerticalPosition(MACOS_TRAFFIC_LIGHT_BASE_POSITION.y),
  };
}

export function resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const buttonPosition = resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel);
  return {
    buttonPosition,
    metrics: {
      leftPaddingPx: Math.round(MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX / zoomFactor),
    },
  };
}

export function resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel: number) {
  return Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * resolveDesktopZoomFactorForLevel(zoomLevel));
}

export function resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  return {
    // Native button widths ignore page zoom; the fixed CSS margin applies only to the custom-controls branch below.
    rightPaddingPx: Math.round(
      WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / resolveDesktopZoomFactorForLevel(zoomLevel),
    ),
    titleBarHeightPx: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

export function buildWindowsTitleBarOverlayForZoomLevel(
  zoomLevel: number,
  theme: "light" | "dark",
) {
  return {
    color: "#00000000",
    symbolColor: theme === "dark" ? "#f5f5f5" : "#1f1f1f",
    height: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

export function syncWindowControlsOverlayForZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  zoomLevel: number,
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (process.platform === "darwin") {
    const { buttonPosition, metrics } =
      resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel);
    // Page zoom resizes the renderer top bar, but macOS traffic lights ignore zoom.
    // Re-vertical the native buttons per zoom factor; keep the system x, avoiding double compensation with the fixed-width safe area.
    // Traffic-light width is zoom-invariant, so renderer padding compensates inversely by zoomFactor.
    targetWindow.setWindowButtonPosition(buttonPosition);
    targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, metrics);
    return;
  }

  if (process.platform === "win32") {
    if (hasCustomWindowsControls(targetWindow)) {
      // Custom buttons scale with zoom and safe areas stay CSS px, so no extra native-width compensation.
      targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, {
        rightPaddingPx: WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX,
      });
      return;
    }
    // Windows titleBarOverlay controls do not follow renderer zoom automatically.
    // Height-only sync matches vertical sizes but the fixed 136px safe area scales with zoom,
    // pulling nav and window buttons apart; clamped heights also freeze the controls when zooming out.
    // Sync overlay.height and inverse-compensate the right safe area by zoomFactor so both sides scale together.
    targetWindow.setTitleBarOverlay(
      buildWindowsTitleBarOverlayForZoomLevel(
        zoomLevel,
        nativeTheme.shouldUseDarkColors ? "dark" : "light",
      ),
    );
    targetWindow.webContents.send(
      PlatformChannels.WindowControlsOverlayChanged,
      resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel),
    );
  }
}

export function syncMacOSWindowButtonPositionForZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  zoomLevel: number,
) {
  syncWindowControlsOverlayForZoomLevel(targetWindow, zoomLevel);
}

export function syncMacOSWindowButtonPositionForCurrentZoomFactor(
  targetWindow: BrowserWindow | null | undefined,
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  syncWindowControlsOverlayForZoomLevel(targetWindow, zoomLevel);
}
