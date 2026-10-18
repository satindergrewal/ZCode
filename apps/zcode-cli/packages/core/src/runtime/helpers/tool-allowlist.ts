import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
} from "@zcode/contracts";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "../../subagent/explore-tools.js";
import type { AgentRuntimeConfig } from "../types.js";
import { normalizeToolNameAlias } from "../../tool/tool-visibility.js";

const EXPLORE_AGENT_ALLOWED_TOOL_SET = new Set<string>(EXPLORE_AGENT_ALLOWED_TOOLS);

/**
 * Tools additionally not registered in workflow child runtimes.
 *
 * Root cause: workflow children (/workflow, /expert, and script-workflow agent calls) are forced to
 * yolo, and their interaction events mirror to the parent only on the subagent path (runtime/methods/subagent.ts is
 * the only mirrorSubagentToolEvent ingress). CreateWorkflow declares alwaysAsk, so a compiling script would
 * raise a confirmation invisible to the parent UI and hang until the permission timeout. Not registering the tool at all gives the child
 * a clean tool-unavailable error instead of an invisible hang.
 *
 * Long term: mirror workflow-child interaction events to the parent too, alongside the execution engine work.
 */
const WORKFLOW_CHILD_DISALLOWED_TOOLS = [
  CREATE_WORKFLOW_TOOL_NAME,
  // AmendWorkflow shares CreateWorkflow's alwaysAsk gate and nested-orchestration shape; same root cause, same list.
  AMEND_WORKFLOW_TOOL_NAME,
  // SaveWorkflow is listed for the **same** root cause: it also declares alwaysAsk, so in a child it would raise
  // a parent-invisible confirmation and hang until timeout. ListSavedWorkflows is absent — that ban's rationale is no dialog to show,
  // which never applies to read-only queries (same for the two run-introspection tools).
  SAVE_WORKFLOW_TOOL_NAME,
  // **Structural disable** — no nested orchestration inside a child. Resume means re-running the whole script (replaying finished
  // nodes, redispatching the rest), the same capability tier as a fresh CreateWorkflow; even once the no-dialog issue is gone,
  // nested orchestration (a child starting or reviving runs) stays closed.
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  // ResolveWorkflowQuestion is structurally disabled like ResumeWorkflowRun, but guards a different invariant:
  // escalation means the actor asks and whoever created the workflow answers.
  // Letting a child answer casually degrades return-the-judgment-to-the-gate-owner into actors
  // persuading each other — and an actor stuck behind the same gate is the least qualified to decide.
  //
  // Deliberately duplicates bootstrap's `ACTOR_DISALLOWED_TOOLS` (CreateWorkflow set the same two-list
  // precedent): that one trims the driver-side persona tool surface; this one covers every workflow child by taskType,
  // not trusting the driver to remember.
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
] as const;

/**
 * The runtime's final tool-disallow list: the turn-level `toolDisallowlist` plus taskType-derived structural disables.
 * Centralized here rather than at each child runtime's construction, because there are two construction sites
 * (workflow-facade.ts and script-workflow-child-runtime.ts) whose lists would inevitably drift.
 */
export function resolveRuntimeDisallowedTools(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  if (config.taskType !== "workflow_child") return config.toolDisallowlist;

  const disallowed = new Set(config.toolDisallowlist ?? []);
  for (const toolName of WORKFLOW_CHILD_DISALLOWED_TOOLS) disallowed.add(toolName);
  return [...disallowed];
}

/**
 * The dynamic-workflow switch as seen by registerBuiltInTools.
 * **Absent means on**: the TUI keeps the default tool surface; headless writes true/false from --enable-workflow,
 * protocol sessions are controlled by the trusted Host, and workflow_child inherits the parent. The fail-closed defaults live in the
 * headless entry and the protocol server's appRuntimePreferences, not in this layer.
 *
 * Centralized like resolveRuntimeDisallowedTools because registration has **two** entries
 * (initial assembly in helpers/runtime-tools.ts, branch refresh in methods/embedded-search-branch.ts);
 * both must apply the same rule, or a refresh could re-register disabled workflow tools.
 */
export function resolveRuntimeDynamicWorkflowToolsIncluded(config: AgentRuntimeConfig): boolean {
  return config.dynamicWorkflowEnabled !== false;
}

export function resolveBuiltInToolAllowlist(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const normalizedAllowlist = normalizeBuiltInToolAllowlist(config.toolAllowlist);

  if (config.toolset !== "explore") {
    return appendChildControlTool(config, normalizedAllowlist);
  }

  if (!normalizedAllowlist) {
    return appendChildControlTool(config, EXPLORE_AGENT_ALLOWED_TOOLS);
  }

  return appendChildControlTool(
    config,
    normalizedAllowlist.filter((toolName) => EXPLORE_AGENT_ALLOWED_TOOL_SET.has(toolName)),
  );
}

function appendChildControlTool(
  config: AgentRuntimeConfig,
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!allowlist) {
    return allowlist;
  }

  if (config.taskType === "subagent_child") {
    if (allowlist.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
      return allowlist;
    }
    // Explore intersects tools again before runtime registration, so child control tools must be restored into the final result.
    return [...allowlist, RESPOND_TO_COORDINATOR_TOOL_NAME];
  }

  // Workflow children have no allowlist narrowing (personas have no tool tiers; the surface only shrinks, see
  // bootstrap's workflow-actor-tools.ts); submit_result/escalate register via the includeSubmitResult/
  // includeEscalate gates, so nothing to restore here.
  return allowlist;
}

function normalizeBuiltInToolAllowlist(
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  return allowlist?.map((toolName) => normalizeToolNameAlias(toolName));
}
