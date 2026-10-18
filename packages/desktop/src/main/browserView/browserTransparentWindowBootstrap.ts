export interface BrowserWindowForTransparentBootstrap {
  isDestroyed(): boolean;
  isVisible?(): boolean;
  isMinimized?(): boolean;
  isFocused?(): boolean;
  getOpacity?(): number;
  setOpacity?(opacity: number): void;
  showInactive?(): void;
  hide?(): void;
  setSkipTaskbar?(skip: boolean): void;
  on?(event: "focus", listener: () => void): void;
  removeListener?(event: "focus", listener: () => void): void;
}

export interface TransparentWindowBootstrap {
  release(): void;
}

/**
 * * Bounded presentation grace between showInactive and Viz surface creation: same-turn readback throws
 * UnknownVizError (and once SIGSEGV'd under concurrency). Every capture-right-after-showInactive path
 * (activity pump, full capture) shares this one constant.
 */
export const TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS = 100;

/**
 * Grants guests created after a macOS hide-close one invisible window-level presentation.
 *
 * undefined: bootstrap unnecessary; false: this window cannot bootstrap safely.
 */
export function startBrowserScreenshotTransparentWindowBootstrap(options: {
  win: BrowserWindowForTransparentBootstrap;
  enabled: boolean;
  windowId: number;
  webContentsId: number;
  requestId: string;
  hideTaskbarDuringBootstrap?: boolean;
  log?(message: string): void;
}): TransparentWindowBootstrap | false | undefined {
  const { win } = options;
  if (!options.enabled || win.isVisible?.() !== false || win.isMinimized?.() === true) {
    return undefined;
  }
  if (
    !win.isFocused ||
    !win.getOpacity ||
    !win.setOpacity ||
    !win.showInactive ||
    !win.hide ||
    !win.on ||
    !win.removeListener ||
    (options.hideTaskbarDuringBootstrap && !win.setSkipTaskbar)
  ) {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap unavailable windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  let originalOpacity: number;
  try {
    originalOpacity = win.getOpacity();
  } catch {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap opacity read failed windowId=${options.windowId}`,
    );
    return false;
  }

  let released = false;
  let taskbarHidden = false;
  const release = (preserveVisibility: boolean) => {
    if (released) return;
    released = true;
    try {
      win.removeListener?.("focus", handleFocus);
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap listener cleanup failed windowId=${options.windowId}`,
      );
    }
    if (win.isDestroyed()) return;

    try {
      if (!preserveVisibility && !win.isFocused?.()) {
        win.hide?.();
      }
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap hide failed windowId=${options.windowId}`,
      );
    } finally {
      if (!win.isDestroyed()) {
        try {
          win.setOpacity?.(originalOpacity);
        } catch {
          options.log?.(
            `[browser-screenshot-activity] transparent bootstrap opacity restore failed windowId=${options.windowId}`,
          );
        }
        if (taskbarHidden) {
          try {
            win.setSkipTaskbar?.(false);
          } catch {
            options.log?.(
              `[browser-screenshot-activity] transparent bootstrap taskbar restore failed windowId=${options.windowId}`,
            );
          }
        }
      }
    }
  };
  const handleFocus = () => {
    // Transparent bootstrap races user-driven restores from Dock/second-instance.
    // focus means the user owns the window again: restore opacity only, and later Ready/release must not hide again.
    release(true);
  };

  try {
    // Guests attached after the owner hid never got a compositor frame; capturer counts
    // only preserve existing surfaces. Transparentize first, then showInactive, giving one invisible
    // presentation opportunity, restoring the prior window state on Ready/release.
    if (options.hideTaskbarDuringBootstrap) {
      win.setSkipTaskbar?.(true);
      taskbarHidden = true;
    }
    win.setOpacity(0);
    win.on("focus", handleFocus);
    win.showInactive();
  } catch {
    release(true);
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap failed windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  return { release: () => release(false) };
}
