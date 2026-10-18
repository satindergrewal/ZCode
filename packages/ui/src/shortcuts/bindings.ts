/**
 * Shortcut execution kernel — the single implementation of matching, recording, the effective
 * keymap, and conflict detection.
 *
 * - Key knowledge (format parsing, platform modifier semantics, reserved keys) lives only here and
 *   in shared/shortcutCommands.ts;
 * - everything is pure functions; DOM events enter as structured data so unit tests can cover
 *   combination edge cases;
 * - IME composition (isComposing / Process / Dead / keyCode 229) and long-press repeat never match
 *   and never record.
 */
import {
  type ParsedShortcutBinding,
  type ShortcutCommandId,
  parseShortcutBinding,
  serializeShortcutBinding,
  SHORTCUT_COMMANDS,
} from "@zcode/shared";
import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";

/** Keyboard-event structure for matching/recording (KeyboardEvent subset; tests can construct it). */
export interface ShortcutBindingEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** Legacy event-model compat; Chromium reports keyCode 229 during IME composition (CJK etc.). */
  keyCode?: number;
}

// ============================================================================
// Noise filtering (IME / long-press)
// ============================================================================

/** Is this an IME-composition event (isComposing / Process / Dead / keyCode 229)? */
function isImeEvent(event: ShortcutBindingEvent): boolean {
  return (
    event.isComposing === true ||
    event.key === "Process" ||
    event.key === "Dead" ||
    event.keyCode === 229
  );
}

/** Is this noise that must not trigger shortcuts: long-press repeat, IME composition, dead keys? */
function isShortcutEventNoise(event: ShortcutBindingEvent): boolean {
  return event.repeat === true || isImeEvent(event);
}

// ============================================================================
// event.code -> canonical key name (reliable across keyboard-layout differences)
// ============================================================================

const CODE_TO_KEY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      `Key${String.fromCharCode(65 + index)}`,
      String.fromCharCode(97 + index),
    ]),
  ),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Digit${index}`, String(index)])),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`]),
  ),
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  // Enter is recordable/matchable for composer-scope commands; NumpadEnter stays unmapped (undefined behavior)
  Enter: "Enter",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
  Insert: "Insert",
};

/** Canonical key name -> expected event.code (extended version of keyboardShortcuts.getExpectedShortcutCode). */
const KEY_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CODE_TO_KEY).map(([code, key]) => [key, code]),
);

// ============================================================================
// Generic matcher
// ============================================================================

/**
 * Generic match: does the event hit the binding (its canonical serialized string)?
 *
 * Modifiers match exactly: the event's actually-held modifiers must equal the binding's declared
 * set; extra modifiers (Cmd+Ctrl+K hitting CmdOrCtrl+K) do not count.
 * - CmdOrCtrl: macOS = meta without ctrl; Windows/Linux = ctrl without meta (platform split per
 *   keyboardShortcuts.ts);
 * - Ctrl: explicit Ctrl; synonymous with CmdOrCtrl on Windows/Linux (recording only emits
 *   CmdOrCtrl there);
 * - AltGr: on Windows/Linux physical AltGr is reported by Chromium as ctrl+alt held together.
 */
export function matchesShortcutBinding(
  event: ShortcutBindingEvent,
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  if (isShortcutEventNoise(event)) {
    return false;
  }
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }

  const isApple = isAppleKeyboardPlatform(platformInfo);
  if (!modifiersMatch(event, parsed, isApple)) {
    return false;
  }
  return eventMatchesKey(event, parsed.key);
}

function modifiersMatch(
  event: ShortcutBindingEvent,
  parsed: ParsedShortcutBinding,
  isApple: boolean,
): boolean {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event;

  // AltGr is physically indistinguishable from Ctrl+Alt (existing Ctrl+Alt+B-style bindings on
  // Windows/Linux are that chord), so AltGr bindings match the same physical combo as
  // cmdOrCtrl/ctrl+Alt; no exclusivity rule.
  const wantPrimaryOrCtrl = parsed.altGr || parsed.cmdOrCtrl || (!isApple && parsed.ctrl);
  const wantCtrl = !parsed.altGr && !parsed.cmdOrCtrl && parsed.ctrl && isApple;
  const wantAlt = parsed.altGr || parsed.alt;

  // Bare-key bindings (Enter/F5/arrows, no primary modifier) require primary modifiers up,
  // or Cmd+Enter would falsely match bare Enter — latent while every command had a primary
  // modifier, fatal once Enter entered the table.
  if (!wantPrimaryOrCtrl && !wantCtrl && (meta || ctrl)) {
    return false;
  }

  if (wantPrimaryOrCtrl) {
    const ok = isApple ? meta && !ctrl : ctrl && !meta;
    if (!ok) {
      return false;
    }
  }
  if (wantCtrl) {
    // macOS explicit Ctrl (system Emacs editing reserve; applies only when user-bound).
    if (!ctrl || meta) {
      return false;
    }
  }
  if (wantAlt !== alt) {
    return false;
  }
  return parsed.shift === shift;
}

/**
 * Shift+printable single-char bindings (e.g. Shift+f).
 * Such a binding is the same physical event as "typing an uppercase letter"; when the event target
 * is editable, a hit must pass through, or preventDefault eats the character and fires the command
 * instead.
 */
export function isShiftOnlyPrintableBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }
  return (
    !parsed.cmdOrCtrl &&
    !parsed.ctrl &&
    !parsed.alt &&
    !parsed.altGr &&
    parsed.shift &&
    parsed.key.length === 1
  );
}

/**
 * Is the shortcut event's target an editable element (input/textarea/select or contenteditable)?
 * Pairs with isShiftOnlyPrintableBinding: skip Shift-only printable bindings inside editable
 * targets. Always false without a DOM (node tests).
 */
export function isEditableShortcutEventTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Key match: prefer case-insensitive event.key, fall back to event.code (macOS Option rewrites, non-US layouts). */
function eventMatchesKey(event: Pick<ShortcutBindingEvent, "key" | "code">, key: string): boolean {
  if (event.key === key) {
    return true;
  }
  if (event.key.length === 1 && event.key.toLowerCase() === key) {
    return true;
  }
  if (event.code !== undefined) {
    return KEY_TO_CODE[key] === event.code;
  }
  return false;
}

// ============================================================================
// Recorder
// ============================================================================

type ShortcutRecordResult =
  | { kind: "pending" }
  | { kind: "binding"; binding: string }
  | { kind: "invalid"; reason: "no-modifier" | "unsupported-key" };

function isModifierOnlyKey(key: string): boolean {
  return (
    key === "Shift" ||
    key === "Control" ||
    key === "Meta" ||
    key === "Alt" ||
    key === "AltGraph" ||
    key === "OS"
  );
}

/**
 * Record a keyboard event into a canonical binding string.
 *
 * - pending: bare modifier press / IME noise without a resolvable code — keep waiting for the
 *   full combo;
 * - binding: valid combo (primary-modifier platform normalization: mac Cmd, win/linux Ctrl ->
 *   CmdOrCtrl; mac explicit Ctrl stays Ctrl);
 * - invalid: modifier-less plain key (except F-keys/arrows) or unsupported key.
 *
 * Key extraction prefers event.code reverse lookup of the physical base key (Shift+7 records "7"
 * on any layout, not "&"); event.key is fallback only. IME composition events (isComposing/
 * Process/229) have untrustworthy keys but physical codes — recording is an explicit intent after
 * pressing the record button, so record by code even with an IME capturing keys in an editable
 * focus (match-side filtering is unchanged, see isShortcutEventNoise). Escape/Backspace recording
 * semantics (cancel/clear) belong to the settings UI.
 */
export function recordShortcutBinding(
  event: ShortcutBindingEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  if (event.repeat === true || isModifierOnlyKey(event.key)) {
    return { kind: "pending" };
  }

  if (isImeEvent(event)) {
    const codeKey = event.code !== undefined ? CODE_TO_KEY[event.code] : undefined;
    if (codeKey === undefined) {
      return { kind: "pending" };
    }
    return buildRecordedBinding(event, codeKey, platformInfo);
  }

  const key =
    event.code !== undefined
      ? (CODE_TO_KEY[event.code] ?? normalizeEventKey(event.key))
      : normalizeEventKey(event.key);
  if (key === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return buildRecordedBinding(event, key, platformInfo);
}

/** Recording tail: modifier validation + platform normalization + serialization (key name already extracted by the caller). */
function buildRecordedBinding(
  event: ShortcutBindingEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  // Named keys (F-keys/arrows, multi-char) allow modifier-less single keys; plain character keys
  // require at least one modifier.
  const namedKey = key.length > 1;
  if (!hasModifier && !namedKey) {
    return { kind: "invalid", reason: "no-modifier" };
  }

  const parsed: ParsedShortcutBinding = {
    // AltGr is indistinguishable from Ctrl+Alt; recording always emits CmdOrCtrl+Alt (users think Ctrl+Alt).
    cmdOrCtrl: isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey,
    ctrl: isApple ? event.ctrlKey && !event.metaKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    altGr: false,
    key,
  };

  // mac Cmd+Ctrl+combo and win/linux bare-Meta (Win key) combos both normalize cmdOrCtrl/ctrl to
  // false while hasModifier (checked on the raw event) already passed; serialization would become
  // a bare key ("k") — outside the reserved blacklist, skipping conflict detection, and after
  // persisting, every bare press of that key fires the command and eats input. Validate the
  // primary modifier survived normalization before serializing.
  if ((event.metaKey || event.ctrlKey) && !parsed.cmdOrCtrl && !parsed.ctrl) {
    return { kind: "invalid", reason: "unsupported-key" };
  }

  const binding = serializeShortcutBinding(parsed);
  if (binding === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return { kind: "binding", binding };
}

/** event.key -> canonical key name (fallback path only): lowercase single chars, named keys verbatim. */
function normalizeEventKey(rawKey: string): string | null {
  if (rawKey.length === 1) {
    return /^[a-zA-Z0-9[\]=\-,./;'\\`]$/.test(rawKey) ? rawKey.toLowerCase() : null;
  }
  return rawKey in KEY_TO_CODE ? rawKey : null;
}

// ============================================================================
// Recording-state suppression
// ============================================================================

let shortcutRecordingActive = false;

/**
 * Set true while the settings page is recording a shortcut.
 * The recording listener and useAppKeyboard are both window-capture listeners, but recording
 * registers later (on record-button click) and same-phase listeners run in registration order —
 * the recorded combo would trigger the original command before recording handles it, so rebinding
 * never succeeds. useAppKeyboard short-circuits on this flag before dispatch; the menu channel
 * uses platform.setShortcutRecordingActive to tell main to detach menu accelerators temporarily
 * (macOS system menus eat keys before the renderer).
 */
export function setShortcutRecordingActive(active: boolean): void {
  shortcutRecordingActive = active;
}

export function isShortcutRecordingActive(): boolean {
  return shortcutRecordingActive;
}

// ============================================================================
// Effective keymap
// ============================================================================

export type EffectiveShortcutBindings = Readonly<Record<ShortcutCommandId, readonly string[]>>;

/**
 * Compute the effective keymap: command-table defaults + user overrides (whole-group replace).
 * An explicit empty array = user cleared to "unset" (empty effective set, no default fallback —
 * steal-binding leaves the stolen command in this state); if every entry is invalid, fall back to
 * defaults (hand-edited setting.json must not disable all shortcuts).
 */
export function resolveEffectiveShortcutBindings(
  overrides?: Record<string, readonly string[]>,
): EffectiveShortcutBindings {
  const effective: Record<ShortcutCommandId, readonly string[]> = {} as Record<
    ShortcutCommandId,
    readonly string[]
  >;
  for (const entry of SHORTCUT_COMMANDS) {
    const override = overrides?.[entry.id];
    if (override === undefined) {
      effective[entry.id] = entry.defaultBindings;
      continue;
    }
    const valid = override.filter((binding) => parseShortcutBinding(binding) !== null);
    if (override.length > 0 && valid.length === 0) {
      logger.warn("[shortcuts] All override bindings invalid; falling back to defaults", { commandId: entry.id, override });
      effective[entry.id] = entry.defaultBindings;
      continue;
    }
    if (valid.length !== override.length) {
      logger.warn("[shortcuts] Ignoring invalid override entry", { commandId: entry.id, override });
    }
    effective[entry.id] = valid;
  }
  return effective;
}
