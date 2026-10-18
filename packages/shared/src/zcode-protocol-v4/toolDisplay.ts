// Display-layer schemas for zcode-protocol-v4 toolCall.
// Split from rows.ts: after additions on both sides, rows.ts tripped oxlint max-lines(400).
// This file holds only the display union, independent of rowBaseFields; rows depends on it one-way, no cycle.
import { z } from "zod";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
import { timestampSchema } from "./core.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "../official-mcp-tool-error.js";
import { cuaRequestAccessStatusSchema } from "./cuaPermission.js";
import { mcpToolDisplayUiSchema } from "../mcp-apps/schemas.js";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import {
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
} from "./workflow-observation-display.js";

// Structured display model for terminal toolCall output (ported from feat; CUA tools ride the kind:"cua" branch to carry
// errorCode/suggestedAction/media(screenshot) structured content to the renderer). Before consume-main landed
// this union + the toolOutputSchema.display field, protocol zod stripped the agent's display entirely, so
// the UI never saw display?.kind=="cua" and CUA tool calls degraded to fallback rendering.
const toolResultDisplaySchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  z.object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(
      z.object({
        oldStart: z.number().int(),
        oldLines: z.number().int(),
        newStart: z.number().int(),
        newLines: z.number().int(),
        lines: z.array(z.string()),
      }),
    ),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  }),
  z.object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // Legacy v1 snapshots duplicated ToolCallRow.input; accepted for history replay only.
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    permissionStatus: cuaRequestAccessStatusSchema.optional(),
    targetApp: z
      .object({
        schemaVersion: z.literal(1),
        displayName: z.string().trim().min(1).max(512).optional(),
        iconLocators: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("darwin-bundle-id"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-executable-path"),
                  value: z.string().trim().min(1).max(32_768),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-aumid"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
            ]),
          )
          .max(3),
      })
      .strict()
      .optional(),
    media: z
      .array(
        z.object({
          mimeType: z.string().min(1),
          data: z.string().min(1).max(349_528).optional(),
          artifactUri: z.string().min(1).optional(),
        }),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    // Same source as toolCallMcpDisplaySchema: undeclared here, zod silently strips the agent's unavailable,
    // and the official MCP quota notice dies on the v4 path (same display-strip trap as the file header).
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    // Plugin UI metadata; shared by source with the CLI contracts' mcpToolResultDisplayPayloadSchema, see mcp-apps/schemas.ts.
    ui: mcpToolDisplayUiSchema.optional(),
  }),
  // buildToolOutput puts the CLI's ToolResultDisplayPayload into toolOutput.display verbatim, and this union
  // is strict -- create_workflow missing from the members and CreateWorkflow's display is rejected/stripped, the card a plaintext stump.
  // Both member lists must stay in sync (also contracts' toolResultDisplayPayloadSchema), so reuse the toolCall-side shape directly.
  // toolResultDisplayPayloadSchema), so reuse the toolCall-side shape directly.
  toolCallCreateWorkflowDisplaySchema,
  // The five observation-class workflow tool display kinds plus ResumeWorkflowRun's resume card (as above: sync with contracts,
  // a missing member strips the whole block).
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolResultDisplay = z.infer<typeof toolResultDisplaySchema>;

// 4.4.5 toolCall. Terminal output truncates head+tail at every level (R-10); overflow fetches via truncated.ref on demand.
//
// Warning: display is **ungated at the envelope layer** (`.optional().catch(undefined)`): a parse miss degrades to "this card has
// no payload" instead of failing the row, frame, or subscription. Four embed points share the rule -- this file's
// toolOutputSchema, rows.ts' toolCallRow, snapshot.ts' confirm preview, workflow-row-meta.ts' launch-row graph;
// spec: docs/v4-refactor/10-protocol-spec.md 4.4.5 and
// docs/v4-refactor/04-sync-and-recovery.md closure rule 11.
//
// Root cause (2026-09-21, sess_4142de31): display is decorative yet lived in the liveness-critical envelope. The CLI added
// two lineage keys to `list_workflow_runs` run rows; the mirror here lagged => the whole frame was rejected as
// `proto.frameAssemblyInvalidPayload` => the recovery ladder retried the same content => the session stalled in
// `fault.subscription.recoveryFailed`; every snapshot replayed the same stale payload, so it never self-healed. The same incident
// hit 2026-09-17 (`get_workflow_run`'s `providerStop`); back then only that one field got fixed.
//
// Strictness is not lost, just back at the right layer: the renderer's readToolResultDisplay
// (packages/ui/src/ToolCallBlocks/toolResultDisplay.ts) already strict-parses per kind, undefined on failure,
// card degrades to plaintext -- exactly what every spec promised. The envelope gate was a duplicate second
// gate whose only unique effect was killing sessions.
//
// Member schemas stay `.strict()`: they define the shapes this side knows; catch demotes unknown from fatal to
// cardless. The price is silent skew, compensated by producer/mirror parity tests, not by wire-subscriber discovery.
export const toolOutputSchema = z.object({
  text: z.string(),
  display: toolResultDisplaySchema.optional().catch(undefined),
  truncated: z
    .object({
      totalBytes: z.number(),
      ref: z.string(),
    })
    .optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;

// Progress while the tool runs: MCP `notifications/progress` projected onto the row via ToolCallProgress events.
// fraction derives from payload progress/total (none when total is missing); bytes / previewLine stay reserved for shell-output-style progress.
export const toolProgressSchema = z.object({
  bytes: z.number().optional(),
  previewLine: z.string().optional(),
  fraction: z.number().min(0).max(1).optional(),
  total: z.number().optional(),
  message: z.string().max(200).optional(),
  updatedAt: timestampSchema,
});
export type ToolProgress = z.infer<typeof toolProgressSchema>;

/**
 * Target app identity of a node_repl cell (the Computer Use card icon). Must mirror the CLI contracts'
 * `nodeReplCuaAppDisplaySchema` exactly -- both sides strict; one missing field strips the whole display.
 */
const toolCallNodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const toolCallNodeReplImageDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images optional: a pure-action CUA cell has no screenshot yet still carries app identity. The kind name is frozen --
    // a rename would fail persisted rows wholesale inside this strict union.
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
    app: toolCallNodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

const toolCallTaskOutputDisplaySchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

const toolCallRespondToCoordinatorDisplaySchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

const toolCallMcpDisplaySchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    /**
     * Structured marker emitted when official Server MCP deems the call unavailable (quota exhausted / no Coding Plan).
     * The CLI fills it only for official-source + isError; the UI raises the notice above the input box from it.
     * Must stay in sync with the CLI contracts' mcpToolResultDisplayPayloadSchema -- both strict,
     * one missing member fails the whole row.
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    ui: mcpToolDisplayUiSchema.optional(),
  })
  .strict();

export const toolCallDisplaySchema = z.discriminatedUnion("kind", [
  toolCallNodeReplImageDisplaySchema,
  toolCallTaskOutputDisplaySchema,
  toolCallRespondToCoordinatorDisplaySchema,
  toolCallMcpDisplaySchema,
  toolCallCreateWorkflowDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolCallDisplay = z.infer<typeof toolCallDisplaySchema>;
