/**
 * V4 composer toolbar keyboard hotkeys (composer parity).
 *
 * Pure logic (no store/protocol deps; consumes the config command catalog and callbacks).
 * Bound callbacks only touch the Composer:
 * - Ctrl+M        -> open the model menu (openRequestKey bumps; consumed by ModelConfigSelect)
 * - Ctrl+Shift+M  -> cycle the next Submission mode
 * - Ctrl+T        -> cycle the next Submission thinking level
 *
 * All three hotkeys are first-class commands now (openModelMenu / cycleSessionMode /
 * cycleThoughtLevel, window-scope global); matching reads the effective table, rebindable in settings;
 * defaults keep the existing behavior, zero change.
 */
import { useEffect, useRef } from "react";
import type { ShortcutCommandId, ZCodeConfigOption } from "@zcode/shared";
import {
  isShortcutRecordingActive,
  matchesShortcutBinding,
  type EffectiveShortcutBindings,
} from "@/shortcuts/bindings.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";

type ChatToolbarShortcutKey = "m" | "ctrlShiftM" | "t" | null;

/** 旧 chatInputControlShortcuts.getChatToolbarShortcutKey 原样恢复。 */
export function getChatToolbarShortcutKey(
  category: ZCodeConfigOption["category"],
): ChatToolbarShortcutKey {
  switch (category) {
    case "model":
      return "m";
    case "mode":
      return "ctrlShiftM";
    case "thought_level":
      return "t";
    default:
      return null;
  }
}

/** Next cyclic value of a select option (mode cycling). */
export function getNextConfigSelectValue(
  option: Pick<ZCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options?.length) {
    return null;
  }

  const currentValue = String(option.currentValue);
  const currentIndex = option.options.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % option.options.length;

  return option.options[nextIndex]?.value ?? null;
}

interface ToolbarShortcutKeyboardEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  isComposing: boolean;
}

interface ToolbarShortcutState {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
}

type ToolbarShortcutAction = "openModelMenu" | "cycleSessionMode" | "cycleThoughtLevel";

/**
 * Resolves toolbar actions via the effective table (hotkeys promoted to configurable commands).
 * Matching runs through the kernel (command table + matcher, exact modifiers, the semantics of the legacy
 * matchesCtrlShortcut family for Ctrl+m / Ctrl+Shift+m / Ctrl+t); option ownership and
 * disabled gates stay. Event and table come from the caller; pure and unit-testable.
 */
export function resolveToolbarShortcutAction(
  event: ToolbarShortcutKeyboardEvent,
  effective: EffectiveShortcutBindings,
  {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
  }: ToolbarShortcutState,
): ToolbarShortcutAction | null {
  if (
    !hasAnyOption ||
    toolbarDisabled ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing
  ) {
    return null;
  }

  const candidates: ReadonlyArray<{
    action: ToolbarShortcutAction;
    commandId: ShortcutCommandId;
    expectedKey: ChatToolbarShortcutKey;
    option?: ZCodeConfigOption;
    disabled?: boolean;
  }> = [
    {
      action: "openModelMenu",
      commandId: "openModelMenu",
      expectedKey: "m",
      option: modelOption,
      disabled: modelMenuDisabled,
    },
    {
      action: "cycleSessionMode",
      commandId: "cycleSessionMode",
      expectedKey: "ctrlShiftM",
      option: modeOption,
    },
    {
      action: "cycleThoughtLevel",
      commandId: "cycleThoughtLevel",
      expectedKey: "t",
      option: thoughtOption,
    },
  ];

  for (const candidate of candidates) {
    if (candidate.disabled) {
      continue;
    }
    if (
      !candidate.option ||
      getChatToolbarShortcutKey(candidate.option.category) !== candidate.expectedKey
    ) {
      continue;
    }
    for (const binding of effective[candidate.commandId] ?? []) {
      if (matchesShortcutBinding(event, binding)) {
        return candidate.action;
      }
    }
  }

  return null;
}

export function useToolbarShortcutBindings(params: {
  hasAnyOption: boolean;
  toolbarDisabled: boolean;
  modelMenuDisabled: boolean;
  modelOption?: ZCodeConfigOption;
  modeOption?: ZCodeConfigOption;
  thoughtOption?: ZCodeConfigOption;
  onOpenModelMenu: () => void;
  /** Ctrl+Shift+M: thought-level-aware quick session-mode cycle, no menu. */
  onCycleSessionMode: () => void;
  /** Ctrl+T: keeps quick thought-level switching, independent of the default select menu. */
  onCycleThoughtLevel: () => void;
}) {
  const {
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modelOption,
    modeOption,
    thoughtOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
  } = params;
  // Toolbar hotkeys are commands now; matching reads the effective table - rebinding applies instantly
  const effectiveBindings = useEffectiveShortcutBindings();
  const effectiveRef = useRef(effectiveBindings);
  effectiveRef.current = effectiveBindings;

  useEffect(() => {
    if (!hasAnyOption) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // While recording, the keyboard belongs to the recorder. This listener registers before the recorders (same capture phase);
      // unless it steps aside, recorded key previews would really trigger toolbar actions.
      if (isShortcutRecordingActive()) {
        return;
      }
      // On Windows/Linux Cmd/Ctrl+P already belongs to the useAppKeyboard file search,
      // conflicting with the legacy toolbar Ctrl+P. Mode switch moves to Ctrl+Shift+M, still honoring
      // defaultPrevented, never double-handling other capture-phase shortcuts.
      const state = {
        hasAnyOption,
        toolbarDisabled,
        modelMenuDisabled,
        modelOption,
        modeOption,
        thoughtOption,
      };
      const action = resolveToolbarShortcutAction(event, effectiveRef.current, state);
      if (!action) {
        // Diagnostics decouple from the effective table - log model-menu-not-opened only when the pressed
        // key is actually bound to openModelMenu (no false log on the old key; failures on new keys log).
        const openModelMenuBound = (effectiveRef.current.openModelMenu ?? []).some((binding) =>
          matchesShortcutBinding(event, binding),
        );
        if (openModelMenuBound) {
          logger.debug("[V4ComposerToolbar] model-menu hotkey did not open the menu", {
            hasModelOption: Boolean(modelOption),
            shortcutKey: getChatToolbarShortcutKey(modelOption?.category),
            modelMenuDisabled,
          });
        }
        return;
      }

      event.preventDefault();
      if (action === "openModelMenu") {
        logger.debug("[V4ComposerToolbar] Ctrl+M opened the model menu");
        onOpenModelMenu();
        return;
      }

      if (action === "cycleSessionMode") {
        onCycleSessionMode();
        return;
      }

      if (action === "cycleThoughtLevel") {
        onCycleThoughtLevel();
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [
    hasAnyOption,
    toolbarDisabled,
    modelMenuDisabled,
    modeOption,
    modelOption,
    onOpenModelMenu,
    onCycleSessionMode,
    onCycleThoughtLevel,
    thoughtOption,
  ]);
}
