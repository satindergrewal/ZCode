import type { HighlighterTypes } from "@pierre/diffs";
import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";

/**
 * @pierre/diffs defaults to shiki's JavaScript regex engine (shiki-js). It translates each
 * TextMate grammar into giant RegExp objects held forever in an engine-level cache, and V8
 * compiles executed regexes into native code in the code space; double-byte text (e.g.
 * CJK comments) gets compiled a second time. The main window and 4 diff workers share a
 * single 256MB code range, which these regexes eventually exhaust, triggering a renderer
 * V8 OOM (CALL_AND_RETRY_LAST with plenty of free old-space, code cage "ran out of
 * reservation"). The oniguruma WASM engine keeps its regexes in wasm linear memory, leaving
 * the V8 code space alone, and is the reference implementation for TextMate grammars.
 */
export const DIFFS_PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

export interface DiffsHighlighterThemeSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
}

/** Diff worker pool init options; the main-thread fallback renderer and workers must share one engine choice. */
export function createDiffsWorkerHighlighterOptions(
  settings: DiffsHighlighterThemeSettings,
): WorkerInitializationRenderOptions {
  return {
    theme: {
      light: settings.lightTheme,
      dark: settings.darkTheme,
    },
    // Per-patch word diffs add main-thread cost; keep the library defaults for now and
    // tighten later based on slow-path logs, avoiding a "highlighting suddenly vanished"
    // regression in a single change.
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: false,
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
  };
}
