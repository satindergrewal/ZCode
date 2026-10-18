/**
 * React bridge over the shortcut kernel: the only hook egress for the effective keymap and display
 * labels.
 *
 * Data comes from useSettings' shared snapshot (setting.json), so settings write -> update ->
 * refresh recomputes every consumer; no dedicated store/broadcast channel.
 */
import { useMemo } from "react";
import { type ShortcutCommandId } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveEffectiveShortcutBindings, type EffectiveShortcutBindings } from "./bindings.js";
import { formatShortcutBindingLabel } from "./label.js";

/** The effective shortcut keymap (defaults + user overrides, read-only view). */
export function useEffectiveShortcutBindings(): EffectiveShortcutBindings {
  const { settings } = useSettings();
  const overrides = settings?.shortcutBindings;
  return useMemo(() => resolveEffectiveShortcutBindings(overrides), [overrides]);
}

/**
 * Command display label: the effective keymap's first binding, formatted.
 * Unassigned (override set to an explicit empty array) returns "" and does NOT fall back to the
 * default display — the tooltip's keys must match what actually works, or a cleared command keeps
 * advertising the default key while not responding (display-side extension of the empty-array
 * semantics). The effective map is built over the full command set; only invalid commandIds miss
 * keys, treated the same as unassigned.
 */
export function useShortcutCommandLabel(commandId: ShortcutCommandId): string {
  const effective = useEffectiveShortcutBindings();
  const first = effective[commandId]?.[0] ?? "";
  return first === "" ? "" : formatShortcutBindingLabel(first);
}
