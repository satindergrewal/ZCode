/**
 * Shortcut display labels — binding string -> platform-formatted label.
 * Split from bindings.ts (display layer independent of match/record/conflicts; bindings.ts has a
 * max-lines gate).
 */
import { parseShortcutBinding } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";

/**
 * Binding string -> per-key tokens (for keycap rendering in settings): macOS ["⇧","⌘","P"],
 * Windows/Linux ["Ctrl","Shift","P"]. Label display and keycap rendering share one token sequence —
 * the single source of the ordering convention; each token renders its own Kbd cap so sizes do not
 * drift with content.
 */
export function formatShortcutBindingLabelParts(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string[] {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return [binding];
  }

  const displayKey =
    parsed.key === "=" ? "+" : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
  const isApple = isAppleKeyboardPlatform(platformInfo);

  if (isApple) {
    // Apple convention modifier order: Ctrl Alt Shift Cmd
    const parts: string[] = [];
    if (parsed.altGr) {
      parts.push("⌃", "⌥");
    } else {
      if (parsed.ctrl) {
        parts.push("⌃");
      }
      if (parsed.alt) {
        parts.push("⌥");
      }
    }
    if (parsed.shift) {
      parts.push("⇧");
    }
    if (parsed.cmdOrCtrl) {
      parts.push("⌘");
    }
    parts.push(displayKey);
    return parts;
  }

  const parts: string[] = [];
  if (parsed.cmdOrCtrl || parsed.ctrl) {
    parts.push("Ctrl");
  }
  if (parsed.altGr) {
    parts.push("Alt");
  } else if (parsed.alt) {
    parts.push("Alt");
  }
  if (parsed.shift) {
    parts.push("Shift");
  }
  parts.push(displayKey);
  return parts;
}

/**
 * Binding string -> platform display label. macOS uses symbol style (⌘ K, ⌃ ⌥ ⇧ ⌘ P);
 * Windows/Linux use Ctrl+Shift+P style; "=" renders as "+" (zoom semantics), named keys verbatim.
 */
export function formatShortcutBindingLabel(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  return formatShortcutBindingLabelParts(binding, platformInfo).join(
    isAppleKeyboardPlatform(platformInfo) ? " " : "+",
  );
}
