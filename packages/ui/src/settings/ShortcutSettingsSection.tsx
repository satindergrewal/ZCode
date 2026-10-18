import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  type ShortcutCommandId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildShortcutOverridesAfterAppend,
  buildShortcutOverridesAfterSteal,
  buildShortcutOverridesWithBindingAt,
  checkShortcutBindingConflict,
  isSamePhysicalBinding,
} from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import {
  resolveEffectiveShortcutBindings,
  setShortcutRecordingActive,
} from "@/shortcuts/bindings.js";
import { ShortcutBindingRow, type RecordingState } from "./ShortcutBindingRow.js";
import { ShortcutSearchBar } from "./ShortcutSearchBar.js";
import { useShortcutKeySearch } from "./useShortcutKeySearch.js";
import { useShortcutRecording } from "./useShortcutRecording.js";

/**
 * Shortcuts section: read-only command table + keyboard recording + conflict handling.
 * Reads/writes only shortcutBindings overrides; matching/recording/conflict/takeover semantics live in the shortcuts kernel.
 * System-reserved keys reject; app-command conflicts name the holder and allow confirmed takeover.
 * Multi-binding rows: one command per row, chords stacked in the key column; each replaceable/deletable,
 * command-level + appends; physical-equivalent duplicates rejected at record time.
 */
export function ShortcutSettingsSection({ isDesktop = false }: { isDesktop?: boolean }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const keySearch = useShortcutKeySearch();
  const savingRef = useRef(false);

  const overrides = settings?.shortcutBindings;
  const effective = useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
  const commandLabel = useCallback(
    (commandId: ShortcutCommandId) =>
      intl.formatMessage({ id: `settings.shortcuts.command.${commandId}` }),
    [intl],
  );

  const visibleCommands = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    // Local copy: TS cannot keep keySearch.binding's narrowing inside the some closure.
    const keyBinding = keySearch.binding;
    return SHORTCUT_COMMANDS.filter((entry) => {
      // These keep registration and conflict detection but stay out of the visible list.
      if (entry.id === "openOnboarding" || entry.id === "toggleInterfaceMode") return false;
      const matchesText =
        !keyword ||
        entry.id.toLowerCase().includes(keyword) ||
        commandLabel(entry.id).toLowerCase().includes(keyword);
      // Chord filtering uses conflict detection's physical-equivalence (win Ctrl+m equals CmdOrCtrl+m),
      // the same table the who-owns-this-chord conflict hint reads.
      const matchesKey =
        keyBinding === null ||
        (effective[entry.id] ?? []).some((binding) => isSamePhysicalBinding(binding, keyBinding));
      return matchesText && matchesKey;
    });
  }, [commandLabel, effective, keySearch.binding, query]);

  const persistBindings = useCallback(
    async (next: Record<string, string[]>) => {
      if (savingRef.current) {
        return;
      }
      savingRef.current = true;
      try {
        await update({ shortcutBindings: next });
      } catch (error) {
        logger.error("[shortcuts] failed to save shortcut binding", { error: String(error) });
      } finally {
        savingRef.current = false;
      }
    },
    [update],
  );

  /** Append one (the placeholder row's first record routes here too: with an empty effective list it equals writing the first). */
  const appendBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      void persistBindings(buildShortcutOverridesAfterAppend(overrides, commandId, binding));
    },
    [overrides, persistBindings],
  );

  /** Replace effective-list entry bindingIndex (whole-group replace semantics; the full list must be written). */
  const replaceBindingAt = useCallback(
    (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => {
      void persistBindings(
        buildShortcutOverridesWithBindingAt(overrides, commandId, bindingIndex, binding),
      );
    },
    [overrides, persistBindings],
  );

  /**
   * Post-confirm takeover: write the new chord per the record-time row semantics (replace the indexed entry / unassigned
   * records first = append) and remove the conflicting chord from the holder. Takeover changes only conflict
   * handling, never the user's chosen row action (multi-binding takeovers must not silently drop siblings).
   */
  const stealBinding = useCallback(
    (commandId: ShortcutCommandId, binding: string) => {
      const next = buildShortcutOverridesAfterSteal(overrides, commandId, binding, {
        mode: recording?.mode,
        bindingIndex: recording?.bindingIndex,
      });
      void persistBindings(next);
    },
    [overrides, persistBindings, recording],
  );

  /* Trash = clear = unassigned: overwrite an explicit empty array, no default fallback
   * (including removing the menu-channel accelerator). Distinct from recording Backspace's restore-default. */
  const clearAllBindings = useCallback(
    (commandId: ShortcutCommandId) => {
      void persistBindings({ ...overrides, [commandId]: [] });
    },
    [overrides, persistBindings],
  );

  /**
   * Recording Backspace restore-default deletes the override entry. When the default chord is held by another
   * same-scope command (physical equivalence included, win Ctrl+m = CmdOrCtrl+m), hint the conflict without writing;
   * restore and record are two entries of one invariant (chord per command); per user rule, hint only, never auto-clear the holder.
   */
  const clearBinding = useCallback(
    (commandId: ShortcutCommandId) => {
      if (overrides?.[commandId] === undefined) {
        return;
      }
      const defaultBinding = getDefaultShortcutBindings(commandId)[0];
      if (defaultBinding) {
        const conflict = checkShortcutBindingConflict(commandId, defaultBinding, overrides, {
          menuChannelReserved: !isDesktop,
        });
        if (conflict?.kind === "occupied" && conflict.ownerCommandId) {
          toast(
            intl.formatMessage(
              { id: "settings.shortcuts.clearConflict" },
              { command: commandLabel(conflict.ownerCommandId) },
            ),
          );
          return;
        }
      }
      const next = { ...overrides };
      delete next[commandId];
      void persistBindings(next);
    },
    [overrides, persistBindings, isDesktop, intl, commandLabel],
  );

  // Restore-all is destructive (clears every override); reuse the global Promise-style confirm against stray clicks.
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const resetAll = useCallback(async () => {
    if (!overrides || Object.keys(overrides).length === 0) {
      return;
    }
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmTitle" }),
      description: intl.formatMessage({ id: "settings.shortcuts.resetAllConfirmDescription" }),
    });
    if (confirmed) {
      void persistBindings({});
    }
  }, [overrides, persistBindings, requestConfirmation, intl]);

  // Recording suppression: the recording listener registers after useAppKeyboard's capture (same phase, first-registered first),
  // so unsuppressed, the recorded chord would trigger the old command first and rebinding would never land.
  // Renderer channel: the kernel flag short-circuits useAppKeyboard; menu channel: main strips the menu accelerator
  // (macOS's system menu consumes keys before the renderer; preventDefault cannot intercept).
  // Chord-search armed state reuses the same keyboard exclusivity (explicit-intent capture, no command trigger).
  const keyboardExclusive = recording !== null || keySearch.armed;
  useEffect(() => {
    if (!keyboardExclusive) {
      return;
    }
    setShortcutRecordingActive(true);
    platform.setShortcutRecordingActive?.(true);
    return () => {
      setShortcutRecordingActive(false);
      platform.setShortcutRecordingActive?.(false);
    };
  }, [keyboardExclusive, platform]);

  useShortcutRecording({
    recording,
    setRecording,
    effective,
    overrides,
    isDesktop,
    clearBinding,
    appendBinding,
    replaceBindingAt,
  });

  const recordingCommandId = recording?.commandId ?? null;

  return (
    <div className="space-y-4" data-testid="settings-shortcuts-section">
      <ShortcutSearchBar
        query={query}
        onQueryChange={setQuery}
        keySearch={keySearch}
        // Exclusive with inline recording: cancel it before arming; the two window capture listeners never coexist.
        onArmKeySearch={() => setRecording(null)}
        actions={
          <Button
            variant="outline"
            onClick={resetAll}
            disabled={!overrides || Object.keys(overrides).length === 0}
            data-testid="settings-shortcut-reset-all"
          >
            <RotateCcw className="mr-2 size-4" />
            {intl.formatMessage({ id: "settings.shortcuts.resetAll" })}
          </Button>
        }
      />

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_72px] bg-surface px-4 py-3 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderCommand" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderBinding" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderScope" })}</span>
          <span>{intl.formatMessage({ id: "settings.shortcuts.columnHeaderActions" })}</span>
        </div>
        {visibleCommands.map((entry) => (
          <ShortcutBindingRow
            key={entry.id}
            entry={entry}
            commandLabel={commandLabel(entry.id)}
            bindings={effective[entry.id] ?? []}
            isOverridden={overrides?.[entry.id] !== undefined}
            isRecording={recordingCommandId === entry.id}
            recording={recording}
            menuChannelUnavailable={entry.channel === "menu" && !isDesktop}
            onRecord={(bindingIndex) => {
              // Inline recording and armed chord-search are exclusive: coexisting window capture listeners would eat each other's keys.
              keySearch.disarm();
              setRecording({
                commandId: entry.id,
                mode: "replace",
                bindingIndex,
                preview: null,
                error: null,
                conflictBinding: null,
              });
            }}
            onSteal={(binding) => {
              stealBinding(entry.id, binding);
              setRecording(null);
            }}
            onClearAll={() => clearAllBindings(entry.id)}
          />
        ))}
        {visibleCommands.length === 0 ? (
          <div
            className="border-t border-border px-4 py-8 text-center text-ui-sm text-foreground-subtle"
            data-testid="settings-shortcut-search-empty"
          >
            {keySearch.binding !== null
              ? intl.formatMessage(
                  { id: "settings.shortcuts.keySearchEmpty" },
                  { keys: formatShortcutBindingLabel(keySearch.binding) },
                )
              : intl.formatMessage({ id: "settings.shortcuts.searchEmpty" })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
