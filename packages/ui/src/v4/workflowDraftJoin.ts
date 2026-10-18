import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  isPlainRecord,
  readWorkflowAmendTarget,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { isAmendWorkflowToolCall, isCreateWorkflowToolCall } from "@/lib/workflowToolNames.js";

/**
 * Join from workflow tool rows to draft standing (draft number, superseded or not), built in one pass over the row window.
 *
 * A non-compiling script is not a failure: nothing ran; diagnostics went to the model, which fixes and resubmits. The card must show the draft
 * number and whether a newer one follows; neither fact lives on a single row - only row order tells. This is the only implementation of that read; cards consume it.
 *
 * Rules:
 * - Lineage: the tool name; a revision adds the predecessor `run_id`. Creations count among creations, each run revisions count from 1;
 * - Draft no.: 1 + rows in the same lineage/turn since the last compiled pass (`display.ok === true`) that failed (`ok === false`);
 *   rows without display (streaming, pending, rejected, cancelled) neither count nor reset; a new turn counts from 1;
 * - Superseded: a later same-lineage row exists in the window (this turn or any later one).
 *
 * The row window is bounded: once early drafts slide out, draft numbers read low. The draft no. is display-only; no other reader.
 */
export function buildWorkflowDraftByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowDraftPosition> {
  const byToolCallId = new Map<string, WorkflowDraftPosition>();
  // lineage -> toolCallId of the lineage latest row (marks earlier ones superseded once the next appears).
  const latestByLineage = new Map<string, string>();
  // (lineage, turn) -> consecutive failures since the last compiled pass.
  const failuresByLineageTurn = new Map<string, number>();

  for (const row of rows ?? []) {
    if (row.kind !== "toolCall") continue;
    const lineage = workflowDraftLineage(row);
    if (lineage === undefined) continue;

    const previous = latestByLineage.get(lineage);
    if (previous !== undefined) {
      const position = byToolCallId.get(previous);
      if (position !== undefined) byToolCallId.set(previous, { ...position, superseded: true });
    }
    latestByLineage.set(lineage, row.toolCallId);

    const turnKey = `${lineage}\u0000${row.turnId}`;
    const failures = failuresByLineageTurn.get(turnKey) ?? 0;
    byToolCallId.set(row.toolCallId, { ordinal: failures + 1, superseded: false });

    const compiled = readCompiled(row);
    if (compiled === false) failuresByLineageTurn.set(turnKey, failures + 1);
    if (compiled === true) failuresByLineageTurn.set(turnKey, 0);
  }
  return byToolCallId;
}

function workflowDraftLineage(row: ToolCallRow): string | undefined {
  if (isAmendWorkflowToolCall(row)) {
    return `amend\u0000${readWorkflowAmendTarget(row.input) ?? ""}`;
  }
  return isCreateWorkflowToolCall(row) ? "create" : undefined;
}

/**
 * Whether this row compiled: `true` / `false` from display; `undefined` without display.
 * The canonical home of display is `output.display`; a top-level `display` is the legacy-snapshot compat channel
 * (same precedence as `toolCallRowToLegacyNode`; once the two reads diverge, card and draft no. disagree).
 */
function readCompiled(row: ToolCallRow): boolean | undefined {
  const display: unknown = row.output?.display ?? row.display;
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return undefined;
  return typeof display.ok === "boolean" ? display.ok : undefined;
}
