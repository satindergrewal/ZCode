// ============================================================
// Tools Index - Core tool definitions
// ============================================================

// Re-export all tool types
export * from "./contract.js";
export * from "./json-schema.js";
export * from "./read.js";
export * from "./write.js";
export * from "./edit.js";
export * from "./apply-patch.js";
export * from "./bash.js";
export * from "./node-repl.js";
export * from "./glob.js";
export * from "./grep.js";
export * from "./webfetch.js";
export * from "./agent.js";
export * from "./skill.js";
export * from "./todo.js";
export * from "./automation.js";
export * from "./off-peak.js";
export * from "./target.js";
export * from "./plan-mode.js";
export * from "./ask-user-question.js";
export * from "./send-message.js";
export * from "./respond-to-coordinator.js";
export * from "./task-output.js";
export * from "./task-stop.js";
export * from "./read-session-context.js";
export * from "./submit-result.js";
export * from "./websearch.js";
export * from "./workflow.js";
export * from "./create-workflow.js";
// Revision entries: the name constants are consumed by core's
// dispatch, the permission service's owner rules, bootstrap's actor disable list, and the TUI/headless bypass.
export * from "./amend-workflow.js";
export * from "./workflow-settings.js";
export * from "./saved-workflow.js";
export * from "./save-workflow.js";
export * from "./list-saved-workflows.js";
// Discovery surface for the dwf selection: the name constants are consumed by core's tool registration and
// bootstrap's actor disable list; without these lines those consumers get no schema and no LIST_MODELS_TOOL_NAME.
export * from "./list-models.js";
export * from "./eval-workflow-snippet.js";
export * from "./list-workflow-runs.js";
export * from "./get-workflow-run.js";
// Resume entry, same family as the two introspection tools (run_id key, same port-probe failure); without this line consumers get no
// schema and no RESUME_WORKFLOW_RUN_TOOL_NAME constant, and core's name-based dispatch silently breaks.
export * from "./resume-workflow-run.js";
// The two tool surfaces of upgrade Q&A: actor-side escalate and the main agent's
// ResolveWorkflowQuestion. The name constants are consumed by core's allowlist-restore logic and bootstrap's actor
// disable list; dropping these lines breaks both silently (same note as resume-workflow-run).
export * from "./escalate.js";
export * from "./resolve-workflow-question.js";
// 留白补全（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：名字常量被 core 的注册、
// 权限服务的 owner 规则、workflow child 的禁用名单与 display 分派读走。
export * from "./fill-workflow-hole.js";
export * from "./workflow-observation-display.js";
export * from "./tool-result-metadata.js";
export * from "./performance.js";

// Shared types (only once to avoid duplicates)
export type { DiffHunk, GitDiff } from "./write.js";
