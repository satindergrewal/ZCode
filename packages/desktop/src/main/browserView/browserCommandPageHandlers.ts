import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import { browserSnapshotSchema } from "@zcode/shared";
import { EVALUATE_SCRIPT, SNAPSHOT_SCRIPT, VIEWPORT_SCRIPT } from "./browserCommandScripts.js";
import {
  DEFAULT_NAVIGATE_SETTLE_MS,
  BrowserNavigationTimeoutError,
  isAllowedBrowserUrl,
  readState,
  settleNavigation,
} from "./browserCommandState.js";
import type { ControlledView } from "./browserCommandTypes.js";
import type { BrowserCommandDone } from "./browserCommandResult.js";
import { executionError } from "./browserCommandResult.js";
import { captureScreenshotWithCssPixelCorrection } from "./browserScreenshotCapture.js";

const ABORTED_NAVIGATION_CONFIRM_TIMEOUT_MS = 500;
const ABORTED_NAVIGATION_POLL_INTERVAL_MS = 25;

interface ScreenshotViewportMetrics {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
}

interface ScreenshotContentMetrics {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ScreenshotLayoutMetrics {
  layoutViewport?: ScreenshotViewportMetrics;
  visualViewport?: ScreenshotViewportMetrics;
  contentSize?: ScreenshotContentMetrics;
  cssLayoutViewport?: ScreenshotViewportMetrics;
  cssVisualViewport?: ScreenshotViewportMetrics;
  cssContentSize?: ScreenshotContentMetrics;
}

interface ScreenshotCssViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readScreenshotLayoutMetrics(view: ControlledView): Promise<ScreenshotLayoutMetrics> {
  return (await view.cdp.send("Page.getLayoutMetrics")) as ScreenshotLayoutMetrics;
}

function resolveScreenshotCssViewport(
  metrics: ScreenshotLayoutMetrics,
): ScreenshotCssViewport | null {
  const cssViewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
  const cssWidth = cssViewport?.clientWidth;
  const cssHeight = cssViewport?.clientHeight;
  if (
    typeof cssWidth !== "number" ||
    !Number.isFinite(cssWidth) ||
    cssWidth <= 0 ||
    typeof cssHeight !== "number" ||
    !Number.isFinite(cssHeight) ||
    cssHeight <= 0
  ) {
    return null;
  }
  return {
    x: typeof cssViewport?.pageX === "number" ? cssViewport.pageX : 0,
    y: typeof cssViewport?.pageY === "number" ? cssViewport.pageY : 0,
    width: cssWidth,
    height: cssHeight,
  };
}

export async function buildViewportScreenshotParams(
  view: ControlledView,
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {
    format: "png",
    captureBeyondViewport: false,
  };
  if (!view.normalizeScreenshotToCssPixels) return params;
  const cssViewport = resolveScreenshotCssViewport(await readScreenshotLayoutMetrics(view));
  if (!cssViewport) return params;
  // // Legacy layout metrics can read 2x the CSS viewport on Retina guests while capture raster is already CSS 1x;
  // pre-scaling the first frame by 0.5 yields 640x360 and can leave remounted guest compositors
  // pinned top-left. First frame stays CSS 1x; the shared executor corrects real PNG anomalies.
  params.clip = { ...cssViewport, scale: 1 };
  return params;
}

function isElectronNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  return (
    candidate.code === "ERR_ABORTED" ||
    candidate.errno === -3 ||
    (typeof candidate.message === "string" && /\bERR_ABORTED\b|\(-3\)/u.test(candidate.message))
  );
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:m|www)\./u, "");
}

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
}

function isEquivalentNavigationUrl(requestedUrl: string, currentUrl: string): boolean {
  try {
    const requested = new URL(requestedUrl);
    const current = new URL(currentUrl);
    if (requested.protocol === "about:" || current.protocol === "about:") {
      return requested.href === current.href;
    }
    return (
      requested.protocol === current.protocol &&
      normalizedHost(requested.hostname) === normalizedHost(current.hostname) &&
      requested.port === current.port &&
      normalizedPath(requested.pathname) === normalizedPath(current.pathname) &&
      requested.search === current.search
    );
  } catch {
    return false;
  }
}

async function confirmAbortedNavigationCommitted(
  view: ControlledView,
  requestedUrl: string,
  previousUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + ABORTED_NAVIGATION_CONFIRM_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const documentState = (await view.webContents.executeJavaScript(`(() => ({
        href: globalThis.location?.href ?? "",
        readyState: document.readyState
      }))()`)) as { href?: unknown; readyState?: unknown } | null;
      const currentUrl = view.webContents.getURL();
      const href = typeof documentState?.href === "string" ? documentState.href : "";
      const readyState = documentState?.readyState;
      if (
        currentUrl !== previousUrl &&
        href === currentUrl &&
        (readyState === "interactive" || readyState === "complete") &&
        isEquivalentNavigationUrl(requestedUrl, currentUrl)
      ) {
        return true;
      }
    } catch {
      // executeJavaScript can fail transiently mid-document-swap; re-check within a bounded window.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ABORTED_NAVIGATION_POLL_INTERVAL_MS));
  }
  return false;
}

export async function handleNavigate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "navigate" }>,
  done: BrowserCommandDone,
  opts?: { navigateSettleMs?: number; signal?: AbortSignal },
): Promise<BrowserCommandResult> {
  if (!isAllowedBrowserUrl(command.url)) {
    return done({
      ok: false,
      error: { code: "navigation_blocked", message: `Blocked URL: ${command.url}` },
    });
  }
  const previousUrl = view.webContents.getURL();
  try {
    await settleNavigation(
      view.webContents.loadURL(command.url),
      opts?.navigateSettleMs ?? DEFAULT_NAVIGATE_SETTLE_MS,
      opts?.signal,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // www-to-m redirects or SPA routing make Electron loadURL reject with ERR_ABORTED
    // after the new document commits. Success requires URL equivalence plus ready document;
    // never report a landed navigation as hard failure or the model keeps guessing URLs/resource ids.
    if (
      isElectronNavigationAborted(error) &&
      (await confirmAbortedNavigationCommitted(view, command.url, previousUrl, opts?.signal))
    ) {
      return done({ ok: true, state: readState(view.webContents) });
    }
    return done({
      ok: false,
      error: {
        code: error instanceof BrowserNavigationTimeoutError ? "timeout" : "execution_error",
        message: error instanceof Error ? error.message : String(error),
        sideEffect: "uncertain",
      },
    });
  }
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleGetState(
  view: ControlledView,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  const state = readState(view.webContents);
  // Fill scrollX/scrollY/viewportWidth/viewportHeight; read failures keep the base state.
  try {
    const raw = (await view.webContents.executeJavaScript(VIEWPORT_SCRIPT)) as {
      scrollX?: unknown;
      scrollY?: unknown;
      innerWidth?: unknown;
      innerHeight?: unknown;
    } | null;
    if (raw && typeof raw === "object") {
      if (typeof raw.scrollX === "number") state.scrollX = raw.scrollX;
      if (typeof raw.scrollY === "number") state.scrollY = raw.scrollY;
      if (typeof raw.innerWidth === "number") state.viewportWidth = raw.innerWidth;
      if (typeof raw.innerHeight === "number") state.viewportHeight = raw.innerHeight;
    }
  } catch {
    /* /* Viewport read failure keeps the base state. */
  }
  return done({ ok: true, state });
}

export async function handleScreenshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "screenshot" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  if (command.clip === undefined && command.fullPage !== true && view.captureViewportScreenshot) {
    const data = await view.captureViewportScreenshot();
    if (!data) {
      return done({
        ok: false,
        error: { code: "execution_error", message: "screenshot returned empty data" },
      });
    }
    return done({
      ok: true,
      image: { base64: data, mimeType: "image/png" },
      state: readState(view.webContents),
    });
  }

  // Use CDP Page.captureScreenshot: avoids capturePage's V8 FATAL and reaches full page.
  const metrics =
    command.fullPage === true || view.normalizeScreenshotToCssPixels
      ? await readScreenshotLayoutMetrics(view)
      : null;
  const cssViewport =
    view.normalizeScreenshotToCssPixels && metrics ? resolveScreenshotCssViewport(metrics) : null;
  const params: Record<string, unknown> = {
    format: "png",
    // Plain viewport shots must not read beyond-viewport compositor surfaces; clip/fullPage opt in explicitly.
    captureBeyondViewport: command.clip !== undefined || command.fullPage === true,
  };
  if (command.clip) {
    // Region shots: clip in viewport CSS px, scale 1 keeps the same space as coordinates.
    params.clip = {
      x: command.clip.x,
      y: command.clip.y,
      width: command.clip.width,
      height: command.clip.height,
      scale: 1,
    };
  } else if (command.fullPage === true) {
    // Full-page shots: contentSize (CSS preferred) via clip over the whole page.
    const cs = metrics?.cssContentSize ?? metrics?.contentSize;
    if (cs && typeof cs.width === "number" && typeof cs.height === "number") {
      params.clip = {
        x: typeof cs.x === "number" ? cs.x : 0,
        y: typeof cs.y === "number" ? cs.y : 0,
        width: cs.width,
        height: cs.height,
        scale: 1,
      };
    }
  } else if (cssViewport) {
    params.clip = { ...cssViewport, scale: 1 };
  }

  const res = await captureScreenshotWithCssPixelCorrection(view, params);
  if (!res?.data) {
    return done({
      ok: false,
      error: { code: "execution_error", message: "screenshot returned empty data" },
    });
  }
  return done({
    ok: true,
    image: { base64: res.data, mimeType: "image/png" },
    state: readState(view.webContents),
  });
}

export async function handleSnapshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "snapshot" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // The injected script walks visible DOM producing a ref'd structured snapshot (strict vs browserSnapshotSchema).
  const raw = await view.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT(command.maxElements, command.includeHidden),
  );
  // Defensive parse: pages can override getters or return mangled shapes; on safeParse failure raise a precise
  // execution_error instead of passing malformations downstream for generic zod failures.
  const parsed = browserSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return done({
      ok: false,
      error: {
        code: "execution_error",
        message: `invalid snapshot result shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      },
    });
  }
  return done({ ok: true, snapshot: parsed.data });
}

export async function handleEvaluate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "evaluate" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // Evaluates the page expression with JSON-safe serialization; throws become execution_error.
  const raw = (await view.webContents.executeJavaScript(EVALUATE_SCRIPT(command.expression))) as {
    ok?: boolean;
    kind?: string;
    data?: string;
    message?: string;
  } | null;
  if (!raw || typeof raw !== "object")
    return done(executionError("evaluate returned invalid result"));
  if (raw.ok === false) return done(executionError(raw.message ?? "evaluate error"));

  let value: unknown;
  if (raw.kind === "json" && typeof raw.data === "string") {
    try {
      value = JSON.parse(raw.data);
    } catch {
      // Unreachable in theory (page already JSON.stringify'd); pass the raw string through as a fallback.
      value = raw.data;
    }
  } else {
    value = raw.data;
  }
  return done({ ok: true, value });
}
