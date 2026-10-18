/**
 * Boundary types of the execution engine.
 *
 * Pure types + structured errors + constants: the vocabulary all three boundaries contract on:
 * - Boundary A (host API): the sandbox facade shim calls WorkflowHostApi.
 * - Boundary B (driver port): the deterministic core drives WorkflowDriver downward;
 *   progress returns via WorkflowReportSink.
 * - Journal: the store port exposes run/actor/node/event records repository-style,
 *   so in-memory and future SQLite implementations slot in naturally (sync methods fit node:sqlite DatabaseSync and keep the core deterministic).
 */

import type {
  ArtifactContentOp,
  ArtifactOp,
  ArtifactPresetOp,
  WorldReadOp,
} from "../facade/registry.js";
import type { AskProgress, AskStats } from "./ask-observation-types.js";
import type { ActorSessionSeed } from "./imported-cache-types.js";

// ————————————————————————————————————————————————————————————————
// identity
// ————————————————————————————————————————————————————————————————

/**
 * One ask instance identity: site id x per-site ordinal.
 * The nth call of a site is instance site at n (ordinals from 1).
 */
export interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** Actor identity: creation site x ordinal (shaped like InstanceRef, but an actor, not an ask). */
export interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * The opaque actor handle handed to the script; the script-side Agent is a thin wrapper around it.
 * The engine maps ids back to refs; the format is invisible to scripts but must be stable and parseable.
 */
export type ActorId = string;

/** Renders a ref as the stable site at-ordinal string, for logs and handles. */
export function refToString(ref: InstanceRef | ActorRef): string {
  return `${ref.siteId}@${ref.ordinal}`;
}

// ————————————————————————————————————————————————————————————————
// persona / ask messages
// ————————————————————————————————————————————————————————————————

/**
 * The frozen actor persona, handed to the driver session factory.
 *
 * A persona is identity only (name + system prompt). The model tier and tool tier knobs are retired: no lite source host-side, and
 * the tool tier bought only reviewers-cannot-edit -- ordinary subagents never relied on tiers for that; the ask text says so.
 * Subagents run on the parent current model with the full work toolset minus hanging/overprivileged interactive tools.
 * Whether submit_result registers is the driver call, via the site graph (all-untyped actors skip);
 * not expressed here -- a persona describes identity, nothing more.
 */
export interface PersonaSpec {
  name?: string;
  system?: string;
}

/**
 * One ask outbound message: instruction body + typed flag + the schema when typed (opaque to the core,
 * passed through to the validator and the driver schema footnote). The synthesizer produces it;
 * the core never interprets its shape.
 */
export interface AskMessage {
  instructions: string;
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// validation
// ————————————————————————————————————————————————————————————————

/**
 * One validation violation, shaped to be model-readable in the repair tool_result: path + expected + got.
 * Shared type with the schema module (declared twice during parallel work; unified into schema types on landing).
 */
export type { Violation } from "../schema/types.js";
import type { Violation } from "../schema/types.js";

/**
 * The injected validator: schema+value to violations (empty passes). The real validator is
 * implemented in parallel (src/schema); the core depends only on this minimal contract, never the implementation.
 */
export type ValidateFn = (schema: unknown, value: unknown) => Violation[];

/** Per-ask-site static spec: typed flag and schema. Untyped sites carry none. */
export interface AskSpec {
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// stats / budget
// ————————————————————————————————————————————————————————————————

/** The two import-gate causes: a subagent mutating tool, a live world.run. */
export type ImportCloseCause = "mutating-tool" | "world-run";

/**
 * Run-level capacity caps, fixed at submit into dwf_run. Keeps the concurrency cap;
 * stopping goes through the cancel interface.
 *
 * The value **may change while the run lives**: a max-concurrency-only amendment lands on the living run
 * (see the engine setter). The engine therefore replaces its caps wholesale, never field-edits -- the copies already
 * recorded into run events must stay as recorded.
 */
export interface Caps {
  maxConcurrency: number;
}

// Terminal-state detail (ProviderStop detail, the run-stall observation) lives in run-terminal.ts, re-exported
// verbatim: this file is at the 400-line gate, and consumers still import from here by convention.
import type { ProviderStopDetails, RunStallInfo } from "./run-terminal.js";

export type { ProviderStopDetails, RunStallInfo };

// ————————————————————————————————————————————————————————————————
// structured errors
// ————————————————————————————————————————————————————————————————

// Codes, the serializable shape, and the error class live in errors.ts, re-exported verbatim (same
// reason as run-terminal: the 400-line gate; consumers import from here by convention.
import type { WorkflowError, WorkflowErrorJson } from "./errors.js";

export { WorkflowError } from "./errors.js";
export type { WorkflowErrorCode, WorkflowErrorJson, WorkflowErrorMismatch } from "./errors.js";

// ————————————————————————————————————————————————————————————————
// Boundary A: the host API (called by the sandbox script)
// ————————————————————————————————————————————————————————————————

/**
 * World-read ops (read-only, journalable). The vocabulary derives from the registry -- a new primitive is
 * one row there; nothing changes here (see that module top for the container-key rationale).
 */
export type { WorldReadOp };

/**
 * User-facing artifact ops (the vocabulary derives from the artifact registry).
 * Content ops go through the publish host call (effect, via the driver);
 * preset ops through declare (declaration, no driver).
 */
export type { ArtifactContentOp, ArtifactOp, ArtifactPresetOp };

/**
 * The artifact reference handed to the script (the facade ref): id + the version minted by this publish.
 * Content promises fulfill with it.
 */
export interface ArtifactRef {
  id: string;
  version: number;
}

/**
 * The persisted shape of one artifact version (the node result json; a zod mirror lives shared-side).
 *
 * Content and preset members share one shape, each filling its half: content has bytes/uri/sourcePath,
 * presets the spec. Bytes **never** enter the journal -- the uri points into the tool-artifact store, their home.
 */
export interface ArtifactVersionRecord {
  id: string;
  kind: ArtifactOp;
  /* From 1. Preset declarations always 1 (a declaration has no versions; it happens once). */
  version: number;
  title?: string;
  description?: string;
  /* Content MIME (from the extension table or the explicit opts). */
  contentType?: string;
  /* Content byte size. */
  bytes?: number;
  /* The store-returning artifact uri (content members). */
  uri?: string;
  /* Workspace-relative original path (file only; provenance and workspace display). */
  sourcePath?: string;
  /* The preset spec (normalized; re-declaration compared by canonical JSON). */
  spec?: unknown;
  /* Published-at (epoch ms). Driver/host written -- the engine has no clock. */
  publishedAt?: number;
  /**
   * This id is the run deliverable. Stamped by the **engine**, not the driver: sticky by id --
   * once one version carries it, later versions do too, flag re-passed or not.
   */
  primary?: true;
}

/**
 * Driver request to publish one content artifact (Boundary B).
 *
 * The version is computed by the **engine** before dispatch (completed rows for the id, plus one) and handed down,
 * not counted by the driver: the driver shall not know the journal shape, and the store toolCallId must carry it
 * (one byte set per version). path or content, per the op; arg validation is the driver.
 */
export interface ArtifactPublishRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  op: ArtifactContentOp;
  id: string;
  version: number;
  /* file: the workspace-relative path. */
  path?: string;
  /* markdown: the body. */
  content?: string;
  /* The script opts (passthrough; shape validation is the driver). */
  opts?: unknown;
}

/**
 * The host API: the surface the lowered script facade shims call across the sandbox boundary. All serializable, async.
 * createActor returns its handle synchronously; the session is created lazily at first live dispatch.
 *
 * worldRead takes a **positional args array**, not a per-op payload object: grep/diff are multi-arg, status nullary -- a single-string
 * signature cannot hold; and a payload object would move per-op branching into lowering -- exactly where new primitives must be zero-touch.
 * Lowering passes through verbatim; per-op arity/validation is the driver (the side that knows what a base ref looks like).
 */
export interface WorkflowHostApi {
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId;
  ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown>;
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publish one intermediate result. **Fire-and-forget (synchronous, no return) yet sited and journaled** -- that
   * combination is the whole design, both halves forced: a script publishes a finding with nothing to await; and
   * the run panel and completion notice must not show one finding twice after resume, hence the journal.
   *
   * No driver round trip: the engine persists the node, emits the event (or silently skips on a replay hit), done.
   */
  report(siteId: string, item: unknown, artifactId?: string): void;
  /**
   * Control flow passed a phase marker. Synchronous, no return, no driver round trip, **no journal row**,
   * just one phase-entered event. The name comes from the literal, trimmed by lowering.
   */
  enterPhase(name: string): void;
  /**
   * Publish a **content artifact** (file/markdown). Effect: the driver copies bytes into
   * the store, one journal row; success fulfills the ref, failure rejects catchably.
   *
   * As in worldRead: args are the call-site positional args, packed by lowering verbatim; this layer takes only the id
   * the engine needs (caps and versioning), the rest to the driver.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef>;
  /**
   * Declare a **preset artifact** (chart/table/metrics/board). Synchronous, no return,
   * **no driver**: nothing to await; the engine validates the spec, persists the node, emits, done.
   *
   * Failures (bad spec / same id different spec / over cap) are failRun -- void has no rejection channel, the
   * same argument as report.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void;
  log(message: string): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary B：driver port
// ————————————————————————————————————————————————————————————————

/** An opaque actor-session reference (the zcode session id in production). */
export interface SessionRef {
  readonly id: string;
}

/** The core verdict on one submit attempt, delivered to the driver via respondToSubmit. */
export type SubmitVerdict =
  | { kind: "accept" }
  | { kind: "reject"; violations: Violation[] }
  | { kind: "nudge" };

/**
 * The downward port: side effects the core asks of the driver. The core is a pure deterministic machine; effects and progress live driver-side.
 * Journal and emit hang off the driver: journal decisions via driver.journal, Boundary C fan-out via driver.emit.
 */
export interface WorkflowDriver {
  /**
   * Mint an actor session. The seed is present **only when the actor consumed at least one imported ask**
   * (the amend-resume transcript truncation): the driver must copy the source session first
   * messageCount messages into the new session, idempotently -- skip when the target has content,
   * the crash-then-reattach-same-id case (ids minted purely from run+actor).
   *
   * Optional param: existing drivers dropping one formal parameter is legal TS; seedless drivers (fakes,
   * pure-replay tests) may ignore it.
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
   * Execute one world read. args are the call-site **positional args**, packed verbatim, unchecked here;
   * per-op arity/validation is the driver (see the host API worldRead).
   */
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publish content bytes: validate the arg shape,
   * resolve the workspace path (out-of-root rejected), read bytes (cap+1 probe; over-cap rejects, never truncates), mime
   * from the extension, write the store, return the record.
   *
   * **Optional**: pure-replay/fake rigs have no store nor filesystem. Absent, the engine rejects the node
   * store-unavailable -- one loud named failure, not a silent downgrade (presets unaffected; they never touch the driver).
   */
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  journal: JournalStorePort;
  emit(event: RunEvent): void;
  /**
   * Post-settlement resource release: called exactly once after the terminal path records run-settled.
   * Production drivers run the app-close shutdown chain per actor runtime (beginShutdown, node_repl release, browser close)
   * and clear the session table; in-flight asks are already aborted. Optional: fakes/pure-replay have nothing to release.
   */
  dispose?(): void;
}

/**
 * A model request of an in-flight ask is **waiting**:
 * - cause slot: queued at the process-level admission gate (a missed tryAdmit); no other fields.
 * - cause backoff: a retry scheduled, with reason/attempt/delay/retryAfter.
 * The reason is a contracts retry-reason value (`network_error` / `timeout` / `stream_idle_timeout` /
 * `stale_connection` / `offpeak_queued` ...); the pure package does not import contracts, hence an open string. The delay is relative: the engine has no clock.
 */
export interface AskWaitInfo {
  cause: "slot" | "backoff";
  reason?: string;
  attempt?: number;
  delayMs?: number;
  retryAfterMs?: number;
}

/** Why the process-level concurrency cap changed. */
export type ConcurrencyChangeReason =
  | "rate_limited"
  | "provider_overloaded"
  | "offpeak_queued"
  | "recovered"
  | "idle_reset";

/**
 * The governor's cap adjustment for one provider key, fanned out to every run with in-flight or waiting asks on
 * that key (per-run duplication of a process-level fact is acceptable redundancy -- the journal can then
 * explain why this run was slow).
 */
export interface ConcurrencyChange {
  /** The provider key (`${providerId}/${modelId}`). */
  key: string;
  previous: number;
  next: number;
  reason: ConcurrencyChangeReason;
  lastGood?: number;
  lastBad?: number;
  /** Rate limiting with Retry-After: how long new dispatches stay frozen (relative). */
  cooldownMs?: number;
}

/**
 * The upward surface: the driver reports session progress into the core. The core implements this interface
 * (the production driver holds its reference; in phase-one tests the test plays the "model" and calls these).
 */
export interface WorkflowReportSink {
  /** One submit attempt; the core validates and returns the verdict via respondToSubmit. */
  askSubmitAttempted(instance: InstanceRef, payload: unknown): void;
  /** A turn ended without submit: the core decides nudge, or settles an untyped ask by finalText. */
  askTurnEnded(instance: InstanceRef, finalText: string): void;
  /**
   * Progress observation at one turn resolution: the engine only
   * `record()`s it as `node-progress`, deciding nothing from it. **Must precede the same turn's askStats call**
   * -- the ordering of the two events is a read-surface contract. Calls arriving after the run settled are ignored.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void;
  /** Usage stats: accumulates run usage and broadcasts usage/instance updates. */
  askStats(instance: InstanceRef, stats: AskStats): void;
  /** Unrecoverable driver-side error; settles the ask as failed. */
  askFailed(instance: InstanceRef, error: WorkflowError): void;
  /**
   * A deterministic model-side error: does **not** settle
   * the node, instead stops the whole run as `stopped(provider)` (in-flight asks all aborted, same as cancel).
   * `error.code` must be `ProviderStop`. Calls arriving after the run settled are ignored.
   */
  stopRun(error: WorkflowError): void;
  /** Run-level stall observation: the engine only `record()`s it. */
  runStalled(info: RunStallInfo): void;
  /**
   * Three pure observations: the engine only `record()`s them, deciding nothing.
   * Calls arriving after the run / node settled are ignored.
   */
  /** The ask's next model request is waiting: the process-level admission gate (slot) or runner backoff. */
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void;
  /** One of the ask's model requests actually went out (`model_request_started`, not already executing on entry). */
  askExecuting(instance: InstanceRef): void;
  /**
   * A subagent of this ask is **about to** run a workspace-mutating tool:
   * the engine closes the import cache on it. The only driver observation the engine decides on -- cached answers
   * speak to the predecessor world, which no longer exists after the first write. Reported before the tool
   * touches anything (after PreToolUse, before the handler), so the closing precedes the first byte on disk.
   * Calls arriving after the run / node settled are ignored.
   */
  askMutating(instance: InstanceRef): void;
  /** A process-level governor changed the cap of the provider key this run sits on. */
  concurrencyChanged(change: ConcurrencyChange): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary C: run events
// ————————————————————————————————————————————————————————————————

/**
 * Node kinds: ask, world-read, world-run, or report (the latter three have no actor, no actorSeq).
 * `world-run` is the journaled command execution of world.run -- mechanically isomorphic to world-read;
 * a separate kind keeps the audit surface honest (effects must not masquerade as reads).
 * `report` has a journal row yet is a node in neither graph -- it emits progress, not ordering.
 * `artifact` is one publish or one declaration of a **user-facing artifact**; like
 * `report` it has a row but no node: a deliverable is not a step others can await. ⚠ Unrelated to `RunSettlement.artifact`
 * (the top-level return value).
 */
export type NodeKind = "ask" | "world-read" | "world-run" | "report" | "artifact";

/**
 * The **bounded** input of a world-read / world-run node (`dwf_node.input_json`). `args` is kept
 * verbatim by position, but once serialized past {@link WORLD_READ_INPUT_MAX_BYTES} each item is truncated to a
 * string preview with `truncated` set -- the audit surface prefers honestly saying "truncated" over stuffing a
 * 200 KB `node -e` code string into a hot-read table.
 */
export interface WorldReadInput {
  op: string;
  args: unknown[];
  truncated?: true;
}

/** Byte cap of the serialized `WorldReadInput` (4 KB). */
export const WORLD_READ_INPUT_MAX_BYTES = 4096;

/** The semantic outcome of a node settlement. Replay hits are distinguished by the `cached` flag on the event, not folded in here. */
export type NodeOutcome = "ok" | "failed" | "cancelled";

/**
 * Run lifecycle status. Three terminal states:
 * - `completed`: the script returned;
 * - `errored`: a script error (thrown, or an engine contract violated) -- not resumable, only fixable via `resume_from`;
 * - `stopped`: the run was stopped (a `RunStopReason`), **always resumable**.
 *
 * The physical column `dwf_run.status` keeps the legacy five values (`failed` / `cancelled`) unmigrated: this is the
 * **logical** vocabulary; the mapping lives only in the SQLite repository codecs (adapters `dwf-journal-codecs.ts`).
 */
export type RunStatus = "pending" | "running" | "completed" | "errored" | "stopped";

/**
 * Why the run stopped: `user` (user cancelled) / `model` (the main agent's TaskStop) / `provider` (a deterministic
 * model-side error, see `ProviderStop`) / `interrupted` (owning process died, sandbox crash / timeout / protocol
 * corruption -- host-side, a rerun likely fixes it) / `superseded` (stopped and replaced by an AmendWorkflow; the
 * successor id is in `supersededBy`; **not resumable** -- the successor is the live one).
 */
export type RunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";

/**
 * The run event vocabulary (Boundary C). Every state transition worth observing emits one event.
 * `compaction` is reserved for long-context compaction -- never emitted in v1, a placeholder so it can be
 * added non-breakingly later.
 */
export type RunEvent =
  | { type: "run-started"; runId: string; caps: Caps }
  /**
   * The turn that launched the run: `inputId` is the inputId of the parent-session turn that
   * started this run (a minted UUID v7 on hub-direct starts). **Recorded once, in the run's birth
   * incarnation**, right after the first
   * `run-started`; a resume re-emitting `run-started` does not repeat it -- the run's subagent steps therefore
   * always hang under the same
   * message. Zero SQL: the anchor lives in the journal event, not a dwf_run column (migration deliberately skipped).
   * `phaseNames` is the phase table declared by the script (declaration order), filled by the submitter from the
   * causality graph; the sidebar mini-track draws the stations ahead from it. Also recorded once;
   * cold replay rebuilds it for free; absent when the script has no `phase()` markers.
   * `subagentModel` is which model this run's subagents run on, canonical `providerId/modelId[$reasoningLevel]`. Same host-metadata lane as the anchor and phase table: the engine **never reads it**,
   * it is recorded once in the birth incarnation with this event; the host reads the same string back from the
   * event head on resume and both read surfaces
   * (subagent sessions pick by "this field > resume pin > parent session model", bootstrap's
   * workflow-actor-model.ts). Also zero SQL -- not a `dwf_run` column. Absent means subagents run on the session model.
   * `phaseAlongside` is **positionally aligned** with `phaseNames`: `phaseAlongside[i]` holds the indexes of the other
   * phases still running when `phaseNames[i]` is entered (indexes into the same `phaseNames`). The sidebar draws two
   * parallel stations as a double segment from it; absent when no phases run in parallel -- absence means "this track is a straight line".
   * `scriptPath` is **which file** this run's script came from (absolute path). Same rules as `subagentModel`, item
   * for item: never read by the engine, recorded once in the birth
   * incarnation, zero SQL; the host reads the same string back on both read surfaces. Absent means this run has no editable script
   * file (drafts that never landed, runs from before this feature); the model surface falls back to inline resubmit.
   */
  | {
      type: "run-launched";
      inputId: string;
      toolCallId?: string;
      parentSessionId?: string;
      phaseNames?: string[];
      subagentModel?: string;
      scriptPath?: string;
      phaseAlongside?: number[][];
    }
  /**
   * `phaseName` records the phase name set by the most recent `enterPhase` at the instance's birth.
   * Present only on **birth events** -- the actor's `actor-created`,
   * the node's `node-queued`, and the cache-hit (replay / amend-resume)
   * `node-settled { cached: true }` that stands in for queued; other `node-*` events omit it, and the reducer
   * carries it forward per the `actorSiteId` precedent. Instances born before any marker omit the key entirely.
   *
   * It is **not** the current phase when the event fires: node-queued may be held past the next marker
   * by the hold rule, while birth happened in the previous phase.
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
       * The **head** {@link INSTRUCTIONS_HEAD_MAX_CHARS} characters of the author instructions
       * (ends trimmed, no ellipsis), present only on ask nodes. On the event track, the only answer to
       * "what is this subagent doing": the full instructions live only in
       * `dwf_node.input_json`, and the read surfaces (run detail, GetWorkflowRun) do not read that table for a one-line summary.
       *
       * Taken at **admission time**, i.e. before the engine appends its footnote -- the footnote is the
       * engine's words, not the author's.
       */
      instructionsHead?: string;
    }
  /**
   * Dispatch: the driver is told to start. For asks this event **repeats its own birth facts** -- `kind` / `actor` /
   * `phaseName` / `instructionsHead` are verbatim identical to the instance's `node-queued`, while `actorName` /
   * `actorPhaseName` are the `name` / `phaseName` its subagent's `actor-created` carried.
   *
   * Why repeat already-emitted facts: the read-surface table is **bounded**, and "interesting" happens at dispatch,
   * not at queueing. A 2000-agent run emits every `actor-created` / `node-queued` in the first seconds;
   * the table fills with the first 1024 queued, none settled, and after that no **actually running**
   * instance can enter the table. Carrying its birth facts, this event is a self-sufficient birth:
   * the read surface can admit the instance and its subagent from it alone, without chasing a long-rejected queued.
   *
   * Both phase names are **birth stamps**, not the current phase at emit time: a queued ask can sit behind the
   * concurrency cap while the script has moved on (stamping in engine-phase-stamp.ts, reading the table written at the mint site).
   * A world-read dispatch carries none of these keys: it fires right after its own `node-queued`, and has no subagent.
   */
  | {
      type: "node-dispatched";
      instance: InstanceRef;
      kind?: NodeKind;
      actor?: ActorRef;
      actorName?: string;
      actorPhaseName?: string;
      phaseName?: string;
      instructionsHead?: string;
    }
  | { type: "node-repairing"; instance: InstanceRef; attempt: number; violations: Violation[] }
  | { type: "node-nudged"; instance: InstanceRef }
  /**
   * The three adaptive-concurrency observation events. Same family as escalation:
   * the engine core decides nothing from them -- they are facts observed by the driver / governor, recorded via the engine's
   * `record()` into the journal + fan-out. `node-waiting` ⇄ `node-executing` is a self-loop between dispatched and settled
   * (making `executing` an **observable** phase), and changes no journal record of the node
   * (nothing written to dwf_node).
   */
  | ({ type: "node-waiting"; instance: InstanceRef } & AskWaitInfo)
  | { type: "node-executing"; instance: InstanceRef }
  | ({ type: "concurrency-changed" } & ConcurrencyChange)
  /**
   * This run's **own** concurrency cap changed in place: a max_concurrency-only amendment lands on the living
   * run -- same runId, no successor minted, not one in-flight ask lost.
   *
   * Do not confuse this with the adjacent `concurrency-changed`: that one is the governor's view of the process-level
   * shared cap (in model requests, engine only records), this one is this run's in-flight ask cap and the result of a
   * **command** -- new caps, the `dwf_run.caps_max_concurrency` write, and this event happen in one synchronous step, always consistent.
   * `previous` is the pre-change copy: the read surface wants to say "8 -> 2", not derivable from a single caps value.
   */
  | { type: "run-caps-changed"; runId: string; caps: Caps; previous: Caps }
  | {
      type: "node-settled";
      instance: InstanceRef;
      outcome: NodeOutcome;
      cached?: boolean;
      error?: WorkflowErrorJson;
      /** Present only with `cached: true`: a cache-hit node has no queued; this event is its birth. */
      phaseName?: string;
    }
  /**
   * One ask's progress at a turn resolution.
   * Same family as the escalation / concurrency observations: the **engine core does not interpret it**, only
   * `record()`s it -- it changes no scheduling
   * decision, enters no inputHash, replay does not compare it. The order of the two same-turn events is load-bearing:
   * this one precedes `usage-updated`, so whoever reads the new usage has already read the progress that earned it.
   */
  | ({ type: "node-progress"; instance: InstanceRef } & AskProgress)
  /** Run-level token usage update: carries the total spent directly (written to the journal's spent_tokens in step; the two are always equal). */
  | { type: "usage-updated"; spentTokens: number }
  | { type: "log"; message: string }
  /**
   * The amend-resume import cache closed: a live subagent is about to
   * rewrite the workspace (`cause: "mutating-tool"`, `actorName` its effective name), or a live `world.run`
   * (`cause: "world-run"`). At most one per run; a resume after an amended run crashes restores "gate closed" from
   * it -- the **only** source of truth for the closing, no longer inferred from "an ask was once live". Non-amended
   * runs have no table to close and do not emit it.
   */
  | {
      type: "import-cache-closed";
      instance: InstanceRef;
      cause: ImportCloseCause;
      actorName?: string;
    }
  /**
   * Control flow passed a `phase("...")` marker. **No site, no journal row, no driver round trip** -- a marker is
   * not a unit of work, just a "where are we" tick. `name` is the author's verbatim string (ends trimmed, the same key the analyzer uses to mint phase ids);
   * `ordinal` counts per name, **emitted on every evaluation**: re-entering a name is +1, and the analyzer reads the
   * second same-name marker as a back edge. On resume the re-run script re-emits the prefix (no journal row to dedupe against); consumers reducing monotonically are immune.
   */
  | { type: "phase-entered"; name: string; ordinal: number }
  /**
   * One published intermediate result, exactly once per **unskipped** report call (a replay hit skips
   * silently, no re-emit). Travels the exact same route as every other run event (progress sink ->
   * bounded session events -> projection reducer), landing in the run panel's Results section.
   *
   * `artifactId` present means this item also fed that preset artifact (`report(item, "perf")`) -- the projection
   * bumps that artifact's `itemCount` by it, the board hook's signal to refetch on count change.
   */
  | { type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }
  /**
   * A new version of a **user-facing artifact** is in place: one event per successful content publish, one per preset
   * declaration that actually lands (idempotent no-ops emit nothing). Same rule as report -- replay hits do not
   * re-emit, cold recovery reads the journal.
   *
   * The success path emits **only this event**, no node lifecycle events (node-queued / dispatched / settled).
   * Same argument as `report`: an artifact is a deliverable, not a step others can await; it is a node in neither graph.
   */
  | { type: "artifact-published"; instance: InstanceRef; artifact: ArtifactVersionRecord }
  /**
   * A content-artifact publish failed (the node journals as `failed`, the script gets a catchable rejection).
   *
   * **Deliberately not reusing `node-settled{failed}`**: readers of that event reduce it into `nodes[]` and expect a
   * graph node at the site, while artifact sites **enter no graph** -- a node-settled on such a site would be an
   * unexplainable "unknown node" in the run panel, and the graph layer would report an unknown site id. The publish
   * failure therefore gets its own event: it carries enough to render a failure card (id / kind / structured error)
   * without posing as a unit of work. A replay hit on a failure record does **not** re-emit (same as report / artifact-published).
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
   * An actor escalated a blocking question to the main agent, and parks inside its own ask awaiting the answer.
   *
   * **The engine core never emits these two events** -- the driver emits them inside the ask boundary (same layer as
   * repair / nudge turns); the zero-I/O state machine never sees escalation. Why they live in this vocabulary anyway:
   * they travel the same two tracks as every other run event (the journal's dwf_event + driver.emit's live fan-out),
   * and those tracks are shaped by `RunEvent`. Escalation **writes no dwf_node row** (waiting is not work).
   */
  | {
      type: "escalation-raised";
      qid: string;
      actor: ActorRef;
      /**
       * The actor's **effective name** (= `spec.name` after `normalizePersona`, the one on the
       * `actor-created` event and the cache identity key amend-resume uses). Absent for anonymous actors,
       * with no synthesized fallback label -- consumers decide how to render "nameless".
       */
      actorName?: string;
      question: string;
      context?: string;
      /**
       * Question time (epoch ms). **Required**: the first question a reader answers is always "how long has this
       * been waiting", and the event track has no other clock -- `dwf_event.time_created` exists only on the durable
       * track; the live track (driver.emit -> progress sink -> sidebar) cannot see it, and an
       * event-received-locally fallback would render every question as just-asked on a cold replay of history.
       *
       * The same instant as the snapshot's `pendingQuestions[].askedAt` (the driver takes `Date.now()` once,
       * shared by event and park record), so wait times agree across both read surfaces.
       */
      askedAt: number;
    }
  | { type: "escalation-resolved"; qid: string; answer: string }
  /** Run-level stall observation (see {@link RunStallInfo}); calls after the run settled are ignored. */
  | ({ type: "run-stalled" } & RunStallInfo)
  /**
   * `stopReason` is present only when `status === "stopped"`; `error` is always present on `errored`, and on
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
// Journal store port + records
// ————————————————————————————————————————————————————————————————

/** The dwf_run record (the core hard-depends only on caps/status/failure; the rest is shape-for-phase-two). */
export interface RunRecord {
  runId: string;
  parentSessionId?: string;
  cwd?: string;
  /**
   * The human-given run name (`CreateWorkflow`'s optional `input.name`). Pure display metadata: the engine never
   * reads it, it is persisted with scriptText / cwd at createRun for the host's enumeration surface to use as a label --
   * otherwise cross-session
   * listings would be bare runId strings. Absent means unnamed (read side falls back to the script's first line, no write-back).
   */
  name?: string;
  /**
   * The CreateWorkflow tool-call id that started this run. Pure host metadata: the engine never reads it, persisted
   * with scriptText / cwd at createRun. It is the only surviving correlation anchor after a restart -- the `workflowRuns` projection does not
   * survive processes; tool-card joins and the resume notification anchor are both restored from it.
   */
  toolCallId?: string;
  scriptText?: string;
  scriptHash?: string;
  /**
   * This run's arguments (a saved workflow's declared params, validated with defaults backfilled).
   *
   * Part of the run's **identity**, the same level as `scriptText`, not display metadata: resume replays the
   * args stored here, never accepting new ones -- different args are a different run and owe a fresh
   * confirmation window. Absent (NULL on legacy rows) reads as `{}`, no backfill (invariants 6/7).
   */
  args?: Record<string, unknown>;
  /**
   * The amend-resume lineage pointer: which predecessor run this run amends. Host metadata; the engine never reads it, persisted with the rest at
   * createRun. An amendment is a **supersede** -- new runId, new script, predecessor row untouched -- so the only link
   * between the two is this pointer: resume rebuilds the import cache (`port.resume` rebuilds the ImportedCache when present) and
   * the UI's "continued from run X" both restore from here. Absent means this run is not an amendment (the vast majority).
   */
  resumedFrom?: string;
  caps: Caps;
  /** Cumulative token usage (an observation surface, not a control surface). */
  spentTokens: number;
  status: RunStatus;
  /** Present when `status === "stopped"` (absent decodes to `user` on legacy rows; see the repository codecs). */
  stopReason?: RunStopReason;
  /** Present when `stopReason === "superseded"`: the successor run that replaced this one (both ends of the same edge as its `resumedFrom`). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  /** The script's top-level return value. Present only for completed runs (an `undefined` product means the whole field is absent). */
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
   * Which model the actor actually ran on (`providerId/modelId`), written by the driver side.
   *
   * Why not inside `persona`: persona is the frozen identity the engine writes at createActor, while the model is a host-side
   * fact (the parent session's choice **at that moment**) invisible to the engine. Two fields give identity and host fact one author each,
   * and whoever writes it owns it.
   *
   * Why persist it: run cost becomes auditable, and resume can re-attach to the **same** model -- if the parent
   * session switches main models between runs, the run's second half does not silently switch models (the pin, see bootstrap's
   * workflow-actor-model.ts).
   *
   * Like `sessionId`, a "driver-owned field": the engine's putActor only carries the existing value through
   * (see createActor in engine.ts and ensureSession in scheduler.ts), never producing it itself.
   */
  resolvedModel?: string;
}

/**
 * Node persistence states. A node is persisted as `running` **at admission** (with actorSeq and inputHash),
 * updated to completed/failed at settlement. A node that crashes mid-execution therefore keeps a `running` row,
 * and resume re-dispatches live at the recorded actorSeq position (rather than short-circuiting as a finished result).
 *
 * **The report node is the sole exception to this two-write rule**: written once, persisted straight as `completed` --
 * no driver call between admission and settlement, hence nothing that can fail in between.
 */
export type NodeRecordStatus = "running" | "completed" | "failed";

/**
 * The dwf_node record. unique(runId, siteId, ordinal); asks additionally carry
 * unique(runId, actorSiteId, actorOrdinal, actorSeq). world-read and report rows have empty actor* and
 * actorSeq; a report row also satisfies: written once, status always `completed`, `result` the reported item,
 * `inputHash` covering that item (defensively compared on replay hits).
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
   * The **user-facing artifact** id (the `dwf_node.artifact_id` column). Two row kinds carry it: `kind: "artifact"`
   * rows (the artifact they publish/declare), and tagged `kind: "report"` rows (which preset this item fed).
   * The latter is where the "board = projection of the journal" invariant lands -- every point on a board is one
   * `kind = report ∧ artifact_id = ?` row. Empty on other rows.
   */
  artifactId?: string;
  /**
   * **world-read / world-run only**: the op and args this
   * site actually executed, **bounded** ({@link WorldReadInput}). `inputHash` answers only "same input?",
   * not "what input" -- the workspace transcript must say *what ran*, not just *something ran*.
   * Written at admission (same putNode as `inputHash`), carried through the settlement upsert verbatim; absent on
   * pre-0030 rows and on ask / report / artifact rows.
   */
  input?: WorldReadInput;
  /**
   * **ask nodes only**: after the ask's full exchange ends (repair / nudge turns and the post-submit
   * closing message included), the length of the actor session's message log -- a count offset, not a message-id range.
   *
   * A driver-owned backfilled field (same family as the `stats` backfill, likewise getNode + putNode read-modify-write), not
   * engine-produced. A count instead of an id range because count's key property is **invariance under prefix copy**: copy the
   * first N messages of the source session into a new one and every message id changes while the count does not, so the
   * copied ask's boundary value stays valid in the new session. That is the foundation of amend-resume full-fidelity
   * transcript truncation (and chained amendments).
   */
  messageBoundary?: number;
}

/** One persisted event; `sequence` is assigned monotonically by appendEvent. */
export interface StoredEvent {
  sequence: number;
  event: RunEvent;
  /**
   * When the storage layer appended this event (epoch ms). The only clock for every "how long ago" in the
   * event log: log-line age, the subagent's last action, how long the run has stalled -- all computed from it.
   * Reading `Date.now()` at the reader instead is wrong -- it would stamp a week-old cold-replayed history as "just now".
   *
   * Optional in the type so test doubles implementing the port keep compiling; both **real** implementations (the SQLite
   * `time_created` column, the in-memory append timestamp) must fill it; the contract tests pin this.
   */
  timeCreated?: number;
}

/**
 * Event pagination (cursor = journal sequence). The app's run-detail page pulls the event log incrementally with it:
 * returning everything at once means reading the whole journal into memory per page.
 */
export interface ListEventsOptions {
  /** Only events with sequence **strictly greater** than this. The cursor is "the last sequence read", not an offset. */
  afterSequence?: number;
  /** Max events per page; unlimited by default. */
  limit?: number;
}

/**
 * The persistence payload of a run settlement. The reason it exists is **one write**: terminal status and product in
 * two UPDATEs and a crash in between mints a `completed` run whose product is unrecoverable. Absent keys mean
 * "do not touch that column"
 * (the engine's `running` write and pre-column legacy rows both rely on this semantics).
 */
export interface RunSettlementRecord {
  /** Written in the same stroke as `status === "stopped"`; other statuses omit it. */
  stopReason?: RunStopReason;
  /** Same write as `stopReason === "superseded"` (the stopped envelope is rewritten whole; splitting loses it). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  result?: unknown;
}

/**
 * The journal storage port: repository-style, synchronous methods, no SQL leakage. In-memory implementation in journal-memory.ts;
 * the SQLite implementation shares this port. The legacy test entrypoint left with the Vitest cleanup, keeping production compilation free of undeclared test frameworks.
 */
export interface JournalStorePort {
  createRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void;
  /**
   * Persist cumulative token usage on its own (a frequent small write outside run settlement). Unknown runIds must throw;
   * never touch status / failure -- usage updates and run settlement are two independent write paths.
   */
  updateRunUsage(runId: string, spentTokens: number): void;
  /**
   * Persist this run's concurrency cap on its own (`dwf_run.caps_max_concurrency`). Unknown runIds must throw;
   * **that column only** -- status, usage, and the settlement bag are outside this write, same family as {@link updateRunUsage}.
   *
   * It is that column's **second writer** (the first is {@link createRun}): a max_concurrency-only
   * amendment lands on the living run in place, while resume keeps the row's caps -- unpersisted, the restored cap would be the old one.
   */
  updateRunCaps(runId: string, caps: Caps): void;

  putActor(record: ActorRecord): void;
  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined;
  listActors(runId: string): ActorRecord[];

  putNode(record: NodeRecord): void;
  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined;
  listNodes(runId: string): NodeRecord[];

  appendEvent(runId: string, event: RunEvent): StoredEvent;
  /**
   * List events by ascending sequence. Omitting `opts` means everything (the historical shape); with cursor / limit the
   * filtering must happen in the storage layer, never fetch-all-then-slice -- the whole point of pagination is not
   * reading the entire journal into memory. Unknown runIds and out-of-range cursors return an empty array (no throw):
   * in the race window between projection and journal, a client returning a not-yet-existing cursor is normal timing.
   */
  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[];
}

// The driver-side per-ask observation vocabulary (usage + progress) lives in ask-observation-types.ts (as above); re-exported here to keep import paths stable.
export {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
} from "./ask-observation-types.js";
export type { AskLastTool, AskProgress, AskStats } from "./ask-observation-types.js";

// ————————————————————————————————————————————————————————————————
// Import cache (amend-resume)
// ————————————————————————————————————————————————————————————————

// The import-cache data structures live in imported-cache-types.ts (split out when this file hit its max-lines cap); re-exported here to keep import paths stable.
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

/** In-node repair (reject-retry) cap: 3. */
export const REPAIR_ATTEMPTS = 3;

/** Nudge cap when a turn ends without submit: 1. */
export const NUDGE_ATTEMPTS = 1;
