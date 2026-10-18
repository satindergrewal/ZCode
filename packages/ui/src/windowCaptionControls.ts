import type { CSSProperties } from "react";

export const WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX = 136;
export const WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR =
  "var(--windows-caption-controls-right-inset)";
export const WINDOWS_CAPTION_CONTROL_WIDTH_VAR = "var(--windows-caption-control-width)";

type WindowsCaptionControlsStyle = CSSProperties & {
  "--windows-caption-controls-right-inset": string;
  "--windows-caption-control-width": string;
};

export function createWindowsCaptionControlsStyle(
  _fallbackRightInsetPx = WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX,
): WindowsCaptionControlsStyle {
  return {
    // Drawn buttons scale with the page; post-WCO geometry can still span the window,
    "--windows-caption-controls-right-inset": `${WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX}px`,
    // so legacy menus keep thirds while compact controls use fixed 28px.
    "--windows-caption-control-width": "calc(var(--windows-caption-controls-right-inset) / 3)",
  };
}

// Windows-titlebar-only style; never disturb Linux custom caption spacing.
export const WINDOWS_CAPTION_CONTROL_CLASS =
  "h-full w-[var(--windows-caption-control-width,46px)] rounded-none";
