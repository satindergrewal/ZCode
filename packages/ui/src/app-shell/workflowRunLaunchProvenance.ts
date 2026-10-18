import type { ConversationRow, WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";

/**
 * Provenance of a directly-launched run: scope, description, arguments, and the
 * "launched by you from the workflow hub" moment. Only hub-launched runs carry it — it
 * hangs off the launch turn's turnHeader/userInput row `workflowLaunch` metadata (same
 * toolCallId). Runs started via the tool path find none in the row window, so this returns
 * undefined and the side pane omits the section. turnHeader wins (authoritative live
 * projection; its startedAt IS the launch moment), falling back to the same payload on a
 * user-visible row (cold-restore hydration also writes the userInput row).
 */
interface WorkflowLaunchProvenance {
  meta: WorkflowLaunchMeta;
  startedAt?: number;
}

export function resolveWorkflowLaunchProvenance(
  rows: readonly ConversationRow[] | undefined,
  toolCallId: string,
): WorkflowLaunchProvenance | undefined {
  let fallback: WorkflowLaunchProvenance | undefined;
  for (const row of rows ?? []) {
    if (row.kind === "turnHeader" && row.workflowLaunch?.toolCallId === toolCallId) {
      return { meta: row.workflowLaunch, startedAt: row.startedAt };
    }
    if (
      fallback === undefined &&
      row.kind === "userInput" &&
      row.workflowLaunch?.toolCallId === toolCallId
    ) {
      fallback = { meta: row.workflowLaunch, startedAt: row.createdAt };
    }
  }
  return fallback;
}
