import { isNonRetryableWorkspacePrepareError, type ZCodeProvider } from "@zcode/shared";

export function shouldAutoRetryWorkspacePrepare(errorMessage: string) {
  // Bugfix: remote ZCode agents in Docker often fail on resource mismatch, missing optionals, or instant exits.
  // None hit the no-auto-retry list, so draft prewarm looped loading forever.
  // Treat exited-early/timeout/missing-deps as deterministic: stop auto-retry and fail the UI fast.
  // Bugfix: with a signed-out provider prepareWorkspace triggers OAuth; if login never completes,
  // auto-retry relaunched it endlessly -- repeated login popups, eternal loading.
  // Missing auth/login timeout are no-retry too; the next attempt waits for a manual retry.
  // Bugfix: the no-retry patterns gate both the UI auto-retry and the service MCP fallback.
  // Reuse the shared central list so the two sides cannot drift again.
  return !isNonRetryableWorkspacePrepareError(errorMessage);
}

export function shouldRestartWorkspaceProcessBeforePrepareRetry(_params: {
  provider: ZCodeProvider;
  errorMessage: string;
}): boolean {
  // GLM-only now: no restart-retry policy for third-party CLI crash copy.
  return false;
}
