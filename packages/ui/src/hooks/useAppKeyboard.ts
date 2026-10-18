import { useEffect, useRef } from "react";
import { SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutRecordingActive,
  matchesShortcutBinding,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";

/** Handler table for window-channel shortcuts: command id -> callback; null/missing means currently unavailable. */
type AppKeyboardHandlers = Partial<Record<ShortcutCommandId, (() => void) | null>>;

/**
 * Thin global keyboard dispatch: window keydown capture -> kernel matcher -> command handler.
 *
 * - All key knowledge lives in the shortcuts kernel (active map + matcher); this hook knows no specific keys;
 * - a null/missing handler skips preventDefault (unavailable features keep browser defaults, e.g. history navigation);
 * - capture-phase interception, so focus in normal page areas is not stolen by browser or desktop-shell defaults;
 * - the listener attaches once; handlers/active map flow through refs, so a rebound shortcut applies on the next keypress.
 */
export function useAppKeyboard(handlers: AppKeyboardHandlers) {
  const effective = useEffectiveShortcutBindings();
  const stateRef = useRef({ handlers, effective });
  stateRef.current = { handlers, effective };

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) {
        return;
      }
      // Recording short-circuit: the recording listener registers after this one (same phase, registration order); without
      // short-circuiting, the recorded combo triggers the old command first and rebinding never succeeds (see setShortcutRecordingActive).
      if (isShortcutRecordingActive()) {
        return;
      }

      const { handlers: currentHandlers, effective: currentEffective } = stateRef.current;
      // A bare Shift+printable binding (Shift+f) and typing a capital letter are the same physical event;
      // skip such bindings while focus is in an editable element (chat input/search/terminal) or the capital cannot be typed.
      const editableTarget = isEditableShortcutEventTarget(event.target);
      for (const entry of SHORTCUT_COMMANDS) {
        if (entry.channel !== "window") {
          continue;
        }
        // Composer-scoped commands are consumed by the input Lexical plugin; global dispatch stays unaware of them.
        if (entry.scope === "composer") {
          continue;
        }
        const handler = currentHandlers[entry.id];
        if (!handler) {
          continue;
        }
        const bindings = currentEffective[entry.id];
        if (!bindings || bindings.length === 0) {
          continue;
        }
        for (const binding of bindings) {
          if (editableTarget && isShiftOnlyPrintableBinding(binding)) {
            continue;
          }
          if (matchesShortcutBinding(event, binding)) {
            event.preventDefault();
            handler();
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, []);
}
