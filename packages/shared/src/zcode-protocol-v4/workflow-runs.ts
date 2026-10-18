// ============================================================
// workflowRuns: live runtime schema of dwf engine runs (the workflowRuns key of snapshot.ts)
// ============================================================
// Split out of snapshot.ts: this vocabulary is self-contained (run/actor/node/usage/limits),
// and the split brings snapshot.ts back under max-lines (same precedent as workspace-hook-review.ts).

import { z } from "zod";

import { workflowRunArtifactSummarySchema } from "./workflow-artifacts.js";

// -- workflowRuns: live runtime state of dwf engine runs --
// Same pattern as subagents: runtime state belongs to the conversation authority projection, not a renderer query cache.
// One engine RunEvent -> one session event -> whole-key replacement here; no dual clock of event-plus-followup-RPC.
export const WORKFLOW_RUNS_LIMITS = {
  //** The most recent runs; oldest evicted beyond the cap. */
  maxRuns: 8,
  /**
   * actors and nodes share a bound. Every node belongs to an actor, so the nodes bound already implies the
   * actor magnitude; squeezing actors lower (once 32) just made a routine 50-way fan-out silently
   * lose 18 subagents in the inspector, while nodes, engine, and graph all had room.
   *
   * 2026-09-20: 256 -> 1024. The old bound existed because whole-key state resends made unbounded O(N²)
   * bytes; once key-level deltas landed (workflow-runs-delta.ts) each event ships only its diff.
   * The two remaining reasons never needed 256: keep a runaway `agent()` loop in check,
   * and bound one run's bytes. Cross-run totals are {@link maxTotalEntries}'s job.
   * Still not a product-level subagent cap.
   */
  maxActors: 1_024,
  maxNodes: 1_024,
  /**
   * Entry budget of the whole state key: sum of `nodes.length + actors.length` across runs.
   *
   * Per-run bound times {@link maxRuns} is 16384 entries; ~150 B each is ~2.5 MB --
   * uncomfortably close to the 16 MiB snapshot ceiling, and snapshots serialize whole. The budget keeps the worst case ~1 MB,
   * at the cost of evicting the oldest settled run early (its facts remain in the journal; details still queryable).
   * The reducer evicts settled runs only, never running ones, never the event's own run.
   */
  maxTotalEntries: 6_144,
  /**
   * Display budget for the detail page's Results section, deliberately far below the engine's per-run report cap (`REPORT_CAPS.maxItemsPerRun`):
   * the wire bound is presentational; the engine's is contractual. Entries beyond this bound stay
   * in the journal (`dwf_node.kind = "report"`); they just skip this high-frequency key.
   */
  maxReports: 64,
  maxReportPreviewLength: 2_048,
  maxResultPreviewLength: 2_048,
  maxErrorLength: 2_048,
  /**
   * Escalated questions parked simultaneously. The real engine bound is
   * 3 per ask x in-flight asks (maxConcurrency), so 32 suffices under any real caps;
   * it is also a guard -- a runaway script must not be able to blow up a high-frequency key.
   */
  maxPendingQuestions: 32,
  /** Display cap for question/clarification text; equals the event payload's 2048, so the happy path never truncates. */
  maxQuestionLength: 2_048,
  /** Bound on concurrency-bucket provider keys (`${providerId}/${modelId}`). */
  maxConcurrencyKeyLength: 256,
  /**
   * Wire bound on subagent model strings (`providerId/modelId`, optional `$reasoningLevel`). Same value as the
   * concurrency-bucket provider key: same family of identifier, plus a possible level suffix.
   */
  maxSubagentModelLength: 256,
  /**
   * Wire bound on actor `sessionId`. A session id is minted/read identity, not display text: over-bound values
   * are dropped whole, not truncated -- a clipped session id points at another (or no) session.
   */
  maxSessionIdLength: 256,
  /**
   * Bound on `run.concurrencyCeiling` (default concurrency D, derived `max(4, min(16, cores - 2))`); guards bad payloads only
   * (the reducer treats out-of-bound as unreadable and keeps the known value).
   */
  maxConcurrencyCeiling: 1_024,
  /**
   * Wire bound on subagent display names (same for actor.name and pendingQuestion.actorName). Names are arbitrary
   * author strings (`agent("reader-" + paths.join("+"))`); the reducer clips to this bound before publishing:
   * a 131-char name once got every later frame rejected renderer-side, killing the subscription.
   */
  maxActorNameLength: 128,
  /**
   * User-facing artifact count. Equals the engine-side
   * `ARTIFACT_CAPS.maxArtifactsPerRun` -- the inverse of maxReports' display<engine reasoning: the engine
   * artifact cap is already 32, so a lower display bound would only silently drop cards
   * from the side panel for max-running scripts -- and those cards are the entire point.
   */
  maxArtifacts: 32,
  /**
   * Entered-phase count. Equals the display payload's
   * `CREATE_WORKFLOW_GRAPH_MAX_PHASES`: phases the timeline cannot draw need not be recorded.
   */
  maxPhases: 32,
  /** Wire bound on phase names, equal to display's `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS` (the UI joins on the name). */
  maxPhaseNameLength: 128,
  /**
   * Holes a run remembers (docs/dynamic-workflow/presentation.md, "Holes on the timeline"). Same bound as the display
   * payload's `holes`: undrawable holes need no memory. A hole is a phase, so this never
   * exceeds `maxPhases` anyway.
   */
  maxHoles: 32,
  /** Wire bound on the hole type literal (`Plan`); same as the display field of the same name. */
  maxHoleTypeLength: 128,
  /** Bound on the hole prompt inside run state (the side panel waiting body renders it); clipped to 499 chars + ellipsis. */
  maxHolePromptLength: 500,
  /**
   * Bound on an ask's task summary (`node-queued` instructionsHead). Equals the engine's
   * `INSTRUCTIONS_HEAD_MAX_CHARS`: the head is pre-clipped there; this is the second wire-side gate.
   * 240 is what it takes to see at a glance what a subagent was sent to do; longer just ships the full
   * instructions over the wire, which already live in the journal and the subagent transcript.
   */
  maxInstructionsHeadLength: 240,
  /** Bound on the latest tool-call name (siteId-scale; a tool name is an identifier, not prose). */
  maxLastToolNameLength: 64,
  /**
   * Bound on the latest tool-call target (file path, command head). Equals the engine's
   * `LAST_TOOL_TARGET_MAX_CHARS`. Doubles as a safety bound: room for a path or command head only,
   * never full args or file contents -- those never belong on this high-frequency key.
   */
  maxLastToolTargetLength: 120,
} as const;

/**
 * actors/nodes bounds compiled into legacy consumers (the pre-`workflowRunDeltas` generation).
 *
 * These two numbers must never change: they are validation bounds inside someone else's binary. An over-bound
 * payload is not trimmed -- the whole `state.updated` patch fails to parse, the frame drops, and the subscription goes
 * silent (the 2026-09-04 `fault.subscription.recoveryFailed` had exactly this shape). So frames to such
 * subscribers must pass `clampWorkflowRunsForLegacy` first.
 *
 * "first 256" is not arbitrary: the legacy reducer rejected newcomers at the bound, which yields exactly the oldest 256.
 */
export const WORKFLOW_RUNS_LEGACY_LIMITS = {
  maxActors: 256,
  maxNodes: 256,
} as const;

/**
 * A phase entered by control flow (`phase("...")` mark; docs/dynamic-workflow/presentation.md,
 * 2026-09-05). `name` is the author's literal (the timeline joins display `phases[].name` on it); `rounds` counts
 * entries, monotonic via max, so resume-replayed prefixes never double it.
 */
export const workflowRunPhaseSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  rounds: z.number().int().positive(),
});
export type WorkflowRunPhase = z.infer<typeof workflowRunPhaseSchema>;

/**
 * How much of the bound was spent in a birth phase (docs/dynamic-workflow/presentation.md, "Reduction").
 *
 * The run-level counters (`nodesUnlisted`/`nodesUnlistedSettled` in {@link workflowRunUsageSchema}) say how
 * many entries a run omitted in total, not where -- but the read surface is per-stop: a stop's roster, counter ring, and
 * "N more" must add back its own off-table entries, or wide fan-outs render as a tiny number.
 *
 * Absent `phaseName` = the phaseless bucket (born before any `phase()` mark, or an unstampeding old CLI). `actors` counts
 * this phase's subagents currently off the actor table (rejected, evicted, orphan-rule-removed),
 * `actorsSettled` the known-finished among them, `actorsFailed` the failed, and `settled` the off-table
 * settled nodes booked to this bucket. `actors` fluctuates: an evicted subagent returns on its next dispatch.
 * Zero optional subkeys are absent; an all-zero bucket is absent entirely (same absent-when-empty rule as the rest of this file).
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
 * Run-level usage: observability, not control (docs/dynamic-workflow/authoring.md). `spentTokens` copies
 * the engine `usage-updated` total (written in the same step as `dwf_run.spent_tokens`,
 * always equal); `nodesUsed` counts dispatched nodes from node events --
 * no cap exists to derive it from, none needed.
 */
export const workflowRunUsageSchema = z.object({
  spentTokens: z.number().int().nonnegative(),
  nodesUsed: z.number().int().nonnegative(),
  /**
   * Instances rejected from the table at {@link WORKFLOW_RUNS_LIMITS.maxNodes}, and settled among them
   * (docs/dynamic-workflow/presentation.md). `truncated` says only "something did not fit", never how much --
   * so a 3000-way fan-out would read as "1024 steps", a lie.
   *
   * Both are additive counts (rejected instances have no tabular identity to dedup on), so the counter moves only when an event
   * raises the watermark; retransmitted tail events cannot inflate them. `run-started` zeroes them with all of usage:
   * resume re-emits the script prefix, and not zeroing would sum two lifetimes. Absent when zero.
   */
  nodesUnlisted: z.number().int().nonnegative().optional(),
  nodesUnlistedSettled: z.number().int().nonnegative().optional(),
});
export type WorkflowRunUsage = z.infer<typeof workflowRunUsageSchema>;

/**
 * One actor instance. `status` is derived, three-valued:
 * Engine Boundary C emits no actor lifecycle events beyond `actor-created`, so status is inferred from the actor's
 * nodes and the run's terminal state:
 *   - `running`: some node executing/repairing/nudged (model request in flight);
 *   - `waiting`: a live node (queued/dispatched/waiting: undispatched, awaiting a slot, or backing off),
 *     or no nodes yet with the run unsettled (created, never asked);
 *   - `completed`: otherwise (all nodes settled, or the run is terminal).
 * No observable actor-level failed: a failed ask still finished its work; the outcome sits on nodes.
 *
 * `sessionId` is the session holding this subagent's transcript (drill-down reads it directly;
 * docs/dynamic-workflow/presentation.md, "Subagent transcripts"). Usually the run-scoped session the run service
 * mints deterministically from `(runId, actorRef)`. In a revised run, a subagent whose answers all came from
 * import hits has no session of its own; the field then carries the predecessor session read, delivered by the
 * cached settle's `sourceSessionId`, and switches back after the first live dispatch (the seed is copied into the prefix).
 */
export const workflowRunActorSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  sessionId: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxSessionIdLength).optional(),
  status: z.enum(["waiting", "running", "completed"]),
  /**
   * Birth phase: the `phase("...")` mark in force when its ordinal was minted. The UI joins `phases[].name`
   * by name -- the only vocabulary engine and analyzer share -- hence the `maxPhaseNameLength` parity.
   *
   * Two readings of absent, both consumer-recognized: born before any mark (no/later `phase()`),
   * or an old CLI that never sends the key.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * This subagent's model: when the persona names one, the host resolves the canonical
   * `providerId/modelId[$level]` via the run's binding table (docs/dynamic-workflow/presentation.md, "Reduction").
   * Absent = running on the run's subagent model (or an old CLI). Same bound as `subagentModel`.
   */
  model: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength).optional(),
});
export type WorkflowRunActor = z.infer<typeof workflowRunActorSchema>;

/**
 * Latest tool call within an ask (via `node-progress`). `name` is the tool; `target` is a
 * label-short target -- a file path or command head; absent when unreadable.
 *
 * Deliberately just these two keys: full args and file contents stay off this high-frequency key (one per resolved turn);
 * they live in journal and transcript. The `target` bound is thus both display budget and constraint guard.
 */
export const workflowRunNodeLastToolSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolNameLength),
  target: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength).optional(),
});
export type WorkflowRunNodeLastTool = z.infer<typeof workflowRunNodeLastToolSchema>;

/**
 * One node (ask/world-read). `phase` mirrors the engine's actual node events:
 *   queued → dispatched → executing ⇄ waiting → (repairing | nudged) → settled。
 * `executing`/`waiting` come from driver observation:
 * `node-executing` = the ask's model request truly sent; `node-waiting` = awaiting a process-level slot or backing off.
 * `dispatched` is thus the brief session-ready-request-not-admitted phase; readers group it with queued/waiting.
 *
 * `kind` is optional: resume cache-hit short-circuits straight to `node-settled` (asks via scheduler.ts'
 * releaseCachedAsk/tryImportedSettle; world-reads via engine-world.ts replay/import hits),
 * skipping `node-queued`, and kind rides only on queued.
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
   * verbatim the semantics of {@link workflowRunActorSchema}'s like-named key: the `phase("...")` mark at
   * ordinal-mint time, UI-joined by name; absent = pre-mark birth or old CLI.
   *
   * Not the same as `phase` above: that is the node lifecycle phase (queued/executing/
   * settled...); this is the script-phase coordinate. The distinct name keeps the concepts apart.
   *
   * The engine stamps birth events only (`node-queued`, plus the direct
   * `node-settled { cached: true }` on replay hits); other `node-*` events omit it and the reducer carries it forward.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * The ask's task: first 240 chars of the author's `instructions`, via `node-queued`. The read surface answers "what was this subagent sent to do" from it --
   * phase alone says running, never what at.
   *
   * Head of the author's literal text, without engine-appended footers (runtime scaffolding, not the task).
   * Two readings of absent: world-read nodes (no instructions) or old CLIs/journals without the key.
   */
  instructionsHead: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength)
    .optional(),
  /**
   * Resolved-turn ordinal of this ask (1-based, nudges included) plus cumulative tool calls and the latest
   * tool call -- via `node-progress`, one per resolved turn.
   *
   * Together they answer "is it moving": an ask stuck in `executing` for ten minutes is only distinguishable
   * as long-running vs dead by these. Legacy journals without `node-progress` omit all three --
   * readers must show unknown, never 0; 0 asserts the fact "no tool calls yet".
   *
   * Reduction is last-writer-wins, not max (inverse of `phases[].rounds`): a resume re-queue is a new ask
   * counting from 1; max would freeze the previous lifetime's readings here.
   */
  turn: z.number().int().positive().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  lastTool: workflowRunNodeLastToolSchema.optional(),
});
export type WorkflowRunNode = z.infer<typeof workflowRunNodeSchema>;

/**
 * This run's concurrency picture. Two bounds;
 * effective concurrency is the smaller:
 *
 * - `cap`: the shared gate for this run's provider key (the governor buckets by key, fans out per run,
 *   moving with `concurrency-changed`).
 * - `ceiling`: default concurrency D (the wire key predates the concept; kept for old readers). A reference line, not a cap:
 *   the shared cap may auto-grow to 2D and users may raise the run above D. Taken from `run.concurrencyCeiling`
 *   when known; only D-less old CLIs fall back to the largest seen `previous`/`next`.
 * - `limit`: this run's own bound (`max_concurrency` of CreateWorkflow/AmendWorkflow,
 *   landing in `caps.maxConcurrency`); arrives on `run-started`, moves with `run-caps-changed` on retune.
 *   Present only when != D (either direction): default-running runs look exactly as before, no extra key.
 * - `cooldownMs`: how long a Retry-After throttling freezes new dispatches, relative (same reasoning as `retryInMs`);
 *   `idle_reset` and run terminality clear it.
 *
 * UI reading rules: workflowRunConcurrencyView (docs/dynamic-workflow/concurrency.md, "What the user sees").
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
 * One progressive artifact from script `report(item)` (a Results-section row on the detail page).
 *
 * `report` is not `log`: it has site identity, journal rows, and its own RunEvent, so it feeds
 * the event log, Results, and completion notifications -- but never the causality graph (pure progress emission,
 * no ordering semantics) and never `nodes[]` -- chatty reports must not inflate step counts.
 *
 * `siteId x ordinal` is identity (the journal key) and the reduction dedup key: on replay every
 * `report` call re-runs; one instance must land as one row, not two.
 *
 * Stores preview text, not the raw value: the serialization rule (strings verbatim, else pretty JSON) is the same
 * one used for artifact echo-back, computed once CLI-side, so renderers never duplicate the contract -- and
 * the every-payload-bounded invariant reduces to one string cap.
 */
export const workflowRunReportSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  preview: z.string().max(WORKFLOW_RUNS_LIMITS.maxReportPreviewLength),
  /**
   * Second arg of `report(item, artifactId)`: which preset board this item feeds. Absent = untagged, Results only.
   *
   * Tagged items still enter `reports`: one channel, one cap; the tag adds a destination, never reroutes.
   * Bound equals the artifact id's (64) -- it is one.
   */
  artifactId: z.string().min(1).max(64).optional(),
});
export type WorkflowRunReport = z.infer<typeof workflowRunReportSchema>;

/**
 * A parked escalation: an actor hit a real blocker
 * (broken gate, contradictory instructions, missing facts), escalated it to the main agent, and pauses inside its ask.
 *
 * Identity is `qid` (globally unique, cross-run), not a site instance -- escalations have no site identity: no dwf_node
 * row, no maxNodes; a slow tool call inside one ask turn. Dedup key is qid; the actor is a mere
 * attribute -- a different family from the (siteId, ordinal)-deduped nodes/actors/reports tables.
 *
 * Hence `actorSiteId`/`actorOrdinal` are optional (shapes copied from `WorkflowRunNode`): a record that
 * cannot say who asked must still render -- visibility is the feature's whole point, and hiding a question
 * over an unreadable actor ref destroys it. `actorName` is the persona
 * name, absent for anonymous actors (events never synthesize fallback labels; consumers render nameless their own way).
 *
 * Purely in-memory, cleared at run terminality: the truth is parked deferreds in the CLI process. Death loses them,
 * so "someone still owes an answer" is always false on terminal runs -- by definition nobody is listening.
 */
export const workflowRunPendingQuestionSchema = z.object({
  /** Globally unique question id (`dwfq-<runId fragment>-<seq>`); the main agent answers by it. */
  qid: z.string().min(1).max(128),
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  actorName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  question: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength),
  context: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength).optional(),
  /**
   * Ask time (epoch ms), event-carried -- this module is pure reduction with no clock.
   *
   * Mandatory event-side (the driver is the sole producer, same `Date.now()` as the parked record) yet optional here:
   * old dev machines may replay events predating askedAt. Render waiting-time when present;
   * absence is not an error.
   */
  askedAt: z.number().int().nonnegative().optional(),
});
export type WorkflowRunPendingQuestion = z.infer<typeof workflowRunPendingQuestionSchema>;

/**
 * A hole (docs/dynamic-workflow/authoring.md, "Holes"; projection side in docs/dynamic-workflow/presentation.md
 * "Holes on the timeline"): a `hole<T>("name")` in the script; the run parks that branch awaiting
 * `FillWorkflowHole` code. Identity is the site id (name key `hole#<8-hex>`): one site may park many ordinals across loops;
 * only the latest is kept -- filling is once per site, and the surface only says waiting/filled.
 *
 * `state`: `waiting` = a parked deferred exists in the engine (truth in the CLI process, pendingQuestions-family;
 * stripped on new lifetimes and terminality); `filled` = the fill joined the run (journal `hole-filled`, survives lifetimes).
 * `type` is the author's literal; absent when the payload omits it -- readers fall back to display `holes[].type` by site id.
 * `since` is arrival (epoch ms, event-carried; no clock here); `filledAt`/`filledBy` arrive on `hole-filled`.
 */
export const workflowRunHoleSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  type: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxHoleTypeLength).optional(),
  /** Prompt shown to the main agent (`hole-reached` payload `prompt`), clipped per {@link WORKFLOW_RUNS_LIMITS.maxHolePromptLength}. */
  prompt: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxHolePromptLength).optional(),
  state: z.enum(["waiting", "filled"]),
  since: z.number().int().nonnegative().optional(),
  filledAt: z.number().int().nonnegative().optional(),
  filledBy: z.string().min(1).max(128).optional(),
});
export type WorkflowRunHole = z.infer<typeof workflowRunHoleSchema>;

export const workflowRunSchema = z.object({
  runId: z.string().min(1).max(128),
  /** The CreateWorkflow tool call that started this run (tool-card -> detail correlation key). */
  toolCallId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  /** Present only when `status === "stopped"`. */
  stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
  /**
   * Both lineage ends: which run this one revises
   * (`resumedFrom` on run-started) and which revision stopped-and-replaced it (`supersededBy` on run-settled,
   * only with `stopReason: "superseded"`). Both optional, per the `reports` rule:
   * fields added to a living state key degrade to missing-key, never a dropped frame.
   */
  resumedFrom: z.string().min(1).max(128).optional(),
  supersededBy: z.string().min(1).max(128).optional(),
  usage: workflowRunUsageSchema,
  error: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxErrorLength).optional(),
  /**
   * Resumable. Present only when true.
   *
   * The CLI computes it on `run-settled` with the same predicate as the resume gate (live via toProgressPayload,
   * cold replay via the reseed from journal rows); the reducer only carries it -- the UI must never re-derive from status + failureCode
   * (the two predicates will diverge someday: lit button, rejected command). Optional per `reports`: fields added to a
   * living state key degrade gracefully on old CLIs.
   */
  resumable: z.literal(true).optional(),
  resultPreview: z.string().max(WORKFLOW_RUNS_LIMITS.maxResultPreviewLength).optional(),
  actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors),
  nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes),
  /**
   * Progressive artifacts from `report(item)`, in report order. Absent entirely at zero (never an empty array):
   * the Results section renders nothing at all instead of an empty shell for report-less workflows.
   *
   * Deliberately optional, not required: this extends a living state key, and parse errors on known keys
   * are not stripped -- they fail the whole `state.updated` patch and drop the frame.
   * Required would trip that path for every reports-less old CLI; optional degrades to a missing key.
   */
  reports: z.array(workflowRunReportSchema).max(WORKFLOW_RUNS_LIMITS.maxReports).optional(),
  /**
   * Parked escalations in ask order. Absent entirely at zero (never `[]`), same doctrine as `reports`: the sidebar
   * renders nothing rather than an empty shell on a question-less run.
   *
   * Zero is this key's steady state, and it flaps: an answered question leaves the table, the last answer
   * returns it to absent. Consumers must never treat seen-once as here-to-stay.
   *
   * The second optional rationale matches `reports`: extending a living state key means parse errors on known keys
   * are not stripped -- required would drop whole frames from old CLIs lacking the field.
   */
  pendingQuestions: z
    .array(workflowRunPendingQuestionSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPendingQuestions)
    .optional(),
  /**
   * Concurrency picture (see {@link workflowRunConcurrencySchema}). Present after a `concurrency-changed`
   * (shared bucket moved) or when `run-started`/`run-caps-changed` delivered a limit != default
   * (the user bounded this run). Runs with neither sit on defaults -- nothing to say.
   * Optional per the `reports`/`pendingQuestions` rule.
   */
  concurrency: workflowRunConcurrencySchema.optional(),
  /**
   * Default concurrency D (run-started's `concurrencyCeiling`, a process fact baked in at payload mint; the key
   * predates the concept, kept for old readers). A starting point, not a cap. Unlike `concurrency`, present
   * whenever readable, own bound or not -- the config dialog writes "default N" from it and treats equal-to-default as no own bound
   * (docs/dynamic-workflow/concurrency.md, "Protocol state"). Optional per the `concurrency` rule:
   * old CLIs omit it; a missing key degrades.
   */
  concurrencyCeiling: z
    .number()
    .int()
    .positive()
    .max(WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling)
    .optional(),
  /**
   * Which model this run's subagents run on (`subagent_model` of CreateWorkflow/AmendWorkflow,
   * landing in payload `subagentModel`), canonical `providerId/modelId` with optional `$reasoningLevel`.
   * Arrives on `run-started` and never moves -- kin of `concurrency.limit`: a user-set condition for this run,
   * indifferent to runtime fluctuation.
   *
   * Present only when the user pinned a model for this run: otherwise subagents follow the session model.
   * The main agent always stays on the session model; this key speaks for the subagent side only.
   * Optional verbatim per `reports`/`concurrency`: a field added to a living state key degrades to missing
   * on old CLIs, never a dropped frame.
   */
  subagentModel: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength).optional(),
  /**
   * User-facing artifacts of this run, first-seen order, latest-version metadata only. Absent entirely at zero (never `[]`):
   * the side panel's Artifacts section renders nothing -- absent-when-empty, per `reports`/`pendingQuestions`.
   *
   * The second optional rationale matches `reports` verbatim, and is the one that matters: extending a living
   * state key means parse errors on known keys are not stripped -- required would drop frames from any
   * artifact-less old CLI. A missing key degrades; it does not error.
   *
   * Terminology: artifact here is the user-facing published output, not the
   * script's top-level return behind `resultPreview` (which the engine also calls artifact). See workflow-artifacts.ts header.
   */
  artifacts: z
    .array(workflowRunArtifactSummarySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxArtifacts)
    .optional(),
  /**
   * Entered phases, first-entry order.
   * Absent entirely at zero; optional per `reports` verbatim (old CLIs omit it; a missing key degrades,
   * never errors). Feeds the timeline's empty-phase dots and pre-first-dispatch running segments.
   */
  phases: z.array(workflowRunPhaseSchema).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
  /** Name of the phase control last entered (latest `phase-entered`); absent if never entered. */
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * Declared phase names in declaration order (`run-launched.phaseNames`); complements entered `phases`: the sidebar mini-track draws not-yet-reached stops from it.
   * Absent entirely for none/old-CLI/mark-less scripts.
   */
  phaseNames: z
    .array(z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * Position-aligned still-running table (`run-launched.phaseAlongside`):
   * `phaseAlongside[i]` holds indexes of phases whose strands still ran at `phaseNames[i]` entry, indexing into
   * `phaseNames`. The sidebar mini-track draws a double segment between parallel stops from it
   *
   * Depends on `phaseNames`: absent whenever that is; also absent with no parallelism -- absence means
   * a straight track. Reduction guarantees every index lands in the accepted table (workflow-runs-phases.ts).
   */
  phaseAlongside: z
    .array(z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * Which `phaseNames` stops are still-open holes (index table; `run-launched.holes`/`hole-filled.holes`;
   * docs/dynamic-workflow/presentation.md, "Holes on the timeline", "The model"). The sidebar renders only from `phaseNames`
   * with no display payload to query, so this table is its only basis for dotted hole dots. Once filled, the stop
   * leaves the table, replaced wholesale on `hole-filled`. Depends on `phaseNames`; absent when that is or when empty.
   *
   */
  phaseHoles: z
    .array(z.number().int().nonnegative())
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * This run's holes (see {@link workflowRunHoleSchema}), first-arrival order. Absent entirely at zero, per
   * `pendingQuestions`. Optional per `reports` verbatim: a field added to a living state key degrades to missing
   * on old CLIs, never a dropped frame.
   */
  holes: z.array(workflowRunHoleSchema).max(WORKFLOW_RUNS_LIMITS.maxHoles).optional(),
  /**
   * Bound spend per birth phase (see {@link workflowRunUnlistedPhaseSchema}). Absent entirely when
   * every bucket is zero. One longer than `maxPhases`: the trailing phaseless bucket shares the table.
   *
   * Once the table is full, newer phases' attribution is dropped while the run-level counters stay exact --
   * a stop may lack a number it never had; the run total must not lie.
   */
  unlistedByPhase: z
    .array(workflowRunUnlistedPhaseSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPhases + 1)
    .optional(),
  /**
   * Set when actors/nodes/reports/pendingQuestions/artifacts/phases hit their caps;
   * facts remain in the journal. Eviction (making room for newcomers) sets it too: the run's entry tables no
   * longer hold their own facts, and `run-started` reads this bit to decide whether a new lifetime starts empty.
   */
  truncated: z.boolean().optional(),
  /** Journal sequence of the last reduced event; a raise is the re-fetch trigger for the event log. */
  lastEventSequence: z.number().int().nonnegative(),
});
export type WorkflowRunState = z.infer<typeof workflowRunSchema>;

export const workflowRunsStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  runs: z.array(workflowRunSchema).max(WORKFLOW_RUNS_LIMITS.maxRuns),
});
export type WorkflowRunsState = z.infer<typeof workflowRunsStateSchema>;
