// CreateWorkflow's standing description (docs/dynamic-workflow/authoring.md "The authoring surface").
//
// Deliberately shortened since 2026-09-21: facade declarations, authoring rules, phase/naming rules, and full field semantics moved into
// the `dynamic-workflows` skill's "Tool reference" section, enforced by the skill gate on resolveInput
// (handlers/workflow-skill-gate.ts) so the model has read it before writing a script. The description plus facade used to be
// ~8k tokens resent with every model request; now three things stay resident — what it is, when (not) to use it,
// read the skill first. Routing stays here, not in the skill, because it decides whether to call the tool at all and must be
// readable before the skill loads.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

const INTRO =
  "Create and run a dynamic workflow: a TypeScript script that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results. The script is typechecked, the user is asked to confirm it, and the run starts in the background; you are notified with its final result when it settles. Compilation errors come back as diagnostics.";

/**
 * Routed only by "did the user ask" (user ruling 2026-09-16, docs/dynamic-workflow/launch.md "When the
 * model may call it"): workflows start only via `/workflow` or an explicit request; the model never decides to start one itself.
 */
const WHEN_TO_USE = [
  "When to use:",
  '- The user explicitly asks for a workflow — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or any phrasing that names workflow/工作流 as the means: this tool is mandatory. Do not substitute the Agent/Task subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow — the user chose the tool, and that choice is theirs. Size only decides how many subagents the script gets, never whether it is written.',
  "- Without such an explicit request, do not start a workflow: delegate with the Agent tool or do the work yourself, even for multi-step or multi-subagent tasks.",
].join("\n");

const SKILL_GATE = `Before writing or revising a script, load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool: it carries the facade declarations the script is checked against, the authoring rules, and this tool's full contract. A call that submits a script is refused until that skill has been loaded in this session; running a saved workflow by name is exempt.`;

const SOURCES =
  "Pass exactly one source: `script` (a one-off script written inline; it is saved to a draft file the result names — revise that file and resubmit with `path`, never paste the script again), `saved` (a workflow saved in this project or globally, by name; check ListSavedWorkflows before writing one from scratch), or `path` (a script file on disk, normally the file a previous result named). To change a run that already exists — errored, completed, stopped or still running — call AmendWorkflow instead of starting over.";

export const CREATE_WORKFLOW_TOOL_DESCRIPTION = [
  INTRO,
  "",
  WHEN_TO_USE,
  "",
  SKILL_GATE,
  "",
  SOURCES,
].join("\n");
