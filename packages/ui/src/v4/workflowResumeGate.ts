/**
 * The gate that supplies the Resume callback in session context.
 *
 * Pressing Resume really starts an engine, so once the rollout misses, no path may start one. The tool-card footer
 * (create-workflow renderer) and the turn-tail digest card (ConversationWorkflowDigests) both gate on callback presence,
 * so cutting the single supply point in session context hides both buttons - no need to thread the rollout
 * into leaf components. The run details panel uses its own sendCommand behind an equivalent gate.
 *
 * Read-only sessions (shared read-only timeline) never offered Resume; that rule stands.
 *
 * Existing runs render as usual: cards, digests, the run panel, artifacts - all present, just inert.
 */
export function resolveWorkflowResumeHandler<THandler>(options: {
  readOnly: boolean | undefined;
  /** Pass false while the rollout snapshot is not ready: unknown means unavailable (fail-closed). */
  dynamicWorkflowEnabled: boolean;
  handler: THandler;
}): THandler | undefined {
  if (options.readOnly === true) return undefined;
  if (!options.dynamicWorkflowEnabled) return undefined;
  return options.handler;
}
