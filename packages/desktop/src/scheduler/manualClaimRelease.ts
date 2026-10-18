export interface ManualClaimReleaseRepo {
  get(
    automationId: string,
  ): Promise<{ workspaceKey: string } | null>;
  getRun(runId: string): Promise<{ workspaceKey: string } | null>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

export interface ManualClaimReleaseParams {
  repo: ManualClaimReleaseRepo;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  logError: (message: string) => void;
}

export async function releaseManualClaimForSettledRun(
  params: ManualClaimReleaseParams,
): Promise<void> {
  const releaseWorkspaceKey =
    params.workspaceKey ??
    (await params.repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
    (await params.repo.get(params.automationId).then((automation) => automation?.workspaceKey));
  if (!releaseWorkspaceKey) {
    params.logError(
      `manual claim release skipped: workspaceKey missing automation=${params.automationId} runId=${params.runId}`,
    );
    return;
  }
  // After a scheduler restart or lost inFlight state, main's late reports can still arrive; the manual
  // single-flight lock must recover the workspaceKey from the run ledger or automation, or it stalls until stale reaping.
  await params.repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
}

export async function settleManualClaimForDispatchResult(
  params: ManualClaimReleaseParams & { ok: boolean },
): Promise<void> {
  // An ok from the host only means accepted/queued; the real terminal state arrives via the host subscription,
  // so the scheduler releases the manual claim only on dispatch failure with no awaitable turn.
  if (params.ok) return;
  await releaseManualClaimForSettledRun(params);
}
