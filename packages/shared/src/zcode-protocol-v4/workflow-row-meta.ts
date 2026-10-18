// ============================================================
// Row-level metadata of workflow rounds (turnHeader / userInput members of rows.ts)
// ============================================================
// Split from rows.ts: the notification manifest, background-result attribution, and direct-launch triples pushed rows.ts past
// its max-lines cap (same precedent as create-workflow-display.ts--feature-level schemas get their own module).
// Public names unchanged: rows.ts re-exports as-is; both the @zcode/shared barrel and relative imports keep working.

import { z } from "zod";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

// Structured payload of workflow notifications.
// Minted and bounded at the emitter; never parsed back from model-facing notice text. Bounding rule: the payload rides the
// turnHeader row through protocol + snapshot with honest truncation (resultTruncated / count!=shown => the preview is partial;
// full data is fetchable via run id). Batch rounds deliberately carry none (one manifest per round does not hold under batching).
export const workflowNotificationMetaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal"),
    status: z.enum(["completed", "errored", "stopped"]),
    // Present only when `status === "stopped"`.
    stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
    summary: z.string().min(1).max(500),
    result: z.string().max(4000).optional(),
    resultForm: z.enum(["prose", "json"]).optional(),
    resultTruncated: z.literal(true).optional(),
    error: z.string().max(2000).optional(),
    reports: z
      .object({
        count: z.number().int().nonnegative(),
        shown: z.number().int().nonnegative(),
        preview: z.array(z.string().max(500)).max(8),
      })
      .optional(),
    // Chips payload of user-facing artifacts.
    // Terminology: artifact here is what the script published to the user via `artifact.*`, unrelated to
    // `result` on the same payload (the script top-level return, also called artifact inside the engine).
    // Only chip-renderable fields: byte count / entry count are visible after opening the side panel, not on the chip.
    // Cap 8; beyond it (including kind-filtered ones) sets artifactsTruncated; title's 120 matches
    // ARTIFACT_CAPS.maxTitleLength, truncated emitter-side.
    // Exception: the deliverable (`primary`) entry also carries `description` (<= 500, same as ARTIFACT_CAPS), because
    // the completion card draws it as a one-line deliverable and on cold transcripts only this payload is readable. List primary first.
    artifacts: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
          title: z.string().max(120).optional(),
          version: z.number().int().positive(),
          contentType: z.string().max(255).optional(),
          primary: z.literal(true).optional(),
          description: z.string().max(500).optional(),
        }),
      )
      .max(8)
      .optional(),
    artifactsTruncated: z.literal(true).optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("escalation"),
    qid: z.string().min(1),
    actor: z.string().min(1),
    question: z.string().min(1).max(4000),
    context: z.string().max(4000).optional(),
    askedAt: z.number().optional(),
  }),
  // Run-level stall: one entry per stall segment; not a terminal state.
  z.object({
    kind: z.literal("stall"),
    sinceMs: z.number().int().nonnegative(),
    reason: z.string().max(64).optional(),
    cap: z.number().int().nonnegative().optional(),
  }),
]);
export type WorkflowNotificationMeta = z.infer<typeof workflowNotificationMetaSchema>;

export const backgroundResultOriginMetaSchema = z.object({
  // The three values stay in sync with contracts' BackgroundResultOriginMeta.
  // "workflow" is a dynamic-workflow run (workId == runId) reusing the whole background-notice pipeline.
  backgroundSource: z.enum(["bash", "subagent", "workflow"]),
  workId: z.string().min(1),
  title: z.string().min(1),
  // Present only on single-notice rounds with backgroundSource === "workflow"; zod strips unknown keys,
  // so omitting it here silently drops the whole chain--this field is the manifest's only data source.
  workflowNotification: workflowNotificationMetaSchema.optional(),
});
export type BackgroundResultOriginMeta = z.infer<typeof backgroundResultOriginMetaSchema>;

// Launch metadata of direct launches.
// The GUI uses the hub's Run to start a saved workflow in a new session; the agent mints one controlOnly round;
// that round's turnHeader and userInput both project with origin: "workflowLaunch", each carrying this metadata.
// Cold recovery (message metadata) and live projection (TurnStarted payload) share the same copy, cold hot-identical.
 // Bounding rule matches workflowNotificationMetaSchema: emitter-minted, bounded, honest truncation--
// full script/diagnostics are fetchable via runId in the detail side panel; the card draws only this fixed-length summary.
// Deliberately not reusing backgroundResultOriginMeta's backgroundSource shape: that means "background notice attribution",
// this means "user-launched from the hub"; different semantics, separate shapes so cross-evolution cannot drag either.
const workflowSubagentModelTextSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength);

// Settings round: the user changed settings in the run card / detail page "Configure",
// the agent revised out a new run from the same script, and records it with a controlOnly round shaped like a direct launch.
// This block says **what changed**: only changed settings appear; a missing from/to end means that end is the default
// (model = session model, cap = host cap). `ceiling` is the host cap, for readings like "13 -> 4".
export const workflowSettingsAmendMetaSchema = z.object({
  // Revised from which run. **Absent = applied in place**: a cap-only change on an in-flight
  // run neither stops it nor starts another, so there is no predecessor--`runId` is the adjusted
  // one itself. Renderers show only that row, no extra card (two cards for one run reads as two runs).
  // Optional; producer and consumer must share the schema to parse in-place adjustment records.
  predecessorRunId: z.string().min(1).max(128).optional(),
  subagentModel: z
    .object({
      from: workflowSubagentModelTextSchema.optional(),
      to: workflowSubagentModelTextSchema.optional(),
    })
    .optional(),
  maxConcurrency: z
    .object({
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
    })
    .optional(),
  ceiling: z.number().int().positive().optional(),
});
export type WorkflowSettingsAmendMeta = z.infer<typeof workflowSettingsAmendMetaSchema>;

export const workflowLaunchMetaSchema = z.object({
  // runId == workId: joins the launch-round run card's live state / step count, and the cancel/resume/detail-side-panel keys.
  runId: z.string().min(1).max(128),
  // launch-<uuid> prefix (distinct from model tool-call ids); the same id as the synthesized CreateWorkflow toolCall.
  toolCallId: z.string().min(1).max(128),
  // Workflow name from the resolution (agent-filled; neither user nor model may rename). Always present on hub launches; a settings
  // round takes the adjusted run's own name, absent if never named--card and side panel fall back like any unnamed run,
  // never titling with a run id.
  name: z.string().min(1).max(200).optional(),
  // scope / path belong to hub launches only: a settings round (the `amend` below) revises an existing run with no saved file to point at.
  // Recorded skew: legacy desktops require them, so a new CLI's settings round fails the parse there and the row drops (same tier as
  // the origin closed-enum addition); hub-launch rounds always carry both, unaffected.
  scope: z.enum(["project", "global"]).optional(),
  // Resolved script path on disk; detail/diagnostics only, not shown on the card. 1024 covers deep global/project paths.
  path: z.string().min(1).max(1024).optional(),
  // Argument key-value map (the card's render source). Bounded: serialized <= 4KB, same bound as contracts' TurnStartedPayload,
  // keeping whole large objects out of every persisted message and live event.
  args: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= 4096, {
      message: "workflowLaunch.args JSON must be ≤ 4096 bytes",
    })
    .optional(),
  // Description line (if any); same copy as the args pane / hub card, 500 matching the notice summary bound.
  description: z.string().max(500).optional(),
  // Pre-launch compiled create_workflow display (bounded causal graph + diagnostics): the run detail side panel locates the
  // "initiating row" by toolCallId for the graph; direct launches have no tool row, so the graph comes from here. Same schema as the tool-row display.
  // Also ungated: a display parse failure just leaves this row graphless, never rejecting the frame (see toolDisplay.ts).
  display: toolCallCreateWorkflowDisplaySchema.optional().catch(undefined),
  // The exact script text this run executes (side panel Script section), mirroring the tool row's input.script; bound equal to contracts'
  // WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS.
  script: z.string().max(256_000).optional(),
  // Settings rounds only: which run this was revised from via "Configure", and what changed.
  amend: workflowSettingsAmendMetaSchema.optional(),
});
export type WorkflowLaunchMeta = z.infer<typeof workflowLaunchMetaSchema>;
