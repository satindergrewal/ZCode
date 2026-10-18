import { SessionEventType } from "@zcode/contracts";
import type { WorkspaceHookReviewFlow, WorkspaceHookReviewFlowRegistry } from "@zcode/core";
import type { WorkspaceHookReviewHostPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";

/**
 * Supervises a review flow until it terminates: follows the supersede chain and fills in
 * telemetry and ReviewSettled on timeout.
 *
 * This is the ONLY place that awaits flow.result: with no awaiter, the 10-minute deadline silently settles as timed_out inside the
 * registry, the frontend never sees ReviewSettled, the panel keeps rendering pending,
 * and every later click is rejected by registry.validate as workspace_hooks_review_superseded
 * (observed: 9 consecutive clicks all rejected, with no auto-reopen).
 *
 * A standalone module shared by requestReview and the post-revoke reopen path: every entry that starts a flow must
 * hand it to this supervisor, or an unwatched orphan flow appears just the same.
 */
export async function superviseWorkspaceHookReviewFlow(input: {
  flow: WorkspaceHookReviewFlow;
  host: WorkspaceHookReviewHostPort;
  registry: WorkspaceHookReviewFlowRegistry;
  sessionId: string;
  telemetry: WorkspaceHookReviewTelemetry;
}): Promise<void> {
  let flow = input.flow;
  while (true) {
    const outcome = await flow.result;
    if (outcome.reasonCode === "workspace_hooks_review_superseded") {
      const current = input.registry.getCurrentFlow(input.sessionId);
      if (!current || current === flow) return;
      flow = current;
      continue;
    }
    if (outcome.reasonCode === "workspace_hooks_interaction_timeout") {
      input.telemetry.timeout(flow.request);
      await input.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: flow.request.interactionId,
          state: "timed_out",
          reasonCode: outcome.reasonCode,
        },
      });
    }
    return;
  }
}
