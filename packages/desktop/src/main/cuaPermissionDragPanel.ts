/**
 * * Lifecycle manager for the CUA permission drag panel.
 *
 * * Four non-negotiable properties, all learned the hard way:
 *
 * * 1. **Must not activate its own app** (`type: "panel"` + `focusable: false`, both required). It floats above
 * *    System Settings; users drag between it and the Settings page. focusable alone still activates ZCode.app,
 * *    jumping focus to the main window and breaking onboarding; see createRealCuaPermissionPanelWindow notes.
 * * 2. **Must outrank System Settings** (`alwaysOnTop(true, "screen-saver")`); plain floating gets covered when
 * *    the Settings page activates.
 * * 3. **Stop position tracking once the drag lands** (`freezePosition()`); Settings then shows a modal and continued
 * *    tracking chases it and gets buried.
 * * 4. **Destroy on every terminal state.** PiP panels once lived forever without explicit start/stop edges; here
 * show/hide/destroy are explicit, destroy is idempotent and stops the position source.
 *
 * The real BrowserWindow is injected via `createWindow`, so lifecycle/positioning unit-test without Electron.
 */

import type { CuaPermissionKind, Locale } from "@zcode/shared";
import { resolvePanelBounds, type PanelSize, type Rect } from "./cuaPermissionPanelPositioner.js";

/* /** The minimal window surface the panel needs, for easy test doubles. */
export interface CuaPermissionPanelWindow {
  onceReadyToShow(callback: () => void): void;
  setBounds(bounds: Rect): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface CreateCuaPermissionDragPanelOptions {
  createWindow: (initialBounds: Rect) => CuaPermissionPanelWindow;
  getDisplayWorkArea: () => Rect;
  /* /** System Settings bounds source; on absence or throw, fail-open to the screen bottom. */
  getSettingsBounds?: () => Rect | null;
  /* /** Releases that source (usually kills the resident helper). */
  stopSettingsBounds?: () => void;
  /* /** App icon (data URL) shown in the panel tile; the page falls back to a builtin placeholder. */
  getIconDataUrl?: () => string | null;
  /* /** Current ZCode UI locale, re-read on every show; the panel never guesses the system language. */
  getLocale: () => Locale;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  panelSize?: PanelSize;
  repositionIntervalMs?: number;
}

export interface CuaPermissionDragPanel {
  show(permission: CuaPermissionKind): void;
  /**
   * * Stops position tracking while the window stays visible and draggable.
   *
   * * After a landed drag, Settings shows a modal (may-not-record); more tracking chases the dialog,
   * * buries the panel, and distracts from Settings, where attention now is. The position must pin after one drag;
   * * the next permission stage's show() resumes tracking automatically.
   */
  freezePosition(): void;
  hide(): void;
  destroy(): void;
}

export const CUA_PERMISSION_PANEL_STATE_CHANNEL = "zcode:cua-permission-panel-state";

const DEFAULT_PANEL_SIZE: PanelSize = { width: 560, height: 124 };
// // 150ms tracking: balances sync cost against panel responsiveness while Settings drags.
const DEFAULT_REPOSITION_INTERVAL_MS = 150;

export function createCuaPermissionDragPanel(
  options: CreateCuaPermissionDragPanelOptions,
): CuaPermissionDragPanel {
  const panelSize = options.panelSize ?? DEFAULT_PANEL_SIZE;
  const intervalMs = options.repositionIntervalMs ?? DEFAULT_REPOSITION_INTERVAL_MS;

  let window: CuaPermissionPanelWindow | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastBounds: Rect | null = null;
  let destroyed = false;

  function readSettingsBounds(): Rect | null {
    if (!options.getSettingsBounds) return null;
    try {
      return options.getSettingsBounds();
    } catch (error) {
      // // Fail-open: snapping is cosmetic; a broken source must never kill onboarding.
      options.logger.warn(
        "[cua-permission-panel] settings bounds source failed; falling back to screen bottom",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  function sameRect(a: Rect | null, b: Rect): boolean {
    return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function reposition(): void {
    if (!window || window.isDestroyed()) return;
    const bounds = resolvePanelBounds({
      settings: readSettingsBounds(),
      display: options.getDisplayWorkArea(),
      panel: panelSize,
    });
    // // setBounds every tick visibly jitters; move only when the target rect truly changes.
    if (sameRect(lastBounds, bounds)) return;
    lastBounds = bounds;
    window.setBounds(bounds);
  }

  function startTracking(): void {
    if (timer) return;
    timer = setInterval(reposition, intervalMs);
    // // Position tracking must never keep the process alive.
    timer.unref?.();
  }

  function stopTracking(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    show(permission: CuaPermissionKind): void {
      if (destroyed) destroyed = false;
      const initialBounds = resolvePanelBounds({
        settings: readSettingsBounds(),
        display: options.getDisplayWorkArea(),
        panel: panelSize,
      });
      lastBounds = initialBounds;

      if (!window || window.isDestroyed()) {
        window = options.createWindow(initialBounds);
        window.onceReadyToShow(() => {
          if (!window || window.isDestroyed()) return;
          window.setBounds(lastBounds ?? initialBounds);
          // // The panel is a static renderer outside the main React Intl tree; without an explicit locale even
          // English ZCode flashes hardcoded Chinese. Send locale before show to avoid the fallback flash.
          window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
            permission,
            locale: options.getLocale(),
            iconDataUrl: options.getIconDataUrl?.() ?? null,
          });
          window.showInactive();
          startTracking();
        });
        return;
      }

      window.setBounds(initialBounds);
      window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
        permission,
        locale: options.getLocale(),
        iconDataUrl: options.getIconDataUrl?.() ?? null,
      });
      window.showInactive();
      startTracking();
    },

    hide(): void {
      stopTracking();
      if (window && !window.isDestroyed()) window.hide();
    },

    freezePosition(): void {
      stopTracking();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopTracking();
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
      lastBounds = null;
      options.stopSettingsBounds?.();
    },
  };
}

/**
 * * Production window factory. The option set is the minimal tested-working combination; each line earns its place:
 * *   frame:false + transparent: rounded overlay look
 *   type:"panel"               —— NSPanel + NSWindowStyleMaskNonactivatingPanel：
 * *   (with type:panel) clicking never activates the owning app
 * *   focusable:false: the window itself never takes focus
 * *   skipTaskbar:true: stays out of Dock and task switchers
 * *   show:false + showInactive: visible without activation
 * *   alwaysOnTop screen-saver: outranks System Settings (floating gets covered)
 *
 * * type and focusable must co-occur; the first cut set focusable:false only and clicking the panel
 * * threw focus to the main window. Three-way comparison:
 * *   focusable:false alone: app still activates, focus lands on the next focusable window (main)
 * *   type:panel alone (focusable defaults true): the panel takes focus, activating the app, burying Settings
 * *   both: zero focus events on click, Settings stays frontmost
 * * In short focusable silences the window, type:panel silences app activation; either half missing breaks it.
 */
export function createRealCuaPermissionPanelWindow(deps: {
  BrowserWindow: typeof import("electron").BrowserWindow;
  app: Pick<typeof import("electron").app, "isPackaged">;
  preloadPath: string;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
}): (initialBounds: Rect) => CuaPermissionPanelWindow {
  return (initialBounds: Rect) => {
    const win = new deps.BrowserWindow({
      ...initialBounds,
      // // macOS: NSPanel with NSWindowStyleMaskNonactivatingPanel; see above,
      // // the necessary condition for clicks that leave Settings frontmost.
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // // Match the main window: packaged builds always load renderer assets from the signed bundle.
    if (!deps.app.isPackaged && deps.rendererDevUrl) {
      void win.loadURL(`${deps.rendererDevUrl}/cua-permission-panel.html`);
    } else {
      void win.loadFile(`${deps.rendererDir}/cua-permission-panel.html`);
    }

    return {
      onceReadyToShow(callback: () => void) {
        win.once("ready-to-show", callback);
      },
      setBounds(bounds: Rect) {
        win.setBounds(bounds);
      },
      showInactive() {
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      },
      hide() {
        win.hide();
      },
      destroy() {
        win.destroy();
      },
      isDestroyed: () => win.isDestroyed(),
      send(channel: string, payload: unknown) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
    };
  };
}
