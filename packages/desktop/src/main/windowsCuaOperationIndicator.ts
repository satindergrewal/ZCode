import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions, Display, Point, Rectangle } from "electron";
import type { HostCuaOperationStateResponse, Locale } from "@zcode/shared";
import {
  INDICATOR_CARD_TOP_OFFSET,
  INDICATOR_SHADOW_INSET,
  indicatorDataUrl,
  indicatorWindowSize,
} from "./windowsCuaOperationIndicatorContent.js";

const HIDE_ANIMATION_MS = 120;
/**
 * * Fallback hide deadline. Turn end/session close/runtime loss/workspace disposal drive the real hides;
 * this timer fires only if all of them fail, so the overlay never sticks forever.
 *
 * 30s, not shorter: CUA facts report per cell (one per node_repl cell); later cells refresh the timer
 // but one cell can run long; 10s would darken the overlay mid-operation.
 */
const AUTO_HIDE_MS = 30_000;
const CREATE_RETRY_MS = 250;

export interface WindowsCuaOperationIndicatorWindow {
  readonly webContents: Pick<BrowserWindow["webContents"], "executeJavaScript">;
  destroy(): void;
  hide(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  moveTop(): void;
  on(event: "closed", listener: () => void): this;
  setAlwaysOnTop(flag: boolean, level?: Parameters<BrowserWindow["setAlwaysOnTop"]>[1]): void;
  setBounds(bounds: Rectangle): void;
  setContentProtection(enable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  showInactive(): void;
}

export interface WindowsCuaOperationIndicator {
  handleState(source: object, event: HostCuaOperationStateResponse): void;
  clearSource(source: object): void;
  ownsWindow(candidate: object): boolean;
  refreshContent(): void;
  dispose(): void;
}

interface IndicatorLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface WindowsCuaOperationIndicatorOptions {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  logger: IndicatorLogger;
  createWindow?: (options: BrowserWindowConstructorOptions) => WindowsCuaOperationIndicatorWindow;
  getCursorScreenPoint?: () => Point;
  getDisplayNearestPoint?: (point: Point) => Pick<Display, "workArea">;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createWindowsCuaOperationIndicator(
  options: WindowsCuaOperationIndicatorOptions,
): WindowsCuaOperationIndicator {
  const platform = options.platform ?? process.platform;
  const createWindow =
    options.createWindow ??
    ((windowOptions: BrowserWindowConstructorOptions) =>
      new BrowserWindow(windowOptions) as WindowsCuaOperationIndicatorWindow);
  const getCursorScreenPoint =
    options.getCursorScreenPoint ?? (() => screen.getCursorScreenPoint());
  const getDisplayNearestPoint =
    options.getDisplayNearestPoint ?? ((point: Point) => screen.getDisplayNearestPoint(point));
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));

  const activeTurnKeysBySource = new Map<object, Set<string>>();
  const ownedWindows = new WeakSet<object>();
  const failedWindows = new WeakSet<object>();
  let window: WindowsCuaOperationIndicatorWindow | null = null;
  let windowReady = false;
  let windowShown = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const autoHideTimersBySource = new Map<object, Map<string, ReturnType<typeof setTimeout>>>();
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let setupRetryAvailable = false;
  let disposed = false;

  function hasActiveTurns(): boolean {
    for (const keys of activeTurnKeysBySource.values()) {
      if (keys.size > 0) return true;
    }
    return false;
  }

  function keyFor(event: HostCuaOperationStateResponse): string {
    const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
    return `${workspaceKey}\0${event.sessionId}\0${event.turnId}`;
  }

  function setDocumentState(nextState: "active" | "leaving"): void {
    if (!window || window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(nextState)}`)
      .catch((error) =>
        options.logger.debug("[cua-operation-indicator] state update failed", error),
      );
  }

  function cancelPendingHide(): void {
    if (!hideTimer) return;
    cancelSchedule(hideTimer);
    hideTimer = null;
  }

  function cancelAutoHide(source: object, key: string): void {
    const timers = autoHideTimersBySource.get(source);
    const timer = timers?.get(key);
    if (!timer) return;
    cancelSchedule(timer);
    timers?.delete(key);
    if (timers?.size === 0) autoHideTimersBySource.delete(source);
  }

  function scheduleAutoHide(source: object, key: string): void {
    cancelAutoHide(source, key);
    const timers = autoHideTimersBySource.get(source) ?? new Map();
    autoHideTimersBySource.set(source, timers);
    let timer: ReturnType<typeof setTimeout>;
    timer = schedule(() => {
      const currentTimers = autoHideTimersBySource.get(source);
      if (currentTimers?.get(key) !== timer) return;
      currentTimers.delete(key);
      if (currentTimers.size === 0) autoHideTimersBySource.delete(source);

      const sourceKeys = activeTurnKeysBySource.get(source);
      if (!sourceKeys?.delete(key)) return;
      if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
      // The safety timer is the fail-hidden boundary: without a runtime inactive, the native overlay
      // must not stay visible forever; a later CUA tool-started re-arms the key and timer.
      if (!hasActiveTurns()) beginHide();
    }, AUTO_HIDE_MS);
    timers.set(key, timer);
  }

  function scheduleSetupRetry(): void {
    if (!setupRetryAvailable || !hasActiveTurns() || reconcileTimer) return;
    setupRetryAvailable = false;
    reconcileTimer = schedule(() => {
      reconcileTimer = null;
      ensureWindow();
    }, CREATE_RETRY_MS);
  }

  function discardFailedWindow(target: WindowsCuaOperationIndicatorWindow): void {
    failedWindows.add(target);
    if (window === target) {
      window = null;
      windowReady = false;
      windowShown = false;
    }
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.debug(
        "[cua-operation-indicator] failed to discard partial window",
        destroyError,
      );
    }
  }

  function positionWindow(target: WindowsCuaOperationIndicatorWindow): void {
    const { width, height } = indicatorWindowSize(options.getLocale());
    const point = getCursorScreenPoint();
    const { workArea } = getDisplayNearestPoint(point);
    target.setBounds({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + INDICATOR_CARD_TOP_OFFSET - INDICATOR_SHADOW_INSET.top),
    });
  }

  function handleLoadFailure(target: WindowsCuaOperationIndicatorWindow, error: unknown): void {
    options.logger.warn("[cua-operation-indicator] failed to load window content", error);
    if (disposed || target !== window) return;
    discardFailedWindow(target);
    scheduleSetupRetry();
  }

  function showWindowOnTop(target: WindowsCuaOperationIndicatorWindow): void {
    target.showInactive();
    // Windows can drop WS_EX_TOPMOST after hiding transparent windows; showInactive restores visibility only,
    // not Z-order, so re-assert the band and bring to front on every show.
    target.setAlwaysOnTop(true, "screen-saver");
    target.moveTop();
  }

  function loadContent(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      positionWindow(target);
      void target
        .loadURL(indicatorDataUrl(options.getLocale()))
        .then(() => {
          if (disposed || target !== window || target.isDestroyed()) return;
          windowReady = true;
          setupRetryAvailable = false;
          if (!hasActiveTurns()) {
            // refreshContent can land after hide; the HTML defaults to active, so restore the idle state explicitly
            // when no turn is live, or a stray show() would fake activity.
            setDocumentState("leaving");
            return;
          }
          positionWindow(target);
          showWindowOnTop(target);
          windowShown = true;
          setDocumentState("active");
        })
        .catch((error) => handleLoadFailure(target, error));
    } catch (error) {
      handleLoadFailure(target, error);
    }
  }

  function ensureWindow(repositionExisting = false): void {
    if (disposed || platform !== "win32" || !hasActiveTurns()) return;
    cancelPendingHide();
    if (window && !window.isDestroyed()) {
      if (repositionExisting) positionWindow(window);
      setDocumentState("active");
      // Root cause: exit hides without destroying; reused turns must re-show the loaded window.
      if (windowReady && !windowShown) {
        showWindowOnTop(window);
        windowShown = true;
      }
      if (windowReady) setupRetryAvailable = false;
      return;
    }

    let created: WindowsCuaOperationIndicatorWindow | null = null;
    try {
      const { width, height } = indicatorWindowSize(options.getLocale());
      created = createWindow({
        width,
        height,
        alwaysOnTop: true,
        focusable: false,
        frame: false,
        // The old window kept a 1px transparent border and DWM's rectangular shadow, clipping rounded corners
        // into hard edges; a larger transparent canvas lets CSS own the shadow.
        hasShadow: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        transparent: true,
        backgroundColor: "#00000000",
        autoHideMenuBar: true,
        fullscreenable: false,
        maximizable: false,
        minimizable: false,
        movable: false,
        webPreferences: {
          contextIsolation: true,
          devTools: false,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window = created;
      windowReady = false;
      windowShown = false;
      ownedWindows.add(created);
      created.setIgnoreMouseEvents(true);
      created.setContentProtection(true);
      created.on("closed", () => {
        const failedDuringSetup = failedWindows.delete(created as object);
        if (window === created) {
          window = null;
          windowReady = false;
          windowShown = false;
        }
        if (failedDuringSetup || disposed || !hasActiveTurns() || reconcileTimer) return;
        // Cause: the OS can close the window mid-turn; rebuild proactively, never wait for the next state.
        setupRetryAvailable = true;
        reconcileTimer = schedule(() => {
          reconcileTimer = null;
          ensureWindow();
        }, 0);
      });
      loadContent(created);
    } catch (error) {
      options.logger.warn("[cua-operation-indicator] failed to create secure window", error);
      if (created) discardFailedWindow(created);
      scheduleSetupRetry();
    }
  }

  function hideOrDestroy(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      target.hide();
      windowShown = false;
      return;
    } catch (error) {
      // Closing is the safety floor: the overlay claims ZCode-is-operating, and a failed hide lies to the user.
      // If hide() throws, destroy instead; the next CUA cell rebuilds via ensureWindow.
      options.logger.warn("[cua-operation-indicator] hide failed, destroying window", error);
    }
    if (window === target) {
      window = null;
      windowReady = false;
    }
    windowShown = false;
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.warn(
        "[cua-operation-indicator] destroy after failed hide failed",
        destroyError,
      );
    }
  }

  function beginHide(): void {
    setupRetryAvailable = false;
    if (!window || window.isDestroyed() || hideTimer) return;
    setDocumentState("leaving");
    const target = window;
    hideTimer = schedule(() => {
      hideTimer = null;
      if (!disposed && !hasActiveTurns() && target === window && !target.isDestroyed()) {
        hideOrDestroy(target);
      }
    }, HIDE_ANIMATION_MS);
  }

  function handleState(source: object, event: HostCuaOperationStateResponse): void {
    if (disposed || platform !== "win32") return;
    const key = keyFor(event);
    const sourceKeys = activeTurnKeysBySource.get(source);
    if (event.active) {
      if (sourceKeys?.has(key)) {
        cancelPendingHide();
        scheduleAutoHide(source, key);
        ensureWindow();
        return;
      }
      const wasActive = hasActiveTurns();
      if (!wasActive) setupRetryAvailable = true;
      const nextKeys = sourceKeys ?? new Set<string>();
      nextKeys.add(key);
      activeTurnKeysBySource.set(source, nextKeys);
      scheduleAutoHide(source, key);
      // Reposition to the pointer's display only on empty-to-nonempty transitions; parallel sources otherwise make it jump.
      ensureWindow(!wasActive);
      return;
    }
    if (!sourceKeys?.delete(key)) return;
    cancelAutoHide(source, key);
    if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
    if (!hasActiveTurns()) beginHide();
  }

  function clearSource(source: object): void {
    if (disposed || platform !== "win32" || !activeTurnKeysBySource.delete(source)) return;
    const timers = autoHideTimersBySource.get(source);
    for (const key of timers ? [...timers.keys()] : []) {
      cancelAutoHide(source, key);
    }
    if (!hasActiveTurns()) beginHide();
  }

  function refreshContent(): void {
    if (disposed || platform !== "win32" || !window || window.isDestroyed()) return;
    if (hasActiveTurns()) setupRetryAvailable = true;
    loadContent(window);
  }

  function ownsWindow(candidate: object): boolean {
    return ownedWindows.has(candidate);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    setupRetryAvailable = false;
    activeTurnKeysBySource.clear();
    for (const [source, timers] of autoHideTimersBySource) {
      for (const timer of timers.values()) cancelSchedule(timer);
      autoHideTimersBySource.delete(source);
    }
    cancelPendingHide();
    if (reconcileTimer) {
      cancelSchedule(reconcileTimer);
      reconcileTimer = null;
    }
    const target = window;
    window = null;
    windowReady = false;
    windowShown = false;
    if (target && !target.isDestroyed()) target.destroy();
  }

  return { handleState, clearSource, ownsWindow, refreshContent, dispose };
}
