const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 3_000;

/**
 * In-app browser Playwright commands use a short failure budget: 3s by default, capped
 * by the call site. The old IAB used 30s, causing long useless polling after a wrong
 * locator guess; this shared normalizer keeps every adapter on the same budget.
 */
export function normalizePlaywrightTimeout(
  timeoutMs: number | undefined,
  max = PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
): number {
  const requested = typeof timeoutMs === "number" ? timeoutMs : PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(0, requested), max || PLAYWRIGHT_DEFAULT_TIMEOUT_MS);
}
