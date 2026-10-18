/**
 * Shortcut commands and binding serialization -- the repo-wide single source of shortcut data.
 *
 * Design constraints:
 * - pure data + pure functions only, no DOM/Electron deps; shared by renderer/main/services;
 * - one binding-string form serves setting.json persistence, renderer matching, and Electron menu accelerators alike;
 * - key knowledge converges here; consumers (useAppKeyboard, settings, menus) never parse keys themselves.
 */

/** Dispatch channel of a shortcut command: window = renderer key dispatch (all platforms); menu = desktop app-menu accelerator. */
export type ShortcutChannel = "window" | "menu";

/** Configurable command ids, one-to-one with SHORTCUT_COMMANDS. */
export type ShortcutCommandId =
  | "toggleInterfaceMode"
  | "openOnboarding"
  | "openCommandCenter"
  | "openSettings"
  | "findInTask"
  | "toggleSidebar"
  | "switchTheme"
  | "toggleTerminal"
  | "toggleSidePane"
  | "previousConversation"
  | "nextConversation"
  | "navigateBack"
  | "navigateForward"
  | "openModelMenu"
  | "cycleSessionMode"
  | "cycleThoughtLevel"
  | "newTask"
  | "openWorkspace"
  | "closeActiveContext"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "composerSend"
  | "composerInsertNewline";

/**
 * Command scope: global = global dispatch (useAppKeyboard / menu accelerator);
 * composer = consumed by the Lexical keymap plugin while the composer focuses, invisible to other dispatchers.
 * Enter-family keys are therefore safe to table--blast radius confined to the composer.
 */
export type ShortcutScope = "global" | "composer";

export interface ShortcutCommandEntry {
  readonly id: ShortcutCommandId;
  readonly channel: ShortcutChannel;
  /// Scope; default global.
  readonly scope?: ShortcutScope;
  /// Default bindings, canonical serialized form; several = dual defaults (replaced whole on override).
  readonly defaultBindings: readonly string[];
}

/**
 * The command table: the single source of truth for shortcut commands.
 * Note: navigateBack/Forward are history back/forward; previousConversation/nextConversation
 * are prev/next task (an early prototype mixed them; this table rules).
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommandEntry[] = [
  {
    id: "openCommandCenter",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"],
  },
  // Open settings: mac Cmd+, / win-linux Ctrl+, (platform convention, cf. macOS Settings..., VSCode)
  { id: "openSettings", channel: "window", defaultBindings: ["CmdOrCtrl+,"] },
  { id: "findInTask", channel: "window", defaultBindings: ["CmdOrCtrl+f"] },
  { id: "toggleSidebar", channel: "window", defaultBindings: ["CmdOrCtrl+b"] },
  { id: "switchTheme", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+l"] },
  { id: "toggleTerminal", channel: "window", defaultBindings: ["CmdOrCtrl+j"] },
  { id: "toggleSidePane", channel: "window", defaultBindings: ["CmdOrCtrl+Alt+b"] },
  { id: "previousConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+["] },
  { id: "nextConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+]"] },
  { id: "navigateBack", channel: "window", defaultBindings: ["CmdOrCtrl+["] },
  { id: "navigateForward", channel: "window", defaultBindings: ["CmdOrCtrl+]"] },
  // Composer toolbar actions (promoted fixed hotkeys): explicit Ctrl modifier (Ctrl on mac too,
  // matching legacy matchesCtrlShortcut), consumed by the toolbar's window capture per the effective table.
  { id: "openModelMenu", channel: "window", defaultBindings: ["Ctrl+m"] },
  { id: "cycleSessionMode", channel: "window", defaultBindings: ["Ctrl+Shift+m"] },
  { id: "cycleThoughtLevel", channel: "window", defaultBindings: ["Ctrl+t"] },
  { id: "newTask", channel: "menu", defaultBindings: ["CmdOrCtrl+n"] },
  { id: "openWorkspace", channel: "menu", defaultBindings: ["CmdOrCtrl+o"] },
  { id: "closeActiveContext", channel: "menu", defaultBindings: ["CmdOrCtrl+w"] },
  { id: "zoomIn", channel: "menu", defaultBindings: ["CmdOrCtrl+="] },
  { id: "zoomOut", channel: "menu", defaultBindings: ["CmdOrCtrl+-"] },
  { id: "resetZoom", channel: "menu", defaultBindings: ["CmdOrCtrl+0"] },
  // composer scope: consumed by the input's Lexical plugin, never useAppKeyboard/menus.
  // channel is a type placeholder (renderer behavior); dispatchers recognize by scope.
  { id: "composerSend", channel: "window", scope: "composer", defaultBindings: ["Enter"] },
  {
    id: "composerInsertNewline",
    channel: "window",
    scope: "composer",
    defaultBindings: ["Shift+Enter"],
  },
  { id: "toggleInterfaceMode", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+u"] },
  { id: "openOnboarding", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+o"] },
];

/** Default bindings by command id; unknown ids return [] (effective-table resolve ignores unknowns wholly). */
export function getDefaultShortcutBindings(id: string): readonly string[] {
  return SHORTCUT_COMMANDS.find((entry) => entry.id === id)?.defaultBindings ?? [];
}

// ============================================================================
// Binding serialization format (an Electron-accelerator compatible subset)
// ============================================================================

/** Parsed binding: four modifier switches + normalized key. */
export interface ParsedShortcutBinding {
  cmdOrCtrl: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  altGr: boolean;
  /// Normalized key: lowercase letter / digit / symbol (= - [ ] , . / ; ' ` \) / named (F1..F12, ArrowUp...).
  key: string;
}

/** Fixed modifier order at serialization. */
const MODIFIER_ORDER = [
  ["CmdOrCtrl", "cmdOrCtrl"],
  ["Ctrl", "ctrl"],
  ["Alt", "alt"],
  ["Shift", "shift"],
  ["AltGr", "altGr"],
] as const satisfies ReadonlyArray<readonly [string, keyof ParsedShortcutBinding]>;

/** Menu-compat alias normalization: Plus/Equal -> "=", Minus -> "-". */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  Plus: "=",
  Equal: "=",
  Minus: "-",
};

/** Single-char keys: lowercase letters, digits, symbols. Uppercase illegal (record/serialize lowercased). */
const SINGLE_CHAR_KEY = /^[a-z0-9[\]=\-,./;'\\`]$/;

/** Named-key allowlist (case-sensitive). Enter serves composer-scope commands. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "Insert",
  "Enter",
]);

/** Normalize a key name: canonical name, or null when illegal. */
export function normalizeShortcutKey(rawKey: string): string | null {
  const aliased = KEY_ALIASES[rawKey] ?? rawKey;
  if (SINGLE_CHAR_KEY.test(aliased)) {
    return aliased;
  }
  return NAMED_KEYS.has(aliased) ? aliased : null;
}

/**
 * Parse a binding. Lenient: modifier order-free ("Shift+CmdOrCtrl+p" parses);
 * strict: key must be canonical (no uppercase, bare +, unknown named keys), no duplicate modifiers.
 */
export function parseShortcutBinding(binding: string): ParsedShortcutBinding | null {
  const tokens = binding.split("+");
  // The last token must be a key; "+" alone is illegal (use = or alias Plus)--an empty split token fails.
  const keyToken = tokens[tokens.length - 1];
  if (keyToken === undefined || keyToken === "") {
    return null;
  }

  const parsed: ParsedShortcutBinding = {
    cmdOrCtrl: false,
    ctrl: false,
    alt: false,
    shift: false,
    altGr: false,
    key: "",
  };

  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_ORDER.find(([name]) => name === token);
    if (!modifier || parsed[modifier[1]]) {
      // Unknown modifiers (incl. Meta/Command etc.) and duplicates are illegal.
      return null;
    }
    parsed[modifier[1]] = true;
  }

  const key = normalizeShortcutKey(keyToken);
  if (key === null) {
    return null;
  }
  parsed.key = key;
  return parsed;
}

/** Serialize canonically (fixed modifier order + canonical key); null when any part is illegal. */
export function serializeShortcutBinding(parsed: ParsedShortcutBinding): string | null {
  const key = normalizeShortcutKey(parsed.key);
  if (key === null) {
    return null;
  }

  const parts: string[] = [];
  for (const [name, field] of MODIFIER_ORDER) {
    if (parsed[field]) {
      parts.push(name);
    }
  }
  parts.push(key);
  return parts.join("+");
}

/** Is this binding canonical (parse->serialize round-trips)? */
export function isValidShortcutBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  return parsed !== null && serializeShortcutBinding(parsed) === binding;
}
