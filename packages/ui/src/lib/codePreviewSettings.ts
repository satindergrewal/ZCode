/**
 * Types and defaults for code preview settings.
 *
 * A neutral standalone module: if defined in the zustand store, presentational components
 * (ai-elements / ToolCallBlocks) would need the store just for types and defaults.
 * The store only re-exports; components take props with these defaults as the fallback.
 */
import type { BundledTheme } from "shiki";

export interface CodePreviewSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}

export const DEFAULT_CODE_PREVIEW_SETTINGS: CodePreviewSettings = {
  lightTheme: "github-light",
  darkTheme: "github-dark",
  showLineNumbers: true,
  wrapLongLines: false,
  fontSizePx: 12,
};
