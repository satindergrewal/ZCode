/**
 * Expiry show/hide clock for the Highspeed group-tail footer.
 *
 * Context (spec 9.3): footer visibility is driven by the ConversationTimeline's liveNowMs crossing
 * the card expiresAt. The wake timer is a renderer setTimeout, frozen by Chromium while the window is
 * hidden/occluded; liveNowMs then stalls pre-expiry and the footer appears only after the user sends
 * one more message (the running clock jumps liveNowMs to now), breaking the no-extra-send rule.
 *
 *
 * So besides the expiry setTimeout, listen on visibilitychange and focus; compensate one refresh on return,
 * snapping liveNowMs to now. vs SessionPane's wake compensation (highspeedAutoShareClock): that refreshes
 * completed share-entry/view data, this one the footer show/hide clock; neither waits for new messages/snapshots.
 *
 */

type ExpiryClockWindow = Pick<
  Window & typeof globalThis,
  "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"
>;

type ExpiryClockDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

export interface HighspeedFooterExpiryClockDeps {
  windowTarget?: ExpiryClockWindow;
  documentTarget?: ExpiryClockDocument;
  now?: () => number;
}

/**
 * Wake once at the next card's expiry boundary; compensate when the window reappears or refocuses.
 * Returns dispose, clearing timer and listeners (for a React effect cleanup).
 */
export function armHighspeedFooterExpiryClock(
  nextExpiryMs: number,
  onExpire: () => void,
  deps: HighspeedFooterExpiryClockDeps = {},
): () => void {
  const windowTarget = deps.windowTarget ?? window;
  const documentTarget = deps.documentTarget ?? document;
  const now = deps.now ?? Date.now;

  // +20ms ensures the fire is past expiresAt; boundary jitter otherwise keeps the footer reading not-expired.
  const delayMs = Math.max(0, nextExpiryMs - now()) + 20;
  const timer = windowTarget.setTimeout(onExpire, delayMs);

  const catchUpFromWindowWake = () => {
    // No compensation when hiding (as in SessionPane); snap the clock only on return to foreground.
    if (documentTarget.visibilityState === "hidden") return;
    onExpire();
  };
  documentTarget.addEventListener("visibilitychange", catchUpFromWindowWake);
  windowTarget.addEventListener("focus", catchUpFromWindowWake);

  return () => {
    windowTarget.clearTimeout(timer);
    documentTarget.removeEventListener("visibilitychange", catchUpFromWindowWake);
    windowTarget.removeEventListener("focus", catchUpFromWindowWake);
  };
}
