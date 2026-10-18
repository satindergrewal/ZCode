/**
 * Composer autofocus decision (pure, React/DOM-free, unit-testable).
 *
 * New task (startDraft bumps draftFocusVersion) / session switch (sessionId-to-scope) / mount
 * all request the caret back; whether focus happens is a three-way:
 * - skip: disabled (background split pane, autoFocusEnabled=false) or mobile viewport
 *   (focus pops the soft keyboard) - no focus, no parked intent.
 * - defer: enabled but briefly non-editable (connecting session) - park the
 *   intent, fire once on disabled-to-false.
 * - focus-now: enabled and editable, focus immediately.
 */
type ComposerAutoFocusDecision = "focus-now" | "defer" | "skip";

export interface ComposerAutoFocusOptions {
  /** Host gate (SessionPane.focused): only the focused pane autofocuses. */
  autoFocusEnabled: boolean;
  /** Composer non-editable (v4: session connecting). */
  disabled: boolean;
  /** Mobile text-input viewport. */
  isMobileViewport: boolean;
}

export function resolveComposerAutoFocus({
  autoFocusEnabled,
  disabled,
  isMobileViewport,
}: ComposerAutoFocusOptions): ComposerAutoFocusDecision {
  if (!autoFocusEnabled || isMobileViewport) return "skip";
  if (disabled) return "defer";
  return "focus-now";
}
