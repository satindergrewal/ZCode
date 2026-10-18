/**
 * Minimal controlled-view abstraction: executors depend only on these methods, stub-testable without Electron.
 * The real implementation is browserGuestManager over a webview guest's webContents + webContents.debugger.
 */
export interface ControlledViewWebContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /**
   * Evaluates a script in the page context, returning the last expression (structured clone).
   * Wired by browserGuestManager to guest.executeJavaScript(script, true) (userGesture, as element-picker).
   */
  executeJavaScript(script: string): Promise<unknown>;
}

export interface ControlledViewCdp {
  /** Pass-through to webContents.debugger.sendCommand; sessionId targets cross-process iframe/OOPIF. */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

export interface ControlledView {
  webContents: ControlledViewWebContents;
  cdp: ControlledViewCdp;
  /**
   * Viewport screenshot already composited by the host. Normal captures only (no clip, not fullPage);
   * desktop production reads the guest surface in main, dodging Windows CDP tiling of small surfaces.
   */
  captureViewportScreenshot?: () => Promise<string | undefined>;
  /**
   * Free-size guests keep the host backing scale on the visible surface; capture targets stay CSS px.
   * Only when flagged does the executor read CDP layout metrics and verify the real raster.
   */
  normalizeScreenshotToCssPixels?: boolean;
  /**
   * High-quality downscaling from the host image engine. The core executor never imports Electron:
   * desktop production wires nativeImage; tests/other hosts inject equivalents.
   */
  resizeScreenshotToCssPixels?: (
    base64Png: string,
    target: { height: number; width: number },
  ) => Promise<string | undefined> | string | undefined;
}

export interface BrowserPoint {
  cx: number;
  cy: number;
}
