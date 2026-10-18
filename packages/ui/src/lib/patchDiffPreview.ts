import { getFiletypeFromFileName, getSingularPatch, parsePatchFiles } from "@pierre/diffs";

const MAX_PATCH_DIFF_SAFE_LINE_COUNT = 1_200;
const MAX_PATCH_DIFF_SAFE_CHAR_COUNT = 180_000;
const MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER = 1_200;
const MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES = 800;
// Never assemble display copy here: hardcoding English in the lib layer breaks i18n.
// Emit an internal marker token instead; the component layer renders real copy via intl.
const FALLBACK_TRUNCATED_MARKER_PREFIX = "\\ __ZCODE_DIFF_TRUNCATED__:";
const FALLBACK_TRUNCATED_MARKER_REGEX = /^\\ __ZCODE_DIFF_TRUNCATED__:(\d+)$/;
const PACKAGE_MANAGER_LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES = new Set(["zsh"]);
// @pierre/diffs classifies Gradle scripts as plain text. When some entry points or workers
// are unavailable such patches still go through PatchDiff and can stall the main thread in
// synchronous parsing. Degrade to a lightweight <pre> by suffix up front so clicking a file
// chip never freezes the whole pane.
const PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES = [".gradle", ".gradle.kts"];

function buildTruncatedMarkerLine(omittedLineCount: number): string {
  return `${FALLBACK_TRUNCATED_MARKER_PREFIX}${omittedLineCount}`;
}

export function countPatchFileDiffs(patch: string): number {
  const lines = patch.split(/\r?\n/);
  const gitDiffHeaderCount = lines.filter((line) => line.startsWith("diff --git ")).length;
  if (gitDiffHeaderCount > 0) {
    return gitDiffHeaderCount;
  }

  const parseHunkRange = (line: string): { oldLines: number; newLines: number } | null => {
    const match = line.match(/^@@\s-\d+(?:,(\d+))?\s\+\d+(?:,(\d+))?\s@@/);
    if (!match) {
      return null;
    }
    return {
      oldLines: Number(match[1] ?? "1"),
      newLines: Number(match[2] ?? "1"),
    };
  };

  const isFileHeaderPair = (index: number): boolean => {
    return (
      (lines[index]?.startsWith("--- ") ?? false) && (lines[index + 1]?.startsWith("+++ ") ?? false)
    );
  };

  const consumeHunkBody = (start: number, oldLines: number, newLines: number): number | null => {
    let cursor = start;
    let remainingOld = oldLines;
    let remainingNew = newLines;

    while (remainingOld > 0 || remainingNew > 0) {
      const line = lines[cursor];
      if (line === undefined) {
        return null;
      }

      // In multi-file patches without a `diff --git` prefix, the next file header is
      // `--- a/x` immediately followed by `+++ b/x` -- both start with -/+. Consuming them
      // as the current hunk's deletions/additions means that when the model overcounts the
      // hunk header (a common LLM off-by-one) the surplus budget eats the next file header,
      // and the following @@ is treated as another hunk of the same file, collapsing a
      // multi-file patch into one. While consuming the body, probe for a complete
      // `---`/`+++` header pair: end the hunk early and hand control back to the outer loop
      // to recognize the new file instead of folding the header into the body.
      if (isFileHeaderPair(cursor)) {
        return cursor;
      }

      if (line.startsWith("\\ ")) {
        cursor += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        remainingOld -= 1;
        remainingNew -= 1;
      } else if (line.startsWith("-")) {
        remainingOld -= 1;
      } else if (line.startsWith("+")) {
        remainingNew -= 1;
      } else {
        return null;
      }

      if (remainingOld < 0 || remainingNew < 0) {
        return null;
      }
      cursor += 1;
    }

    while (lines[cursor]?.startsWith("\\ ")) {
      cursor += 1;
    }
    return cursor;
  };

  let diffCount = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const oldHeader = lines[cursor];
    const newHeader = lines[cursor + 1];
    if (!oldHeader?.startsWith("--- ") || !newHeader?.startsWith("+++ ")) {
      cursor += 1;
      continue;
    }

    let hunkCursor = cursor + 2;
    let hasHunk = false;
    let sawHunkHeader = false;

    while (hunkCursor < lines.length) {
      const hunkRange = parseHunkRange(lines[hunkCursor] ?? "");
      if (!hunkRange) {
        break;
      }
      sawHunkHeader = true;

      const nextCursor = consumeHunkBody(hunkCursor + 1, hunkRange.oldLines, hunkRange.newLines);
      if (nextCursor === null) {
        break;
      }

      hasHunk = true;
      hunkCursor = nextCursor;
    }

    if (!hasHunk && !sawHunkHeader) {
      cursor += 1;
      continue;
    }

    // Hunk bodies may contain real lines starting with `---`/`+++`, so counting on the pair
    // alone is wrong; still, when the body is truncated after a hunk header, conservatively
    // count "one file diff". Consume the body per the hunk header's declared line count and
    // recognize a `---/+++` pair as a file header only when its hunk parses, counting
    // conservatively on truncation so multi-file patches are not collapsed into one.
    diffCount += 1;
    cursor = hasHunk ? hunkCursor : cursor + 2;
  }

  return diffCount;
}

export function parseTruncatedMarkerOmittedLineCount(line: string): number | null {
  const markerMatch = FALLBACK_TRUNCATED_MARKER_REGEX.exec(line);
  if (!markerMatch) {
    return null;
  }

  const omittedLineCount = Number.parseInt(markerMatch[1] ?? "", 10);
  if (!Number.isFinite(omittedLineCount) || omittedLineCount <= 0) {
    return null;
  }

  return omittedLineCount;
}

export function getPatchPreviewLineContent(line: string): string {
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return line.slice(1);
  }

  return line;
}

function isPatchHunkHeaderLine(line: string): boolean {
  return line === "@@" || line.startsWith("@@ ");
}

function getMaxHunkLineNumber(lines: readonly string[]): number {
  let maxLineNumber = 0;

  for (const line of lines) {
    if (!line.startsWith("@@ ")) {
      continue;
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }

    const oldStart = Number.parseInt(match[1] ?? "0", 10);
    const oldCount = Number.parseInt(match[2] ?? "1", 10);
    const newStart = Number.parseInt(match[3] ?? "0", 10);
    const newCount = Number.parseInt(match[4] ?? "1", 10);
    const oldEnd = oldStart + Math.max(0, Number.isNaN(oldCount) ? 1 : oldCount) - 1;
    const newEnd = newStart + Math.max(0, Number.isNaN(newCount) ? 1 : newCount) - 1;

    maxLineNumber = Math.max(maxLineNumber, oldEnd, newEnd);
  }

  return maxLineNumber;
}

function limitPlainTextPreviewLines(lines: readonly string[]): string[] {
  if (lines.length <= MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES) {
    return [...lines];
  }

  const keepCount = MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES - 1;
  const headCount = Math.ceil(keepCount / 2);
  const tailCount = keepCount - headCount;
  const omittedCount = lines.length - keepCount;

  return [
    ...lines.slice(0, headCount),
    buildTruncatedMarkerLine(omittedCount),
    ...lines.slice(lines.length - tailCount),
  ];
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    // Standard unified diff headers may append a tab-separated timestamp after the path.
    // Without stripping it first, suffix-based degradation rules like `.gradle` are bypassed
    // by `test.gradle\t...`.
    const fileName = line.slice(4).trim().split("\t", 1)[0]?.trim() ?? "";
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}

function normalizePatchFileName(fileName: string): string {
  return fileName.replace(/^([ab])\//, "");
}

function isPackageManagerLockfile(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  return PACKAGE_MANAGER_LOCKFILE_NAMES.has(
    normalizePatchFileName(fileName).split("/").at(-1)?.toLocaleLowerCase() ?? "",
  );
}

function shouldForcePlainTextPatchPreviewByFileName(fileName: string | null): boolean {
  if (!fileName) {
    return false;
  }

  const normalizedFileName = normalizePatchFileName(fileName).toLocaleLowerCase();

  return PATCH_DIFF_FORCE_PLAIN_TEXT_PATH_SUFFIXES.some((suffix) =>
    normalizedFileName.endsWith(suffix),
  );
}

function shouldForcePlainTextPatchPreview(fileName: string | null): boolean {
  if (isPackageManagerLockfile(fileName)) {
    return true;
  }

  if (shouldForcePlainTextPatchPreviewByFileName(fileName)) {
    return true;
  }

  if (!fileName) {
    return false;
  }

  return PATCH_DIFF_FORCE_PLAIN_TEXT_FILE_TYPES.has(getFiletypeFromFileName(fileName));
}

function collectPatchMetadataPreviewLines(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return false;
    }

    return (
      !line.startsWith("diff --git ") &&
      !line.startsWith("index ") &&
      !line.startsWith("--- ") &&
      !line.startsWith("+++ ")
    );
  });
}

function collectPlainTextPreviewLines(lines: readonly string[]): string[] {
  const previewLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (!inHunk) {
      if (isPatchHunkHeaderLine(line)) {
        inHunk = true;
      }
      continue;
    }

    // Filtering by `+++ / --- / @@` prefixes deleted real `++ `/`-- ` body lines. Skip only
    // the hunk header itself; once inside a hunk, keep everything verbatim.
    if (isPatchHunkHeaderLine(line)) {
      continue;
    }

    previewLines.push(line);
  }

  if (inHunk || previewLines.length > 0) {
    return previewLines;
  }

  // rename-only/mode-only Git patches have no @@ hunk yet still carry changes users need.
  // They used to go to PatchDiff, where some packaged builds rendered an empty expansion;
  // keep the metadata and use the lightweight fallback.
  return collectPatchMetadataPreviewLines(lines);
}

function normalizePlainTextPreviewLines(lines: readonly string[]): string[] {
  const normalizedLines = limitPlainTextPreviewLines(lines);

  // The fallback optimizes for readability and interactivity; protocol headers like
  // `---/+++ / @@` need not survive.
  while (normalizedLines.length > 0 && normalizedLines.at(-1) === "") {
    normalizedLines.pop();
  }

  return normalizedLines.length > 0 ? normalizedLines : [""];
}

export function getPlainTextPatchPreviewLines(patch: string): string[] {
  return normalizePlainTextPreviewLines(getPlainTextPatchContentLines(patch));
}

export function getPlainTextPatchContentLines(patch: string): string[] {
  return collectPlainTextPreviewLines(patch.split(/\r?\n/));
}

export function getPlainTextPatchFallbackLines(patch: string): string[] | null {
  const lines = patch.split(/\r?\n/);
  const patchFileDiffCount = countPatchFileDiffs(patch);
  const hasMultipleFileDiffs = patchFileDiffCount > 1;
  const hasNoFileDiff = patchFileDiffCount === 0;
  const isCreatedFile = lines.some((line) => line === "--- /dev/null");
  const isDeletedFile = lines.some((line) => line === "+++ /dev/null");
  const maxHunkLineNumber = getMaxHunkLineNumber(lines);
  const isOversizedPatch =
    lines.length > MAX_PATCH_DIFF_SAFE_LINE_COUNT || patch.length > MAX_PATCH_DIFF_SAFE_CHAR_COUNT;
  const isDeepHunkLinePatch = maxHunkLineNumber > MAX_PATCH_DIFF_SAFE_HUNK_LINE_NUMBER;
  const patchFileName = getPatchContentFileName(lines);
  const shouldForcePlainTextPreview = shouldForcePlainTextPatchPreview(patchFileName);

  const metadataOnlyPreviewLines = collectPatchMetadataPreviewLines(lines);
  const isMetadataOnlyPatch =
    metadataOnlyPreviewLines.length > 0 && !lines.some(isPatchHunkHeaderLine);

  if (
    !hasNoFileDiff &&
    !hasMultipleFileDiffs &&
    !isCreatedFile &&
    !isDeletedFile &&
    !isOversizedPatch &&
    !isDeepHunkLinePatch &&
    !isMetadataOnlyPatch &&
    !shouldForcePlainTextPreview
  ) {
    try {
      // Our own counter can classify this as logically single-file by hunk line counts, but
      // PatchDiff's real parser splits removed SQL comments (body lines like `--- ...`) into a
      // second file. Safety must be decided by the parser that actually renders: @pierre/diffs.
      // Do not call getSingularPatch -- on expected multi-file results it console.error(files)
      // before throwing, leaking user code to the console. Parse with throwOnError and count
      // ourselves so normal degradation stays log-free.
      const parsedPatches = parsePatchFiles(patch, undefined, true);
      if (parsedPatches.length === 1 && parsedPatches[0]?.files.length === 1) {
        return null;
      }
    } catch {
      // Parse failure and multi-file results are both expected degradation conditions; the
      // lightweight text preview below handles them.
    }
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (isMetadataOnlyPatch) {
    return normalizePlainTextPreviewLines(metadataOnlyPreviewLines);
  }

  if (hasNoFileDiff) {
    // Summaries/tool replays can yield apply_patch fragments or bare hunks. Without standard
    // file-diff headers PatchDiff throws synchronously ("Provided patch must contain exactly 1
    // file diff"), so degrade directly.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (shouldForcePlainTextPreview) {
    // For lockfiles/shell scripts the highlight-worker path of PatchDiff is unreliable in
    // production builds; the diff loads but expansion fails. Always use the lightweight text
    // preview here, prioritizing visible content.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if ((isCreatedFile || isDeletedFile) && !isOversizedPatch && !isDeepHunkLinePatch) {
    // Expanding created/deleted non-plain-text files in the file-changes panel can render an
    // empty shell in PatchDiff. Created/deleted files are whole-file snapshots anyway; stop
    // branching by extension and always use the lightweight fallback so expansion always
    // shows readable content.
    return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
  }

  if (!hasMultipleFileDiffs && !isOversizedPatch && !isDeepHunkLinePatch) {
    try {
      const resolvedPatchFileName = patchFileName ?? getSingularPatch(patch).name;
      const patchFileType = getFiletypeFromFileName(resolvedPatchFileName);

      // Even a tiny patch for a created/deleted plain-text file can stall the main thread in
      // @pierre/diffs synchronous rendering, freezing the whole UI. Also, when a deleted
      // file's body starts with `--- `, getSingularPatch misparses it as a new file header.
      // Prefer the path from the first real file header and fall back to the library parse,
      // keeping file-type detection independent of the body. Unknown suffixes degrade to
      // text, so gate on the parsed file type rather than a fixed extension list.
      if (patchFileType !== "text") {
        return null;
      }
    } catch {
      // Single-file counting only filters obviously malformed input; the parser's verdict
      // still rules before handing off to @pierre/diffs. A parse failure means it cannot
      // confirm "exactly one file diff", and continuing would hit the error boundary.
      return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
    }
  }

  // @pierre/diffs PatchDiff renders single-file patches only. Some toolchains concatenate
  // multi-file unified diffs into one field; PatchDiff then throws at render time ("Provided
  // patch must contain exactly 1 file diff") and takes the whole page into the error
  // boundary. Like oversized/deep-hunk inputs, degrade to the plain-text preview to keep the
  // chat usable. Oversized patches (e.g. thousand-line Dockerfiles) trigger synchronous
  // parsing on expansion, occupying the UI main thread long enough that the page freezes
  // after "expand diff". Large files with a single change can also place hunk line numbers
  // very deep (1500+), where PatchDiff similarly stalls. The lightweight plain-text render
  // keeps interactivity first.

  return normalizePlainTextPreviewLines(collectPlainTextPreviewLines(lines));
}
