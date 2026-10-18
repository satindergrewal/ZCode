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
  // production branch unit-testable. Real renderer builds still follow Vite's PROD flag.
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

export function isLoggerLevelEnabled(_level: LogLevel): boolean {
  // In production builds every renderer level is disabled; this guard lets callers
  // exit before building heavy payloads.
  return !isRendererProductionBuild() && !isRendererLoggingDisabled();
}

function log(level: LogLevel, ...args: unknown[]) {
  // In production, renderer logging is a plain no-op: no console formatting, IPC forwarding,
  // or disk writes slowing the render thread.
  if (!isLoggerLevelEnabled(level)) {
    return;
  }
  consoleFns[level](formatLogPrefix("ui"), ...args);
  // Standalone typechecks of this package lack the desktop-injected window.zcode types, and
  // the Electron bridge only accepts info/warn/error; passing debug through would diverge
  // from both types and the host protocol. Narrow the bridge shape; forward supported levels only.
  if (level !== "debug" && typeof window !== "undefined") {
    // Pure frontend state modules (tabStore) now log info inside Vitest's Node env too.
    // Unconditional window access would throw ReferenceError on first logged line in tests,
    // i.e. debug noise to investigate noise. Confirm a browser-like env before the desktop bridge.
    (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
  }
}

function lifecycleLog(level: DesktopLogLevel, ...args: unknown[]) {
  // Production keeps only filtered lifecycle diagnostics; message-stream logs stay off.
  // Tests and fault injection can still silence every renderer log via the explicit global switch.
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
  /** traceId-prefixed log for end-to-end tracing */
  trace: (traceId: string, level: LogLevel, ...args: unknown[]) => {
    log(level, `[trace:${traceId}]`, ...args);
  },
};

/**
 * The only renderer exit for in-memory local diagnostics.
 * The documented exception to the production log policy: desktop builds still persist via the
 * desktop bridge (max one line per 60s, changes only); no bridge on web means no-op.
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
