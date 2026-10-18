export const DEFAULT_BROWSER_URL = "about:blank";

const RECOVERABLE_BROWSER_GUEST_EXIT_REASONS = new Set([
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "memory-eviction",
]);

/**
 * In-place recovery applies only to guests that already ran but were terminated
 * abnormally by Chromium.
 *
 * Previously only the `<webview>` DOM was kept, without covering its renderer being
 * killed by the OS; launch/integrity failures are not a "recycled page", and blindly
 * rebuilding would just spin in an infinite loop.
 */
export function isRecoverableBrowserGuestExitReason(reason: string): boolean {
  return RECOVERABLE_BROWSER_GUEST_EXIT_REASONS.has(reason);
}

// Synchronous <webview> methods (getURL/canGoBack/loadURL/executeJavaScript, ...) throw these
// errors while the guest is not attached yet (before dom-ready) or its frame is being
// disposed/reattached. Both are expected webview lifecycle races, not real failures; if they
// reach the window.onerror global handler a single source floods the exception count, so they
// are collapsed at the call boundary.
const WEBVIEW_DETACHED_ERROR_FRAGMENTS = [
  "must be attached to the DOM",
  "Render frame was disposed",
] as const;

export function isWebviewDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) {
    return false;
  }
  return WEBVIEW_DETACHED_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * Run one webview synchronous call safely:
 * - returns the call result on success;
 * - swallows lifecycle-race errors ("guest not attached" / "frame disposed") and returns the
 *   fallback, optionally recording via onDetached (for debug-level logs, not silently);
 * - rethrows everything else so real bugs stay visible.
 */
export function safeWebviewCall<T>(
  call: () => T,
  fallback: T,
  onDetached?: (error: unknown) => void,
): T {
  try {
    return call();
  } catch (error) {
    if (isWebviewDetachedError(error)) {
      onDetached?.(error);
      return fallback;
    }
    throw error;
  }
}

const ALLOWED_BROWSER_PROTOCOLS = new Set(["about:", "data:", "file:", "http:", "https:"]);

const URL_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface BrowserGuestFailure {
  exitCode: number;
  reason: string;
}

export interface BrowserState {
  canGoBack: boolean;
  canGoForward: boolean;
  currentUrl: string;
  errorMessage: string | null;
  /**
   * Chromium net error code for the main-frame load failure.
   *
   * Electron's `<webview>` has no Chrome-style interstitial: a blocked navigation lands on an
   * empty chrome-error page and the user sees plain black. The code must travel with
   * errorMessage to render a readable error state and offer the certificate bypass hint.
   */
  loadErrorCode: number | null;
  /** Process-level failure where the guest never rendered; kept apart from renderable load errors. */
  guestFailure: BrowserGuestFailure | null;
  isLoading: boolean;
  isReady: boolean;
  title: string;
}

export interface BrowserNavigationRequest {
  id: string;
  url: string;
}

export const INITIAL_BROWSER_STATE: BrowserState = {
  canGoBack: false,
  canGoForward: false,
  currentUrl: DEFAULT_BROWSER_URL,
  errorMessage: null,
  loadErrorCode: null,
  guestFailure: null,
  isLoading: false,
  isReady: false,
  title: "",
};

/** Chromium certificate error code range (ERR_CERT_COMMON_NAME_INVALID ... ERR_CERT_KNOWN_INTERCEPTION_BLOCKED). */
const CERTIFICATE_LOAD_ERROR_CODE_MIN = -217;
const CERTIFICATE_LOAD_ERROR_CODE_MAX = -200;

/**
 * Whether a load failure stems from a certificate problem.
 *
 * Only certificate failures should offer "ignore certificate errors"; showing that hint for
 * DNS or connection-refused failures would mislead.
 */
export function isCertificateBrowserLoadErrorCode(code: number | null | undefined): boolean {
  if (typeof code !== "number") return false;
  return code >= CERTIFICATE_LOAD_ERROR_CODE_MIN && code <= CERTIFICATE_LOAD_ERROR_CODE_MAX;
}

export function isAllowedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The system-browser entry accepts web and file URLs only; the embedded browser's wider local/inline allowlist does not apply. */
export function isDefaultBrowserOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

function hasAllowedExplicitProtocol(input: string): boolean {
  const protocol = input.match(URL_PROTOCOL_RE)?.[0].toLowerCase();
  return protocol ? ALLOWED_BROWSER_PROTOCOLS.has(protocol) : false;
}

function hasDisallowedExplicitProtocol(input: string): boolean {
  const match = input.match(URL_PROTOCOL_RE);
  if (!match) {
    return false;
  }

  const protocol = match[0].toLowerCase();
  if (ALLOWED_BROWSER_PROTOCOLS.has(protocol)) {
    return false;
  }

  return !/^\d{1,5}(?:$|[/?#])/.test(input.slice(match[0].length));
}

function parseSchemeLessUrl(input: string): URL | null {
  try {
    const normalizedInput = normalizeBareIpv6LoopbackInput(input);
    return new URL(
      normalizedInput.startsWith("//") ? `http:${normalizedInput}` : `http://${normalizedInput}`,
    );
  } catch {
    return null;
  }
}

function normalizeBareIpv6LoopbackInput(input: string): string {
  if (input === "::1") {
    return "[::1]";
  }

  if (/^::1(?=[:/?#])/.test(input)) {
    return `[::1]${input.slice(3)}`;
  }

  return input;
}

function getSchemeLessExplicitPort(input: string): string | null {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const withoutLeadingSlashes = normalizedInput.startsWith("//")
    ? normalizedInput.slice(2)
    : normalizedInput;
  const authority = withoutLeadingSlashes.split(/[/?#]/, 1)[0] ?? "";
  const hostWithPort = authority.split("@").at(-1) ?? authority;

  if (hostWithPort.startsWith("[")) {
    return hostWithPort.match(/^\[[^\]]+\]:(\d+)$/)?.[1] ?? null;
  }

  const portMatch = hostWithPort.match(/:(\d+)$/);
  if (!portMatch) {
    return null;
  }

  const host = hostWithPort.slice(0, portMatch.index);
  return host.includes(":") ? null : (portMatch[1] ?? null);
}

function parseIpv4Address(host: string): [number, number, number, number] | null {
  if (!IPV4_RE.test(host)) {
    return null;
  }

  const octets = host.split(".").map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost");
}

export function isLocalDevelopmentHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (
    isLocalhostName(normalizedHost) ||
    normalizedHost === "::1" ||
    normalizedHost === "0:0:0:0:0:0:0:1" ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".test")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Address(normalizedHost);
  if (!ipv4) {
    return false;
  }

  const [first, second, third, fourth] = ipv4;
  return (
    first === 127 ||
    (first === 0 && second === 0 && third === 0 && fourth === 0) ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

export function isLocalDevelopmentBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return isLocalDevelopmentHost(parsed.hostname);
  } catch {
    return false;
  }
}

export type MessageLinkOpenTarget = "app-browser" | "external-browser";

/**
 * Interaction semantics: the two context-menu items are explicit complementary targets; only
 * plain left-click uses the local/private-network heuristic. Reusing the left-click default for
 * the menu "Open" item sent public links (e.g. Feishu docs) to the system browser from both.
 */
export function resolveMessageLinkOpenTarget(input: {
  href: string;
  forceExternal?: boolean;
  forceInApp?: boolean;
}): MessageLinkOpenTarget {
  // When both flags are passed forceExternal wins, keeping caller combinations unambiguous.
  if (input.forceExternal) {
    return "external-browser";
  }

  if (input.forceInApp) {
    return "app-browser";
  }

  return isLocalDevelopmentBrowserUrl(input.href) ? "app-browser" : "external-browser";
}

function shouldPreferHttpForSchemeLessUrl(parsed: URL, explicitPort: string | null): boolean {
  if (isLocalDevelopmentHost(parsed.hostname)) {
    return true;
  }

  if (explicitPort && explicitPort !== "443") {
    return true;
  }

  return false;
}

function inferBrowserUrl(input: string): string {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const parsed = parseSchemeLessUrl(normalizedInput);
  const protocol =
    parsed && shouldPreferHttpForSchemeLessUrl(parsed, getSchemeLessExplicitPort(normalizedInput))
      ? "http"
      : "https";
  return normalizedInput.startsWith("//")
    ? `${protocol}:${normalizedInput}`
    : `${protocol}://${normalizedInput}`;
}

export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // The address bar used to prefix every scheme-less input with https://, which blocked
  // localhost, 127.0.0.1 and common dev ports. Following browser address-bar convention,
  // local/private/port-bearing hosts default to HTTP; public domains still prefer HTTPS.
  if (hasDisallowedExplicitProtocol(trimmed)) {
    return null;
  }

  const url = hasAllowedExplicitProtocol(trimmed) ? trimmed : inferBrowserUrl(trimmed);
  return isAllowedBrowserUrl(url) ? url : null;
}

export function displayBrowserUrl(url: string): string {
  return url === DEFAULT_BROWSER_URL ? "" : url;
}
