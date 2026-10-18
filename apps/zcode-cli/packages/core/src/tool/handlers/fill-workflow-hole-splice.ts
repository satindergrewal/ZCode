// ============================================================
// FillWorkflowHole: the valid script for the confirm-dialog preview
// ============================================================
// docs/dynamic-workflow/launch.md "Approval": another session's run opens a dialog drawing the **valid script's** graph
// (with the body spliced in), while the actual splice and compile happen port-side, after approval. So this pre-splices in resolveInput
// purely so prepareApproval has a graph; it is not the execution path — the port's `fillHole` is.
//
// The splice itself is the analyzer package's `spliceHoleBody` (apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md
// "Sites"): the body goes before the hole call's closing brace; site-id numbering is the analyzer's guarantee.

import { collectSites, createWorkflowProgram, spliceHoleBody } from "@zcode/dynamic-workflow";

/**
 * Splices the body into the run's script, returning the valid script text; when it cannot (unknown hole, already filled, not even a site table) return
 * `undefined` — the caller opens a dialog without a preview. Never throws.
 */
export function spliceHoleBodyPreview(
  scriptText: string,
  holeSiteId: string,
  body: string,
): string | undefined {
  try {
    const table = collectSites(createWorkflowProgram(scriptText));
    return spliceHoleBody(scriptText, table, holeSiteId, body)?.text;
  } catch {
    return undefined;
  }
}
