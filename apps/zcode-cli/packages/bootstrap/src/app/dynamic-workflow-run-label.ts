// ============================================================
// The workflow run's display label (derived on read, never written back to dwf_run.name)
// ============================================================
//
// Two reasons for the standalone module:
//   1. **Both read surfaces must share one chain**. If List (ListWorkflowRuns) and detail (GetWorkflowRun) each
//      assemble their own fallback, some branch drifts, and the symptom is the same run showing different names in two places.
//   2. **Directly unit-testable**. The run service drags in the whole AgentRuntime / engine / journal dependency chain;
//      a pure function should not pay that price just to be asserted.

import type { DynamicWorkflowRunSummary } from "@zcode/contracts";

/**
  * Character cap for script-derived labels. 80 is one readable list line; the derived value is a heuristic -- the longer, the less label-like.
 */
export const DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS = 80;

/**
  * Derives the run's display label: `name` -> first non-empty script line (trimmed, capped at 80) -> runId.
 *
  * Deliberately no "smarter" extraction (first comment, regex heading, agent-name scrape): the first line is the **honest**
  * one ("the script starts like this"), and every extra heuristic is one more way to mislabel someone's script.
 *
  * The derived result is **never written back** to `dwf_run.name`: persisting would fossilize a display heuristic as data, after which
  * even "does this run have a name at all" becomes unanswerable.
 */
export function resolveDynamicWorkflowRunLabel(input: {
  runId: string;
  name?: string;
  scriptText?: string;
}): Pick<DynamicWorkflowRunSummary, "label" | "labelSource"> {
    // A blank-only name equals unnamed: in the list it renders as a non-clickable blank line, not a label.
  const name = input.name?.trim();
  if (name !== undefined && name.length > 0) return { label: name, labelSource: "name" };

  const firstLine = firstNonEmptyLine(input.scriptText);
  if (firstLine !== undefined) {
    return { label: boundLabel(firstLine), labelSource: "script" };
  }

    // Cannot happen in theory (submit always carries scriptText). labelSource still reports "script" -- the only distinction
    // the tool surface needs is "user-named" vs "derived by us"; adding another source value for a branch that
    // cannot happen just makes every consumer write one more never-true check.
  return { label: input.runId, labelSource: "script" };
}

/** First non-empty line (trimmed). undefined when the whole text is blank. */
function firstNonEmptyLine(scriptText: string | undefined): string | undefined {
  if (scriptText === undefined) return undefined;
  for (const line of scriptText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
  * Truncates to the cap without leaving lone surrogates. Scripts are model-written external input; string literals
  * may contain emoji, and half a surrogate pair is neither valid text nor safe in every runtime's
  * JSON codec (same treatment as create-workflow's boundGraphText and port payload bounding).
 */
function boundLabel(value: string): string {
  if (value.length <= DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS) return value;
  const cut = value.slice(0, DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}
