import { replyToChannelToolEntry } from "./reply-to-channel.js";
// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  type JsonSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { webFetchToolEntry } from "./webfetch.js";
import { webSearchToolEntry } from "./websearch.js";
import {
  agentToolEntry,
  createAgentToolEntry,
  createTaskToolEntry,
  taskToolEntry,
} from "./agent.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { skillToolEntry } from "./skill.js";
import { todoReadToolEntry, todoWriteToolEntry } from "./todo.js";
import {
  cronCreateToolEntry,
  cronDeleteToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
} from "./cron.js";
import { offPeakCreateToolEntry, offPeakListToolEntry } from "./off-peak.js";
import {
  createEnterPlanModeToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "./plan-mode.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { sendMessageToolEntry } from "./send-message.js";
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";
import { createSubmitResultToolEntry, submitResultToolEntry } from "./submit-result.js";
import { escalateToolEntry } from "./escalate.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { fillWorkflowHoleToolEntry } from "./fill-workflow-hole.js";
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readSessionContextToolEntry } from "./read-session-context.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
// import { workflowToolEntry } from "./workflow.js";
import { createToolRuleNameSet } from "../tool-visibility.js";

// The direct branch keeps the Glob/Grep implementations; on the embedded-search branch registerBuiltInTools
// hides Glob/Grep uniformly, with Bash find/grep taking over search.

export const builtInTools: ToolEntry[] = [
  readToolEntry,
  writeToolEntry,
  editToolEntry,
  // applyPatchToolEntry,
  bashToolEntry,
  globToolEntry,
  grepToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
  askUserQuestionToolEntry,
  sendMessageToolEntry,
  respondToCoordinatorToolEntry,
  submitResultToolEntry,
  // The actor escalation channel. Structurally identical to submit_result:
  // registered when the port exists (includeEscalate); under `tools:"none"` the workflow_child allowlist
  // restore logic brings it back. Not on the actor default denylist — the actor most likely to hit an unseen wall is
  // exactly the one its author did not flag.
  escalateToolEntry,
  taskOutputToolEntry,
  taskStopToolEntry,
  readSessionContextToolEntry,
  replyToChannelToolEntry,
  agentToolEntry,
  taskToolEntry,
  skillToolEntry,
  jsToolEntry,
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  // Saved definitions: write side gated like CreateWorkflow (alwaysAsk), read side ungated.
  saveWorkflowToolEntry,
  // The workflow-authoring experiment channel: synchronous, read-only (v1), fully transient.
  evalWorkflowSnippetToolEntry,
  // The two read-only run-introspection tools: always-on, ungated. Not in WORKFLOW_CHILD_DISALLOWED_TOOLS —
  // that ban exists because CreateWorkflow alwaysAsk has no dialog in a child runtime; read-only queries do not apply.
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  // The run resume entry: kin to the two read-only introspection tools (run_id key, same port-probe failure), but it is
  // execution semantics — alwaysAsk mandatory outside yolo (cancelled is the user explicit stop; revival must ask first),
  // so it belongs in WORKFLOW_CHILD_DISALLOWED_TOOLS (child yolo has no dialog). After GetWorkflowRun: the run tools list/get/resume sit together.
  resumeWorkflowRunToolEntry,
  // The main-agent side of escalation Q&A: kin to the three run tools above —
  // same dwf run port, same typeof-probe failure. The difference is downstream: it joins the actor-session
  // denylist (bootstrap workflowActorToolPolicy); subagents must not answer for the main agent.
  resolveWorkflowQuestionToolEntry,
  // The main-agent side of hole filling (docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"): kin of
  // ResolveWorkflowQuestion (same run port, same typeof-probe fallback), but it writes script — sharing AmendWorkflow's
  // alwaysAsk gate and owner-exemption rule, and joining its disable list in the workflow child.
  fillWorkflowHoleToolEntry,
  // The definition list (distinct from the two run tools: those are history, this is runnable). Also read-only, ungated.
  listSavedWorkflowsToolEntry,
  // The model catalog: a likewise read-only, ungated discovery surface for the
  // `subagent_model` of CreateWorkflow / AmendWorkflow. Not in WORKFLOW_CHILD_DISALLOWED_TOOLS
  //  — that ban exists because alwaysAsk has no dialog in a child; read-only queries do not apply.
  listModelsToolEntry,
  // workflowToolEntry,
];

/**
 * The eleven tools not registered while the dynamic-workflow gradation gate is off
 * (FillWorkflowHole included since 2026-09-28: with the gate off, no run reaches a hole).
 * Gate-off means no way to start a workflow at all, so create, amend, save, the snippet experiment and the four
 * run-facing tools come down together; read-only run introspection too — offline it only points at history no longer actionable.
 * `ListModels` too: its only use is picking a run `subagent_model`; with no CreateWorkflow to fill it just points at a absent tool.
 * The legacy `Workflow` tool (the `/expert` script channel) is a different feature, **not** on this list.
 */
const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
]);

/** One of the ten gate-gated workflow tools? Used when cold restore infers activation from history (launch.md "On demand: activation"). */
export function isDynamicWorkflowToolName(toolName: string): boolean {
  return DYNAMIC_WORKFLOW_TOOL_NAMES.has(toolName);
}

interface RegisterBuiltInToolsOptions {
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  includeSubmitResult?: boolean;
  /**
   * When present, submit_result registers a typed declaration (`{ result: <schema> }`, strict-eligible) for dwf mono
   * subagents; absent, the generic declaration. Meaningful only while includeSubmitResult holds.
   */
  submitResultSchema?: JsonSchema;
  /** The actor escalation channel; gated like includeSubmitResult (registered only with WorkflowEscalatePort injected). */
  includeEscalate?: boolean;
  includeWorkflow?: boolean;
  includeAutomation?: boolean;
  /** In-session Off-Peak creation tools; driven by the host offPeakToolEnabled flag (rollout/remote gate). */
  includeOffPeak?: boolean;
  /**
   * The dynamic-workflow gate. **Only an explicit false
   * takes the tools down** (DYNAMIC_WORKFLOW_TOOL_NAMES): absence means the caller is outside the rollout (TUI, headless,
   * workflow_child) and keeps every tool; the fail-closed default lives in the protocol server
   * appRuntimePreferences, not in this layer.
   */
  includeDynamicWorkflow?: boolean;
  /** node_repl (js) is off by default; the official browser-use plugin enables it. */
  includeNodeRepl?: boolean;
  /** browser-use docs and agent.browsers injection are enabled jointly by the official browser-use plugin and the host browser bridge. */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}

export function registerBuiltInTools(
  registry: {
    register(entry: ToolEntry, options?: { silentDuplicateWarning?: boolean }): void;
  },
  options: RegisterBuiltInToolsOptions = {},
): void {
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowedTools = createToolRuleNameSet(options.disallowedTools);

  for (const entry of builtInTools) {
    if (
      options.embeddedSearchEnabled === true &&
      (entry.metadata.name === "Glob" || entry.metadata.name === "Grep")
    ) {
      continue;
    }
    if (allowedTools && !allowedTools.has(entry.metadata.name)) {
      continue;
    }
    if (disallowedTools?.has(entry.metadata.name)) {
      continue;
    }
    if (isSubagentDispatchToolName(entry.metadata.name) && options.includeAgent !== true) {
      continue;
    }
    if (entry.metadata.name === "Skill" && options.includeSkill === false) {
      continue;
    }
    if (entry.metadata.name === "SendMessage" && options.includeSendMessage !== true) {
      continue;
    }
    if (
      entry.metadata.name === "RespondToCoordinator" &&
      options.includeRespondToCoordinator !== true
    ) {
      continue;
    }
    if (entry.metadata.name === "submit_result" && options.includeSubmitResult !== true) {
      continue;
    }
    if (entry.metadata.name === "escalate" && options.includeEscalate !== true) {
      continue;
    }
    if (entry.metadata.name === "Workflow" && options.includeWorkflow !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "CronCreate" ||
        entry.metadata.name === "CronList" ||
        entry.metadata.name === "CronUpdate" ||
        entry.metadata.name === "CronDelete") &&
      options.includeAutomation !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "OffPeakCreate" || entry.metadata.name === "OffPeakList") &&
      options.includeOffPeak !== true
    ) {
      continue;
    }
    if (
      options.includeDynamicWorkflow === false &&
      DYNAMIC_WORKFLOW_TOOL_NAMES.has(entry.metadata.name)
    ) {
      continue;
    }
    if (entry.metadata.name === "js" && options.includeNodeRepl !== true) {
      continue;
    }
    registry.register(resolveBuiltInToolEntryForBranch(entry, options), {
      silentDuplicateWarning: options.silentDuplicateWarnings,
    });
  }
}

function resolveBuiltInToolEntryForBranch(
  entry: ToolEntry,
  options: RegisterBuiltInToolsOptions,
): ToolEntry {
  if (entry.metadata.name === "Bash") {
    return createBashToolEntry({
      bashTimeoutPolicy: options.bashTimeoutPolicy,
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === SUBMIT_RESULT_TOOL_NAME && options.submitResultSchema !== undefined) {
    return createSubmitResultToolEntry(options.submitResultSchema);
  }
  // The gate shapes tool presence and **descriptions** alike: the Agent / Task description sends workflow requests to
  // `CreateWorkflow`; when off, that tool is absent and the stale line points at a nonexistent tool. Same
  // `options.includeDynamicWorkflow` as the registration filter, so initial assembly and branch refresh always agree.
  if (entry.metadata.name === "Agent") {
    return createAgentToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "Task") {
    return createTaskToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "EnterPlanMode") {
    return createEnterPlanModeToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === "js") {
    return createJsToolEntry({
      browserUseEnabled: options.includeBrowserUse === true,
    });
  }
  return entry;
}
