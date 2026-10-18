import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ShortcutCommandId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import { recordShortcutBinding, type EffectiveShortcutBindings } from "@/shortcuts/bindings.js";
import type { RecordingState } from "./ShortcutBindingRow.js";

interface UseShortcutRecordingOptions {
  recording: RecordingState | null;
  setRecording: Dispatch<SetStateAction<RecordingState | null>>;
  /** Effective binding table (Section already resolved overrides). */
  effective: EffectiveShortcutBindings;
  overrides: Record<string, readonly string[]> | undefined;
  isDesktop: boolean;
  /** Recording Backspace: restore default (Section's precheck). */
  clearBinding: (commandId: ShortcutCommandId) => void;
  appendBinding: (commandId: ShortcutCommandId, binding: string) => void;
  replaceBindingAt: (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => void;
}

/**
 * Recording capture: window keydown capture. Escape cancels; Backspace restores default;
 * the rest go to the kernel recorder. Persist per RecordingState.mode: add appends; replace writes
 * the bindingIndex entry (null = the unassigned placeholder row records the first, equivalent to append).
 * Physically-equivalent duplicates on one command are rejected in red at record time (add vs all entries, replace skipping the target).
 */
export function useShortcutRecording({
  recording,
  setRecording,
  effective,
  overrides,
  isDesktop,
  clearBinding,
  appendBinding,
  replaceBindingAt,
}: UseShortcutRecordingOptions): void {
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!recording) {
      return;
    }
    function handleRecordingKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      setRecording((current) => {
        if (!current) {
          return current;
        }
        if (event.key === "Escape") {
          return null;
        }
        if (event.key === "Backspace") {
          clearBinding(current.commandId);
          return null;
        }

        const result = recordShortcutBinding(event);
        if (result.kind === "pending") {
          // A lingering conflict/invalid hint reads as the recorder not listening; clear it the moment a modifier presses,
          // so conflict-then-retry looks alive (it always was listening).
          if (
            current.preview === null &&
            current.error === null &&
            current.conflictBinding === null
          ) {
            return current;
          }
          return { ...current, preview: null, error: null, conflictBinding: null };
        }
        if (result.kind === "invalid") {
          return {
            ...current,
            preview: null,
            conflictBinding: null,
            error: intl.formatMessage({
              id:
                result.reason === "no-modifier"
                  ? "settings.shortcuts.invalidNoModifier"
                  : "settings.shortcuts.invalidKey",
            }),
          };
        }

        // Physical-equivalent duplicate on one command: add compares all effective entries; replace skips the target.
        // One command holding one chord twice is meaningless; reject in red.
        const sameCommandBindings = effective[current.commandId] ?? [];
        const duplicate = sameCommandBindings.some((binding, index) =>
          current.mode === "replace" && index === current.bindingIndex
            ? false
            : isSamePhysicalBinding(binding, result.binding),
        );
        if (duplicate) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            conflictBinding: null,
            error: intl.formatMessage({ id: "settings.shortcuts.duplicateBinding" }),
          };
        }

        // Web menu-channel commands are not configurable yet their default key is consumed by the root fallback listener; reject takeover as reserved
        const conflict = checkShortcutBindingConflict(
          current.commandId,
          result.binding,
          overrides,
          {
            menuChannelReserved: !isDesktop,
          },
        );
        if (conflict) {
          return {
            ...current,
            preview: formatShortcutBindingLabel(result.binding),
            // System-reserved keys reject outright (no confirm); app-command conflicts name the holder and offer confirmed takeover.
            conflictBinding: conflict.kind === "occupied" ? result.binding : null,
            error:
              conflict.kind === "reserved"
                ? intl.formatMessage({ id: "settings.shortcuts.conflictReserved" })
                : intl.formatMessage(
                    { id: "settings.shortcuts.conflictOccupied" },
                    {
                      command:
                        conflict.ownerCommandId !== undefined
                          ? intl.formatMessage({
                              id: `settings.shortcuts.command.${conflict.ownerCommandId}`,
                            })
                          : "",
                    },
                  ),
          };
        }

        if (current.mode === "add" || current.bindingIndex === null) {
          appendBinding(current.commandId, result.binding);
        } else {
          replaceBindingAt(current.commandId, current.bindingIndex, result.binding);
        }
        return null;
      });
    }

    window.addEventListener("keydown", handleRecordingKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleRecordingKeydown, true);
    };
  }, [
    appendBinding,
    clearBinding,
    effective,
    intl,
    isDesktop,
    overrides,
    recording,
    replaceBindingAt,
    setRecording,
  ]);
}
