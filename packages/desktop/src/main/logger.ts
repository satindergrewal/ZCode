import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { formatTimestamp } from "@zcode/shared";
import { cleanupExpiredLogFiles, LOG_RETENTION_DAYS } from "./logRetention.js";
import { getAppConfigDir, maybeThrowInjectedFsFault } from "@zcode/services/node";

function getLogDir() {
  const e2eLogDir =
    process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;
  if (e2eLogDir) {
    return e2eLogDir;
  }
  return join(getAppConfigDir(), "logs");
}

// Ensure the log dir exists at startup.
const LOG_DIR = getLogDir();
mkdirSync(LOG_DIR, { recursive: true });

const logRetentionResult = cleanupExpiredLogFiles(LOG_DIR);
if (logRetentionResult.failedFiles.length > 0) {
  safeConsoleWrite(
    "warn",
    `[log-retention] failed to delete expired logs from ${LOG_DIR}:`,
    logRetentionResult.failedFiles,
    `retentionDays=${LOG_RETENTION_DAYS}`,
  );
}

type LogLevel = "debug" | "info" | "warn" | "error";

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function ignoreBrokenPipeStreamError(error: Error): void {
  // WDIO/dev runners may close stdio pipes while main logs are still flushing.
  // Stream errors are async and try/catch around console.log may miss them; swallow EPIPE here.
  if (!isBrokenPipeError(error)) {
    throw error;
  }
}

process.stdout.on("error", ignoreBrokenPipeStreamError);
process.stderr.on("error", ignoreBrokenPipeStreamError);

function safeConsoleWrite(level: LogLevel, ...args: unknown[]): void {
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    consoleFn(...args);
  } catch (error) {
    // After the dev script or parent terminal exits, main's stdio pipes may already be closed.
    // console.* then throws EPIPE; logging must never kill main, and file logging continues.
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function write(level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });
  const filePath = join(logDir, `${formatDate(now)}.log`);

  // Mirror to console for dev, stamped with time and PID to match the file format.
  safeConsoleWrite(level, `[${ts}] [pid:${pid}] [${source}]`, ...args);

  try {
    maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
    appendFileSync(filePath, line);
  } catch {
    // Write failures must never disturb the app.
  }
}

function writeDedicated(filePrefix: string, level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  mkdirSync(logDir, { recursive: true });
  // Bugfix: 远控 relay trace 与主日志混放时，目录内文件会快速增多，人工排查不直观。
  // 这里把高频 trace 分流到 logs 子目录，避免影响主日志浏览与导出定位。
  const dedicatedDir = join(logDir, "web-remote-control");
  mkdirSync(dedicatedDir, { recursive: true });
  const filePath = join(dedicatedDir, `${filePrefix}-${formatDate(now)}.log`);

  try {
    maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
    appendFileSync(filePath, line);
  } catch {
    // 日志写入失败不应影响应用运行
  }
}

/**
 * Main logger; defaults to ~/.zcode/v2/logs/YYYY-MM-DD.log, with a worker dir for E2E.
 * Console mirroring stays on for dev.
 */
export const logger = {
  // High-frequency browser/CDP protocol details log in dev only, keeping prod volume sub-linear.
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      write("debug", "main", ...args);
    }
  },
  info: (...args: unknown[]) => write("info", "main", ...args),
  warn: (...args: unknown[]) => write("warn", "main", ...args),
  error: (...args: unknown[]) => write("error", "main", ...args),

  /** Entry for renderer logs relayed over IPC into the same file. */
  fromRenderer: (level: LogLevel, args: unknown[]) => write(level, "renderer", ...args),
};

/**
 * Web remote control relay message trace 专用日志。
 * 仅用于高频链路排障，独立落盘避免淹没主日志文件。
 */
export const webRemoteControlRelayLogger = {
  info: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "info", "web-remote-control-relay", ...args),
  warn: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "warn", "web-remote-control-relay", ...args),
  error: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "error", "web-remote-control-relay", ...args),
};
