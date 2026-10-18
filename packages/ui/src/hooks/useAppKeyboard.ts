import { useEffect, useRef } from "react";
import { SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutRecordingActive,
  matchesShortcutBinding,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";

/** Window-channel shortcut handlers: command id -> callback; null/missing = unavailable. */
export type AppKeyboardHandlers = Partial<Record<ShortcutCommandId, (() => void) | null>>;

/**
 * Thin global keyboard dispatch: window capture -> kernel match -> command handler.
 *
 * - All key knowledge lives in the shortcuts kernel; this hook knows no keys.
 * - null/missing handlers skip preventDefault (browser defaults, e.g. history nav).
 * - Capture phase so page-focus keys are not eaten by browser/shell defaults.
 * - One listener; handlers/bindings via ref, so rebinding applies on the next key.
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
      // Recording listener registers later (same phase, order matters): without a short-
      // circuit the recorded combo fires the old command first and rebinding never lands.
      if (isShortcutRecordingActive()) {
        return;
      }

      const { handlers: currentHandlers, effective: currentEffective } = stateRef.current;
      // Shift+printable binds (Shift+f) and typing capitals are the same event;
      // skip them in editables or users cannot type that capital.
      const editableTarget = isEditableShortcutEventTarget(event.target);
      for (const entry of SHORTCUT_COMMANDS) {
        if (entry.channel !== "window") {
          continue;
        }
        // Composer-scoped commands are consumed by the input's Lexical plugin;
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
