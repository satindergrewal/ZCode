import { useMemo } from "react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import { getPlainTextPatchFallbackLines } from "@/lib/patchDiffPreview.js";
import type { CodePreviewSettings } from "@/store/index.js";

interface PatchFallbackContentProps {
  patch: string;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: "light" | "dark";
  sourcePath?: string;
  sourceTitle?: string;
}

export function PatchFallbackContent({
  patch,
  codePreviewSettings,
  resolvedTheme,
  sourcePath,
  sourceTitle,
}: PatchFallbackContentProps) {
  const plainTextFallbackLines = useMemo(() => getPlainTextPatchFallbackLines(patch), [patch]);
  const highlightPath = sourcePath ?? sourceTitle;
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(highlightPath, patch),
    [highlightPath, patch],
  );
  const highlightTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;

  if (plainTextFallbackLines) {
    // @pierre/diffs PatchDiff only supports single-file patches; multi-file patches reaching the
    // side preview threw during render and jammed the pane, so everything degrades to a lightweight
    // diff. The edit side diff uses the same fallback for added/deleted files; it used to render
    // plain text, losing syntax highlighting for HTML/TS etc. Async Shiki keeps the light path.
    return (
      <HighlightedLightweightDiffPreview
        className="h-full"
        codePreviewSettings={codePreviewSettings}
        data-patch-plain-text-preview
        language={highlightLanguage}
        lines={plainTextFallbackLines}
        path={highlightPath}
        theme={highlightTheme}
      />
    );
  }

  return (
    <DiffViewer
      patch={patch}
      diffClassName="block"
      fontSizePx={codePreviewSettings.fontSizePx}
      lightTheme={codePreviewSettings.lightTheme}
      darkTheme={codePreviewSettings.darkTheme}
      themeType={resolvedTheme}
    />
  );
}
