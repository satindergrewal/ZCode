import { useCallback, useEffect, useState } from "react";
import { recordShortcutBinding } from "@/shortcuts/bindings.js";

export interface ShortcutKeySearch {
  // Armed: waiting for the user's chord.
  armed: boolean;
  // Captured chord (null = key filter off). Keyboard-exclusivity suppression is aggregated by the page via armed.
  binding: string | null;
  // Toggle armed. The caller must cancel inline recording first (mutually exclusive; see ShortcutSettingsSection).
  toggle: () => void;
  // Leave armed (keep filtering by the captured chord).
  disarm: () => void;
  // Clear the captured chord (filter back to text only).
  clear: () => void;
}

/**
 // The settings page's search-by-chord state machine (VSCode-style):
 // Escape disarms; Backspace clears the chord; other events go through the kernel recorder
 // (platform-normalized); success disarms and filtering persists until cleared.
 // Bare letters and other impossible command keys (recorder invalid) are ignored silently, awaiting a valid chord.
 // Matching uses conflicts.isSamePhysicalBinding (physical equivalence, win Ctrl+m ===
 // CmdOrCtrl+m), the same table conflict detection sees.
 */
export function useShortcutKeySearch(): ShortcutKeySearch {
  const [armed, setArmed] = useState(false);
  const [binding, setBinding] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) {
      return;
    }
    function handleKeySearchKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setArmed(false);
        return;
      }
      if (event.key === "Backspace") {
        setBinding(null);
        return;
      }
      const result = recordShortcutBinding(event);
      if (result.kind !== "binding") {
        return;
      }
      setBinding(result.binding);
      setArmed(false);
    }

    window.addEventListener("keydown", handleKeySearchKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleKeySearchKeydown, true);
    };
  }, [armed]);

  const toggle = useCallback(() => setArmed((current) => !current), []);
  const disarm = useCallback(() => setArmed(false), []);
  const clear = useCallback(() => setBinding(null), []);

  return { armed, binding, toggle, disarm, clear };
}
