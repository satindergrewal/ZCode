import type {
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Rules for hub-initiated launch turns in the transcript.
 *
 * Launch-metadata turnHeader wins (live-projection authority), falling back to the copy on the
 * user-visible row (cold-restore hydration writes it on the userInput row too). When metadata
 * is present, the turn's workflowLaunch user row is NOT visible input - its body is the
 * model-facing canonical English sentence and the run card speaks for the turn; with both
 * absent, plain rendering returns (the sentence becomes the bubble).
 */
export function resolveWorkflowLaunchMeta(
  header: TurnHeaderRow | undefined,
  userInputs: readonly UserInputRow[],
): WorkflowLaunchMeta | undefined {
  if (header?.origin !== "workflowLaunch") return undefined;
  return (
    header.workflowLaunch ??
    userInputs.find((row) => row.workflowLaunch !== undefined)?.workflowLaunch
  );
}

/** The launch turn's user row: with metadata present the run card speaks; neither visible input nor stream. */
export function isWorkflowLaunchUserInputRow(row: ConversationRow): boolean {
  return row.kind === "userInput" && row.origin === "workflowLaunch";
}
