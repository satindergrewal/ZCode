// AmendWorkflow's standing description (docs/dynamic-workflow/launch.md "What the model is told").
//
// Shortened since 2026-09-21: how the cache hits, the three inherit-on-absence fields, the `path`/`script` sources, and the dialog
// confirm dialog appears -- all in the `dynamic-workflows` skill's "Tool reference", enforced by the skill gate.
// Here only routing -- when to amend rather than rebuild, no stop-first, no wait -- because it decides
// "call this tool or not", and must be readable before the skill loads.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

export const AMEND_WORKFLOW_TOOL_DESCRIPTION = [
  "Amend an existing dynamic-workflow run with a revised script or revised settings. Starts a NEW run that supersedes the old one and imports its finished work as a cache, so only what you changed is paid for again. Works on ANY run of this project: completed, errored, stopped — or still running.",
  "",
  "When to use:",
  "- The run errored, or completed but needs one more stage: fix or extend the script and amend. Never rewrite the workflow from scratch with CreateWorkflow.",
  "- The run is STILL RUNNING and is visibly going wrong: amend it NOW, in one call. Do not TaskStop it first and do not wait for it to finish — this tool stops the running predecessor and starts the revision; the earlier you amend, the less is re-paid.",
  "- The user wants the same workflow with fewer subagents at once, its subagents on another model, or another name: amend with only that field and neither `path` nor `script`.",
  "- To continue a stopped run unchanged, use ResumeWorkflowRun instead.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool before revising a script: it carries the cache rules, what each omitted field keeps, and the confirmation rule. A call that passes \`path\` or \`script\` is refused until that skill has been loaded in this session; a settings-only call is not. Pass \`path\` (the run's script file, edited in place — the usual form) or \`script\` (the whole revised script inline), never both.`,
].join("\n");
