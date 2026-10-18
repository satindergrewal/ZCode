/**
 * Composer-scope shortcut resolution; sole consumer is the
 * LexicalChatInput keymap plugin. useAppKeyboard / menus / the web fallback are
 * unaware of composer commands. Kernel matcher only; no DOM/React, unit-testable standalone.
 */
import type { ShortcutBindingEvent } from "./bindings.js";
import { matchesShortcutBinding } from "./bindings.js";

/** The composer slice of the effective table (two entries; avoids the full-table type dependency). */
export interface ComposerEffectiveBindings {
  readonly composerSend: readonly string[];
  readonly composerInsertNewline: readonly string[];
}

/** Final composer action for Enter-family events. */
export type ComposerKeyAction = "send" | "newline";

/**
 * Resolve the composer action via the effective table (rebind layer, open policy).
 *
 * Match every effective binding of composerInsertNewline / composerSend (newline first:
 * a mis-send costs more than a mis-edit) -- not Enter-limited: send may be bound to F9 or anything,
 * same open policy as other commands. A hit returns the action; all-miss returns null (legacy main path runs).
 *
 * Send-side gates (submitDisabled, mobile enterSubmits, empty input,
 * inverted-delivery yield) belong to the caller; this only answers what the keymap says.
 */
export function resolveComposerKeyAction(
  event: Pick<ShortcutBindingEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  effective: ComposerEffectiveBindings,
  platformInfo?: { platform?: string; userAgent?: string },
): ComposerKeyAction | null {
  for (const binding of effective.composerInsertNewline ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "newline";
    }
  }
  for (const binding of effective.composerSend ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "send";
    }
  }
  return null;
}

/**
 * Should bare Enter fall back to newline (main-path precheck)?
 * Once composerSend is rebound away (bare Enter no longer effective, explicit empty array included),
 * bare Enter no longer means send: let Lexical newline -- what Ctrl+Enter party members expect.
 */
export function shouldBareEnterFallThroughToNewline(effective: ComposerEffectiveBindings): boolean {
  return !effective.composerSend.includes("Enter");
}
