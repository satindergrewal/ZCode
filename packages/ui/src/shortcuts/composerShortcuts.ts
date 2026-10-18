/**
 * Composer-scope shortcut resolution — standalone module; the only consumer is
 * LexicalChatInput's keyboard plugin. useAppKeyboard/menus/web fallback listeners know nothing
 * about composer commands. Depends only on the kernel matcher, not DOM/React; unit-testable alone.
 */
import type { ShortcutBindingEvent } from "./bindings.js";
import { matchesShortcutBinding } from "./bindings.js";

/** The composer-scope commands' slice of the effective keymap (only these two; avoids pulling the full-table types). */
interface ComposerEffectiveBindings {
  readonly composerSend: readonly string[];
  readonly composerInsertNewline: readonly string[];
}

/** Final action for Enter-family events inside the composer. */
type ComposerKeyAction = "send" | "newline";

/**
 * Resolve the composer action from the effective keymap (rebind layer, uniform open policy).
 *
 * Matches every effective binding of `composerInsertNewline` / `composerSend` (newline first:
 * a mis-send costs more than a mis-newline) — NOT restricted to the Enter family: send may be
 * bound to F9 or any key, same open policy as other commands. Hit returns the action; no match
 * returns null (callers fall through to the existing main path).
 *
 * Send-side runtime gating (submitDisabled / mobile viewport enterSubmits / empty input /
 * inverted-delivery yielding) is the caller's job; this answers only "what does the keymap say".
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
 * Once the user rebinds `composerSend` away (effective bindings no longer contain bare Enter,
 * including an explicit empty array = unset), bare Enter no longer means send — let Lexical
 * newline instead (expected post-rebind behavior for Ctrl+Enter users).
 */
export function shouldBareEnterFallThroughToNewline(effective: ComposerEffectiveBindings): boolean {
  return !effective.composerSend.includes("Enter");
}
