/**
 * Name-based detection for the workflow tool family; consolidates matchers that used to be
 * duplicated per call site:
 * - Reusable workflows: `SaveWorkflow` / `ListSavedWorkflows`
 * - Escalation Q&A: `escalate` / `ResolveWorkflowQuestion`
 * - Observe and resume: `GetWorkflowRun` / `ListWorkflowRuns` / `EvalWorkflowSnippet` / `ResumeWorkflowRun`
 * - Model catalog: `ListModels`.
 *
 * Why not `resolveToolCallIdentity`: none of these names are in packages/shared's
 * `ZCODE_KNOWN_TOOL_NAMES`, so identity only returns `unknown` and dispatch falls into the
 * raw-JSON fallback card.
 *
 * These checks must also run **before** family dispatch: the `workflow` family fallback is the
 * CreateWorkflow card (`resolveRenderer.ts`) and the run-confirm block (`PermissionDialog.tsx`);
 * once these names get registered in the workflow family, save/list would silently render as
 * "create workflow" -- the save confirm dialog would even grow a causal graph and a Refine option.
 * Checking by name first keeps both the registered and unregistered worlds correct.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  // Same normalization as cron-create.tsx: strip case and separators so both wire spellings
  // (`SaveWorkflow` / `save_workflow`) match.
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

interface WorkflowToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

function matchesToolName(source: WorkflowToolNameSource, token: string): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === token,
  );
}

export function isSaveWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "saveworkflow");
}

export function isListSavedWorkflowsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listsavedworkflows");
}

export function isEscalateToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "escalate");
}

export function isResolveWorkflowQuestionToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resolveworkflowquestion");
}

export function isGetWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "getworkflowrun");
}

export function isListWorkflowRunsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listworkflowruns");
}

export function isEvalWorkflowSnippetToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "evalworkflowsnippet");
}

export function isResumeWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resumeworkflowrun");
}

/**
 * Model catalog. Same name-based check: `ListModels` is also missing from the known-tool table,
 * and the fallback card would dump that providerId-prefixed model text verbatim.
 */
export function isListModelsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listmodels");
}

/**
 * Create entry. Renderer dispatch still goes through the `workflow` family (its fallback is the
 * create card); this name check exists for readers that bypass dispatch: draft-number linking in
 * compile feedback must recognize every creation in the line window, while the family counts amendments too.
 */
export function isCreateWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "createworkflow");
}

/**
 * Amend entry. It **is registered** in the workflow
 * family (the confirm dialog picks the run-confirm block by family), but the tool row still checks
 * by name first: the same create-workflow renderer swaps in amendment wording instead of the family
 * fallback drawing a plain "create workflow" card.
 */
export function isAmendWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "amendworkflow");
}
