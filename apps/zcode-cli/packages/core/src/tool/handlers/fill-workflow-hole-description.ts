// FillWorkflowHole's standing description (docs/dynamic-workflow/launch.md "What the model is told").
//
// Same shortening rule as AmendWorkflow: the facade, the three hole forms, and authoring rules live in the `dynamic-workflows` skill,
// enforced by the skill gate. What stays here decides "call it, and how to write the body": statements only, compiled
// at the hole, seeing prior bindings, returning the hole's type, rehearsing fixed logic in EvalWorkflowSnippet first,
// one fill per hole (a loop body runs every iteration).

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

export const FILL_WORKFLOW_HOLE_TOOL_DESCRIPTION = [
  "Supplies the body of a hole that a RUNNING dynamic-workflow run has reached and is waiting at. Starts nothing: the run keeps its id, journal and subagents, and grows by the statements you write.",
  "",
  "- Takes run_id and hole_id — both from the hole notification (or from GetWorkflowRun's holes if that notification was lost). Only the branch parked at the hole waits; the rest of the run keeps going, and nothing times out.",
  "- Read the run's draft at the path the notification names for context: the body is compiled WHERE THE HOLE STANDS and sees every binding declared before it. Write only the statements of the hole's function — not the `hole(...)` call, not an arrow, not the script around it — and return a value of the hole's type, or end with a new tail hole named for the next step when the workflow's shape is not known yet (the skill's §15).",
  "- Rehearse fixed logic in EvalWorkflowSnippet first. A hole is filled once: a body under a loop runs on every iteration with that iteration's bindings.",
  "- On diagnostics the fill is saved to a fill file; edit that file in place and resubmit with `path` instead of pasting the body again. To change anything OUTSIDE the hole, use AmendWorkflow.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool before writing a body: it carries the facade the body is checked against and the hole rules. A call is refused until that skill has been loaded in this session. Pass \`script\` (the statements inline) or \`path\` (a file holding them), never both.`,
].join("\n");
