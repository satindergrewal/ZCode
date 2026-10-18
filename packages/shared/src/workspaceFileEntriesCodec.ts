import type { WorkspaceFileEntry } from "@zcode/shared";

/**
 * Columnar codec for workspace file entries (worker/cross-process transport; zero runtime deps).
 * Each line `type\trelativePath`--name is relativePath's last segment and path rebuilds from
 * rootPath, so nothing transmits twice (370k rows measured 65.7MB -> ~25MB).
 * Unix filenames may contain \t \n \\; escaped on pack, restored on unpack.
 *
 * Transport shape (performance-constrained):
 * - RPC top level returns a bare string: the framework's String fast path (length prefix + raw bytes),
 *   avoiding Object JSON stringify/parse escape costs on \t\n-heavy strings (6-9s measured);
 * - one message <= WORKSPACE_FILE_ENTRIES_CHUNK_SIZE (~4MB): on the renderer side, framing a giant message
   is a seconds-long main-thread task (4.6-6.3s measured); chunked fetches + yields between chunks
   keep every slice ~50ms, so input never freezes.
 */
const FIELD_SEPARATOR = "\t";
const LINE_SEPARATOR = "\n";

/** Per-chunk target size (chars); callers page by totalLength. */
export const WORKSPACE_FILE_ENTRIES_CHUNK_SIZE = 4_000_000;

function escapeField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

// One regex restores escapes (several times faster than a char loop; seconds saved at 370k rows).
const UNESCAPE_PATTERN = /\\(.)/g;

function unescapeField(value: string): string {
  return value.replace(UNESCAPE_PATTERN, (match, char: string) => {
    if (char === "t") {
      return "\t";
    }
    if (char === "n") {
      return "\n";
    }
    return char;
  });
}

export function packWorkspaceFileEntries(entries: WorkspaceFileEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.type}${FIELD_SEPARATOR}${escapeField(entry.relativePath)}`);
  }
  return lines.join(LINE_SEPARATOR);
}

/**
 * Unpack and rebuild full entries: name = relativePath's last segment, path = rootPath + it
 *(rootPath with or without trailing separator; \ on Windows, / elsewhere).
 */
export function unpackWorkspaceFileEntries(packed: string, rootPath: string): WorkspaceFileEntry[] {
  if (packed.length === 0) {
    return [];
  }
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const prefix =
    rootPath.endsWith("/") || rootPath.endsWith("\\") ? rootPath : `${rootPath}${separator}`;
  const lines = packed.split(LINE_SEPARATOR);
  const entries: WorkspaceFileEntry[] = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const tabAt = line.indexOf(FIELD_SEPARATOR);
    if (tabAt === -1) {
      continue;
    }
    const relativePath = unescapeField(line.slice(tabAt + 1));
    const lastSlash = relativePath.lastIndexOf("/");
    // Under a Windows root, convert posix relative separators to \ too, matching node:path.join.
    const pathPart = separator === "/" ? relativePath : relativePath.split("/").join("\\");
    entries.push({
      name: lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1),
      path: `${prefix}${pathPart}`,
      relativePath,
      type: line.slice(0, tabAt) === "directory" ? "directory" : "file",
    });
  }
  return entries;
}
