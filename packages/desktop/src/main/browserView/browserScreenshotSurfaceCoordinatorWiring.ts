import { PlatformChannels } from "@zcode/shared";
import { DesktopBrowserScreenshotActivityController } from "./browserScreenshotActivityController.js";
import { DesktopBrowserScreenshotSurfaceCoordinator } from "./browserScreenshotSurfaceCoordinator.js";

interface BrowserWindowForScreenshotSurface {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
    send(channel: string, payload: unknown): void;
  };
}

interface GuestWebContentsForScreenshotActivity {
  id: number;
  isDestroyed(): boolean;
  readonly hostWebContents: { id: number } | null;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

/** Bind the screenshot surface coordinator to its owner BrowserWindow; the coordinator avoids Electron globals for testability. */
export function createDesktopBrowserScreenshotSurfaceCoordinator(options: {
  fromId(windowId: number): BrowserWindowForScreenshotSurface | null;
  fromWebContentsId(webContentsId: number): GuestWebContentsForScreenshotActivity | null;
  log?(message: string): void;
  warn?(message: string): void;
  timeoutMs?: number;
  activityTimeoutMs?: number;
  allowTransparentWindowBootstrap?: boolean;
  hideTaskbarDuringTransparentWindowBootstrap?: boolean;
}): DesktopBrowserScreenshotSurfaceCoordinator {
  const activityController = new DesktopBrowserScreenshotActivityController({
    fromId: options.fromId,
    fromWebContentsId: options.fromWebContentsId,
    allowTransparentWindowBootstrap:
      options.allowTransparentWindowBootstrap ??
      (process.platform === "darwin" || process.platform === "win32"),
    hideTaskbarDuringTransparentWindowBootstrap:
      options.hideTaskbarDuringTransparentWindowBootstrap ?? process.platform === "win32",
    log: options.log,
  });
  return new DesktopBrowserScreenshotSurfaceCoordinator({
    timeoutMs: options.timeoutMs,
    activityTimeoutMs: options.activityTimeoutMs,
    acquireActivity: (windowId, payload) =>
      activityController.acquire({
        windowId,
        webContentsId: payload.webContentsId,
        requestId: payload.requestId,
        reason: "browser-screenshot",
      }),
    sendPrepare: (windowId, payload) => {
      const win = options.fromId(windowId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        options.log?.("[browser-screenshot-surface] prepare skipped for destroyed owner window");
        return false;
      }
      try {
        win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfacePrepare, payload);
        return true;
      } catch {
        // send can throw synchronously while the Electron window is closing; prepare must
        // turn that into a controlled failure, not leak it into the main process.
        options.log?.("[browser-screenshot-surface] prepare send failed");
        return false;
      }
    },
    sendRelease: (windowId, payload) => {
      const win = options.fromId(windowId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        options.log?.("[browser-screenshot-surface] release skipped for destroyed owner window");
        return;
      }
      try {
        win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfaceRelease, payload);
      } catch {
        // release runs inside timeout/dispose/lease finally blocks; it must never throw back into main-process cleanup.
        options.log?.("[browser-screenshot-surface] release send failed");
      }
    },
    log: options.log,
    warn: options.warn,
  });
}
