/**
 * Derives the always-on CUA composer entry button state (zero-dependency pure functions).
 *
 * Why pure functions: the state space is a cartesian product of platform x hide toggle x plugin x
 * permission x session busy; inside a component it is only testable via store mocks, never fully.
 * No React import, no store reads here; the caller (useCuaComposerEntry) injects every input.
 */
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";
import { isCuaPermissionTccGranted } from "@/lib/cuaPermissionStatusStore.js";
import type { StatusDotTone } from "@/settings/StatusDot.js";

/**
 * Four public UI states; finer internal states are log-only and never shown to users.
 *
 * There is no "disabled" (plugin off) state: with computer control off by default, the disabled
 * promo dot no longer renders at all (see the plugin gate in isEntryVisible), so it is unreachable.
 */
export type CuaComposerEntryUiState =
  | "starting"
  /** Lazy start: helper not yet running (normal idle, auto-started on first use) -- neutral dot, not an error. */
  | "idle"
  | "permission-required"
  | "ready"
  | "error";

export interface CuaComposerEntryInputs {
  /** macOS local desktop with the CUA onboarding capability (UA plus preload capability). */
  macLocalDesktop: boolean;
  /** Windows local desktop. */
  windowsLocalDesktop: boolean;
  /** The settings toggle for the composer entry button is off (internal hidden state). */
  hiddenBySettings: boolean;
  /** Whether cuaPermissionService exists; false on remote hosts. */
  permissionServiceAvailable: boolean;
  /** zcode-cua plugin enabled state. */
  pluginEnabled: boolean;
  /** zcode-cua plugin is mid-toggle. */
  pluginToggling: boolean;
  /** Last zcode-cua plugin operation failed. */
  pluginError: boolean;
  /** Helper permission state. The entry never queries it (always null, idle); the settings page reads the truth. */
  permissionStatus: CuaPermissionStatusResult | null;
  /** A turn is running in some task of the current workspace. */
  sessionBusy: boolean;
}

export type CuaComposerEntryView =
  | { visible: false }
  | {
      visible: true;
      uiState: CuaComposerEntryUiState;
      tone: StatusDotTone;
      spinning: boolean;
      tooltipMessageId: string;
      /**
       * open-settings jumps to the settings computerUse section; none means hover tooltip only.
       * Visible states are always open-settings; none only under the session-busy override (see the resolve tail note).
       */
      clickAction: "open-settings" | "none";
      /** session-busy override: greyed and click-inert. Never changes uiState or tone. */
      interactionDisabled: boolean;
    };

const TOOLTIP_MESSAGE_ID: Record<CuaComposerEntryUiState, string> = {
  idle: "chat.toolbar.computerUse.tooltip.idle",
  starting: "chat.toolbar.computerUse.tooltip.starting",
  "permission-required": "chat.toolbar.computerUse.tooltip.permissionRequired",
  ready: "chat.toolbar.computerUse.tooltip.ready",
  error: "chat.toolbar.computerUse.tooltip.error",
};

const BUSY_TOOLTIP_MESSAGE_ID = "chat.toolbar.computerUse.tooltip.sessionBusy";

/**
 * Four visibility gates. Any failure means no DOM at all, never a disabled button:
 * a lingering grey button would suggest the feature works when it cannot.
 */
function isEntryVisible(inputs: CuaComposerEntryInputs): boolean {
  // Platform gate: remote workspace, Linux, plain web and phone control all fail it.
  if (!inputs.macLocalDesktop && !inputs.windowsLocalDesktop) return false;
  // Settings gate: once hidden by the user it stays hidden across restarts and upgrades.
  if (inputs.hiddenBySettings) return false;
  // Service gate: on macOS every state comes from the helper; without it the button shows nothing true.
  // Windows has no TCC and never reads helper permissions, so it is exempt from this gate.
  if (inputs.macLocalDesktop && !inputs.permissionServiceAvailable) return false;
  // No entry while the computer-use plugin is disabled: after a default-off or manual off, a
  // lingering grey promo button in the composer makes the off state hard to read.
  // Exception while toggling: pluginEnabled still holds the pre-toggle value; gating it too would
  // erase the enabling spinner, leaving no progress when the user returns from settings.
  if (!inputs.pluginEnabled && !inputs.pluginToggling) return false;
  return true;
}

/**
 * Internal state decision, short-circuiting top-down with fixed high-to-low priority.
 *
 * Precondition: the caller passed isEntryVisible, so pluginEnabled || pluginToggling holds.
 * Plugin-disabled is a no-render now, not a UI state, so it has no branch here.
 */
function resolveUiState(inputs: CuaComposerEntryInputs): CuaComposerEntryUiState {
  // toggling wins: the mid-toggle state must not be masked by stale enabled or permission values.
  // It also covers disabled-plus-toggling, the only disabled combo passing the plugin gate.
  if (inputs.pluginToggling) return "starting";
  if (inputs.pluginError) return "error";

  // Windows has no TCC: an enabled plugin is ready; no permission stage applies.
  if (!inputs.macLocalDesktop) return "ready";

  // The lazy-start entry carries no state display and permissionStatus stays null:
  // there is no cold-start querying state (a query would auto-start the helper, so querying on
  // mount equals launching it with the app). null counts as idle; the settings page reads truth.
  if (inputs.permissionStatus === null) return "idle";

  // Unhealthy helper (no accessibility field) maps to error, i.e. helper startup failure.
  if (!isCuaPermissionStatusAvailable(inputs.permissionStatus)) {
    // unavailable flagged idle is the normal reply after helper idle exit (300s no access),
    // not a failure; only definite failure without the idle flag reports error.
    if ((inputs.permissionStatus as { idle?: true }).idle === true) return "idle";
    return "error";
  }

  // Permission needs a live probe, but the entry refresh is read-only: the screen-capture probe
  // demands explicit user intent (shouldRunCuaScreenCaptureProbe wants includeFunctionalProbes),
  // so background refreshes always see screenCaptureProbeOk false; readiness gated on it would
  // trap granted users on the missing-macos-permission dot. Like the settings row, use the TCC
  // signal; truly unavailable means the tool errors and the model recovers, no auto-onboarding.
  return isCuaPermissionTccGranted(inputs.permissionStatus) ? "ready" : "permission-required";
}

export function resolveCuaComposerEntryView(inputs: CuaComposerEntryInputs): CuaComposerEntryView {
  if (!isEntryVisible(inputs)) return { visible: false };

  const uiState = resolveUiState(inputs);
  // session-busy is an interactivity override: toggling the plugin changes every session toolset
  // in this workspace and busts prompt caches, costliest mid-run; uiState and tone stay put.
  // Simplification (user decision): the entry no longer carries a status dot; always clickable,
  // always into settings, which owns state display (and starts the helper on demand).
  const interactionDisabled = false;

  return {
    visible: true,
    uiState,
    tone: "subtle",
    spinning: uiState === "starting",
    tooltipMessageId: interactionDisabled ? BUSY_TOOLTIP_MESSAGE_ID : TOOLTIP_MESSAGE_ID[uiState],
    // Previously only disabled and permission-required were clickable while ready, starting and error
    // were pure status lamps. In practice, clicking after a completed grant (button green) did nothing
    // and read as broken, while the settings computerUse section always has something actionable:
    // the plugin toggle, permission row and error details. So the clickable whitelist is gone:
    // visible means navigable; only the session-busy override stays inert
    // (the button is greyed with a session-running tooltip; navigating then would contradict the visuals).
    clickAction: interactionDisabled ? "none" : "open-settings",
    interactionDisabled,
  };
}
