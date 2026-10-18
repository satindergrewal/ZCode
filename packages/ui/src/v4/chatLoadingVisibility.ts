import type {
  ActiveWorkSummary,
  ConversationRow,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * While awaiting user action, the dialog/Q&A card is the only progress feedback; no loading on top.
 * Only permission confirms and AskUserQuestion count; other userInput semantics (ExitPlanMode etc.) stay independent.
 * After the soft gate, workspaceHookReview never blocks the chat.
 */
export function hasChatLoadingBlockingInteraction(
  interactions: readonly PendingInteraction[],
): boolean {
  return interactions.some(
    (interaction) =>
      interaction.payload.kind === "permission" ||
      (interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === "AskUserQuestion"),
  );
}

export function hasChatLoadingBlockingActiveWork(
  activeWorks: readonly ActiveWorkSummary[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact" || work.kind === "goalVerifier");
}

function hasChatLoadingBlockingMaintenanceRow(rows: readonly ConversationRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")),
  );
}

export function shouldShowTurnChatLoading({
  blockedByActiveWork,
  blockedByInteraction,
  isLastTurn,
  isRunning,
  rows,
}: {
  blockedByActiveWork: boolean;
  blockedByInteraction: boolean;
  isLastTurn: boolean;
  isRunning: boolean;
  rows: readonly ConversationRow[];
}): boolean {
  if (!isLastTurn || !isRunning || blockedByActiveWork || blockedByInteraction) {
    return false;
  }

  // pendingInteractions / activeWorks are authoritative, but restore/out-of-order windows
  // may expose row states first; the row-level fallback keeps the bottom loading
  // from flashing back while permission/compact/goal verifier already show.
  return (
    !rows.some((row) => row.kind === "toolCall" && row.status === "pendingApproval") &&
    !hasChatLoadingBlockingMaintenanceRow(rows)
  );
}
