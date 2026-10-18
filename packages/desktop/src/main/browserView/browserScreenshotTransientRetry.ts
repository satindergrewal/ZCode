/** CopyFromSurface before the Viz surface exists throws UnknownVizError; once
 * created, the same request succeeds immediately. Any other failure (guest destroyed, cross-window) is fatal. */
export function isTransientScreenshotCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UnknownVizError");
}

interface ScreenshotTransientRetryContext {
  target: "owner" | "guest";
  windowId: number;
  webContentsId: number;
}

const TRANSIENT_CAPTURE_RETRY_DELAY_MS = 100;
// Budget below the 3s surface-prepare timeout (BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS),
// leaving handshake headroom for the renderer.
const TRANSIENT_CAPTURE_RETRY_BUDGET_MS = 2_000;

/**
 * Transient-retry budget probed at prepare: UnknownVizError is transient with serialized backoff;
 * cumulative failures past the budget give up (back to fast-fail invalidate); any success resets.
 */
export class DesktopBrowserScreenshotTransientRetry {
  private startedAt: number | undefined;
  private attempts = 0;

  constructor(
    private readonly options: {
      delayMs?: number;
      budgetMs?: number;
      log?(message: string): void;
    } = {},
  ) {}

  retryDelayMs(): number {
    return this.options.delayMs ?? TRANSIENT_CAPTURE_RETRY_DELAY_MS;
  }

  /** Records one transient failure; false means budget exhausted, no more retries. */
  schedule(context: ScreenshotTransientRetryContext): boolean {
    this.startedAt ??= Date.now();
    this.attempts += 1;
    if (
      Date.now() - this.startedAt >=
      (this.options.budgetMs ?? TRANSIENT_CAPTURE_RETRY_BUDGET_MS)
    ) {
      this.options.log?.(
        `[browser-screenshot-activity] transient capture retry budget exhausted target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempts=${this.attempts}`,
      );
      return false;
    }
    this.options.log?.(
      `[browser-screenshot-activity] transient capture retry scheduled target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempt=${this.attempts} delayMs=${this.retryDelayMs()}`,
    );
    return true;
  }

  reset(): void {
    this.startedAt = undefined;
    this.attempts = 0;
  }
}
