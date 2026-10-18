/**
 * Shortcut conflict policy — reserved-key blacklist, physical-equivalence normalization, occupancy
 * checks, and confirmed steal-binding.
 *
 * Split from bindings.ts (kernel vs conflict-policy layering; bindings.ts has a max-lines gate):
 * matching/recording/effective keymap stay in bindings.ts; this module only answers "may this
 * binding land".
 */
import { parseShortcutBinding, SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";
import { resolveEffectiveShortcutBindings } from "./bindings.js";

/**
 * Reserved-key blacklist: browser/editor native behaviors, refresh and devtools, the whole
 * function-key row, and component-fixed single keys. Comparison happens after normalization
 * (canonical keys, see checkShortcutBindingConflict); command-table defaults must not intersect it
 * (unit-tested, global scope only).
 * Note: of Escape/Enter/Tab/Space/Backspace, Enter is in the key-name whitelist (composer scope
 * needs it) and explicitly listed here to block the global scope; Escape/Tab/Space/Backspace are
 * not in the key-name whitelist.
 */
const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  // Editing-class native behaviors (primary-modifier combos)
  ...["c", "v", "x", "z", "a", "y", "s", "p", "l"].map((key) => `CmdOrCtrl+${key}`),
  "CmdOrCtrl+Shift+z",
  // Refresh and devtools
  "CmdOrCtrl+r",
  "CmdOrCtrl+Shift+r",
  "CmdOrCtrl+Shift+i",
  "CmdOrCtrl+Shift+j",
  "CmdOrCtrl+Shift+c",
  // The whole function-key row (any F1-F12 combo with modifiers)
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+Shift+F${index + 1}`),
  // Bare arrow keys (component-fixed interactions)
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  // Enter: after the key-name whitelist opened, the global scope must block it explicitly
  // (globalizing the dialog-confirm key would break every confirmation); composer is exempt.
  "Enter",
]);

/**
 * macOS system menu role:"minimize" fixed accelerator Cmd+M:
 * the system menu consumes keys before the renderer, so binding it is a dead binding; no scope
 * may occupy/steal it. mac only — on win/linux CmdOrCtrl+m is physically Ctrl+M (openModelMenu's
 * default) and goes through occupancy checks instead. After the toolbar three-key promotion this
 * is the only mac defense for CmdOrCtrl+m.
 */
const MACOS_MENU_RESERVED_BINDINGS: ReadonlySet<string> = new Set(["CmdOrCtrl+m"]);

/**
 * Physical-equivalence normalization for conflict detection: matching already treats platform-
 * equivalent combos as one physical key (win/linux CmdOrCtrl = explicit Ctrl, AltGr folding into
 * Alt); string-exact conflict checks would let the recorder's platform-normalized output (e.g.
 * "CmdOrCtrl+m" recorded on win) bypass occupancy checks against explicit-Ctrl defaults (toolbar
 * "Ctrl+m" etc.), silently shadowing without a prompt. Normalize per the kernel modifiersMatch
 * semantics into a stable comparison key:
 * - non-apple: primary = cmdOrCtrl | ctrl | altGr (one physical primary), alt = alt | altGr
 * - apple: primary = cmdOrCtrl (meta), secondaryCtrl = ctrl (distinct key), alt = alt | altGr
 */
function canonicalBindingKey(binding: string, isApple: boolean): string | null {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return null;
  }
  if (isApple) {
    // On apple, modifiersMatch's wantPrimaryOrCtrl also counts altGr as primary
    // (AltGr+m = Cmd+Alt+m = CmdOrCtrl+Alt+m); the canonical primary slot must fold it too.
    return `${parsed.cmdOrCtrl || parsed.altGr ? 1 : 0}${parsed.ctrl ? 1 : 0}${
      parsed.alt || parsed.altGr ? 1 : 0
    }${parsed.shift ? 1 : 0}:${parsed.key}`;
  }
  return `${parsed.cmdOrCtrl || parsed.ctrl || parsed.altGr ? 1 : 0}${
    parsed.alt || parsed.altGr ? 1 : 0
  }${parsed.shift ? 1 : 0}:${parsed.key}`;
}

/**
 * Do two binding strings denote the same physical combo (equal canonical keys)? The conflict
 * normalization, reused for search: settings' "search by combo" matches a win-recorded CmdOrCtrl+m
 * against explicit Ctrl+m as the same entry. Unparseable strings are unequal (same null
 * short-circuit as conflict detection).
 */
export function isSamePhysicalBinding(
  a: string,
  b: string,
  options?: { platformInfo?: KeyboardShortcutPlatformInfo },
): boolean {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const keyA = canonicalBindingKey(a, isApple);
  const keyB = canonicalBindingKey(b, isApple);
  return keyA !== null && keyA === keyB;
}

/** Canonical comparison keys of the reserved blacklist (built lazily per platform; canonicalization also catches hand-edited setting.json variants). */
let reservedCanonicalKeysCache: {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} | null = null;
function getReservedCanonicalKeys(): {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} {
  if (reservedCanonicalKeysCache === null) {
    const apple = new Set<string>();
    const nonApple = new Set<string>();
    for (const binding of RESERVED_BINDINGS) {
      const appleKey = canonicalBindingKey(binding, true);
      if (appleKey !== null) {
        apple.add(appleKey);
      }
      const nonAppleKey = canonicalBindingKey(binding, false);
      if (nonAppleKey !== null) {
        nonApple.add(nonAppleKey);
      }
    }
    reservedCanonicalKeysCache = { apple, nonApple };
  }
  return reservedCanonicalKeysCache;
}

interface ShortcutBindingConflict {
  kind: "reserved" | "occupied";
  /** Occupying command when occupied. */
  ownerCommandId?: ShortcutCommandId;
  binding: string;
}

/**
 * Conflict check (reject + highlight policy): would binding newBinding to commandId be rejected?
 * null means bindable. The command's own existing bindings never conflict (override = whole-group
 * replace). Scope isolation: occupancy compares only same-scope commands (composer's
 * CmdOrCtrl+Enter coexisting with global commands is fine); the reserved blacklist blocks only
 * global rebinds.
 * Physical-equivalence normalization: blacklist and occupancy comparisons run on canonical keys so
 * platform-equivalent combos (win/linux CmdOrCtrl = Ctrl) never escape.
 */
export function checkShortcutBindingConflict(
  commandId: ShortcutCommandId,
  newBinding: string,
  overrides?: Record<string, readonly string[]>,
  options?: {
    menuChannelReserved?: boolean;
    /** Defaults to the runtime navigator (tests pass it explicitly to pin platform semantics). */
    platformInfo?: KeyboardShortcutPlatformInfo;
  },
): ShortcutBindingConflict | null {
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalBindingKey(newBinding, isApple);
  // The macOS Cmd+M minimize defense is scope-independent: the system menu eats the key before
  // any renderer dispatch; binding it to a composer command is equally dead.
  if (isApple && MACOS_MENU_RESERVED_BINDINGS.has(newBinding)) {
    return { kind: "reserved", binding: newBinding };
  }
  if (commandScope === "global") {
    if (newKey !== null && getReservedCanonicalKeys()[isApple ? "apple" : "nonApple"].has(newKey)) {
      return { kind: "reserved", binding: newBinding };
    }
  }
  const effective = resolveEffectiveShortcutBindings(overrides);
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // Scope isolation: the same key in another scope is not a conflict.
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    for (const binding of effective[entry.id] ?? []) {
      const candidateKey = canonicalBindingKey(binding, isApple);
      if (newKey !== null && candidateKey === newKey) {
        // Web menu-channel commands are not configurable, but their default keys are still
        // consumed by the root fallback listener (useRootPlatformEffects always handles
        // Cmd/Ctrl+N,O) — reject as reserved, no steal entry, or both actions fire on one key.
        if (options?.menuChannelReserved && entry.channel === "menu") {
          return { kind: "reserved", binding: newBinding };
        }
        return { kind: "occupied", ownerCommandId: entry.id, binding: newBinding };
      }
    }
  }
  return null;
}

/**
 * Steal-binding after confirmation (an in-app command's occupancy may be rebound with consent):
 * bind newBinding to commandId with line-level semantics and remove it from the effective keymap
 * of every other command currently holding it — the stolen command's overrides become its
 * effective bindings minus newBinding, possibly an explicit empty array (= unset, no default
 * fallback). Physical-equivalence normalization: platform-equivalent entries (win Ctrl+m and
 * CmdOrCtrl+m) are cleared together.
 * Line-level semantics: stealing only changes conflict handling, never the user's chosen line
 * action — options.mode/bindingIndex mirrors the recording state: replace + index replaces that
 * entry (others kept); add or null index (unassigned records first) appends; absent (legacy
 * callers) replaces the whole group with the single key.
 */
export function buildShortcutOverridesAfterSteal(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
  options?: {
    platformInfo?: KeyboardShortcutPlatformInfo;
    /** Recording mode (from settings RecordingState): replace = per-line, add = append; absent = whole-group replace. */
    mode?: "replace" | "add";
    /** Target index for replace mode. */
    bindingIndex?: number | null;
  },
): Record<string, string[]> {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalBindingKey(newBinding, isApple);
  const effective = resolveEffectiveShortcutBindings(overrides);
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  const currentBindings = effective[commandId] ?? [];
  if (options?.mode === "replace" && options.bindingIndex != null) {
    const target = options.bindingIndex;
    next[commandId] = currentBindings.map((binding, index) =>
      index === target ? newBinding : binding,
    );
  } else if (options?.mode === "add" || options?.bindingIndex === null) {
    next[commandId] = [...currentBindings, newBinding];
  } else {
    next[commandId] = [newBinding];
  }
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // Scope isolation: stealing clears occupancy of same-scope commands only.
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    const remaining = (effective[entry.id] ?? []).filter((binding) => {
      const candidateKey = canonicalBindingKey(binding, isApple);
      return newKey === null || candidateKey !== newKey;
    });
    if (remaining.length !== (effective[entry.id] ?? []).length) {
      next[entry.id] = remaining;
    }
  }
  return next;
}

/**
 * "Add binding" (a command may hold several; displayed A / B): append newBinding after the
 * command's current effective bindings (defaults included). Override semantics are whole-group
 * replace, so appending must write the full defaults+overrides list into overrides or uncovered
 * defaults are lost. Physical-equivalent duplicates within one command are rejected earlier by the
 * caller (settings recording entry); not re-checked here.
 */
export function buildShortcutOverridesAfterAppend(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = [...(effective[commandId] ?? []), newBinding];
  return next;
}

/** Per-line replace: swap effective list entry bindingIndex for newBinding, write the group back to overrides. */
export function buildShortcutOverridesWithBindingAt(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  bindingIndex: number,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = (effective[commandId] ?? []).map((binding, index) =>
    index === bindingIndex ? newBinding : binding,
  );
  return next;
}
