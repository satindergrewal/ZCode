const fallbackToastClaimsByCommandId = new Set<string>();

/**
 * Fallback events can be observed repeatedly (snapshot replay, SessionPane remount); a module-level claim keeps the Toast single-shot.
 */
export function claimHighspeedFallbackToast(sourceCommandId: string): boolean {
  if (fallbackToastClaimsByCommandId.has(sourceCommandId)) return false;
  fallbackToastClaimsByCommandId.add(sourceCommandId);
  return true;
}
