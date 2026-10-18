/**
 * Boundary types of the execution engine.
 *
 * This module is the vocabulary of pure types + structured errors + constants; all three
 * boundaries contract on it:
 * - Boundary A (host API): the sandbox script's facade shim calls {@link WorkflowHostApi}.
 * - Boundary B (driver port): the engine core (a deterministic state machine) drives
 *   {@link WorkflowDriver} downward, which reports progress via {@link WorkflowReportSink}.
 * - Journal: {@link JournalStorePort} exposes run/actor/node/event records repository-style;
 *   both the in-memory impl and a future SQLite impl fit naturally (synchronous methods match
 *   node:sqlite's DatabaseSync and keep the core deterministic).
 */

import type {
  ArtifactContentOp,
  ArtifactOp,
  ArtifactPresetOp,
  WorldReadOp,
} from "../facade/registry.js";
import type { AskProgress, AskStats } from "./ask-observation-types.js";
import type { ActorSessionSeed } from "./imported-cache-types.js";
import type {
  GetNodeOptions,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
} from "./journal-read-types.js";

// ————————————————————————————————————————————————————————————————
// Identity
// ————————————————————————————————————————————————————————————————

/**
 * Identity of one ask instance: site id x per-site execution ordinal.
 * The nth `ask("ask#3", ...)` call is instance `ask#3@n` (ordinals start at 1).
 */
export interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** Actor identity: creation site x ordinal (same shape as InstanceRef, actor semantics not ask). */
export interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * Opaque actor handle handed to the script. The script-side `Agent` is a thin wrapper around it.
 * The engine maps ActorId back to {@link ActorRef}; the format is invisible to scripts but must
 * be stable and parseable.
 */
export type ActorId = string;

/** Render an InstanceRef / ActorRef as the stable string `site@ordinal`, for logs and handles. */
export function refToString(ref: InstanceRef | ActorRef): string {
  return `${ref.siteId}@${ref.ordinal}`;
}

// ————————————————————————————————————————————————————————————————
// Persona / ask messages
// ————————————————————————————————————————————————————————————————

/**
 * Frozen actor persona, handed to {@link WorkflowDriver.createActorSession}.
 *
 * A persona is identity only (name + system prompt). Model tiers (`model?: "main" | "lite"`)
 * and tool tiers (`tools?: "default" | "readonly" | "none"`) are retired: the host has no lite
 * model source, and tool tiers only ever bought "referee cannot edit files" - ordinary subagents
 * never relied on a tier for that; the ask text says so. Subagents always run on the parent
 * session's current model with the full work toolset minus interactive tools that could hang or
 * need grants. Whether submit_result is registered is decided by the driver from the site graph
 * (all-untyped actors get none); not expressed here - personas describe identity only.
 *
 * 2026-09-26 addendum: a persona may name a **specific** model (`model`,
 * docs/dynamic-workflow/authoring.md "Choosing a model per subagent"). That is not the retired
 * tier notion back: a tier would need a host mapping the host does not have, while this is a
 * model name written verbatim in the script, resolved against the host catalog into the binding
 * table at launch (run-launched's `modelBindings`). The engine only records the name, never
 * interprets it - lookup and session creation are the host's job (bootstrap's
 * workflow-actor-model.ts). It is **not** part of cache identity (imported-cache.ts's
 * matchImportedActor).
 */
export interface PersonaSpec {
  name?: string;
  system?: string;
  /** Model name verbatim from the script (`ModelRef` already flattened to its name in lowering); absent = the run's subagent model. */
  model?: string;
}

/**
 * Outbound message of one ask: instruction body + typed flag + schema when typed (structure
 * opaque to the core, passed through to {@link ValidateFn} and the driver's schema footnote).
 * The schema comes from the synth side; the core never interprets its shape.
 */
export interface AskMessage {
  instructions: string;
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// Validation
// ————————————————————————————————————————————————————————————————

/**
 * One validation violation, designed to be model-readable in repair's tool_result: JSON path +
 * expected + got. Shared type with the schema submodule (declared in parallel; unify into
 * schema/types once landed).
 */
export type { Violation } from "../schema/types.js";
import type { Violation } from "../schema/types.js";

/**
 * Injected validator: `(schema, value) => violations` (empty list passes). The real validator is
 * implemented in parallel by another agent (src/schema/); the core depends only on this minimal
 * contract and never imports the implementation.
 */
export type ValidateFn = (schema: unknown, value: unknown) => Violation[];

/** Static spec per ask site: typed or not, and its schema. Untyped sites have no schema. */
export interface AskSpec {
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// Stats / budget
// ————————————————————————————————————————————————————————————————

/** The two reasons an import cache closes: a subagent's mutating tool, or a live `world.run`. */
export type ImportCloseCause = "mutating-tool" | "world-run";

/**
 * Run-level capacity caps, fixed at submit and stored in dwf_run. Only the concurrency cap
 * remains: token budgets and node caps were removed entirely
 * (docs/dynamic-workflow/authoring.md) - never set in production or mere goalposts; cancellation
 * is the control surface.
 *
 * The value **may change more than once while the run lives**: an amendment carrying only
 * `max_concurrency` applies to the living run
 * ("Two bounds on a run"). The engine therefore replaces its whole caps object instead of
 * mutating fields - the copies already recorded in
 * `run-started` / `run-caps-changed` events must stay as recorded.
 */
export interface Caps {
  maxConcurrency: number;
}

// Terminal-state structured details (ProviderStop detail, run-level stall observation) live in
// run-terminal.ts, re-exported verbatim here: this file is at the 400-line gate and their
// consumers conventionally import them from types.
// consumers conventionally import them from types.
import type { ProviderStopDetails, RunStallInfo } from "./run-terminal.js";

export type { ProviderStopDetails, RunStallInfo };

// ————————————————————————————————————————————————————————————————
// Structured errors (errors are first-class)
// ————————————————————————————————————————————————————————————————

// Error codes, serializable shapes, and WorkflowError itself live in errors.ts, re-exported
// verbatim here (same rationale as run-terminal.ts: 400-line gate; consumers import from types).
// verbatim here (same rationale as run-terminal.ts: 400-line gate; consumers import from types).
import type { WorkflowError, WorkflowErrorJson } from "./errors.js";

export { WorkflowError } from "./errors.js";
export type { WorkflowErrorCode, WorkflowErrorJson, WorkflowErrorMismatch } from "./errors.js";

// ————————————————————————————————————————————————————————————————
// Boundary A: host API (called by the sandbox script)
// ————————————————————————————————————————————————————————————————

/**
 * World-read ops (read-only, journalable). The vocabulary derives from the world-read registry -
 * a new primitive is one line in `facade/registry.ts`; nothing changes here (see that module's
 * container-key note).
 */
export type { WorldReadOp };

/**
 * User-facing artifact ops (vocabulary from the artifact registry, see `facade/registry.ts`).
 * `ArtifactContentOp` goes through {@link WorkflowHostApi.publishArtifact} (effect, via driver);
 * `ArtifactPresetOp` through {@link WorkflowHostApi.declareArtifact} (declaration, no driver).
 */
export type { ArtifactContentOp, ArtifactOp, ArtifactPresetOp };

/**
 * Artifact reference handed to the script (facade's `ArtifactRef`): id + the version minted by
 * this publication. Content members' promises resolve with it.
 */
export interface ArtifactRef {
  id: string;
  version: number;
}

/**
 * Persisted shape of one artifact version (the `dwf_node.result_json` shape; a zod mirror
 * lives on the shared side).
 * Content and preset members share one shape, each filling only its half: content has
 * `bytes`/`uri`/`sourcePath`, preset has `spec`. Bytes **never** enter the journal - `uri`
 * points into the tool-artifact store, the home of bytes.
 */
export interface ArtifactVersionRecord {
  id: string;
  kind: ArtifactOp;
  /** 1-based. Preset declarations are always 1 (a declaration has no versions; it happens once). */
  version: number;
  title?: string;
  description?: string;
  /** MIME of content members (extension table or `opts.contentType`). */
  contentType?: string;
  /** Byte count of content members. */
  bytes?: number;
  /** The store-returned `zcode-artifact://...` (content members). */
  uri?: string;
  /** Workspace-relative original path (`file` only; provenance and "show in workspace"). */
  sourcePath?: string;
  /** Preset member's spec (normalized shape; the engine compares repeat declarations by canonicalJson). */
  spec?: unknown;
  /** Published-at (epoch ms). Written by driver/host - the engine has no clock. */
  publishedAt?: number;
  /**
   * This id is the run's deliverable. Stamped by the **engine**, not the driver: it sticks to
   * the id - once one version carries it, later versions do too, regardless of `primary` at publish.
   */
  primary?: true;
}

/**
 * Driver request to publish one content artifact (Boundary B).
 *
 * `version` is computed by the **engine** before dispatch (completed rows for the id + 1) and
 * passed down, rather than counted by the driver: the driver should not know the journal shape,
 * and the store's `toolCallId` must carry it (one row of bytes per version). `path` /
 * `content` per `op`; arg validation is the driver's.
 */
export interface ArtifactPublishRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  op: ArtifactContentOp;
  id: string;
  version: number;
  /** `file`: workspace-relative path. */
  path?: string;
  /** `markdown`: body. */
  content?: string;
  /** Script-supplied `opts` (passed through verbatim; shape validation is the driver's). */
  opts?: unknown;
}

/**
 * Host API: the surface the lowered script's facade shim calls across the sandbox boundary. All
 * serializable, async. `createActor` returns an opaque handle synchronously; session creation
 * happens lazily on first live dispatch.
 *
 * `worldRead` takes **positional arg arrays**, not per-op payload objects:
 * `files.grep(pattern, glob?)` and `git.diff(base?, path?)` are multi-arg, `git.status()` none -
 * a single-string signature cannot carry them; and payload objects would move "branch per op"
 * into lowering, exactly where a new primitive should cost zero. Lowering passes through
 * verbatim; per-op arity and validation belong to the driver (the side that knows what a base
 * ref looks like).
 */
export interface WorkflowHostApi {
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId;
  ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown>;
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publish one intermediate result. **Fire-and-forget (sync signature, no return) yet sited and
   * journaled** - that combination is the whole design of report, both halves forced: the script
   * publishes a finding with nothing to await; and the run panel plus completion notification must
   * not show the same finding twice after resume, hence journal.
   *
   * No driver round trip: the engine records the node and emits the event in core (or silently
   * skips on replay hit) and returns.
   */
  report(siteId: string, item: unknown, artifactId?: string): void;
  /**
 * Control flow passed a `phase("...")` marker. Sync, no return, no driver round trip, **no
 * journal row**: the engine emits one `phase-entered` event and returns. `name` is taken from
 * the literal by lowering and trimmed.
  enterPhase(name: string): void;
/**
 * The script reached an **unfilled hole** (docs/execution-engine.md "Holes"). A Boundary A
 * call, ask-shaped minus one driver: the engine mints the ordinal, stamps the birth phase,
 * records `hole-reached`, and parks a promise at the site until the main agent delivers, via
 * {@link import("./engine.js").WorkflowEngine.fillHole} this hole's body from the valid script
 * (`{code}`, lowering's `holeBodies[siteId]`). **No journal row**: a hole is not a self-settling
 * node; the fill's product already lives on the run row as the valid script.
 * Already-filled sites (cell fill-table hit, or code remembered this life) should not reach
 * here; defensively the engine still answers at once from the remembered code - no parking, no
 * event. `prompt` truncated before recording.
 */
  hole(siteId: string, name: string, prompt?: string): Promise<{ code: string }>;
  /**
   * Publish a **content artifact** (`artifact.file` / `artifact.markdown`). Effect: bytes copied
   * into the store via driver, one journal row, resolves {@link ArtifactRef} on success and
   * rejects **catchably** on failure.
   *
   * Same rule as `worldRead`: `args` are the call site's positional args (`[id, path, opts]`),
   * packaged verbatim by lowering; this layer only takes the id the engine itself needs (cap and
   * version), the rest goes to driver.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef>;
  /**
   * Declare a **preset artifact** (`artifact.chart` / `table` / `metrics` / `board`). Sync, no
   * return, **no driver**: a declaration has nothing to await; the engine validates spec, records
   * the node, emits the event, done.
   *
   * Failures (invalid spec / same id different spec / over cap) always failRun - a void return has
   * no rejection channel, same argument as `report`.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void;
  log(message: string): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary B：driver port
// ————————————————————————————————————————————————————————————————

/** Opaque ref of one actor session (production: the zcode session id). */
export interface SessionRef {
  readonly id: string;
}

/** The core's verdict on one submit attempt, delivered to the driver via respondToSubmit. */
export type SubmitVerdict =
  | { kind: "accept" }
  | { kind: "reject"; violations: Violation[] }
  | { kind: "nudge" };

/**
 * Downward port: effects the core asks the driver to perform. The core is a pure deterministic
 * state machine; effects and progress reports live in the driver.
 * Journal and emit hang off the driver: the core makes journal decisions via `driver.journal`
 * and fans out Boundary C via `driver.emit`.
 */
export interface WorkflowDriver {
  /**
   * Mint one actor session. `seed` is present **only when the actor consumed >= 1 imported ask
   * entries** (amend-resume transcript truncation): before returning, the driver must copy the
   * source session's first `messageCount` messages into the fresh session, idempotently - skip
   * when the target already has content (crash-resume re-attaching the same session id; the id is
   * minted purely from (runId, actorRef) by the driver).
   *
   * Optional param: existing drivers may omit the formal param (legal TS); seed-less drivers
   * (fakes, pure-replay tests) may ignore it.
   */
  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef>;
  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void;
  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void;
  cancelAsk(instance: InstanceRef): void;
  /**
   * One world read. `args` are the call site's **positional args**, packaged by lowering
   * verbatim, unchecked; per-op arity and validation belong to the driver
   * (see {@link WorkflowHostApi.worldRead}).
   */
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publish one content artifact's bytes: validate arg shapes,
   * resolve the workspace-relative path (outside the roots refused), read bytes (probe cap+1,
   * refuse rather than truncate on overflow), pick contentType by extension, write the
   * tool-artifact store, return the stored record.
   *
   * **Optional**: pure replay / fake rigs have neither store nor filesystem. When absent the core
   * rejects the node with `ArtifactStoreUnavailable` - one loud named failure, not a silent
   * downgrade (preset members unaffected; they never touch the driver anyway).
   */
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  journal: JournalStorePort;
  emit(event: RunEvent): void;
  /**
   * Post-settlement resource release: called exactly once after the engine records
   * `run-settled` on any of the three terminal paths (complete / cancel / fail). The production
   * driver runs the same app-close chain per actor runtime here
   * (the runtime's `closeBrowserSession`: beginShutdown + node_repl session release + browser
   * session close) and clears the session table; in-flight asks were already aborted by
   * cancelAsk. Optional: fake / pure-replay rigs have nothing to release.
   */
  dispose?(): void;
}

/**
 * A model request of an in-flight ask is **waiting**:
 * - `cause: "slot"`: queued at the process-level admission gate (driver's `tryAdmit` miss); no
 *   other fields.
 * - `cause: "backoff"`: the runner scheduled a retry (`model_retry_scheduled`) with reason /
 *   attempt / delayMs / retryAfterMs. `reason` is a contracts `ModelRetryReason` value
 *   (`rate_limited` / `provider_overloaded` / ...); the pure package does not import contracts,
 *   hence an open string. `delayMs` is relative: the engine has no clock.
 */
export interface AskWaitInfo {
  cause: "slot" | "backoff";
  reason?: string;
  attempt?: number;
  delayMs?: number;
  retryAfterMs?: number;
}

/**
 * Why the process-level concurrency cap changed (decision 8/22). `limit_lowered`: the governor
 * lowered this key's growth ceiling (a higher-cap run settled or was tuned down) and the cap
 * moved to the new ceiling (docs/dynamic-workflow/concurrency.md "The governor"). `seeded`: the
 * user raised a run's cap and the cap jumped to it (same doc, "Seeding").
 * The wire is an open string; legacy readers render it as a generic change.
 */
export type ConcurrencyChangeReason =
  | "rate_limited"
  | "provider_overloaded"
  | "offpeak_queued"
  | "recovered"
  | "idle_reset"
  | "limit_lowered"
  | "seeded";

/**
 * A governor cap adjustment for one provider key, fanned out to every run with that key in
 * flight or waiting (per-run copies of a process-level fact are acceptable redundancy - the
 * journal can then explain "why was this run slow").
 */
export interface ConcurrencyChange {
  /** provider key（`${providerId}/${modelId}`）。 */
  key: string;
  previous: number;
  next: number;
  reason: ConcurrencyChangeReason;
  lastGood?: number;
  lastBad?: number;
  /** Throttled with Retry-After: how long new dispatches freeze (relative). */
  cooldownMs?: number;
}

/**
 * Upward surface: the driver reports session progress into the core. The core implements this
 * interface (production drivers hold a reference; phase-one tests play "the model" directly).
 */
export interface WorkflowReportSink {
  /** One submit attempt; the core validates and replies via respondToSubmit. */
  askSubmitAttempted(instance: InstanceRef, payload: unknown): void;
  /** A turn ended uncommitted: the core decides nudge, or settles an untyped ask from finalText. */
  askTurnEnded(instance: InstanceRef, finalText: string): void;
  /**
   * Progress observation at one turn's resolution: the engine only
   * `record()`s `node-progress`, deciding nothing from it. **Must precede the same turn's
   * askStats call** - the ordering of the two events is a read-surface contract. Calls after the
   * run settled are ignored.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void;
  /** Usage: accumulate run usage and broadcast usage/instance updates. */
  askStats(instance: InstanceRef, stats: AskStats): void;
  /** Unrecoverable driver-side error; settles the ask as failed. */
  askFailed(instance: InstanceRef, error: WorkflowError): void;
  /**
   * A deterministic model-side error: **does not** settle
   * the node; instead the whole run stops as `stopped(provider)` (in-flight asks aborted, as in
   * cancel). `error.code` must be `ProviderStop`. Calls after the run settled are ignored.
   */
  stopRun(error: WorkflowError): void;
  /** Run-level stall observation: the engine only `record()`s it. */
  runStalled(info: RunStallInfo): void;
  /**
   * Three pure observations: the engine only `record()`s, deciding nothing.
   * Calls after the run / node settled are ignored.
   */
  /** The ask's next model request is waiting: process gate (slot) or runner backoff. */
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void;
  /** One of the ask's model requests actually fired (`model_request_started`, and not already executing). */
  askExecuting(instance: InstanceRef): void;
  /**
   * The ask's subagent is **about to** run a workspace-mutating tool:
   * the engine closes the import cache on it. The only driver observation the engine decides
   * from - the cache's answers speak to the predecessor's world, which stops existing at the
   * first write. Reported before the tool acts (after PreToolUse, before the handler), so the
   * gate closes before the first byte lands. Calls after the run / node settled are ignored.
   */
  askMutating(instance: InstanceRef): void;
  /** The process governor adjusted the cap of this run's provider key. */
  concurrencyChanged(change: ConcurrencyChange): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary C: run events
// ————————————————————————————————————————————————————————————————

/**
 * Node kinds: ask, world-read, world-run, or report (the latter three: no actor, no actorSeq).
 * `world-run` is the journaled command execution of world.run - mechanically identical to
 * world-read; a separate kind keeps the audit surface honest (effects must not pose as reads).
 * `report` has a journal row but is a node in neither graph - it emits progress, not order.
 * `artifact` is one publication/declaration of a **user-facing artifact**, row-without-node like
 * `report`: a deliverable is not a step others wait on. Unrelated to
 * `RunSettlement.artifact` (the top-level return value).
 */
export type NodeKind = "ask" | "world-read" | "world-run" | "report" | "artifact";

/**
 * The **bounded** input of a world-read / world-run node (`dwf_node.input_json`). `args` stay
 * positional verbatim, but past {@link WORLD_READ_INPUT_MAX_BYTES} serialized, items collapse to
 * string previews and `truncated` sets - the audit surface prefers an honest "truncated" over
 * cramming a 200 KB `node -e` script into a hot table.
 */
export interface WorldReadInput {
  op: string;
  args: unknown[];
  truncated?: true;
}

/** Byte cap of serialized `WorldReadInput` (4 KB). */
export const WORLD_READ_INPUT_MAX_BYTES = 4096;

/** Semantic result of a settled node. Replay hits are distinguished by the event's `cached` flag, not folded here. */
export type NodeOutcome = "ok" | "failed" | "cancelled";

/**
 * Run lifecycle states. Three terminals:
 * - `completed`: the script returned;
 * - `errored`: the script's fault (a throw, an engine contract violated) - not resumable, only
 *   a `resume_from` amendment;
 * - `stopped`: the run was stopped (`RunStopReason`), **always resumable**.
 *
 * The physical column `dwf_run.status` keeps the legacy five values (`failed` /`cancelled`)
 * unmigrated: this is the **logical** vocabulary; the mapping lives only in the SQLite store's
 * codecs (adapters dwf-journal-codecs.ts).
 */
export type RunStatus = "pending" | "running" | "completed" | "errored" | "stopped";

/**
 * Why the run stopped: `user` (user cancel) / `model` (main-agent TaskStop) / `provider`
 * (deterministic model-side error, see `ProviderStop`) / `interrupted` (owning process death,
 * sandbox crash / timeout / protocol corruption - host-side; a rerun likely fixes it) /
 * `superseded` (stopped and replaced by an AmendWorkflow; successor in `supersededBy`;
 * **not resumable** - the successor is the live one).
 */
export type RunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";

/**
 * Run event vocabulary (Boundary C). Every state transition worth observing emits one event.
 * `compaction` is reserved for long-context compaction - never emitted in v1, a placeholder for
 * a non-breaking future addition.
 */
export type RunEvent =
  | { type: "run-started"; runId: string; caps: Caps }
  /**
   * The launching turn: `inputId` is the inputId of the parent-session turn that launched this
   * run (hub launches mint a UUID v7). **Recorded once, in the run's birth life**, right after the
   * first `run-started`; a resume's `run-started` does not repeat it - a run's subagent steps
   * therefore always hang under one message. Zero SQL: the anchor lives in the journal event, not
   * a dwf_run column (no migration on purpose).
   * `phaseNames` is the script's declared phase table (declaration order), filled by the
   * submitter from the causality graph; the sidebar mini-track draws upcoming stations from it.
   * Also once only; cold replay rebuilds it for free; absent without `phase()` markers.
   * `subagentModel` is the model this run's subagents run on, canonical
   * `providerId/modelId[$reasoningLevel]`. Same host-metadata family as the anchor and phase
   * table: the engine **never reads it**, recording it once in the birth life; the host reads the
   * same string back from the event head on resume and both read surfaces (subagent sessions pick
   * by "this field > resume pin > parent session model", bootstrap's workflow-actor-model.ts).
   * Also zero SQL - no dwf_run column. Absent = subagents on the session model.
   * `phaseAlongside` aligns **by position** with `phaseNames`: `phaseAlongside[i]` holds the
   * indices (into that same `phaseNames`) of phases still running when `phaseNames[i]` was
   * entered. The sidebar draws two parallel stations as a double segment; absent when none run in
   * parallel - absence means "this track is a straight line".
   * `scriptPath` is the file this run's script **came from** (absolute). Item by item the same
   * rules as `subagentModel`: never read by the engine, once in the birth life, zero SQL, read
   * back from the event head. Absent = no editable script file (projects where drafts cannot be
   * written, pre-feature runs); the model surface falls back to the inline-resubmit wording.
   * `subagentPermissionMode` is the run's subagent permission mode
   * (docs/dynamic-workflow/launch.md "Permissions inside a run"): the launching session's mode
   * name (plan not carried). The same rules again: never read by the engine, once in the birth
   * life, zero SQL; the host reads it back on resume, validates, and runs subagents in that mode.
   * Absent or unknown value = YOLO.
   */
  | {
      type: "run-launched";
      inputId: string;
      toolCallId?: string;
      parentSessionId?: string;
      phaseNames?: string[];
      subagentModel?: string;
      subagentPermissionMode?: string;
      /**
       * Every model name written in the script (verbatim) -> canonical
       * `providerId/modelId[$level]`
       * (docs/dynamic-workflow/launch.md "Models the script names"). Same path as `subagentModel`:
       * submitter-supplied, recorded in the birth life, never read by the engine. Absent when the
       * script names no model.
       */
      modelBindings?: Record<string, string>;
      scriptPath?: string;
      phaseAlongside?: number[][];
      /**
       * Which `phaseNames` indices are **unfilled holes**
       * (docs/execution-engine.md "Holes"): a hole occupies its named place in the phase table, and
       * the sidebar draws that station dashed. Aligned by the same rule as `phaseAlongside`, same
       * carriage (submitter-supplied, engine never reads); absent when the script has no holes.
       */
      holes?: number[];
    }
  /**
   * `phaseName` records the phase name most recently set by `enterPhase` when the instance
   * was born. It appears only on **birth events** - the actor's `actor-created`, a node's
   * `node-queued`, and, on cache hits (replay / amend-resume), the
   * `node-settled { cached: true }` standing in for queued; other `node-*` events omit it, and
   * reducers carry it forward after the `actorSiteId` precedent. Instances born before any marker
   * omit the key entirely.
   *
   * It is **not** the phase at emit time: a node-queued may be deferred past the next marker by
   * hold rules while the birth happened in the previous phase.
   */
  | {
      type: "actor-created";
      actor: ActorRef;
      name?: string;
      persona?: PersonaSpec;
      phaseName?: string;
    }
  | {
      type: "node-queued";
      instance: InstanceRef;
      kind: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      phaseName?: string;
      /**
       * First {@link INSTRUCTIONS_HEAD_MAX_CHARS} chars of the author's instruction
       * (trimmed, no ellipsis), ask nodes only. On the event track it is the only answer to "what is
       * this subagent doing": the full instruction lives only in `dwf_node.input_json`, which read
       * surfaces (run detail, GetWorkflowRun) do not read for a one-line summary.
       * Taken at **admission** - the copy before the engine appended its epilogue; the epilogue is the
       * engine's voice, not the author's.
       */
      instructionsHead?: string;
    }
  /**
   * Dispatch: the driver is told to run. The ask variant **repeats its own birth facts** -
   * `kind` / `actor` / `phaseName` / `instructionsHead` verbatim as on its `node-queued`, plus
   * `actorName` / `actorPhaseName` from its subagent's `actor-created`.
   *
   * Why repeat already-emitted facts: read-side tables are **bounded**, and "important" happens at
   * dispatch, not at queue time
   * (docs/dynamic-workflow/presentation.md). A 2000-agent run emits every
   * `actor-created` / `node-queued` within the first seconds; the table fills with the first 1024
   * queued, none settled, and no actually-running instance ever enters. With birth facts attached,
   * this event is a self-sufficient birth: read surfaces admit the instance and its subagent from
   * it alone, never hunting a long-evicted queued.
   *
   * Both phase names are **birth stamps**, not the phase at emit: a queued ask can sit behind the
   * concurrency cap while the script moved on (stamps per engine-phase-stamp.ts, reading the table
   * written at mint).
   * world-read dispatches carry none of these: they follow their `node-queued` immediately and
   * have no subagent.
   */
  | {
      type: "node-dispatched";
      instance: InstanceRef;
      kind?: NodeKind;
      actor?: ActorRef;
      actorName?: string;
      actorPhaseName?: string;
      /**
       * Its subagent persona's `model` (the name written in the script, verbatim): a birth fact
       * repeated, same reason as `actorName`, so subagents readmitted at dispatch carry their model
       * (the host derives the canonical string via the binding table).
       */
      actorPersonaModel?: string;
      phaseName?: string;
      instructionsHead?: string;
    }
  | { type: "node-repairing"; instance: InstanceRef; attempt: number; violations: Violation[] }
  | { type: "node-nudged"; instance: InstanceRef }
  /**
   * The three adaptive-concurrency observations. Same family as escalation:
   * the engine core decides nothing from them - they are driver/governor observations recorded via
   * `record()` into the journal + fan-out. `node-waiting` x `node-executing` is a self-loop
   * between dispatched and settled (making `executing` an **observable** phase); the node's
   * journal row is untouched (no dwf_node write).
   */
  | ({ type: "node-waiting"; instance: InstanceRef } & AskWaitInfo)
  | { type: "node-executing"; instance: InstanceRef }
  | ({ type: "concurrency-changed" } & ConcurrencyChange)
  /**
   * This run's **own** concurrency cap changed in place
   * (docs/dynamic-workflow/concurrency.md "Two bounds on a run"): an amendment carrying only
   * `max_concurrency` applied to the living run - same runId, no successor minted, not one
   * in-flight ask lost.
   *
   * Two different bounds - do not confuse with the adjacent `concurrency-changed`: that one is
   * the governor's observation of the process-wide shared cap (model requests; the engine only
   * records); this one is this run's in-flight-ask cap, and the result of a **command** - swapping
   * caps, writing `dwf_run.caps_max_concurrency`, and emitting this event happen in one
   * synchronous step, always consistent. `previous` is the pre-change copy: read surfaces must say
   * "8 -> 2", underivable from one caps value.
   */
  | { type: "run-caps-changed"; runId: string; caps: Caps; previous: Caps }
  | {
      type: "node-settled";
      instance: InstanceRef;
      outcome: NodeOutcome;
      cached?: boolean;
      error?: WorkflowErrorJson;
      /** Present only with `cached: true`: a hit has no queued; this settlement is its birth event. */
      phaseName?: string;
      /**
       * The next four appear only on **ask cache hits** (replay and amend-import hits share the
       * posture): the settlement doubles as the birth event, so it **re-emits birth facts** - the
       * `kind` / `actor` / `actorSeq` / `instructionsHead` a `node-queued` would have carried, for
       * the same reason `node-dispatched` repeats them: a read surface that never saw the instance
       * queued (an amended run starts from empty tables) must still learn whose answer this is.
       * Without them, a subagent whose asks all hit reads as "pending". World nodes' cache hits carry
       * none: no subagent.
       */
      kind?: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      instructionsHead?: string;
      /**
       * Present when the answer was read from a **predecessor transcript** (an import hit, or a
       * resumed amended run replaying an imported row): the session owning that exchange (the import
       * candidate's `transcriptSourceSessionId`). This run built no session for the hit; transcript
       * read surfaces must look there
       * (docs/dynamic-workflow/presentation.md "Subagent
       * transcripts"). Absent = answered in this run's own session.
       */
      sourceSessionId?: string;
    }
  /**
   * One ask's progress at a turn resolution.
   * Same family as the escalation/concurrency observations: **the core does not interpret it**, it
   * only `record()`s - no scheduling decision, not in inputHash, replay does not compare it. The
   * order of the two same-turn events is payload: this one precedes `usage-updated`, so whoever
   * reads the new usage has already read the progress that earned it.
   */
  | ({ type: "node-progress"; instance: InstanceRef } & AskProgress)
  /** Run-level token usage update: carries the spent total directly (journal spent_tokens written in sync; the two never diverge). */
  | { type: "usage-updated"; spentTokens: number }
  | { type: "log"; message: string }
  /**
   * The amend-resume import cache closed: a live subagent is about to
   * mutate the workspace (`cause: "mutating-tool"`, `actorName` its effective name), or a
   * `world.run` executes live (`cause: "world-run"`). At most one per run; a resumed amended run
   * restores "gate closed" from it - the **only** source of that fact, no longer inferred from
   * "some ask went live". Non-amended runs have no gate; never emitted.
   */
  | {
      type: "import-cache-closed";
      instance: InstanceRef;
      cause: ImportCloseCause;
      actorName?: string;
    }
  /**
   * Control flow passed a `phase("...")` marker. **No site, no journal row, no driver round
   * trip** - a marker is not work, just a tick of "where are we". `name` is the author's verbatim
   * word (trimmed; the same key the analyzer uses to mint phase ids); `ordinal` counts per name,
   * **emitted on every evaluation**: re-entering a name increments, and the analyzer reads the
   * second same-name marker as a back-edge. On resume the script re-emits the prefix (no journal
   * row to dedupe against); consumers reducing monotonically are immune.
   */
  | { type: "phase-entered"; name: string; ordinal: number }
  /**
   * The script reached an unfilled hole (docs/execution-engine.md "Holes"). `instance` is
   * `<hole id>@ordinal` - the ordinal mints like nodes', but **no journal row**; `phaseName` is
   * the birth phase, stamped from the same table as `node-queued`. `prompt` truncated to 4000
   * chars. After a resume, a still-waiting hole is reached again and recorded once more (no row,
   * no ordinal to collide).
   */
  | {
      type: "hole-reached";
      instance: InstanceRef;
      name: string;
      prompt?: string;
      phaseName?: string;
    }
  /**
   * `fillHole`: the valid script is written back to the run row and the parked branch released.
   * `phaseNames` is the valid script's phase table (holes occupy named slots), `holes` the
   * still-unfilled indices (aligned per `run-launched.holes`); the sidebar redraws stations from
   * it without waiting for display payloads. `filledBy` is the filling session.
   */
  | {
      type: "hole-filled";
      siteId: string;
      filledAt: number;
      filledBy?: string;
      phaseNames: string[];
      holes?: number[];
      /**
       * The draft minted for a run that had none
       * (docs/dynamic-workflow/launch.md "The draft after a fill").
       * `run-launched.scriptPath` is written once, in the birth life; a cold read trusting only it
       * would miss the fill-minted draft after restart - hence the later path rides this event into
       * the journal, and cold readers take the last present one. Fills of runs that already had a
       * draft (in-place rewrite, same path) omit it.
       */
      scriptPath?: string;
    }
  /**
   * One published intermediate result, exactly once per **unskipped** `report` call (replay
   * hits skip silently, no re-emit). Travels the same route as every run event (progress sink ->
   * bounded session event -> projection reducer), ending in the run panel's Results section.
   *
   * A present `artifactId` means this item also fed that preset (`report(item, "perf")`) - the
   * projection bumps that artifact's `itemCount`, the signal board hooks watch.
   */
  | { type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }
  /**
   * A new version of a **user-facing artifact** is in place: one per successful content publish,
   * one per preset declaration that actually landed (idempotent no-ops emit nothing). Same rule as
   * report - no re-emit on replay; cold recovery reads the journal.
   *
   * The success path emits **only this event**, no node lifecycle events (node-queued /
   * dispatched / settled). Same argument as `report`: an artifact is a deliverable, not a step
   * others wait on; it is a node in neither graph.
   */
  | { type: "artifact-published"; instance: InstanceRef; artifact: ArtifactVersionRecord }
  /**
   * A content publish failed (the node lands `failed` in the journal; the script side gets a
   * catchable rejection).
   *
   * **Deliberately not `node-settled{failed}`**: that event's readers reduce it into `nodes[]`
   * and require a matching graph node, and artifact sites are in **no graph** - a node-settled on
   * such a site is an unexplainable "unknown node" in the run panel, and the graph layer reports
   * an unknown site id. The failure therefore needs its own event, carrying enough to render a
   * failure card (id / kind / structured error) without posing as work. Replay never re-emits a
   * failure record (same as report / artifact-published).
   */
  | {
      type: "artifact-failed";
      instance: InstanceRef;
      id: string;
      op: ArtifactContentOp;
      error: WorkflowErrorJson;
    }
  | { type: "compaction"; actor: ActorRef }
  /**
   * An actor escalated a blocking question to the main agent and parked inside its ask, waiting
   * for the answer.
   *
   * **The engine core never emits these two** - the driver does, inside the ask boundary (the same
   * layer as repair / nudge turns); the zero-IO state machine never sees escalation. They live in
   * this vocabulary anyway: they travel the same two tracks as every run event (the journal's
   * dwf_event + driver.emit's live fan-out), and those tracks' shape is defined by `RunEvent`.
   * Escalation **writes no dwf_node row** (waiting is not work).
   */
  | {
      type: "escalation-raised";
      qid: string;
      actor: ActorRef;
      /**
       * The actor's **effective name** (= `spec.name` after `normalizePersona` - the one on the
       * `actor-created` event and the amend-resume cache-identity key). Absent for anonymous actors,
       * and no fallback label is synthesized - consumers render "nameless" their own way.
       */
      actorName?: string;
      question: string;
      context?: string;
      /**
       * Asked-at (epoch ms). **Required**: the first question any reader answers is "how long has
       * this waited", and the event track has no other clock - `dwf_event.time_created` exists only
       * on the durable track; the live track
       * (driver.emit -> progress sink -> sidebar) cannot see it, and a local receive-time fallback
       * would render every question "just asked" in a cold replay of history.
       *
       * The same instant as the snapshot's `pendingQuestions[].askedAt` (one `Date.now()` shared by
       * event and parked record), so waiting times agree across read surfaces.
       */
      askedAt: number;
    }
  | { type: "escalation-resolved"; qid: string; answer: string }
  /** Run-level stall observation (see {@link RunStallInfo}); ignored once the run settled. */
  | ({ type: "run-stalled" } & RunStallInfo)
  /**
   * `stopReason` present only when `status === "stopped"`; `error` always on `errored`, and on
   * `stopped` only for `provider` (`ProviderStop`) and `interrupted` (`Interrupted`).
   */
  | {
      type: "run-settled";
      status: RunStatus;
      stopReason?: RunStopReason;
      /** Present when `stopReason === "superseded"`: the new run minted by the amendment that stopped this one. */
      supersededBy?: string;
      error?: WorkflowErrorJson;
    };

// ————————————————————————————————————————————————————————————————
// Journal storage port + records
// ————————————————————————————————————————————————————————————————

/** The dwf_run record (the core hard-depends only on caps/status/failure; the rest is phase-two shaping). */
export interface RunRecord {
  runId: string;
  parentSessionId?: string;
  cwd?: string;
  /**
   * User-chosen run name (`CreateWorkflow`'s optional `input.name`). Pure display metadata: the
   * engine never reads it; stored with scriptText/cwd at createRun for the host's enumeration
   * surfaces to label with - else cross-session lists show bare runIds. Absent = unnamed (readers
   * fall back to the first script line, never writing back).
   */
  name?: string;
  /**
   * CreateWorkflow tool call id that launched this run. Pure host metadata: unread by the
   * engine, stored at createRun with scriptText/cwd. The only surviving join anchor across
   * restarts - the `workflowRuns` projection does not survive processes; tool-card joins and the
   * resume notification anchor reconstruct from it.
   */
  toolCallId?: string;
  scriptText?: string;
  scriptHash?: string;
  /**
   * This run's args (a saved workflow's declared parameters, validated, defaults filled).
   *
   * Part of the run **identity**, same rank as `scriptText`, not display metadata: resume replays
   * the stored args and never accepts new ones - different args are a different run and deserve a
   * fresh confirm. Absent (legacy NULL) reads as `{}`, never backfilled (invariant 6/7).
   */
  args?: Record<string, unknown>;
  /**
   * amend-resume lineage pointer: the predecessor run this one amends. Host metadata, unread by
   * the engine, stored at createRun with the rest. Amendment is **supersede** - new runId, new
   * script, predecessor row untouched - so this pointer is the only link: resume rebuilds the
   * import cache from it (`port.resume` rebuilds the ImportedCache when present) and the UI's
   * "continued from run X" reads it here. Absent = not an amendment (the vast majority of runs).
   */
  resumedFrom?: string;
  caps: Caps;
  /** Cumulative token usage (observation surface, not control). */
  spentTokens: number;
  status: RunStatus;
  /** Present when `status === "stopped"` (absent after legacy decode => `user`; see the store codecs). */
  stopReason?: RunStopReason;
  /** Present when `stopReason === "superseded"`: the successor that replaced this run (the two ends of the same edge as its `resumedFrom`). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  /** The script's top-level return value. Present only for completed runs (an `undefined` product leaves the field out). */
  result?: unknown;
}

/** The dwf_actor record, unique(runId, siteId, ordinal). */
export interface ActorRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  name?: string;
  persona?: PersonaSpec;
  sessionId?: string;
  /**
   * The model the actor actually ran on (`providerId/modelId`), written by the driver side.
   *
   * Why not inside `persona`: the persona is the frozen identity the engine writes at
   * createActor, while the model is host fact (the parent session's **then-current** choice),
   * invisible to the engine. Two fields give identity and host fact one author each - whoever
   * writes it owns it.
   *
   * Why persist it: run cost becomes auditable, and resume re-attaches to the **same** model - a
   * parent session changing its main model between runs must not silently switch models mid-run
   * (the pin; see bootstrap's workflow-actor-model.ts).
   * Like `sessionId`, a driver-owned field: the engine's putActor only carries the existing value
   * through (see createActor in engine.ts and ensureSession in scheduler.ts), never producing one.
   */
  resolvedModel?: string;
}

/**
 * Persisted node states. A node lands as `running` at **admission** (with actorSeq and
 * inputHash) and updates to completed/failed at settlement. A node that crashes mid-execution
 * thus keeps a `running` row; resume re-dispatches live at the recorded actorSeq position
 * instead of short-circuiting as a finished result.
 *
 * **The report node is the sole exception to this two-write rule**: written once, persisted
 * `completed` - there is no driver call between admission and settlement, hence nothing that
 * could fail in between.
 */
export type NodeRecordStatus = "running" | "completed" | "failed";

/**
 * The dwf_node record. unique(runId, siteId, ordinal); asks add
 * unique(runId, actorSiteId, actorOrdinal, actorSeq). world-read and report leave actor* and
 * actorSeq empty; report rows also satisfy: written once, status always `completed`, `result`
 * the reported item, `inputHash` over that item (defensively compared on replay hit).
 */
export interface NodeRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  kind: NodeKind;
  actorSiteId?: string;
  actorOrdinal?: number;
  actorSeq?: number;
  inputHash: string;
  status: NodeRecordStatus;
  result?: unknown;
  error?: WorkflowErrorJson;
  stats?: AskStats;
  /**
   * The **user-facing artifact** id (`dwf_node.artifact_id` column). Two row kinds carry it:
   * `kind: "artifact"` rows (the artifact this row published/declared) and labeled
   * `kind: "report"` rows (which preset this item fed). The latter is where the "board = journal
   * projection" invariant lands - every point of a board is a row
   * `kind = report AND artifact_id = ?`. Empty on other rows.
   */
  artifactId?: string;
  /**
   * **world-read / world-run nodes only**: the op and args actually
   * executed at this site, **bounded** ({@link WorldReadInput}). `inputHash` answers "same
   * input?" but not "what input" - the workspace transcript must say *what ran*, not merely
   * *something ran*.
   * Written at admission (in the same putNode as `inputHash`); the settlement upsert carries it
   * through; absent on pre-0030 rows and on ask / report / artifact rows.
   */
  input?: WorldReadInput;
  /**
   * **ask nodes only**: after the ask's full exchange (the repair / nudge turns plus the
   * post-submit closing message) ends, the length of the actor session's message log - a count
   * offset, not an id range.
   *
   * A driver-owned backfill (same family as the `stats` backfill, likewise getNode+putNode
   * read-modify-write); the engine never produces it. A count rather than an id range, because
   * count's key property is **invariance under prefix-copy**: copying the source session's first N
   * messages into a fresh session changes every id but not the count, so the copied ask's boundary
   * value stays valid in the new session. That is the foundation of amend-resume's full-fidelity
   * transcript truncation (and of chained amendments).
   */
  messageBoundary?: number;
}

/** One persisted event; sequence assigned monotonically by appendEvent. */
export interface StoredEvent {
  sequence: number;
  event: RunEvent;
  /**
   * When the store appended this event (epoch ms). The only clock for every "how long ago" in
   * the event log: a row's age, a subagent's last action, how long a stall ran - all computed
   * from it.
   * A read-time `Date.now()` fallback would be wrong - a cold replay would stamp week-old history
   * "just now".
   * Optional in type so test doubles implementing the port keep compiling; both **real** impls
   * (SQLite's `time_created` column, the memory impl's append stamp) must fill it; a contract
   * test pins that.
   */
  timeCreated?: number;
}

// Read-surface options (kinds / types / withResult / reportItems ...) live in journal-read-types.ts (max-lines split).
export type {
  GetNodeOptions,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  RunEventType,
} from "./journal-read-types.js";

/**
 * The persisted payload of run settlement. Exists for **one-write**: terminal state and product
 * as two UPDATEs would let a crash in between mint a `completed` run whose product is
 * unrecoverable. Absent keys mean "do not touch that column"
 * (the engine's `running` write and legacy rows predating a column rely on this).
 */
export interface RunSettlementRecord {
  /** Written in the same stroke as `status === "stopped"`; other states carry none. */
  stopReason?: RunStopReason;
  /** Written in the same stroke as `stopReason === "superseded"` (the stopped envelope is rewritten whole; splitting it loses data). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  result?: unknown;
}

/**
 * Journal storage port: repository-style, synchronous, no SQL leakage. The in-memory impl is
 * journal-memory.ts; the SQLite and memory impls share this port. Legacy test entries went with
 * the Vitest cleanup, keeping production compilation free of undeclared test frameworks.
 */
export interface JournalStorePort {
  createRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void;
  /**
   * Persist cumulative token usage on its own (a high-frequency small write outside run
   * settlement). Unknown runId must throw;
   * never touch status/failure - usage updates and run settlement are independent write paths.
   */
  updateRunUsage(runId: string, spentTokens: number): void;
  /**
   * Persist this run's concurrency cap alone (`dwf_run.caps_max_concurrency`). Unknown runId
   * must throw; **that column only** - status, usage, and the settlement bag are outside this
   * write's scope, same family as {@link updateRunUsage}.
   *
   * It is the column's **second writer** (the first is {@link createRun}): a
   * max_concurrency-only amendment applies in place to the living run, while resume trusts the
   * stored caps - left unpersisted, a restored run would revive the old cap.
   */
  updateRunCaps(runId: string, caps: Caps): void;
  /**
   * Write the **valid script** back to the run row (`dwf_run.script_text` / `script_hash`,
   * docs/execution-engine.md "Holes"). The second writer of these columns after
   * {@link createRun}: a fill splices the body into the script, and resume thereafter hashes the
   * row's text against the row's hash - so the two columns **must be written in one stroke**.
   * Unknown runId must throw; everything else on the row (status, usage, cap, settlement bag,
   * metadata) is outside this write's scope, same family as {@link updateRunUsage}.
   */
  updateRunScript(runId: string, scriptText: string, scriptHash: string): void;

  putActor(record: ActorRecord): void;
  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined;
  listActors(runId: string, opts: ListActorsOptions): ActorRecord[];

  putNode(record: NodeRecord): void;
  getNode(
    runId: string,
    siteId: string,
    ordinal: number,
    opts?: GetNodeOptions,
  ): NodeRecord | undefined;
  /** Read surfaces must declare what they want (docs/execution-engine.md "Reading the journal"); whole-table reads use `"all"`. */
  listNodes(runId: string, opts: ListNodesOptions): NodeRecord[];
  /** `count(*)`: readers wanting only the row count need not read rows out. */
  countNodes(runId: string, kind: NodeKind): number;
  /**
   * Sum of UTF-8 serialized `result` bytes over the kind's rows (the bytes of
   * `JSON.stringify(result)`; resultless rows count 0). Byte-count readers (resume's run-level
   * report-byte accounting) need not read results out: SQLite-side it is
   * `sum(octet_length(result_json))` - length from the row head, results untouched.
   */
  sumResultBytes(runId: string, kind: NodeKind): number;

  appendEvent(runId: string, event: RunEvent): StoredEvent;
  /**
   * List events by ascending sequence. Type filter, cursor, limit, and report-item stripping all
   * happen storage-side, never fetch-all-then-slice - pagination and filtering exist so the whole
   * journal is not read into memory.
   * Unknown runId and out-of-range cursors return empty arrays (no throw): in the race window
   * between projection and journal, a client returning a not-yet-existing cursor is normal.
   */
  listEvents(runId: string, opts: ListEventsOptions): StoredEvent[];
}

// The driver's ask-observation vocabulary (usage + progress) lives in ask-observation-types.ts (as above); re-exported here to keep import paths.
export {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
} from "./ask-observation-types.js";
export type { AskLastTool, AskProgress, AskStats } from "./ask-observation-types.js";

// ————————————————————————————————————————————————————————————————
// Import cache (amend-resume)
// ————————————————————————————————————————————————————————————————

// Import-cache data structures live in imported-cache-types.ts (split at this file's max-lines cap); re-exported here to keep import paths.
export type {
  ActorSessionSeed,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedRunCache,
  ImportedWorldEntry,
} from "./imported-cache-types.js";

// ————————————————————————————————————————————————————————————————
// Policy constants (part of this contract)
// ————————————————————————————————————————————————————————————————

/** In-ask repair (rejection retry) cap: 3. */
export const REPAIR_ATTEMPTS = 3;

/** Nudge cap when a turn ends uncommitted: 1. */
export const NUDGE_ATTEMPTS = 1;
