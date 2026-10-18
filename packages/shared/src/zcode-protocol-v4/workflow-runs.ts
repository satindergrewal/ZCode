// ============================================================
// workflowRuns: live run-state schema of the dwf engine (the workflowRuns key of snapshot.ts)
// ============================================================
// Split out of snapshot.ts: this vocabulary is self-contained (run/actor/node/usage/limits),
// and the split brings snapshot.ts back under its max-lines cap (same precedent as workspace-hook-review.ts).

import { z } from "zod";

import { workflowRunArtifactSummarySchema } from "./workflow-artifacts.js";

// -- workflowRuns: live run state of the dwf engine --
// Same pattern as subagents: run state belongs to the conversation authority projection, not a renderer query cache.
// One engine RunEvent -> one conversation event -> whole-key replacement here, so there is no dual clock of event plus follow-up RPC.
export const WORKFLOW_RUNS_LIMITS = {
  /** Most recent runs; oldest evicted beyond the cap. */
  maxRuns: 8,
  /**
   * actors and nodes share the same capacity so a visible node never outlives its evicted subagent.
   * Key-level deltas carry only the changed part per event; the caps bound each run's projection size
   * and the resource drag of runaway scripts. Cross-run totals are governed by {@link maxTotalEntries}.
   * These are display-state caps; they never limit subagents the engine actually runs.
   */
  maxActors: 1_024,
  maxNodes: 1_024,
  /**
   * Entry budget of the whole state key: sum of `nodes.length + actors.length` over all runs.
   *
   * maxRuns x per-run bound = 16384 entries; at ~150 bytes each that is ~2.5MB -
   * near the 16MiB snapshot cap, and snapshots serialize whole. The budget keeps the worst case ~1MB,
   * at the cost of the oldest terminal run leaving early (its full facts stay in the journal; details still queryable).
   * On over-budget the reducer evicts terminal runs only - never running ones, never the event's own run.
   */
  maxTotalEntries: 6_144,
  /**
   * Display budget of the details-page Results section, deliberately far below the engine's per-run report cap (256):
   // the wire bound is a display budget; the engine's bound is the contract. They need not match. Entries beyond it
   // stay in the journal (`dwf_node.kind = "report"`), just out of this high-frequency state key.
   */
  maxReports: 64,
  maxReportPreviewLength: 2_048,
  maxResultPreviewLength: 2_048,
  maxErrorLength: 2_048,
  /**
   * Concurrent escalated questions. The engine's true bound is
   // 3 per ask x in-flight asks (maxConcurrency), so 32 suffices under any realistic caps;
   // it is also a guard - a runaway script must not be able to blow up a high-frequency state key.
   */
  maxPendingQuestions: 32,
  /** Display cap for questions and notes; equal to the event-payload string bound (2048) so the normal path never truncates. */
  maxQuestionLength: 2_048,
  /** Bound on concurrency-bucket provider keys (`${providerId}/${modelId}`). */
  maxConcurrencyKeyLength: 256,
  /**
   * Wire bound on subagent model strings (`providerId/modelId`, optional `$reasoningLevel` suffix). Same value as the
   // concurrency-bucket provider key: same family of identifier, plus possibly a reasoning tier.
   */
  maxSubagentModelLength: 256,
  /**
   * Bound on `run.concurrencyCeiling`. The ceiling derives from `min(16, cores - 2)`; this bound only rejects bad payloads
   // (the reducer treats out-of-range as unreadable and keeps the known value).
   */
  maxConcurrencyCeiling: 1_024,
  /**
   * Wire bound on subagent display names (actor.name, same value as pendingQuestion.actorName). Names are arbitrary
   // author strings (`agent("reader-" + paths.join("+"))`); the reducer must clip to this bound before publishing:
   // a 131-char name once got every later frame of the parent session rejected, killing the subscription.
   */
  maxActorNameLength: 128,
  /**
   * Count of user-facing artifacts. Equal to the engine's
   // `ARTIFACT_CAPS.maxArtifactsPerRun` - opposite reasoning from maxReports ('display budget < engine contract'):
   // the engine cap is already 32; pushing the display bound lower would silently drop cards
   // from the side panel - the very cards this feature exists for.
   */
  maxArtifacts: 32,
  /**
   * Count of entered phases. Equal to the display payload's
   // `CREATE_WORKFLOW_GRAPH_MAX_PHASES`: phases the timeline cannot draw need not be projected.
   */
  maxPhases: 32,
  /** Wire bound on phase names, equal to display's `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS` (the UI joins both sides by name). */
  maxPhaseNameLength: 128,
  /**
   * Bound on an ask's task summary (`instructionsHead` of node-queued). Equal to the engine's
   // `INSTRUCTIONS_HEAD_MAX_CHARS`: that side already clips to it; this is the second gate on the wire.
   // 240 chars is what 'see at a glance what this subagent was sent to do' needs; longer means shipping the full
   // instructions over the protocol, which live in the journal and the subagent transcript.
   */
  maxInstructionsHeadLength: 240,
  /** Bound on the last tool call's tool name (same order as actor/node siteId; a tool name is an identifier, not prose). */
  maxLastToolNameLength: 64,
  /**
   * Bound on the last tool call's target (file path, command head). Equal to the engine's
   // `LAST_TOOL_TARGET_MAX_CHARS`. Doubles as a safety bound: it fits one path or command head,
   // not full args or file content - those never belong on this high-frequency key.
   */
  maxLastToolTargetLength: 120,
} as const;

/**
 * Bounds compiled into **legacy consumers** (the generation without the `workflowRunDeltas` capability) for actors/nodes.
 *
 * Never change these two numbers: they are validation bounds inside someone else's binary, not ours. An over-bound payload
 * is not trimmed - the whole `state.updated` patch fails to parse, the frame drops, and the subscription dies silently.
 * So every frame for such subscribers passes `clampWorkflowRunsForLegacy` first.
 *
 * 'First 256' is not arbitrary: the legacy reducer rejects-new on overflow, which yields exactly the oldest 256.
 */
export const WORKFLOW_RUNS_LEGACY_LIMITS = {
  maxActors: 256,
  maxNodes: 256,
} as const;

/**
 * A phase entered by control flow (marked via `phase("...")`). `name` is the author's verbatim string (the timeline joins display's `phases[].name` by it); `rounds` counts
 * entries - monotonic (reducer takes max), so resume replays never double it.
 */
export const workflowRunPhaseSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  rounds: z.number().int().positive(),
});
export type WorkflowRunPhase = z.infer<typeof workflowRunPhaseSchema>;

/**
 * How much of the bound a birth phase spent.
 *
 * Two counters ({@link workflowRunUsageSchema} `nodesUnlisted`/`nodesUnlistedSettled`) say how
 * many entries a run under-listed in total, but not where - while the read surface is per-stop: each stop's roster, count ring
 * and 'N more' must add back its own off-table entries, or a wide fan-out stop shows a tiny number.
 *
 * `phaseName` absent = the phaseless bucket (born before any `phase()` mark, or an old CLI). `actors` counts
 * subagents of this phase not currently in the actor table (rejected, evicted, orphan-ruled all count);
 * `actorsSettled` those known finished, `actorsFailed` the failed among them; `settled` counts off-table
 * settled nodes recorded in this bucket. `actors` can rise and fall: an evicted subagent re-enters the table on its next dispatch.
 * Optional subkeys are absent at zero; a bucket of four zeros is absent entirely (same absence rule as the rest of this file).
 */
export const workflowRunUnlistedPhaseSchema = z.object({
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  actors: z.number().int().nonnegative(),
  actorsSettled: z.number().int().nonnegative().optional(),
  actorsFailed: z.number().int().nonnegative().optional(),
  settled: z.number().int().nonnegative(),
});
export type WorkflowRunUnlistedPhase = z.infer<typeof workflowRunUnlistedPhaseSchema>;

/**
 * Run-level usage: an observation surface, not a control surface. `spentTokens` mirrors
 * the engine usage-updated total (written in the same step as `dwf_run.spent_tokens`, always equal);
 * `nodesUsed` counts nodes dispatched in this run - no bound exists to derive it from, none needed.
 * no bound exists to derive it from, and none is needed.
 */
export const workflowRunUsageSchema = z.object({
  spentTokens: z.number().int().nonnegative(),
  nodesUsed: z.number().int().nonnegative(),
  /**
   * Instances rejected from the table on hitting {@link WORKFLOW_RUNS_LIMITS.maxNodes}, and settled ones among them. `truncated` says only 'something did not fit',
   * not how much - a 3000-way fan-out would display as '1024 steps', a falsehood.
   *
   * Both are additive counts (rejected instances have no identity in the table to dedup), so the reducer counts them
   * only when an event raises the watermark; retransmitted tail events cannot inflate them. `run-started`
   * zeroes them with the whole usage: resume re-sends the script prefix, and not resetting would sum two lifetimes. Absent at zero.
   */
  nodesUnlisted: z.number().int().nonnegative().optional(),
  nodesUnlistedSettled: z.number().int().nonnegative().optional(),
});
export type WorkflowRunUsage = z.infer<typeof workflowRunUsageSchema>;

/**
 * One actor instance. `status` is a derived tri-state:
 * Engine Boundary C emits no actor lifecycle events beyond actor-created, so status derives from the actor's
 * nodes and the run's terminal state -
 *   - running: some node executing/repairing/nudged (model request sent, in flight);
 *   - waiting: a live node (queued/dispatched/waiting: not yet placed, queued for a slot, or backing off)
 *     or no nodes yet with the run not terminal (created, never asked);
 *   - completed: everything else (all nodes settled, or run terminal).
 * No observable per-actor failed exists: a failed ask still 'finished its work'; the result lives on nodes.
 *
 * `sessionId` is the actor session id (phase 5 transcript drill-down reads it directly). Also not on Boundary C:
 * the run service mints it deterministically from (runId, actorRef).
 */
export const workflowRunActorSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  status: z.enum(["waiting", "running", "completed"]),
  /**
   * Birth phase of this instance: the `phase("...")` name at control flow when its ordinal was minted. The UI joins `phases[].name`
   * by name - the only vocabulary engine and analyzer share - so the bound equals `maxPhaseNameLength`.
   *
   * Absent has two readings, both valid: born before any mark (no `phase()` in the script, or later),
   * or the event came from an old CLI without the key.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
});
export type WorkflowRunActor = z.infer<typeof workflowRunActorSchema>;

/**
 * Most recent tool call of an ask (via node-progress). `name` is the tool; `target` is
 * a label-short target - file path, command head - absent when unreadable.
 *
 * Deliberately only these two keys: full args and file content stay off this high-frequency key (one per resolved turn);
 * they live in the journal and subagent transcript. The `target` bound is thus both display budget and enforcement of that rule.
 */
export const workflowRunNodeLastToolSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolNameLength),
  target: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength).optional(),
});
export type WorkflowRunNodeLastTool = z.infer<typeof workflowRunNodeLastToolSchema>;

/**
 * A node (ask/world-read) instance. `phase` is the node lifecycle phase the engine actually emitted:
 *   queued → dispatched → executing ⇄ waiting → (repairing | nudged) → settled。
 * executing/waiting come from driver observation:
 * node-executing = the ask's model request truly sent; node-waiting = waiting on a process-level slot or backing off.
 * dispatched is therefore the brief 'session ready, first request not yet admitted' phase; the read surface groups it with queued/waiting.
 *
 * `kind` is optional: resume completion-cache hits emit node-settled directly (ask via scheduler.ts
 * releaseCachedAsk/tryImportedSettle, world-read via engine-world.ts replay/import hits),
 * skipping node-queued, and only queued carries kind.
 */
export const workflowRunNodeSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(["ask", "world-read"]).optional(),
  phase: z.enum(["queued", "dispatched", "executing", "waiting", "repairing", "nudged", "settled"]),
  outcome: z.enum(["ok", "failed", "cancelled"]).optional(),
  cached: z.boolean().optional(),
  /** Site id of the owning actor (world-reads have none). */
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  /**
   * Birth phase of this instance,
   * verbatim semantics of the same key in {@link workflowRunActorSchema}: the `phase("...")` name when the ordinal was
   * minted; the UI joins phases[].name by it; absent = born before any mark, or an old CLI.
   *
   * Not the same as `phase` above: phase is the node lifecycle (queued/executing/settled...),
   * phaseName is the script-phase coordinate. The distinct name keeps the concepts apart.
   *
   * Stamped only on birth events (node-queued, and the direct
   * node-settled {cached:true} on replay hits); other node-* events omit it and the reducer carries it forward.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * This ask's task: first 240 chars of the author's instructions, via node-queued. The read surface answers 'what was this subagent sent to do' from it -
   * the phase only says 'running', never what.
   *
   * Head of the author's verbatim text, without engine-appended footers (runtime scaffolding, not the task).
   * Absent has two readings: a world-read node (no instructions), or an old CLI/journal without the key.
   */
  instructionsHead: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength)
    .optional(),
  /**
   * Which resolved turn this ask reached (1-based, nudge turns count), plus cumulative tool calls and the latest one -
   * via node-progress, one per resolved turn.
   *
   * Together they answer 'is it moving': an ask stuck in executing for ten minutes is only distinguishable
   * (long task vs dead) by these. On journals without node-progress all three are absent -
   * render 'unknown', never 0: 0 is the fact 'no tool call yet'.
   *
   * Reduction is last-writer-wins, not max (opposite of phases[].rounds): a re-queued instance after
   * resume is a brand-new ask counting from 1; max would freeze the previous life's readings here.
   */
  turn: z.number().int().positive().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  lastTool: workflowRunNodeLastToolSchema.optional(),
});
export type WorkflowRunNode = z.infer<typeof workflowRunNodeSchema>;

/**
 * This run's concurrency picture. Two bounds; actual concurrency is the smaller:
 * actual concurrency is the smaller of the two:
 *
 * - cap: the shared gate state of this run's provider key (the governor buckets by key, fans out per run, moves with concurrency-changed);
 *   ceiling: the CPU-derived cap. Events carry no ceiling; the reducer derives it from the max previous/next seen
 *   (buckets start at the ceiling, so the first event's previous is it; a only-decreasing series keeps it maximal).
 *   previous is it; in a only-decreasing series it stays the max).
 * - limit: this run's own bound (`max_concurrency` of CreateWorkflow/AmendWorkflow via caps.maxConcurrency),
 *   arriving with run-started, fixed for the run. Present only below the ceiling:
 *   a run at the ceiling looks exactly as before, no extra key.
 * - cooldownMs: how long a Retry-After freeze blocks new dispatches, relative (same reason as retryInMs);
 *   idle_reset and run terminal state clear it.
 *
 * The UI shows the readout only when min(cap, limit) < ceiling (see workflowRunConcurrencyView).
 */
export const workflowRunConcurrencySchema = z.object({
  key: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxConcurrencyKeyLength).optional(),
  cap: z.number().int().positive(),
  ceiling: z.number().int().positive(),
  limit: z.number().int().positive().optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
});
export type WorkflowRunConcurrency = z.infer<typeof workflowRunConcurrencySchema>;

/**
 * A progressive artifact delivered by script `report(item)` (one row of the details Results section).
 *
 * report differs from log: it has site identity, enters the journal, has its own RunEvent - so it enters
 * the event log, the Results section, and the completion notice to the model; but it never enters the causality graph
 * (pure progress, no ordering meaning) nor nodes[] - a chatty workflow must not look like more steps.
 *
 * siteId x ordinal is identity (the journal key) and the reducer's dedup key: on replay every
 * report call re-runs; one instance must land as one row, not two.
 *
 * Stores preview text, not raw values: the serialization rule (strings as-is, else pretty JSON) is the same one
 * used for run-artifact echo, computed once CLI-side, so the renderer never duplicates the contract; it also
 * reduces the 'all payloads bounded at the protocol edge' invariant to one string bound.
 */
export const workflowRunReportSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  preview: z.string().max(WORKFLOW_RUNS_LIMITS.maxReportPreviewLength),
  /**
   * Second arg of `report(item, artifactId)`: which preset board this entry feeds. Absent = untagged, Results section only.
   *
   * Tagged entries still enter reports: one channel, one cap; the tag adds a destination, never reroutes.
   * Bound equals the artifact-id bound (64): it is one.
   */
  artifactId: z.string().min(1).max(64).optional(),
});
export type WorkflowRunReport = z.infer<typeof workflowRunReportSchema>;

/**
 * An escalated question while parked: an actor hit a real blocker
 * (broken gate, contradictory instructions, missing fact), escalated to the main agent, and parks inside its ask awaiting the answer.
 *
 * Identity is qid (globally unique, cross-run), not a site instance - escalations have no site identity:
 * no dwf_node row, no maxNodes; a slow tool call inside one ask turn. Dedup key is qid; the actor is an attribute.
 * A different family from the (siteId, ordinal)-deduped nodes/actors/reports tables.
 *
 * actorSiteId/actorOrdinal are therefore optional (shape copied from WorkflowRunNode's pair): a record
 * that cannot say who asked must still display - visibility is the point; hiding a question over an
 * unreadable actor ref destroys its only fallback value. actorName is the persona name, absent for anonymous actors
 * (the event side deliberately synthesizes no fallback label; consumers decide how to render nameless).
 *
 * Purely in-memory, cleared at run terminal state: the truth is a parked deferred in the CLI process.
 * Once the process dies the deferreds are gone, so 'who still owes an answer' is always false on terminal runs -
 */
export const workflowRunPendingQuestionSchema = z.object({
  /** Globally unique question id (like `dwfq-<runId fragment>-<seq>`); the main agent answers by it. */
  qid: z.string().min(1).max(128),
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  actorName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  question: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength),
  context: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength).optional(),
  /**
   * Ask time (epoch ms), carried by the event - this module is a pure reducer with no clock.
   *
   * Required event-side (the driver is the sole producer, same Date.now() as the parked record), yet optional here:
   * journals on old dev machines may replay events predating askedAt. Render wait time only when present;
   * absence is not an error.
   */
  askedAt: z.number().int().nonnegative().optional(),
});
export type WorkflowRunPendingQuestion = z.infer<typeof workflowRunPendingQuestionSchema>;

export const workflowRunSchema = z.object({
  runId: z.string().min(1).max(128),
  /** The CreateWorkflow tool call that started this run (tool card -> details correlation key). */
  toolCallId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  /** Present only when status === "stopped". */
  stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
  /**
   * Both ends of the lineage: which run this one revised
   * (`resumedFrom` of run-started) and which revision stopped-and-replaced it
   * (`supersededBy` of run-settled, only with stopReason superseded). Both optional, same reason as reports:
   * appending fields to a live state key means old CLIs just omit one key - degradation, not a dropped frame.
   */
  resumedFrom: z.string().min(1).max(128).optional(),
  supersededBy: z.string().min(1).max(128).optional(),
  usage: workflowRunUsageSchema,
  error: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxErrorLength).optional(),
  /**
   * Resumable. Present only when true.
   *
   * Computed by the CLI on the run-settled payload with the same predicate as the resume gate (live via toProgressPayload,
   * cold replay from journal lines); the reducer only carries it - the UI must never re-derive from status+failureCode
   * (the two predicates will drift: button lit, command rejected). Optional per the reports rule: appending to a
   * live state key means old CLIs omit one key - degradation, not a dropped frame.
   */
  resumable: z.literal(true).optional(),
  resultPreview: z.string().max(WORKFLOW_RUNS_LIMITS.maxResultPreviewLength).optional(),
  actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors),
  nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes),
  /**
   * Progressive artifacts from `report(item)`, in report order. The whole key is absent at zero (not an empty array):
   * the Results section renders nothing at all rather than an empty shell for workflows that never report.
   *
   * Deliberately optional: this appends a field to a live state key, and parse errors on known keys
   * are not trimmed - the whole state.updated patch fails, the frame drops.
   * Required would trip that path for any old CLI without reports; optional degrades to 'one key fewer'.
   */
  reports: z.array(workflowRunReportSchema).max(WORKFLOW_RUNS_LIMITS.maxReports).optional(),
  /**
   * Escalated questions in ask order. Whole key absent at zero (not []), same convention as reports:
   * the sidebar renders nothing rather than an empty section for a question-less run.
   *
   * Zero is this key's steady state, and it churns: an answered question leaves the table, the last answer
   * returns it to absent. Consumers must not treat 'seen once' as 'stays forever'.
   *
   * Second reason for optional, as with reports: appending to a live state key; parse errors on known keys
   * are not trimmed - required would drop whole frames for old CLIs without the field.
   */
  pendingQuestions: z
    .array(workflowRunPendingQuestionSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPendingQuestions)
    .optional(),
  /**
   * Concurrency picture (see workflowRunConcurrencySchema). Present only when one bound sits below the ceiling:
   * either a concurrency-changed arrived (shared bucket throttled) or run-started carried a sub-ceiling
   * limit (user-capped). Runs with neither stay at the ceiling; nothing to say.
   * Optional per the reports/pendingQuestions rule.
   */
  concurrency: workflowRunConcurrencySchema.optional(),
  /**
   * This machine's concurrency ceiling (run-started's concurrencyCeiling, a process fact baked in CLI-side).
   * Unlike concurrency.ceiling - the chip's own watermark, present only with the chip - this one is
   * present whenever readable, regardless of the run's relation to it: where the config dialog's stepper stops. Optional per the concurrency rule.
   */
  concurrencyCeiling: z
    .number()
    .int()
    .positive()
    .max(WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling)
    .optional(),
  /**
   * Which model this run's subagents use (CreateWorkflow/AmendWorkflow subagent_model via payload subagentModel),
   * canonical `providerId/modelId`, optional $reasoningLevel. Fixed with run-started for the run -
   * same family as concurrency.limit: a user-set condition, not a runtime observation.
   * condition, not a runtime observation.
   *
   * Present only when the user pinned a model for this run: otherwise subagents follow the session model, nothing to say.
   * The main agent always stays on the session model; this key speaks only for the subagent side.
   * Optional, verbatim the reports/concurrency reason: appended to a live state key; old CLIs omit one key -
   * degradation, not a dropped frame.
   */
  subagentModel: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength).optional(),
  /**
   * User-facing artifacts published by this run, in first-seen order, latest-version metadata only. Whole key absent when none (not []):
   * the side panel's Artifacts section renders nothing - same absence rule as reports/pendingQuestions.
   *
   * Second optional rationale, verbatim reports, and the one that matters: appended to a live
   * state key; parse errors on known keys are not trimmed - required would drop whole frames for
   * old CLIs without artifacts. One key fewer is degradation, not error.
   *
   * Terminology: artifact here is user-visible script output, not the 'top-level return value'
   * behind resultPreview (called artifact inside the engine too). See the workflow-artifacts.ts header.
   */
  artifacts: z
    .array(workflowRunArtifactSummarySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxArtifacts)
    .optional(),
  /**
   * Phases entered by control flow, first-entry order.
   * Whole key absent at zero; optional per the reports rule (old CLIs omit; one key fewer is degradation,
   * not error). The timeline uses it for zero-member stop lights and to fill every stop's pre-first-dispatch running segment.
   */
  phases: z.array(workflowRunPhaseSchema).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
  /** Phase name control flow last entered (latest phase-entered); absent before any. */
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * Phases the script declares, declaration order (run-launched.phaseNames). Complements phases (entered): the sidebar mini-track draws not-yet-reached stops from it.
   * Whole key absent at zero / old CLI / mark-less scripts.
   */
  phaseNames: z
    .array(z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * Position-aligned 'also running' table (run-launched.phaseAlongside):
   * phaseAlongside[i] lists indexes into phaseNames - phases whose strands still ran when phaseNames[i] was entered.
   * The sidebar mini-track draws parallel stops as a double segment.
   *
   * Depends on phaseNames: absent whenever that is; also absent with no parallel phases - absence reads
   * 'this track is a straight line'. The reducer guarantees every index lands in the accepted table (workflow-runs-phases.ts).
   */
  phaseAlongside: z
    .array(z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * Per-birth-phase spend of the bound (see workflowRunUnlistedPhaseSchema). Whole key absent
   * when no bucket exists. One extra slot beyond maxPhases: the phaseless bucket shares the table.
   *
   * Once full, newer phases' attribution drops; the run-level counters stay exact - a stop may miss a number it never had,
   * run totals must not lie.
   */
  unlistedByPhase: z
    .array(workflowRunUnlistedPhaseSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPhases + 1)
    .optional(),
  /**
   * Set when actors/nodes/reports/pendingQuestions/artifacts/phases hit their caps;
   * also set by eviction (making room): the run's entry tables no longer fit their own facts,
   * and run-started reads this bit to decide whether a new life starts from empty tables.
   */
  truncated: z.boolean().optional(),
  /** Journal sequence of the last reduced event; raising it triggers an event-log refetch. */
  lastEventSequence: z.number().int().nonnegative(),
});
export type WorkflowRunState = z.infer<typeof workflowRunSchema>;

export const workflowRunsStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  runs: z.array(workflowRunSchema).max(WORKFLOW_RUNS_LIMITS.maxRuns),
});
export type WorkflowRunsState = z.infer<typeof workflowRunsStateSchema>;
