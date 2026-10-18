import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";
import { getFiletypeFromFileName } from "@pierre/diffs";
import {
  getPatchPreviewLineContent,
  getPlainTextPatchContentLines,
  getPlainTextPatchFallbackLines,
  parseTruncatedMarkerOmittedLineCount,
} from "@/lib/patchDiffPreview.js";

const MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT = 180_000;
const MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT = 1_200;

export type GitPaneDiffPreviewPlan =
  | {
      kind: "rich";
    }
  | {
      kind: "patch";
    }
  | {
      kind: "plain-text";
      lines: string[];
    };

export function getSourceMessageId(sourceId: GitChangeSourceId): string {
  switch (sourceId) {
    case "unstaged":
      return "git.source.unstaged";
    case "staged":
      return "git.source.staged";
    case "branch":
      return "git.source.branch";
    case "last-turn":
      return "git.source.lastTurn";
    default:
      return "git.source.unstaged";
  }
}

export function getDiffFallbackMessageId(availability: GitDiffResult["availability"]): string {
  switch (availability) {
    case "binary":
      return "git.diff.binaryTitle";
    case "truncated":
      return "git.diff.truncatedTitle";
    default:
      return "git.diff.unavailableTitle";
  }
}

export function getDiffCacheKey(sourceId: GitChangeSourceId, path: string): string {
  return `${sourceId}:${path}`;
}

export function getGitPaneDiffFindContent(diff: GitDiffResult | null): string | null {
  if (diff?.availability !== "patch") {
    return null;
  }

  if (diff.beforeContent !== null && diff.afterContent !== null) {
    return `${diff.beforeContent}\n${diff.afterContent}`;
  }

  if (diff.patch) {
    const previewPlan = getGitPaneDiffPreviewPlan(diff);
    const visibleLines =
      previewPlan.kind === "plain-text"
        ? previewPlan.lines
        : getPlainTextPatchContentLines(diff.patch);

    // With full-text degraded, searching raw patch hits ghost matches in headers/index/hunks;
    // search visible lines and strip markers that never render.
    return visibleLines
      .filter((line) => parseTruncatedMarkerOmittedLineCount(line) === null)
      .map(getPatchPreviewLineContent)
      .join("\n");
  }

  if (diff.beforeContent === null && diff.afterContent === null) {
    return null;
  }

  return `${diff.beforeContent ?? ""}\n${diff.afterContent ?? ""}`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function countLogicalLines(content: string | null): number {
  if (!content) {
    return 0;
  }

  let lineCount = content.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }

  return lineCount;
}

export function shouldRenderPatchOnlyGitDiffPreview(diff: GitDiffResult): boolean {
  if (diff.availability !== "patch" || !diff.patch) {
    return false;
  }

  // Failed repo reads keep the patch valid but one side empty; do not fabricate files.
  // Fold incomplete pairs into the patch safety precheck, not whole-file add/delete.
  if (diff.beforeContent === null || diff.afterContent === null) {
    return true;
  }

  const fullContentCharCount = (diff.beforeContent?.length ?? 0) + (diff.afterContent?.length ?? 0);
  if (fullContentCharCount > MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT) {
    return true;
  }

  const fullContentLineCount = Math.max(
    countLogicalLines(diff.beforeContent),
    countLogicalLines(diff.afterContent),
  );

  return fullContentLineCount > MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT;
}

export function getGitPaneDiffPreviewPlan(diff: GitDiffResult | null): GitPaneDiffPreviewPlan {
  if (diff?.availability !== "patch" || !diff.patch) {
    return { kind: "rich" };
  }

  const reviewFallbackLines = shouldRenderPlainTextDiffPreview(diff.patch);
  if (reviewFallbackLines) {
    return {
      kind: "plain-text",
      lines: reviewFallbackLines,
    };
  }

  if (!shouldRenderPatchOnlyGitDiffPreview(diff)) {
    return { kind: "rich" };
  }

  const fullPatchFallbackLines = getPlainTextPatchFallbackLines(diff.patch);
  if (fullPatchFallbackLines) {
    return {
      kind: "plain-text",
      lines: fullPatchFallbackLines,
    };
  }

  // Large files: MultiFileDiff compares whole files and builds ASTs in render;
  // only hunks matter first. Past the threshold use PatchDiff with its async
  // highlight worker, skipping whole-file main-thread cost.
  return { kind: "patch" };
}

export function shouldRenderPlainTextDiffPreview(patch: string): string[] | null {
  const fallbackLines = getPlainTextPatchFallbackLines(patch);
  if (!fallbackLines) {
    return null;
  }

  const lines = patch.split(/\r?\n/);
  const isCreatedOrDeletedPatch =
    lines.some((line) => line === "--- /dev/null") ||
    lines.some((line) => line === "+++ /dev/null");
  if (!isCreatedOrDeletedPatch) {
    return fallbackLines;
  }

  const patchFileName = getPatchContentFileName(lines);
  if (!patchFileName) {
    return null;
  }

  // The review panel downsizes only plain-text add/delete files to light previews.
  // The generic fallback covers structured files (JSON) to avoid blank expands;
  // re-route by type so structured files keep PatchDiff semantics.
  return getFiletypeFromFileName(patchFileName) === "text" ? fallbackLines : null;
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    const fileName = line.slice(4).trim();
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}
