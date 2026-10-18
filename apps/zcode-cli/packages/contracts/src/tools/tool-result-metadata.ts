import { z } from "zod";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "@zcode/shared";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CreateWorkflowCausalityGraphSchema,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
} from "./workflow-observation-display.js";

export const COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION = 1;
export const TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS = 64;
export const TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS = 2_000;
export const MCP_TOOL_DISPLAY_MAX_NAME_CHARS = 256;
export const MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS = 4 * 1024;
export const CUA_TARGET_APP_DISPLAY_META_KEY = "zcode.cua/target-app-display-v1" as const;

export const applicationIconLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("darwin-bundle-id"), value: z.string().trim().min(1).max(512) })
    .strict(),
  z
    .object({
      kind: z.literal("windows-executable-path"),
      value: z.string().trim().min(1).max(32_768),
    })
    .strict(),
  z.object({ kind: z.literal("windows-aumid"), value: z.string().trim().min(1).max(512) }).strict(),
]);

export const cuaTargetAppDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(512).optional(),
    iconLocators: z.array(applicationIconLocatorSchema).max(3),
  })
  .strict();

export const cuaRequestAccessStatusDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal("darwin"),
    grantOwner: z.string().trim().min(1).max(512),
    accessibility: z.enum(["granted", "stale", "denied"]),
    screenRecording: z.enum(["granted", "denied", "unknown"]),
  })
  .strict();

// CreateWorkflow display length caps and diagnostic-entry schema moved to create-workflow.ts
// (shared by the create_workflow and eval_workflow_snippet display payloads; keeping them here would cycle).

export const toolResultDisplayDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

export const fileDiffToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(toolResultDisplayDiffHunkSchema),
    truncated: z.boolean().optional(),
  })
  .strict();

export const localAgentMessageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export const taskStopToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  })
  .strict();

export const taskOutputToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS).optional(),
    output: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

export const respondToCoordinatorToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

export const cuaToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // Legacy v1 history duplicated ToolCallRow.input; accepted for replay compat only, new producers no longer write it.
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    targetApp: cuaTargetAppDisplaySchema.optional(),
    permissionStatus: cuaRequestAccessStatusDisplaySchema.optional(),
    media: z
      .array(
        z
          .object({
            mimeType: z.string().min(1),
            // Max base64 length for a 256 KiB source image; the overall budget is enforced by the projector.
            data: z.string().min(1).max(349_528).optional(),
            artifactUri: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * Target app identity of a node_repl cell (Computer Use). `appKey` is the producer-side form:
 * `darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<path>` / `linux-exe:<path>`；
 * The UI derives an `ApplicationIconLocator` from the prefix and resolves it via the platform service; the protocol carries no icon bytes.
 */
export const nodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const nodeReplImageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images is optional rather than min(1): pure-action CUA cells (click, type) have no screenshot yet must still project app identity.
    // The kind stays node_repl_images -- renaming would strip whole persisted rows in the strict union.
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: nodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

export const mcpToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    toolName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    description: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS).optional(),
    /**
     * Structured marker emitted when an official server MCP declares this call unavailable (quota exhausted / no Coding Plan).
     * Present only when the tool result is isError and the MCP is an official source; the UI surfaces a hint above the input box.
     * Same source as `code`: OFFICIAL_MCP_TOOL_ERROR_CODES in `@zcode/shared`.
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * ⚠ This field set is **frozen**. Extra keys on an existing kind do not mean `an old client reads one field less` -- the whole display
 * fails validation: the two real strict-parse sites (the packages/ui create-workflow renderer safeParse and
 * legacy v3's per-kind lookup) drop the entire tool result with it. Gate-specific facts always travel through the **tool input**
 * channel (schema-less on that side for every version); the saved source of reusable workflows works exactly that way.
 */
export const createWorkflowToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    // The tool-output boundary already caps size (see the graph schema in create-workflow.ts); display reuses that contract as-is.
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

// contracts is on zod v3, the App on v4; keep the same strict contract as shared/bash-output-display.ts.
const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();

export const toolResultDisplayPayloadSchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  fileDiffToolResultDisplayPayloadSchema,
  localAgentMessageToolResultDisplayPayloadSchema,
  taskStopToolResultDisplayPayloadSchema,
  taskOutputToolResultDisplayPayloadSchema,
  respondToCoordinatorToolResultDisplayPayloadSchema,
  cuaToolResultDisplayPayloadSchema,
  nodeReplImageToolResultDisplayPayloadSchema,
  mcpToolResultDisplayPayloadSchema,
  createWorkflowToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
]);

export type FileDiffToolResultDisplayPayload = z.infer<
  typeof fileDiffToolResultDisplayPayloadSchema
>;
export type LocalAgentMessageToolResultDisplayPayload = z.infer<
  typeof localAgentMessageToolResultDisplayPayloadSchema
>;
export type TaskStopToolResultDisplayPayload = z.infer<
  typeof taskStopToolResultDisplayPayloadSchema
>;
export type TaskOutputToolResultDisplayPayload = z.infer<
  typeof taskOutputToolResultDisplayPayloadSchema
>;
export type RespondToCoordinatorToolResultDisplayPayload = z.infer<
  typeof respondToCoordinatorToolResultDisplayPayloadSchema
>;
export type CuaToolResultDisplayPayload = z.infer<typeof cuaToolResultDisplayPayloadSchema>;
export type ApplicationIconLocator = z.infer<typeof applicationIconLocatorSchema>;
export type CuaTargetAppDisplay = z.infer<typeof cuaTargetAppDisplaySchema>;
export type CuaRequestAccessStatusDisplay = z.infer<typeof cuaRequestAccessStatusDisplaySchema>;
export type NodeReplImageToolResultDisplayPayload = z.infer<
  typeof nodeReplImageToolResultDisplayPayloadSchema
>;
export type McpToolResultDisplayPayload = z.infer<typeof mcpToolResultDisplayPayloadSchema>;
export type CreateWorkflowToolResultDisplayPayload = z.infer<
  typeof createWorkflowToolResultDisplayPayloadSchema
>;
export type NodeReplCuaAppDisplay = z.infer<typeof nodeReplCuaAppDisplaySchema>;

export type ToolResultDisplayPayload = z.infer<typeof toolResultDisplayPayloadSchema>;

export const toolResultSerializationMetadataSchema = z
  .object({
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative(),
    budgetStrategy: z.enum(["inline", "truncate", "artifact"]),
    artifactPath: z.string().min(1).optional(),
  })
  .strict();

export type ToolResultSerializationMetadata = z.infer<typeof toolResultSerializationMetadataSchema>;

export const completedToolPartMetadataSchema = z
  .object({
    schemaVersion: z.literal(COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION),
    display: toolResultDisplayPayloadSchema.optional(),
    serialization: toolResultSerializationMetadataSchema.optional(),
  })
  .passthrough();

export type CompletedToolPartMetadata = z.infer<typeof completedToolPartMetadataSchema>;

export function parseCompletedToolPartMetadata(
  input: unknown,
): CompletedToolPartMetadata | undefined {
  const scrubbed =
    isPlainRecord(input) && "display" in input
      ? { ...input, display: scrubPersistedDisplay(input.display) }
      : input;
  const result = completedToolPartMetadataSchema.safeParse(scrubbed);
  return result.success ? result.data : undefined;
}

export function parseToolResultDisplayPayload(
  input: unknown,
): ToolResultDisplayPayload | undefined {
  const result = toolResultDisplayPayloadSchema.safeParse(scrubPersistedDisplay(input));
  return result.success ? result.data : undefined;
}

/**
 * Uniform scrubbing before parsing.
 *
 * display is **persisted**: it lands in the tool part's `metadata.display`, every later read re-runs
 * strict validation, and the renderer keeps an equally strict mirror schema per frame. Stripping must therefore happen CLI-side,
 * before parsing -- the two entries above are the only choke point; v4 cold-start hydration and session-transcript replay both pass through.
 *
 * Each stripper handles only its own kind and touches only keys that are present; other kinds reach parsing untouched.
 */
function scrubPersistedDisplay(display: unknown): unknown {
  return stripProviderStopFromGetWorkflowRunError(stripWithdrawnRefinedNames(display));
}

/**
 * Strip `providerStop` from persisted get_workflow_run cards.
 *
 * Early producers wrote the model-channel-only `providerStop` into display, while the renderer's
 * mirror schema only ever accepted `{code, message}`, so those frames were rejected. Producers now emit
 * code / message only, but persisted parts are re-read on every cold start, so the strip has to live here.
 *
 * Only payloads with kind get_workflow_run, a plain-object error, and `providerStop` present are touched; errors without
 * the key and missing errors are returned as-is -- no undefined is invented.
 */
function stripProviderStopFromGetWorkflowRunError(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "get_workflow_run") return display;
  const error = display.error;
  if (!isPlainRecord(error) || !("providerStop" in error)) return display;
  const { providerStop: _dropped, ...rest } = error;
  return { ...display, error: rest };
}

/**
 * Strip withdrawn model-refinement fields.
 *
 * Persisted create_workflow displays may carry `refinedName` on lanes and phases and `refinedLabel` on
 * steps. All three fields were removed from the schema and both entries parse with `.strict()`: without
 * stripping, an old session's whole display (graph included) is rejected here, not just one name losing.
 *
 * Only create_workflow payloads carrying a causalityGraph are touched; other kinds reach parsing untouched. Only present
 * keys are changed -- no undefined is invented for absent `phases` and the like.
 */
function stripWithdrawnRefinedNames(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return display;
  const graph = display.causalityGraph;
  if (!isPlainRecord(graph)) return display;
  return {
    ...display,
    causalityGraph: {
      ...graph,
      ...("lanes" in graph ? { lanes: withoutKey(graph.lanes, "refinedName") } : {}),
      ...("steps" in graph ? { steps: withoutKey(graph.steps, "refinedLabel") } : {}),
      ...("phases" in graph ? { phases: withoutKey(graph.phases, "refinedName") } : {}),
    },
  };
}

function withoutKey(items: unknown, key: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isPlainRecord(item) || !(key in item)) return item;
    const { [key]: _dropped, ...rest } = item;
    return rest;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
