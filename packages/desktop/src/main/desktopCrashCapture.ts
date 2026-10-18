import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { app, crashReporter, type BrowserWindow, type WebContents } from "electron";
import { getAppConfigDir } from "@zcode/services/node";
import {
  type CrashDumpV8OomSummary,
  readCrashDumpAnnotationsFromFile,
  summarizeCrashDumpAnnotations,
} from "./crashDumpAnnotations.js";

const LOCAL_ONLY_CRASH_SUBMIT_URL = "https://zcode.invalid/local-crash-only";
const CRASH_DUMP_STABLE_AFTER_MS = 1_000;
const CRASH_ARCHIVE_RETRY_DELAYS_MS = [1_500, 5_000] as const;
const CRASH_ARCHIVE_MAX_FILES = 5;
const CRASH_ARCHIVE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

interface CrashCaptureLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface CrashCapturePaths {
  rootDir: string;
  stagingDir: string;
  archiveDir: string;
}

interface CrashArchiveRetentionPolicy {
  maxFiles: number;
  maxTotalBytes: number;
}

interface CrashArchiveCleanupResult {
  deletedFiles: string[];
  failedFiles: string[];
}

export interface ArchivedCrashDumpRecord {
  dumpPath: string;
  archivedDumpPath: string;
  /* /** Null when the dump carries no V8 OOM annotation (GPU/native crashes). */
  v8OomSummary: CrashDumpV8OomSummary | null;
}

function resolveCrashCapturePaths(): CrashCapturePaths {
  const rootDir = join(getAppConfigDir(), "crash");
  return {
    rootDir,
    stagingDir: join(rootDir, "live"),
    archiveDir: join(rootDir, "archive"),
  };
}

export function resolveCrashReporterSourceDirs(
  stagingDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs = [join(stagingDir, platform === "win32" ? "reports" : "completed")];

  if (platform === "darwin") {
    dirs.push(join(stagingDir, "pending"));
  }

  return dirs;
}

function isStableCrashDump(path: string, nowMs: number): boolean {
  try {
    const stats = statSync(path);
    return nowMs - stats.mtimeMs >= CRASH_DUMP_STABLE_AFTER_MS;
  } catch {
    return false;
  }
}

function persistArchivedCrashDump(
  dumpPath: string,
  archiveDir: string,
  archivedAt: Date,
): ArchivedCrashDumpRecord | null {
  const fileName = basename(dumpPath);
  const archivedDumpPath = join(archiveDir, fileName);
  if (existsSync(archivedDumpPath)) {
    return null;
  }

  const sourceStats = statSync(dumpPath);
  copyFileSync(dumpPath, archivedDumpPath);
  // copyFileSync stamps the archive with copy time, so batch cleanup could delete newer crashes first.
  // Preserve the dump's original time so cleanup orders by real crash sequence.
  utimesSync(archivedDumpPath, sourceStats.atime, sourceStats.mtime);
  // Forensics: a white-screen bundle carries only logs; crashpad annotations are the only way to tell
  // JS-heap OOM from JIT-code exhaustion. Parse failure costs evidence only, never the archive.
  const annotations = readCrashDumpAnnotationsFromFile(archivedDumpPath, sourceStats.size);
  const v8OomSummary = summarizeCrashDumpAnnotations(annotations);
  writeFileSync(
    join(archiveDir, `${fileName}.json`),
    JSON.stringify(
      {
        archivedAt: archivedAt.toISOString(),
        originalPath: dumpPath,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        ...(v8OomSummary ? { v8OomSummary } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dumpPath, archivedDumpPath, v8OomSummary };
}

function pruneCrashDumpArchive(
  archiveDir: string,
  policy: CrashArchiveRetentionPolicy,
): CrashArchiveCleanupResult {
  // At startup, archive and clean locally before ARMS scans/deletes live dumps; keep the same critical section
  // as the existing archiver so async IO cannot reorder appCrashCaptureBootstrap before appARMSBootstrap.
  const deletedFiles: string[] = [];
  const failedFiles: string[] = [];
  const dumps: Array<{ entry: string; path: string; mtimeMs: number; size: number }> = [];
  const dumpEntries = new Set<string>();
  const metadataFiles: Array<{ dumpEntry: string; path: string }> = [];

  try {
    for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.endsWith(".dmp.json")) {
        metadataFiles.push({
          dumpEntry: entry.name.slice(0, -".json".length),
          path: join(archiveDir, entry.name),
        });
        continue;
      }

      if (!entry.name.endsWith(".dmp")) {
        continue;
      }

      dumpEntries.add(entry.name);
      const path = join(archiveDir, entry.name);
      try {
        const stats = statSync(path);
        dumps.push({ entry: entry.name, path, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        failedFiles.push(path);
      }
    }
  } catch {
    return { deletedFiles, failedFiles: [archiveDir] };
  }

  dumps.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.entry.localeCompare(right.entry),
  );

  const maxFiles = Math.max(1, policy.maxFiles);
  const maxTotalBytes = Math.max(0, policy.maxTotalBytes);
  let keptCount = dumps.length;
  let keptBytes = dumps.reduce((total, dump) => total + dump.size, 0);
  const dumpsToDelete: typeof dumps = [];

  while (keptCount > 1 && (keptCount > maxFiles || keptBytes > maxTotalBytes)) {
    const dump = dumps[keptCount - 1];
    dumpsToDelete.push(dump);
    keptCount -= 1;
    keptBytes -= dump.size;
  }

  for (const dump of dumpsToDelete) {
    // The local crash archive needs a capacity bound or dumps accumulate forever.
    // Clean only successfully copied archives; never touch live files Crashpad still owns.
    try {
      unlinkSync(dump.path);
      deletedFiles.push(dump.path);
    } catch {
      failedFiles.push(dump.path);
      continue;
    }

    const metadataPath = `${dump.path}.json`;
    if (existsSync(metadataPath)) {
      try {
        unlinkSync(metadataPath);
        deletedFiles.push(metadataPath);
      } catch {
        failedFiles.push(metadataPath);
      }
    }
  }

  for (const metadata of metadataFiles) {
    if (dumpEntries.has(metadata.dumpEntry)) {
      continue;
    }

    // If the dump deletes but its metadata fails, the next pass cannot reach that metadata via the dump set.
    // Rescan orphaned .dmp.json each pass so transient delete failures converge without touching other JSON.
    try {
      unlinkSync(metadata.path);
      deletedFiles.push(metadata.path);
    } catch {
      failedFiles.push(metadata.path);
    }
  }

  return { deletedFiles, failedFiles };
}

export function archiveCrashDumps(
  paths: CrashCapturePaths,
  options?: {
    platform?: NodeJS.Platform;
    now?: Date;
    retention?: CrashArchiveRetentionPolicy;
  },
): {
  archivedFiles: string[];
  archivedDumps: ArchivedCrashDumpRecord[];
  skippedFiles: string[];
  deletedArchiveFiles: string[];
  failedArchiveFiles: string[];
} {
  mkdirSync(paths.archiveDir, { recursive: true });

  const platform = options?.platform ?? process.platform;
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const archivedFiles: string[] = [];
  const archivedDumps: ArchivedCrashDumpRecord[] = [];
  const skippedFiles: string[] = [];

  for (const dir of resolveCrashReporterSourceDirs(paths.stagingDir, platform)) {
    if (!existsSync(dir)) {
      continue;
    }

    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".dmp")) {
        continue;
      }

      const dumpPath = join(dir, entry);
      if (!isStableCrashDump(dumpPath, nowMs)) {
        skippedFiles.push(dumpPath);
        continue;
      }

      try {
        const record = persistArchivedCrashDump(dumpPath, paths.archiveDir, now);
        if (record) {
          archivedFiles.push(dumpPath);
          archivedDumps.push(record);
        }
      } catch {
        skippedFiles.push(dumpPath);
      }
    }
  }

  const cleanupResult = pruneCrashDumpArchive(
    paths.archiveDir,
    options?.retention ?? {
      maxFiles: CRASH_ARCHIVE_MAX_FILES,
      maxTotalBytes: CRASH_ARCHIVE_MAX_TOTAL_BYTES,
    },
  );

  return {
    archivedFiles,
    archivedDumps,
    skippedFiles,
    deletedArchiveFiles: cleanupResult.deletedFiles,
    failedArchiveFiles: cleanupResult.failedFiles,
  };
}

let hasStartedLocalCrashReporter = false;
let registeredCrashEventMonitor = false;

function logCrashArchiveCleanup(
  logger: CrashCaptureLogger,
  result: { deletedArchiveFiles: string[]; failedArchiveFiles: string[] },
  source: string,
): void {
  if (result.deletedArchiveFiles.length > 0) {
    logger.info(
      `[crash-capture] pruned ${result.deletedArchiveFiles.length} archive file(s) source=${source}`,
    );
  }
  if (result.failedArchiveFiles.length > 0) {
    logger.warn(
      `[crash-capture] failed to prune ${result.failedArchiveFiles.length} archive file(s) source=${source}`,
      result.failedArchiveFiles,
    );
  }
}

function logArchivedCrashDumpSummaries(
  logger: CrashCaptureLogger,
  result: { archivedDumps: ArchivedCrashDumpRecord[] },
  source: string,
): void {
  for (const record of result.archivedDumps) {
    const dump = basename(record.archivedDumpPath);
    if (record.v8OomSummary) {
      // One line names the OOM: code_space_exhausted is a full 256MB JIT code range,
      // js_heap_exhausted is a plain heap leak; exact numbers land in the archive's .dmp.json.
      logger.warn(
        `[crash-capture] v8 oom annotations source=${source} dump=${dump}`,
        record.v8OomSummary,
      );
    } else {
      logger.info(`[crash-capture] archived dump has no v8 oom annotations dump=${dump}`);
    }
  }
}

function scheduleCrashArchive(
  logger: CrashCaptureLogger,
  paths: CrashCapturePaths,
  source: string,
) {
  for (const delayMs of CRASH_ARCHIVE_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      const result = archiveCrashDumps(paths);
      if (result.archivedFiles.length > 0) {
        logger.info(
          `[crash-capture] archived ${result.archivedFiles.length} dump(s) source=${source} delayMs=${delayMs}`,
        );
      }
      logArchivedCrashDumpSummaries(logger, result, source);
      logCrashArchiveCleanup(logger, result, source);
    }, delayMs);
    timer.unref?.();
  }
}

export function initializeCrashCapture(
  logger: CrashCaptureLogger,
  remoteCrashReporterEnabled: boolean,
): CrashCapturePaths {
  const paths = resolveCrashCapturePaths();
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.stagingDir, { recursive: true });
  mkdirSync(paths.archiveDir, { recursive: true });
  app.setPath("crashDumps", paths.stagingDir);

  const startupArchiveResult = archiveCrashDumps(paths);
  logCrashArchiveCleanup(logger, startupArchiveResult, "startup");
  if (startupArchiveResult.archivedFiles.length > 0) {
    logger.info(
      `[crash-capture] restored ${startupArchiveResult.archivedFiles.length} local dump(s) from previous runs`,
    );
  }
  logArchivedCrashDumpSummaries(logger, startupArchiveResult, "startup");

  if (!remoteCrashReporterEnabled && !hasStartedLocalCrashReporter) {
    hasStartedLocalCrashReporter = true;
    crashReporter.start({
      companyName: "",
      productName: app.name || app.getName(),
      submitURL: LOCAL_ONLY_CRASH_SUBMIT_URL,
      uploadToServer: false,
      compress: true,
    });
    logger.info("[crash-capture] local crashReporter started without remote upload");
  }

  logger.info(
    `[crash-capture] configured remoteCrashReporterEnabled=${String(remoteCrashReporterEnabled)} stagingDir=${paths.stagingDir} archiveDir=${paths.archiveDir}`,
  );
  return paths;
}

export interface CrashEventMonitorHooks {
  onRenderProcessGone?: (
    webContents: WebContents,
    details: { reason: string; exitCode: number },
  ) => void;
  onChildProcessGone?: (details: {
    type: string;
    reason: string;
    exitCode: number;
    serviceName?: string;
    name?: string;
  }) => void;
  onBrowserWindowCreated?: (win: BrowserWindow) => void;
}

export function resolveProcessGoneLogLevel(reason: string): "info" | "warn" {
  // Root cause: Electron also fires gone for controlled exits (clean-exit/killed). The raw gone
  // callback only records the lifecycle fact; whether it is a crash is decided by stability
  // classification. The old code logged error unconditionally and the ARMS console collector
  // counted it as an exception, polluting error stats.
  return reason === "clean-exit" || reason === "killed" ? "info" : "warn";
}

export function registerCrashEventMonitor(
  logger: CrashCaptureLogger,
  paths: CrashCapturePaths,
  hooks?: CrashEventMonitorHooks,
): void {
  if (registeredCrashEventMonitor) {
    return;
  }
  registeredCrashEventMonitor = true;

  app.on("render-process-gone", (_event, webContents, details) => {
    logger[resolveProcessGoneLogLevel(details.reason)]("[crash-capture] render-process-gone:", {
      webContentsId: webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
      name: webContents.getType(),
      url: webContents.getURL(),
    });
    hooks?.onRenderProcessGone?.(webContents, details);
    // The remote crash SDK may prune live dumps after processing.
    // Two delayed archive passes after the event copy raw dumps to ~/.zcode/v2/crash/archive,
    // keeping the remote report while preserving a local copy for triage.
    scheduleCrashArchive(logger, paths, "render-process-gone");
  });

  app.on("child-process-gone", (_event, details) => {
    logger[resolveProcessGoneLogLevel(details.reason)](
      "[crash-capture] child-process-gone:",
      details,
    );
    hooks?.onChildProcessGone?.(details);
    scheduleCrashArchive(logger, paths, "child-process-gone");
  });

  app.on("browser-window-created", (_, win) => {
    hooks?.onBrowserWindowCreated?.(win);
    if (!hooks?.onBrowserWindowCreated) {
      win.webContents.on("unresponsive", () => {
        logger.warn("[crash-capture] window became unresponsive:", {
          windowId: win.id,
          webContentsId: win.webContents.id,
          url: win.webContents.getURL(),
        });
      });
    }
  });
}
