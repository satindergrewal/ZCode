import { formatLogPrefix } from "@zcode/shared";

export type LogLevel = "debug" | "info" | "warn" | "error";

type DesktopLogLevel = Exclude<LogLevel, "debug">;

type DesktopLogBridgeWindow = Window & {
  zcode?: {
    log?: (level: DesktopLogLevel, args: unknown[]) => void;
  };
};

function isRendererProductionBuild(): boolean {
  const viteProduction =
    ((import.meta as ImportMeta & { env?: { readonly PROD?: boolean } }).env ?? {}).PROD === true;
  // Vitest freezes import.meta.env.PROD at transform time; the NODE_ENV fallback keeps the
  // production branch testable. Real renderer builds still follow Vite's PROD flag.
  return (
    viteProduction || (typeof process !== "undefined" && process.env.NODE_ENV === "production")
  );
}

function isRendererLoggingDisabled(): boolean {
  return (
    (
      globalThis as typeof globalThis & {
        __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean;
      }
    ).__ZCODE_RENDERER_DISABLE_LOGGING__ === true
  );
}

const consoleFns: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function isLoggerLevelEnabled(_level: LogLevel): boolean {
  // All renderer log levels are disabled in production builds; exposed so callers can bail
  // out before building heavy payloads.
  return !isRendererProductionBuild() && !isRendererLoggingDisabled();
}

function log(level: LogLevel, ...args: unknown[]) {
  // Renderer logs are a plain no-op in production: console formatting, IPC forwarding and
  // persistence must not slow down the render loop.
  if (!isLoggerLevelEnabled(level)) {
    return;
  }
  consoleFns[level](formatLogPrefix("ui"), ...args);
  // Standalone typecheck of this package lacks the desktop-injected window.zcode declaration,
  // and the Electron bridge only accepts info/warn/error — passing debug through would drift
  // from both the types and the host protocol. Narrow the bridge shape and forward only the
  // levels main actually supports.
  if (level !== "debug" && typeof window !== "undefined") {
    // Pure frontend state modules (tabStore etc.) now log info even under Vitest's Node
    // environment. Touching window unconditionally would throw ReferenceError on the first
    // logged line and turn debugging into new test noise; confirm a browser context first.
    (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
  }
}

function lifecycleLog(level: DesktopLogLevel, ...args: unknown[]) {
  // Production keeps only filtered lifecycle diagnostics so message-stream logging stays off;
  // tests and fault injection can still silence every renderer log via the explicit global flag.
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (isRendererProductionBuild()) {
    if (typeof window !== "undefined") {
      (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
    }
    return;
  }
  log(level, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
  lifecycle: {
    info: (...args: unknown[]) => lifecycleLog("info", ...args),
    warn: (...args: unknown[]) => lifecycleLog("warn", ...args),
    error: (...args: unknown[]) => lifecycleLog("error", ...args),
  },
  /** Log with a traceId prefix for end-to-end tracing. */
  trace: (traceId: string, level: LogLevel, ...args: unknown[]) => {
    log(level, `[trace:${traceId}]`, ...args);
  },
};

/**
 * Sole renderer outlet for in-memory local diagnostics.
 * This is the sanctioned monitoring exception in the renderer production log policy:
 * production builds still persist via the desktop bridge (at most one line per 60s,
 * only on change); no-op on the web when no bridge exists. Business modules must not
 * use it to bypass production gating.
 */
export function logMemoryDiagnostics(line: string): void {
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (typeof window !== "undefined") {
    const bridge = (window as DesktopLogBridgeWindow).zcode?.log;
    if (bridge) {
      bridge("info", [line]);
      return;
    }
  }
  if (!isRendererProductionBuild()) {
    consoleFns.info(formatLogPrefix("ui"), line);
  }
}
