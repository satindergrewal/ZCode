import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { redactFeedbackText, ZCODE_VERSION, ZCODE_COMMIT } from "@zcode/shared";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface FeedbackLogSource {
  directory: string;
  archivePrefix: string;
  exitLogsOnly?: boolean;
  //** Collect only names listed at the root; the opt-in for single-file archive entries. */
  includeFileNames?: readonly string[];
  /** Defaults to locally modified today; config can lift the restriction. */
  onlyCurrentDay?: boolean;
  /** Config files use the structured safe projection so plugin-private keys never upload. */
  contentPolicy?: "diagnostic" | "cli-config";
}

function decodeDiagnosticLog(buffer: Buffer): string | null {
  try {
    const encoding =
      buffer[0] === 0xff && buffer[1] === 0xfe
        ? "utf-16le"
        : buffer[0] === 0xfe && buffer[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
    }
    return text;
  } catch {
    return null;
  }
}

type SafeScalarType = "boolean" | "number" | "string";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickSafeSection(
  value: unknown,
  scalarFields: Readonly<Record<string, SafeScalarType>> = {},
  stringArrayFields: readonly string[] = [],
  booleanMapFields: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(scalarFields)) {
    if (typeof value[key] === type) result[key] = value[key];
  }
  for (const key of stringArrayFields) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) {
      result[key] = candidate;
    }
  }
  for (const key of booleanMapFields) {
    const candidate = value[key];
    if (
      isRecord(candidate) &&
      Object.values(candidate).every((item) => typeof item === "boolean")
    ) {
      result[key] = candidate;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Project only non-sensitive CLI config; unknown plugin options, MCP, network, and hooks fields are all dropped. */
function sanitizeCliConfig(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const projection: Record<string, unknown> = {};
  const root = pickSafeSection(parsed, { model: "string" });
  if (root) Object.assign(projection, root);
  const sections: ReadonlyArray<{
    key: string;
    scalarFields: Readonly<Record<string, SafeScalarType>>;
    stringArrayFields?: readonly string[];
    booleanMapFields?: readonly string[];
  }> = [
    { key: "modelStream", scalarFields: { idleTimeoutMs: "number" } },
    {
      key: "permission",
      scalarFields: {
        mode: "string",
        autoApproveHighRisk: "boolean",
        allowMediumRiskInAuto: "boolean",
      },
      stringArrayFields: ["allowedTools", "disallowedTools"],
    },
    {
      key: "features",
      scalarFields: {
        compact: "boolean",
        rewind: "boolean",
        subagent: "boolean",
        memory: "boolean",
        skill: "boolean",
        mcp: "boolean",
      },
    },
    { key: "memory", scalarFields: { use: "boolean" } },
    {
      key: "plugins",
      scalarFields: { enabled: "boolean" },
      stringArrayFields: ["suppressedBuiltins"],
      booleanMapFields: ["enabledPlugins"],
    },
    {
      key: "skills",
      scalarFields: {
        enabled: "boolean",
        includeInstructions: "boolean",
        metadataBudget: "number",
      },
    },
    { key: "logging", scalarFields: { level: "string", format: "string" } },
    { key: "ui", scalarFields: { locale: "string", theme: "string" } },
    { key: "toolConcurrency", scalarFields: { maxConcurrency: "number" } },
    {
      key: "modelAnomalyGuard",
      scalarFields: {
        toolCallWarningThreshold: "number",
        repeatedToolCallWarningThreshold: "number",
        maxBudgetWarningsPerTurn: "number",
      },
    },
  ];
  for (const sectionDefinition of sections) {
    const section = pickSafeSection(
      parsed[sectionDefinition.key],
      sectionDefinition.scalarFields,
      sectionDefinition.stringArrayFields,
      sectionDefinition.booleanMapFields,
    );
    if (section) projection[sectionDefinition.key] = section;
  }
  return redactFeedbackText(JSON.stringify(projection, null, 2), { diagnostic: true });
}

/** The only archive path for feedback uploads: allow-listed sources, bounded reads, and no raw fallback when decoding is unsafe. */
export async function createFeedbackDiagnosticArchive(options: {
  sources: readonly FeedbackLogSource[];
  outputRootDir: string;
  now?: () => Date;
  maxTotalBytes?: number;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}): Promise<{ path: string; size: number }> {
  const now = options.now?.() ?? new Date();
  // Filter files by local calendar day; midnight comes from the calendar, honoring 23/25h DST days.
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const isToday = (mtimeMs: number) => mtimeMs >= dayStart && mtimeMs < dayEnd;
  await mkdir(options.outputRootDir, { recursive: true });
  const outputDir = await mkdtemp(join(options.outputRootDir, "archive-"));
  const path = join(outputDir, "zcode-diagnostic-logs.zip");
  const entries: Array<{ name: string; data: Buffer }> = [];
  const skippedLogFilesByReason: Record<string, number> = {};
  const skipLogFile = (reason: string) => {
    skippedLogFilesByReason[reason] = (skippedLogFilesByReason[reason] ?? 0) + 1;
  };
  let totalBytes = 0;
  let visited = 0;
  const budget = Math.min(options.maxTotalBytes ?? MAX_TOTAL_BYTES, MAX_TOTAL_BYTES);
  try {
    options.onProgress?.({ processedBytes: 0, totalBytes: 0 });
    for (const source of options.sources) {
      // Never follow links at the diagnostics root itself; normalize system aliases such as macOS /var.
      const root = await realpath(source.directory).catch(() => null);
      if (!root || !(await lstat(source.directory).catch(() => null))?.isDirectory()) continue;
      const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
        if (depth > 4 || visited >= 2000) return;
        const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
          if (++visited > 2000) return;
          if (entry.isSymbolicLink()) continue;
          const absolutePath = join(directory, entry.name);
          const name = posix.join(prefix, entry.name);
          const isExplicitFileSource = source.includeFileNames !== undefined;
          if (entry.isDirectory() && !source.exitLogsOnly && !isExplicitFileSource) {
            await walk(absolutePath, name, depth + 1);
            continue;
          }
          if (
            !entry.isFile() ||
            (isExplicitFileSource
              ? !source.includeFileNames!.includes(entry.name)
              : !(source.exitLogsOnly
                  ? entry.name.endsWith(".exit.log")
                  : /(?:\.log(?:\.\d+)?|\.jsonl|\.ndjson)$/i.test(entry.name)))
          )
            continue;
          if ((await realpath(absolutePath).catch(() => null)) !== absolutePath) {
            skipLogFile("unsafe-path");
            continue;
          }
          const info = await lstat(absolutePath).catch(() => null);
          if (
            !info?.isFile() ||
            info.nlink !== 1 ||
            info.size > MAX_FILE_BYTES ||
            totalBytes + info.size > budget ||
            (source.onlyCurrentDay !== false && !isToday(info.mtimeMs))
          ) {
            skipLogFile("metadata-policy");
            continue;
          }
          // O_NOFOLLOW stops post-check symlink swaps; re-verify via the opened inode.
          const handle = await open(
            absolutePath,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          ).catch(() => null);
          if (!handle) {
            skipLogFile("open-failed");
            continue;
          }
          try {
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              opened.nlink !== 1 ||
              opened.ino !== info.ino ||
              opened.dev !== info.dev ||
              (source.onlyCurrentDay !== false && !isToday(opened.mtimeMs)) ||
              opened.size > MAX_FILE_BYTES ||
              totalBytes + opened.size > budget
            ) {
              skipLogFile("opened-file-policy");
              continue;
            }
            // Appends are normal: trust the length confirmed at read-open and leave later growth to the next archive run.
            // Never probe size+1 and discard the active log; on short reads skip conservatively.
            const bytes = Buffer.alloc(opened.size);
            let length = 0;
            while (length < bytes.length) {
              const read = await handle.read(bytes, length, bytes.length - length, length);
              if (!read.bytesRead) break;
              length += read.bytesRead;
            }
            if (length !== opened.size) {
              skipLogFile("short-read");
              continue;
            }
            const text = decodeDiagnosticLog(bytes.subarray(0, length));
            if (text === null) {
              skipLogFile("unsupported-text");
              continue;
            }
            const sanitizedText =
              source.contentPolicy === "cli-config"
                ? sanitizeCliConfig(text)
                : redactFeedbackText(text, { diagnostic: true });
            if (sanitizedText === null) {
              skipLogFile("invalid-config");
              continue;
            }
            const data = Buffer.from(sanitizedText);
            if (data.length > MAX_FILE_BYTES || totalBytes + data.length > budget) {
              skipLogFile("redacted-size-limit");
              continue;
            }
            entries.push({ name, data });
            totalBytes += Math.max(length, data.length);
          } finally {
            await handle.close();
          }
        }
      };
      await walk(root, source.archivePrefix, 0);
    }
    const zip = new ZipFile();
    const output = createWriteStream(path, { mode: 0o600 });
    // The pipeline watches zip and stdout errors; any failure cleans up this run\x27s directory.
    const writing = pipeline(zip.outputStream, output);
    for (const entry of entries) zip.addBuffer(entry.data, entry.name);
    zip.addBuffer(
      Buffer.from(
        [
          "ZCode diagnostic logs",
          `timestamp: ${now.toISOString()}`,
          `appVersion: ${ZCODE_VERSION}`,
          `commit: ${ZCODE_COMMIT}`,
          `node: ${process.version}`,
          `os: ${platform()} ${release()} (${arch()})`,
          `includedLogFiles: ${entries.length}`,
          `skippedLogFiles: ${Object.values(skippedLogFilesByReason).reduce((sum, count) => sum + count, 0)}`,
          `skippedLogFilesByReason: ${JSON.stringify(skippedLogFilesByReason)}`,
          "Scope: diagnostic text log files modified today (local time), plus an explicit non-sensitive CLI config projection; credentials and structured payloads redacted.",
        ].join("\n"),
      ),
      "about.txt",
    );
    zip.end();
    await writing;
    const { size } = await stat(path);
    options.onProgress?.({ processedBytes: size, totalBytes: size });
    return { path, size };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}
