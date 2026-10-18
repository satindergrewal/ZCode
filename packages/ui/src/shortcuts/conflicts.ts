/**
 * Shortcut conflict policy: reserved-key blacklist, physical-equivalence canonicalization, occupancy checks and confirm-to-steal.
 *
 * Split from bindings.ts (kernel vs conflict policy; bindings.ts also has a max-lines gate):
 * matching/recording/effective tables stay in bindings.ts; this module only answers can-this-binding-land.
 */
import { parseShortcutBinding, SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";
import { resolveEffectiveShortcutBindings } from "./bindings.js";

/**
 * Reserved-key blacklist: browser/editor natives, reload and devtools, whole function-key rows,
 * and single keys pinned by component interactions. Compared post-canonicalization (canonical keys, see checkShortcutBindingConflict);
 * command defaults must not intersect (unit-tested, global scope only).
 * Note: of Escape/Enter/Tab/Space/Backspace, Enter is in the name allowlist (composer needs it),
 * listed here to block global; Escape/Tab/Space/Backspace remain outside the name allowlist.
 */
export const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  // Editing-native behaviors (primary-modifier combos)
  ...["c", "v", "x", "z", "a", "y", "s", "p", "l"].map((key) => `CmdOrCtrl+${key}`),
  "CmdOrCtrl+Shift+z",
  // Reload and devtools
  "CmdOrCtrl+r",
  "CmdOrCtrl+Shift+r",
  "CmdOrCtrl+Shift+i",
  "CmdOrCtrl+Shift+j",
  "CmdOrCtrl+Shift+c",
  // Function-key rows (any F1-F12 combo with modifiers)
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+Shift+F${index + 1}`),
  // Arrow single keys (component-pinned interactions)
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  // Enter: once the name allowlist opened, global must block it explicitly
  // (a global confirm key kills every dialog confirm); composer is exempt.
  "Enter",
]);

/**
 * macOS system-menu role minimize's fixed accel Cmd+M (scene B, new):
 * the menu eats keys before the renderer, so binding it is a dead binding no scope may take or steal.
 * mac only -- on win/linux CmdOrCtrl+m physically equals Ctrl+M (openModelMenu default),
 * handled by occupancy checks, not this reservation. After the toolbar trio landed this is the only mac guard for CmdOrCtrl+m.
 */
const MACOS_MENU_RESERVED_BINDINGS: ReadonlySet<string> = new Set(["CmdOrCtrl+m"]);

/**
 * Physical-equivalence canonicalization for conflict checks (new): matching treats platform-equivalent
 * combos as one physical key (win/linux CmdOrCtrl equals explicit Ctrl; AltGr stacks the Alt bit). Pure string
 * equality would let the recorder's platform-normalized output (win Ctrl records as CmdOrCtrl+m) bypass occupancy
 * checks against explicit-Ctrl defaults (toolbar trio Ctrl+m and friends), silently shadowing without a prompt.
 * Canonicalization folds kernel modifiersMatch semantics into a stable comparison key:
 * - non-apple: primary = cmdOrCtrl|ctrl|altGr (one physical primary), alt = alt|altGr
 * - apple: primary = cmdOrCtrl (meta), secondaryCtrl = ctrl (distinct key), alt = alt|altGr
 */
function canonicalBindingKey(binding: string, isApple: boolean): string | null {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return null;
  }
  if (isApple) {
    // On apple, modifiersMatch's wantPrimaryOrCtrl counts altGr as primary too
    // (AltGr+m equals CmdOrCtrl+Alt+m); the canonical primary bit must fold in as well.
    return `${parsed.cmdOrCtrl || parsed.altGr ? 1 : 0}${parsed.ctrl ? 1 : 0}${
      parsed.alt || parsed.altGr ? 1 : 0
    }${parsed.shift ? 1 : 0}:${parsed.key}`;
  }
  return `${parsed.cmdOrCtrl || parsed.ctrl || parsed.altGr ? 1 : 0}${
    parsed.alt || parsed.altGr ? 1 : 0
  }${parsed.shift ? 1 : 0}:${parsed.key}`;
}

/**
 * Do two binding strings name the same physical combo (equal canonical keys)? The conflict canonicalization
 * doubles as search: by-combo search in settings matches recorded CmdOrCtrl+m with explicit Ctrl+m on win.
 * Any unparseable string means not-equal (same null-short-circuit as conflict detection).
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

/** Canonical comparison keys for the reserved blacklist (built per platform, lazily; canonicalizing also catches hand-edited setting.json variants). */
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

export interface ShortcutBindingConflict {
  kind: "reserved" | "occupied";
  /** Occupying command when occupied. */
  ownerCommandId?: ShortcutCommandId;
  binding: string;
}

/**
 * Conflict detection (reject + red): would binding newBinding to commandId be rejected?
 * null means bindable. The command's own existing bindings never conflict (override replaces the whole set).
 * Scope isolation: occupancy compares same-scope commands only (composer CmdOrCtrl+Enter
 * coexists with global commands); the reserved blacklist blocks global rebinds only.
 * Physical canonicalization (new): blacklist and occupancy compare canonical keys, so platform-equivalent
 * combos (win/linux CmdOrCtrl equals Ctrl) are never missed.
 */
export function checkShortcutBindingConflict(
  commandId: ShortcutCommandId,
  newBinding: string,
  overrides?: Record<string, readonly string[]>,
  options?: {
    menuChannelReserved?: boolean;
    /** Defaults to runtime navigator (tests pass it explicitly to pin platform semantics). */
    platformInfo?: KeyboardShortcutPlatformInfo;
  },
): ShortcutBindingConflict | null {
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalBindingKey(newBinding, isApple);
  // The macOS Cmd+M minimize guard is scope-independent: the system menu eats keys before any renderer,
  // so a composer binding is equally dead.
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
    // Scope isolation: same key across scopes is not a conflict
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    for (const binding of effective[entry.id] ?? []) {
      const candidateKey = canonicalBindingKey(binding, isApple);
      if (newKey !== null && candidateKey === newKey) {
        // Web menu-channel commands are not configurable, but root-level fallback listeners
        // (useRootPlatformEffects always handles Cmd/Ctrl+N, O) still consume their defaults:
        // reject as reserved, no steal entry, or both actions fire on one key.
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
 * Post-confirm steal (app commands may rebind after confirmation):
 * bind newBinding to commandId per row semantics and drop it from every other command's effective set --
 * the stolen command gets overrides = its effective bindings minus newBinding, possibly an explicit empty array (unset, no default fallback).
 * Physical canonicalization (new): platform-equivalent entries (win Ctrl+m and CmdOrCtrl+m) are cleared together.
 * Row semantics: stealing only changes how the conflict is resolved, never the user's chosen row action --
 * options.mode/bindingIndex mirror the recording state: replace + index replaces that row (others kept);
 * add, or index null (unassigned records to first) appends; legacy callers replace the whole set with the single key.
 */
export function buildShortcutOverridesAfterSteal(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
  options?: {
    platformInfo?: KeyboardShortcutPlatformInfo;
    /** Recording mode (from the settings RecordingState): replace = row replace, add = append; default = whole-set replace. */
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
    // Scope isolation: stealing clears same-scope occupancy only
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
 * Add binding (a command may carry several; shown A / B): append newBinding after the command's
 * current effective set (defaults included). Since override replaces the whole set, appending must
 * write defaults plus existing overrides into overrides, or uncovered defaults vanish.
 * Physical-equivalent duplicates within a command are rejected by the caller (settings recording); none here.
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

/**
 * Row-model ops all write the effective list back into overrides; three builders pair with it:
 * AfterAppend (append), WithoutBindingAt (drop index; empty means explicit unset) and
 * WithBindingAt (replace index). Same-command equivalents are rejected by the settings recorder first.
 */

/** Row delete: drop effective index bindingIndex, write the whole set to overrides (spec 8). */
export function buildShortcutOverridesWithoutBindingAt(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  bindingIndex: number,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = (effective[commandId] ?? []).filter((_, index) => index !== bindingIndex);
  return next;
}

/** Row replace: swap effective index bindingIndex for newBinding, write the whole set to overrides (spec 8). */
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
