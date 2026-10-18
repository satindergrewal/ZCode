// ============================================================
// ListSavedWorkflows Tool Handler
// ============================================================
// Enumerate dwf definitions saved in this project (= session working directory).
//
// Distinct from ListWorkflowRuns, and both descriptions must say so: that one lists executed runs
// (history, stateful, runId), this one lists runnable definitions (catalog, stateless, named). The classic
// model mistake is asking "which workflows exist" as "which ran", then telling the user "you have
// no workflows" -- while five sit in the project.

import {
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  ListSavedWorkflowsInputJsonSchema,
  ListSavedWorkflowsInputSchema,
  ListSavedWorkflowsOutputJsonSchema,
  ListSavedWorkflowsOutputSchema,
  SAVED_WORKFLOW_PROJECT_DIR,
  type ListSavedWorkflowsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { listSavedWorkflows } from "./saved-workflows/index.js";

const LIST_SAVED_WORKFLOWS_TIMEOUT_MS = 10_000;
/** Like ListWorkflowRuns: the list stays light (one dir scan answers), 24k fits dozens with headroom. */
const LIST_SAVED_WORKFLOWS_MODEL_BYTES = 24_000;

const LIST_SAVED_WORKFLOWS_DESCRIPTION = [
  `Lists the dynamic workflows saved in this project (\`${SAVED_WORKFLOW_PROJECT_DIR}/\`, keyed on the session's working directory) and the global archive (\`~/.zcode/workflows\`, available from every project). These are workflow DEFINITIONS you can run, not past runs — for the run history use ListWorkflowRuns instead.`,
  "",
  "- Each row gives the name, what the workflow does, when to reach for it, and the arguments it takes.",
  "- Run one by passing its name to CreateWorkflow as `saved: { name, args }`. The user still confirms the run.",
  "- Check here before writing a workflow from scratch: if the project already saved one that fits, running it beats rebuilding it.",
  "- `invalid` lists saved files that could not be read (usually a hand-edited metadata block). They are named so they can be fixed, not silently skipped.",
].join("\n");

const listSavedWorkflowsHandler: ToolHandler = async (input, context) => {
  ListSavedWorkflowsInputSchema.parse(input);

  // cwd is always this session's working directory: the model may not scan across projects; also the
// precondition of `sideEffectScope: "none"`.

  return {
    workflows: entries,
    // Absent when empty: an empty array hangs a noise field on every call.
    ...(invalid.length > 0 ? { invalid } : {}),
  } satisfies ListSavedWorkflowsOutput;
};

/**
 * Model face: one XML-ish container, one block per workflow.
 *
 * Deliberately unlike ListWorkflowRuns' **single-line** attribute style: runs are high-cardinality
// low-information entities (50 look alike; attributes on one line fit), while a saved workflow carries
// description, when-to-use, and args -- what the model needs to **choose**; one line would crush it. Counts
// are far lower too (a few to dozens per project), so a few lines each is affordable.
 */
function formatListSavedWorkflowsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListSavedWorkflowsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListSavedWorkflows returned an invalid result.";

  const { workflows, invalid } = parsed.data;

  if (workflows.length === 0 && invalid === undefined) {
    // "No workflow saved in this project" must be one sentence: an empty container reads as "the tool failed".
    return [
      '<saved_workflows count="0">',
      `No workflows are saved in this project yet. Saved definitions live in ${SAVED_WORKFLOW_PROJECT_DIR}/.`,
      "</saved_workflows>",
    ].join("\n");
  }

  const blocks = workflows.map((workflow) => {
    const lines = [
      `<workflow name="${escapeAttribute(workflow.name)}" scope="${workflow.scope}">`,
      `  ${workflow.description}`,
    ];
    if (workflow.whenToUse !== undefined) lines.push(`  When to use: ${workflow.whenToUse}`);
    for (const [key, spec] of Object.entries(workflow.args ?? {})) {
      const notes = [
        spec.type,
        spec.required === true ? "required" : undefined,
        spec.default === undefined ? undefined : `default ${JSON.stringify(spec.default)}`,
      ].filter((note) => note !== undefined);
      const description = spec.description === undefined ? "" : ` — ${spec.description}`;
      lines.push(`  arg ${key} (${notes.join(", ")})${description}`);
    }
    lines.push("</workflow>");
    return lines.join("\n");
  });

  const invalidLines = (invalid ?? []).map(
    (entry) => `<invalid path="${escapeAttribute(entry.path)}">${entry.reason}</invalid>`,
  );

  return [
    `<saved_workflows count="${workflows.length}">`,
    ...blocks,
    ...invalidLines,
    "</saved_workflows>",
  ].join("\n");
}

/** Name and path go in attribute slots: both may contain quotes (paths especially); unescaped would make malformed tags. */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export const listSavedWorkflowsToolEntry: ToolEntry = {
  capability: "List the reusable dynamic-workflow definitions saved in this project",
  metadata: {
    name: LIST_SAVED_WORKFLOWS_TOOL_NAME,
    description: LIST_SAVED_WORKFLOWS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    maxOutputBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listSavedWorkflowsHandler,
  inputSchema: ListSavedWorkflowsInputJsonSchema,
  outputSchema: ListSavedWorkflowsOutputJsonSchema,
  runtimeInputSchema: ListSavedWorkflowsInputSchema,
  runtimeOutputSchema: ListSavedWorkflowsOutputSchema,
  formatModelContent: formatListSavedWorkflowsModelContent,
  permission: {
    permission: "listSavedWorkflows",
    reason: "ListSavedWorkflows reads the saved workflow definitions of the current project",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // No path subject in the input (cwd comes from session context), so the pattern matches by tool name only.
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Deliberately NOT inheriting SaveWorkflow/CreateWorkflow alwaysAsk: those gates exist for
    // "writes the user's repo" and "runs a block of code"; reading a list is neither.
  },
  resultBudget: {
    maxInlineBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    maxModelBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    maxMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "ListSavedWorkflows scans the project's workflow directory synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
