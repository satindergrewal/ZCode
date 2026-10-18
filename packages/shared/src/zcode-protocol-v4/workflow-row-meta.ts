// ============================================================
// Row-level metadata for workflow turns (turnHeader / userInput members of rows.ts)
// ============================================================
// Split from rows.ts: the notification manifest, background-result attribution, and direct-launch shapes pushed rows.ts past
// its max-lines cap (same precedent as create-workflow-display.ts -- feature-level schemas get their own module).
// Public names unchanged: rows.ts re-exports as-is; both the @zcode/shared barrel and relative imports keep working.

import { z } from "zod";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

// Structured payload of workflow notifications.
// Minted by the emitter, bounded; never parsed back out of model-facing notification text. Bound principle: the payload rides the turnHeader row
// through protocol + snapshot, honestly truncated (resultTruncated / count!=shown means the preview is partial;
// the full set is fetchable via run id). Batch turns deliberately carry none (one manifest per turn does not hold under batching).
export const workflowNotificationMetaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal"),
    status: z.enum(["completed", "errored", "stopped"]),
    // Present only when status === "stopped".
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
    // Terminology: artifact here is what the script published via `artifact.*`, unrelated to
    // `result` on the same payload (the script's top-level return value, also called artifact internally).
    // Chip-fittable fields only: bytes / entry count are one side-panel away; no room on the chip.
    // Bound 8; overflow (including kind-filtered entries) sets artifactsTruncated; title's 120 matches
    // ARTIFACT_CAPS.maxTitleLength, truncated in place by the emitter.
    // Exception: the deliverable (`primary`) entry also carries `description` (<= 500, per ARTIFACT_CAPS), because
    // the completion card draws it as a one-line titled deliverable and on cold transcripts this payload is the only readable copy. Primary first in the list.
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
  // Hole (the `hole` kind of docs/dynamic-workflow/transcript-and-notifications.md "The payload"): the run reached an
  // open `hole<T>()`; that branch is parked and the main agent owes code. `type` is the author-written type text (`Plan`); `before` /
  // `after` are the phase names around the hole; `draftPath` / `line` point at the hole's line in the draft file. prompt shares the
  // escalation's 4000 bound, emitter-truncated. Same name as the contract (hand-mirrored on the apps/zcode-cli contracts side).
  z.object({
    kind: z.literal("hole"),
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    name: z.string().min(1).max(128),
    type: z.string().min(1).max(128),
    prompt: z.string().max(4000).optional(),
    draftPath: z.string().max(1024).optional(),
    line: z.number().int().positive().optional(),
    before: z.string().max(128).optional(),
    after: z.string().max(128).optional(),
    reachedAt: z.number().optional(),
  }),
  // Run-level stall: one per stall segment, not a terminal state.
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
  // "workflow" is a dynamic-workflow run (workId = runId) riding the whole background-notification pipeline.
  backgroundSource: z.enum(["bash", "subagent", "workflow"]),
  workId: z.string().min(1),
  title: z.string().min(1),
  // Present only on single-notification turns with backgroundSource === "workflow"; zod strips unknown keys,
  // so omitting it here silently loses the whole chain -- this field is the manifest render's only data source.
  workflowNotification: workflowNotificationMetaSchema.optional(),
});
export type BackgroundResultOriginMeta = z.infer<typeof backgroundResultOriginMetaSchema>;

// Direct-launch turn metadata.
// The GUI uses the hub's Run to start a saved workflow in a fresh session; the agent mints one controlOnly turn;
// that turn's turnHeader and userInput both project with origin: "workflowLaunch", each carrying this metadata.
// Cold recovery (message metadata) and live projection (TurnStarted payload) use the same copy -- one shape hot and cold.
// Bound principle matches workflowNotificationMetaSchema: emitter-minted, bounded, honestly truncated --
// full script / diagnostics are fetchable via runId in the detail side panel; the card draws only this fixed-size summary.
// Deliberately not backgroundResultOriginMeta's backgroundSource shape: that means background-notification attribution,
// this means a hub-initiated launch; different semantics, separate shapes so cross-evolution cannot drag one into the other.
const workflowSubagentModelTextSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength);

// Settings-amend turn: the user changed settings via the run card / detail Configure,
// the agent amended a new run from the same script, and records it with a controlOnly turn shaped like direct launch.
// This block states **what changed**: only changed settings appear; a from/to missing one side means that side is the default
// (model = session model, ceiling = default concurrency). `ceiling` is the legacy default-concurrency D (name predates the rename, kept for compat),
// reading like "default 13 -> 4".
export const workflowSettingsAmendMetaSchema = z.object({
  // Amended from which run. **Absent = takes effect in place** (docs/dynamic-workflow/concurrency.md): a concurrency-only
  // change on a live run neither stops it nor starts another, so there is no predecessor -- `runId` is the adjusted
  // one. Renderers show the row only, no extra card (two cards for one run read as two runs).
  // Recorded skew (same tier as scope / path below): required on old desktops, where in-place amend turns fail to parse
  // and the row drops -- one lost record; run card and the run itself are unaffected.
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
  // runId = workId: drives the launch-turn run card's live state / step count, and the cancel / resume / detail side-panel join key.
  runId: z.string().min(1).max(128),
  // launch-<uuid> prefix (distinct from model tool-call ids); the same id as the synthesized CreateWorkflow toolCall.
  toolCallId: z.string().min(1).max(128),
  // Workflow name from resolution (agent-filled; neither user nor model may rename). Always present on hub launches; amend turns
  // take the adjusted run's own name -- never-named runs have none, and card/side panel fall back per the unnamed-run rule,
  // never titling with a run id.
  name: z.string().min(1).max(200).optional(),
  // scope / path belong to hub launches only: an amend turn (below) edits an existing run and has no saved file to point at.
  // Recorded skew: required on old desktops, where new-CLI amend turns fail to parse and the row drops (same tier as the
  // origin closed-enum addition); hub-launch turns always carry both, unaffected.
  scope: z.enum(["project", "global"]).optional(),
  // Resolved script path on disk; detail/diagnostics only, not shown on the card. 1024 covers deep global/project paths.
  path: z.string().min(1).max(1024).optional(),
  // Argument map (card render source). Bounded: serialized <= 4KB, same bound as contracts' TurnStartedPayload,
  // keeping whole-object dumps out of every persisted message and live event.
  args: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= 4096, {
      message: "workflowLaunch.args JSON must be ≤ 4096 bytes",
    })
    .optional(),
  // Description line (if any); same copy as the args dialog / hub card, 500 like the notification summary.
  description: z.string().max(500).optional(),
  // Pre-launch compiled create_workflow display (bounded causal graph + diagnostics): the run detail side panel locates the
  // origin row by toolCallId for the graph; direct launch has no tool row, so the graph comes from here. Same schema as the tool-row display.
  // Also ungated: a graph parse failure just means no graph on this row, never a rejected frame (see the toolDisplay.ts comment).
  display: toolCallCreateWorkflowDisplaySchema.optional().catch(undefined),
  // The script text this run actually executed (side panel Script section), mirroring the tool row's input.script; bound matches contracts'
  // WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS.
  script: z.string().max(256_000).optional(),
  // Amend turns only: which run this one was amended from via Configure, and what changed.
  amend: workflowSettingsAmendMetaSchema.optional(),
});
export type WorkflowLaunchMeta = z.infer<typeof workflowLaunchMetaSchema>;
