// ============================================================
// The workflow actor's tool surface (AgentRuntime tool config)
// ============================================================
//
// The subagent tool surface must land on the child runtime's tool registration, or the live transcript
// shows even judge actors carrying the full interaction toolset. Two risk classes:
//   1. Hanging: AskUserQuestion / EnterPlanMode in a headless child has no one to answer; the turn never ends;
//      Since 2026-09-23 AskUserQuestion reaches the user via the parent session, returned to the subagent (see the subtraction-table note);
//   2. Escalation/recursion: CreateWorkflow lets an actor submit another workflow; ReadSessionContext reads across into the parent session.
// This module is that missing subtraction, applied by the driver-side runtime factory when building the AgentRuntime.
//
// No per-persona tool tiers: every actor gets the full work toolset minus the table below;
// "judges don't edit files" is said in the ask text -- ordinary subagents work the same way (Explore keeps Bash,
// read-only enforced by prompt).

import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_SESSION_CONTEXT_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
} from "@zcode/contracts";

/** The tool-surface slice of AgentRuntimeConfig. */
interface WorkflowActorToolPolicy {
  toolDisallowlist: readonly string[];
}

/**
 * Removed from the full set: the plan pair — subagents do not hold plans for approval; CreateWorkflow would have an actor recurse
 // into submitting workflows; ReadSessionContext reads across into the parent. The rest (Bash / Edit / Write / search / web) stay —
 // the actor is there to work.
 *
 * AskUserQuestion is not in the table: it flows via PermissionRequested through the parent-runtime-derived broker and the parent mirror
 // into the confirm dialog (docs/dynamic-workflow/launch.md "Permissions inside a run"), no longer dangling.
 */
const ACTOR_DISALLOWED_TOOLS: readonly string[] = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  "CreateWorkflow",
  // The revision entry uses the same nested orchestration as CreateWorkflow; same root cause, same list.
  "AmendWorkflow",
  READ_SESSION_CONTEXT_TOOL_NAME,
  // A subagent never answers escalation questions for the main agent (dynamic-workflow docs/execution-engine.md "Escalation").
  // Different root cause from the above: not an over-privileged read but identity — the entire point of escalation is handing the judgment
  // judgment to whoever created this workflow; a drive-by answer from another actor quietly degrades it to actors
  // persuading each other. Actors ask via `escalate` (always registered); answers belong to the main session.
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
];

/**
 * The workflow actor's AgentRuntime tool configuration. Pure function for the driver-side runtime factory to fold into
 * AgentRuntimeConfig: no narrowing beyond plan and the out-of-scope metatools.
 *
 * Covers builtin tools only; MCP/plugin tool filtering waits for the production wiring (same factory seam).
 */
export function workflowActorToolPolicy(): WorkflowActorToolPolicy {
  return { toolDisallowlist: ACTOR_DISALLOWED_TOOLS };
}
