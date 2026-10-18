/**
 * Shortcut execution kernel: the single implementation of matching, recording, effective tables and conflict detection.
 *
 * - Key knowledge (parsing, platform modifier semantics, reserved keys) lives only here and shared/shortcutCommands.ts;
 * - pure functions; DOM events enter as structured args so combo edges are unit-testable;
 * - IME composition (isComposing / Process / Dead / keyCode 229) and long-press repeats never match or record.
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

/** Keyboard-event subset for matching/recording (constructible in tests). */
export interface ShortcutBindingEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** Legacy event model compat; Chromium reports keyCode 229 during IME composition. */
  keyCode?: number;
}

// ============================================================================
// Noise filtering (IME / long press)
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
export function isShortcutEventNoise(event: ShortcutBindingEvent): boolean {
  return event.repeat === true || isImeEvent(event);
}

// ============================================================================
// event.code to canonical name map (layout-independent source of truth)
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
  // Enter is recordable/matchable for the composer scope; NumpadEnter stays unmapped (undefined behavior kept)
  Enter: "Enter",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
  Insert: "Insert",
};

/** Canonical name to expected event.code (extended keyboardShortcuts.getExpectedShortcutCode). */
const KEY_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CODE_TO_KEY).map(([code, key]) => [key, code]),
);

// ============================================================================
// Generic matcher
// ============================================================================

/**
 * Generic match: does a keyboard event hit the binding (canonical serialized string)?
 *
 * Modifiers match exactly: the pressed set must equal the declared set; extras
 * (Cmd+Ctrl+K hitting CmdOrCtrl+K) do not count.
 * - CmdOrCtrl: mac = meta without ctrl; win/linux = ctrl without meta (platform split per keyboardShortcuts.ts);
 * - Ctrl: explicit; on win/linux synonymous with CmdOrCtrl (recording only emits CmdOrCtrl there);
 * - AltGr: physical AltGr surfaces as ctrl+alt on win/linux.
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

  // AltGr and Ctrl+Alt are physically indistinguishable (existing win/linux Ctrl+Alt+B bindings press both),
  // so AltGr bindings match the same physical combo as cmdOrCtrl/ctrl+Alt; no exclusivity rule.
  const wantPrimaryOrCtrl = parsed.altGr || parsed.cmdOrCtrl || (!isApple && parsed.ctrl);
  const wantCtrl = !parsed.altGr && !parsed.cmdOrCtrl && parsed.ctrl && isApple;
  const wantAlt = parsed.altGr || parsed.alt;

  // Bare-key bindings (Enter/F5/arrows, no primary modifier) require modifiers up,
  // or Cmd+Enter matches bare Enter -- latent while every command has a modifier, fatal once Enter joins.
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
    // macOS explicit Ctrl (system Emacs reserve; effective only when user-bound).
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
 * Shift+printable single-char bindings (Shift+f and friends).
 * They are the same physical event as typing the capital; over editable targets the
 * match must pass through, or preventDefault eats the capital and fires the command.
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
 * Is the shortcut event target editable (input/textarea/select or contenteditable)?
 * Pairs with isShiftOnlyPrintableBinding: skip Shift-only printable bindings inside editable targets.
 * Always false without a DOM (node tests).
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

/** Key match: prefer lowercase event.key, fall back to event.code (macOS Option rewrites, non-US layouts). */
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

export type ShortcutRecordResult =
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
 * - pending: bare modifier or IME noise without a resolvable code -- keep waiting for the full combo;
 * - binding: legal combo (platform-normalized primary: mac Cmd, win/linux Ctrl to CmdOrCtrl; mac explicit Ctrl stays Ctrl);
 * - invalid: modifierless plain keys (except F/arrows) or unsupported keys.
 *
 * The name prefers event.code reverse lookup, so Shift+7 records 7 on any layout, not the shifted glyph;
 * event.key is fallback only. IME events (isComposing/Process/229) have untrustworthy keys but
 * trustworthy codes -- recording is an explicit post-click intent, and with an IME on, a focused
 * editable turns Shift+letter into composition; record by code anyway (matching filters as usual,
 * see isShortcutEventNoise). Escape/Backspace recording semantics (cancel/clear) live in the settings UI.
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

/** Recording tail: modifier validation + platform normalization + serialization (name already extracted). */
function buildRecordedBinding(
  event: ShortcutBindingEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  // Named multi-char keys (F keys, arrows) may be bare; character keys need a modifier.
  const namedKey = key.length > 1;
  if (!hasModifier && !namedKey) {
    return { kind: "invalid", reason: "no-modifier" };
  }

  const parsed: ParsedShortcutBinding = {
    // AltGr and Ctrl+Alt are physically identical; recording always emits CmdOrCtrl+Alt (users think Ctrl+Alt).
    cmdOrCtrl: isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey,
    ctrl: isApple ? event.ctrlKey && !event.metaKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    altGr: false,
    key,
  };

  // mac Cmd+Ctrl combos and win/linux bare-Meta (Win key) combos both normalize
  // cmdOrCtrl/ctrl to false while hasModifier (raw event) already passed; serialization would
  // emit a bare key (k) -- unreserved, unchecked, and every bare press app-wide would
  // fire the command and eat input. Validate the primary modifier survived normalization.
  if ((event.metaKey || event.ctrlKey) && !parsed.cmdOrCtrl && !parsed.ctrl) {
    return { kind: "invalid", reason: "unsupported-key" };
  }

  const binding = serializeShortcutBinding(parsed);
  if (binding === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return { kind: "binding", binding };
}

/** event.key to canonical name (fallback path): lowercase single chars, named keys verbatim. */
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
 * Set while the settings page records shortcuts.
 * The recording listener and useAppKeyboard are both window-capture, but registered later
  // (on record-click); same phase runs first-registered-first, so the recorded combo would
  // fire the old command before recording; rebinding would never succeed.
 * useAppKeyboard short-circuits on this flag; the menu channel tells main via platform.setShortcutRecordingActive
 */
export function setShortcutRecordingActive(active: boolean): void {
  shortcutRecordingActive = active;
}

export function isShortcutRecordingActive(): boolean {
  return shortcutRecordingActive;
}

// ============================================================================
// Effective tables
// ============================================================================

export type EffectiveShortcutBindings = Readonly<Record<ShortcutCommandId, readonly string[]>>;

/**
 * Effective table = command defaults + user override (whole-set replace).
 * Explicit empty array = user cleared to unset (empty effective table, no default fallback -- stealing leaves this);
 * all-invalid entries fall back to defaults (a hand-broken setting.json must not kill shortcuts wholesale).
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
      logger.warn("[shortcuts] All override bindings invalid; falling back to defaults", {
        commandId: entry.id,
        override,
      });
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
