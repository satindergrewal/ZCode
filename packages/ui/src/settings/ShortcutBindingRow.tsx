import { Keyboard, Pencil, Trash2 } from "lucide-react";
import type { ShortcutCommandEntry, ShortcutCommandId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Kbd, KbdGroup } from "@/components/ui/kbd.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabelParts } from "@/shortcuts/label.js";

export interface RecordingState {
  commandId: ShortcutCommandId;
  // Recording mode: replace = replace one binding (bindingIndex into existing, null = unassigned records first); add = append.
  mode: "replace" | "add";
  // Target index in replace mode; null in add mode.
  bindingIndex: number | null;
  // Live preview label while recording; null until a full chord.
  preview: string | null;
  // Conflict/invalid hint (post-i18n), shown in red.
  error: string | null;
  // Pending binding when occupied by another app command; confirmed takeover via bind-anyway (system-reserved keys get no confirm).
  conflictBinding: string | null;
}

interface ShortcutBindingRowProps {
  entry: ShortcutCommandEntry;
  // Localized command name (formatted by the parent).
  commandLabel: string;
  bindings: readonly string[];
  // Whether a user override exists (true tints keycaps brand-color as customized).
  isOverridden: boolean;
  isRecording: boolean;
  recording: RecordingState | null;
  // Web menu-channel command: recording entry disabled (default key consumed by the root fallback listener).
  menuChannelUnavailable: boolean;
  // Replace one binding (index into the effective list; null = unassigned records first).
  onRecord: (bindingIndex: number | null) => void;
  onSteal: (binding: string) => void;
  // Clear all bindings = unassigned (explicit empty array, no default fallback).
  onClearAll: () => void;
}

/**
 // The shortcuts page's command row: the left column holds the name centered across all bindings, the right column
 // lists them, one per row: per-key keycaps plus a pencil (click to re-record that binding); recording embeds at the
 // binding's position. No add/delete yet (replace only); the action column is the clear-all trash.
 */
export function ShortcutBindingRow({
  entry,
  commandLabel,
  bindings,
  isOverridden,
  isRecording,
  recording,
  menuChannelUnavailable,
  onRecord,
  onSteal,
  onClearAll,
}: ShortcutBindingRowProps) {
  const { intl } = useZCodeIntl();
  const conflictBinding = isRecording ? recording?.conflictBinding : null;

  // Inline recording block at the replaced/appended slot (the preview kbd takes focus)
  function renderRecorder() {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <Keyboard className="size-4 text-foreground-subtle" />
          <kbd
            ref={(el) => {
              // Recording grabs focus at start: pull it out of editable elements (e.g. the search box above),
              // else IMEs swallow Shift+letter into composition and the recorder gets only
              // isComposing/229 noise, reading as cannot-recognize-Shift-chords.
              el?.focus();
            }}
            tabIndex={-1}
            className="w-fit rounded-md bg-surface px-2 py-1 font-mono text-ui-sm outline-none"
          >
            {recording?.preview ?? intl.formatMessage({ id: "settings.shortcuts.recording" })}
          </kbd>
        </span>
        {recording?.error ? (
          <span
            className="text-ui-sm text-destructive"
            data-testid={`settings-shortcut-error-${entry.id}`}
          >
            {recording.error}
          </span>
        ) : (
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.shortcuts.recordingHint" })}
          </span>
        )}
        {conflictBinding ? (
          <Button
            variant="outline"
            size="xs"
            className="w-fit"
            data-testid={`settings-shortcut-steal-${entry.id}`}
            onClick={() => onSteal(conflictBinding)}
          >
            {intl.formatMessage({ id: "settings.shortcuts.stealConfirm" })}
          </Button>
        ) : null}
      </span>
    );
  }

  /**
   // One binding row: per-key keycaps (shadcn Kbd style, h-5/min-w-5 centered, symbols and letters sized alike) plus
   // a pencil (click keycap or pencil to replace). The keycap overrides text color only (custom = brand), never bg:
   // bg-inherit via cn's tailwind-merge would override Kbd's bg-muted with a transparent ancestor chain,
   // and the chip's surface vanishes.
   */
  function renderBinding(binding: string, index: number) {
    return (
      <span key={binding} className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={menuChannelUnavailable}
          className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-bind-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <KbdGroup>
            {formatShortcutBindingLabelParts(binding).map((part, partIndex) => (
              <Kbd key={`${part}-${partIndex}`} className={isOverridden ? "text-brand" : undefined}>
                {part}
              </Kbd>
            ))}
          </KbdGroup>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={menuChannelUnavailable}
          aria-label={intl.formatMessage(
            { id: "settings.shortcuts.rebindAria" },
            { command: commandLabel },
          )}
          data-testid={`settings-shortcut-edit-${entry.id}-${index}`}
          onClick={() => onRecord(index)}
        >
          <Pencil className="size-3.5" />
        </Button>
      </span>
    );
  }

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px] items-center border-t border-border px-4 py-3 text-ui-base"
      data-testid={`settings-shortcut-row-${entry.id}`}
    >
      <span className="flex min-w-0 items-center">
        <span className="truncate">{commandLabel}</span>
      </span>
      <span className="flex min-w-0 flex-col items-start gap-1.5">
        {bindings.map((binding, index) =>
          isRecording && recording?.mode === "replace" && recording.bindingIndex === index
            ? renderRecorder()
            : renderBinding(binding, index),
        )}
        {/* Unassigned commands record the first slot: with no bindings the recording state fills the keycap cell */}
        {isRecording && recording?.mode === "replace" && recording?.bindingIndex === null
          ? renderRecorder()
          : null}
        {bindings.length === 0 && !isRecording ? (
          <button
            type="button"
            disabled={menuChannelUnavailable}
            className="w-fit rounded-lg px-0 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={intl.formatMessage(
              { id: "settings.shortcuts.rebindAria" },
              { command: commandLabel },
            )}
            data-testid={`settings-shortcut-bind-${entry.id}-unassigned`}
            onClick={() => onRecord(null)}
          >
            <Kbd>{intl.formatMessage({ id: "settings.shortcuts.notSet" })}</Kbd>
          </button>
        ) : null}
      </span>
      {/* Scope in its own column: global = everywhere; composer = chat input only */}
      <span
        className="text-ui-sm text-foreground-subtle"
        data-testid={`settings-shortcut-scope-${entry.id}`}
      >
        {entry.scope === "composer"
          ? intl.formatMessage({ id: "settings.shortcuts.scopeComposer" })
          : intl.formatMessage({ id: "settings.shortcuts.scopeGlobal" })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage(
          { id: "settings.shortcuts.clearAria" },
          { command: commandLabel },
        )}
        // Web menu-channel commands disable recording too: the default key is consumed by the root fallback listener,
        // so clearing to unassigned would not really disable it, a split shows-unassigned-yet-fires state.
        disabled={menuChannelUnavailable || bindings.length === 0}
        onClick={onClearAll}
        data-testid={`settings-shortcut-clear-${entry.id}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
