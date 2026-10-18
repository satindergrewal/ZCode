// ============================================================
// Dynamic Workflow Run Port - submit / observe / cancel boundary for dwf engine runs
// ============================================================

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "./dynamic-workflow-run-roster.port.js";
import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "./dynamic-workflow-run-retune.port.js";
import type {
  DynamicWorkflowRunFillHoleRequest,
  DynamicWorkflowRunHole,
  FillWorkflowHoleResult,
} from "./dynamic-workflow-run-hole.port.js";
import type {
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
} from "./dynamic-workflow-run-workspace.port.js";
import type { DynamicWorkflowRunProgressPayload } from "../events/session.events.js";
import type { ModelSelection } from "../model/model.js";
import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { WorkflowTaskSnapshot } from "./workflow.port.js";

/**
 * Submit request for one workflow run. The script text is the authoritative input (compilation,
 * site table, schema synth, and lowering all derive from it), so only the script and the
 * execution context are passed here - never any compiled artifact. "Compile once" happens on
 * the port implementation side (run service); callers must have no notion of compiled artifacts.
 */
export interface DynamicWorkflowRunSubmitRequest {
  /** Workflow script source. Stored byte-for-byte (dwf_run.script_text); resume keys off its hash. */
  scriptText: string;
  /** Working directory of the run (sandboxed child cwd, root for world-read). */
  cwd: string;
  /**
   * Display name of the run (optional `input.name` of `CreateWorkflow`). Stored in `dwf_run.name`
   * as a label for enumeration surfaces. Pure display metadata: not used by execution or resume
   * validation; absent means unnamed (read side falls back to the first script line).
   */
  name?: string;
  /**
   * Arguments for this run (declarative parameters of a saved workflow; the tool layer has
   * validated them against the declarations and filled defaults).
   *
   * Unlike `name`, this is **not** display metadata: it is stored in `dwf_run.args_json` and
   * injected into the sandbox as the script-readable `args` global, making it part of the run
   * identity - resume replays the stored copy and never accepts a new one. Inline scripts have
   * no args; absent means `{}`.
   */
  args?: Record<string, unknown>;
  /** Session that launched this run; engine events are projected back into it. */
  parentSessionId?: SessionId | string;
  /** CreateWorkflow tool call that launched this run (tool card -> detail page linkage key). */
  toolCallId?: ToolCallId | string;
  /**
   * inputId of the turn that launched the run: the subagent's `agent_step` events nest under
   * that message. Only hub-launched runs set it (the UUID v7 minted by `startSavedWorkflowRun`,
   * shared with controlOnly launch turns); chat-path runs omit it, and the run service resolves
   * it from the parent runtime's active turn.
   */
  launchInputId?: string;
  /**
   * Phase table declared by the script (named phases for the causality graph, declaration order,
   * <= 32 x 128; `createWorkflowPhaseNames`). The engine records it with the anchor in
   * `run-launched`, and the sessions-index projection uses it to draw upcoming sites on the
   * sidebar mini-track. Pure display metadata: not used by execution or resume validation;
   * absent when the script has no `phase()` markers.
   */
  phaseNames?: string[];
  /**
   * This run's own concurrency cap (docs/dynamic-workflow/concurrency.md "Two bounds on a run"):
   * asks simultaneously in flight, stored in `dwf_run.caps_max_concurrency` and reused by resume.
   * **Absent means the default concurrency** (machine-derived, `resolveWorkflowDefaultConcurrency`);
   * when given it is floored to an integer >= 1 with **no upper bound** - above or below the
   * default are both fine. The tool layer already floors it once in `resolveInput` (the confirm
   * dialog shows the effective value); flooring here again is the port's own contract.
   */
  maxConcurrency?: number;
  /**
   * Model that this run's subagents run on. Recorded as the canonical form in the journal event
   * `run-launched` and reused by resume; **absent means inherit the launching session's model**.
   *
   * Takes a structured {@link ModelSelection} rather than a string: the tool layer has **already**
   * resolved the user-quoted name against the model catalog once (failures return before the
   * confirm dialog); the port must not resolve names again - that would leave two answers to
   * "where does resolution happen". The main agent is unaffected: it always stays on the session model.
   */
  subagentModel?: ModelSelection;
  /**
   * Models named in the script (docs/dynamic-workflow/launch.md "Models the script names"): keys
   * are the names written verbatim in the script (that is what the runtime persona carries),
   * values are selections already resolved against the model catalog by the tool layer. Same
   * path and same rationale as {@link subagentModel}: recorded once in `run-launched` (canonical
   * string), never read by the engine; the host looks it up by persona name when creating
   * subagent sessions. Absent when the script names no model.
   */
  modelBindings?: Record<string, ModelSelection>;
  /**
   * Absolute path of the file this run's script **came from**. Same path as {@link subagentModel}:
   * recorded once in `run-launched`, never read by the engine, zero SQL (no such column on
   * `dwf_run`); both read surfaces read it back from the event.
   *
   * ⚠ Unrelated to the artifact `sourcePath` elsewhere in this file: that is where an artifact
   * is stored; this is the home of the **script**.
   *
   * Absent means this run has no editable script file (projects where drafts cannot be written,
   * runs launched before the upgrade), so the model surface falls back to the old
   * "fix the script, submit inline" wording. Pure model-facing metadata: desktop and TUI never show it.
   */
  scriptPath?: string;
  /**
   * "Running alongside" table aligned **by position** with
   * {@link DynamicWorkflowRunSubmitRequest.phaseNames} (`createWorkflowPhaseAlongside`):
   * `phaseAlongside[i]` holds the **indices** (into the same `phaseNames`) of other phases still
   * running when `phaseNames[i]` was entered. The sidebar mini-track uses it to draw two parallel
   * phases as a double segment.
   *
   * Same posture as `phaseNames`: pure display metadata recorded with the anchor in
   * `run-launched`, unread by the engine; when no phases run in parallel the whole field is
   * absent (absent means "this track is a straight line").
   */
  phaseAlongside?: number[][];
  trace: TraceContext;
}

export interface DynamicWorkflowRunSubmitOptions {
  signal?: AbortSignal;
}

/**
 * Result of submit. Success carries only runId: it is simultaneously the backgroundTaskId and
 * the workId of cancelBackgroundWork (runId == taskId == workId), so the three paths need no
 * per-path identity maps. A brand-new run has nothing to refuse: wiring failures (corrupt
 * compiled artifacts, unavailable journal) still throw.
 */
export type DynamicWorkflowRunSubmitResult = { ok: true; runId: string };

/**
 * Request for {@link DynamicWorkflowRunPort.amend}.
 *
 * Amendment is **supersede**: mint a **new run** from the new script, importing "the completed
 * ask prefix per named actor" and world nodes from the predecessor journal as cache. The
 * predecessor **may still be in flight** - that is the reason this method exists: the service
 * stops it, waits for settlement, imports, then launches, all in one call, so the model no
 * longer needs TaskStop + poll + resubmit. Fully orthogonal to `scriptText`: the amended run
 * redeclares the script; args (saved workflows only) do not carry over.
 */
export interface DynamicWorkflowRunAmendRequest {
  scriptText: string;
  cwd: string;
  /** Predecessor run being amended. Any state. */
  predecessorRunId: string;
  /** Display name of the new run; absent keeps the predecessor's name. */
  name?: string;
  parentSessionId?: SessionId | string;
  /** AmendWorkflow tool call starting this amendment (new run's tool card -> detail page key). */
  toolCallId?: ToolCallId | string;
  /** Declared phase table of the **new script**; semantics as {@link DynamicWorkflowRunSubmitRequest.phaseNames}. */
  phaseNames?: string[];
  /**
   * Concurrency cap of the new run; semantics as
     {@link DynamicWorkflowRunSubmitRequest.maxConcurrency} (absent means the ceiling).
   * "Omit keeps predecessor, `null` clears" is a **tool-surface** three-state, normalized here
   * into a number or absence in `AmendWorkflow`'s `resolveInput` - the confirm dialog must show
   * the inherited value, so that rule can only live before the handler.
   */
  maxConcurrency?: number;
  /**
   * Subagent model of the new run; semantics as
   * {@link DynamicWorkflowRunSubmitRequest.subagentModel} (absent means inherit the session
   * model). "Omit keeps predecessor, `null` clears" is a **tool-surface** three-state, normalized
   * in `AmendWorkflow`'s `resolveInput`, together with one re-resolution, into a selection or absence.
   */
  subagentModel?: ModelSelection;
  /**
   * Models named by the **new script**; semantics as
   * {@link DynamicWorkflowRunSubmitRequest.modelBindings}. "Same name keeps the predecessor's
   * binding" is a **tool-surface** rule, normalized in `AmendWorkflow`'s `resolveInput`, together
   * with re-resolution, into this table; the port inherits no bindings from the predecessor.
   */
  modelBindings?: Record<string, ModelSelection>;
  /**
   * Absolute path of the file the **new script** came from; semantics as
   * {@link DynamicWorkflowRunSubmitRequest.scriptPath}.
   *
   * Unlike the concurrency cap and subagent model, there is **no three-state**: an amendment
   * always records the file this amendment's script came from (`path` submit: that file; inline
   * submit: the draft just written), never the predecessor's - the predecessor path points at
   * the **old script**, and recording it on the new run would send the model off to edit a file
   * that is no longer running.
   */
  scriptPath?: string;
  /**
   * "Running alongside" table of the **new script**; semantics as
   * {@link DynamicWorkflowRunSubmitRequest.phaseAlongside} (indices refer to this request's
   * `phaseNames`, not the predecessor's).
   */
  phaseAlongside?: number[][];
  /**
   * New run reuses the predecessor's stored args (`dwf_run.args_json`). Absent means the
   * amendment carries no args (tool-path contract unchanged). Only the GUI "configure" flow
   * sends it: it re-runs the predecessor's own script, which reads exactly the args the
   * predecessor launched with; without inheritance, a saved workflow launched from the hub with
   * args would re-run with empty `args`.
   */
  inheritArgs?: true;
  trace: TraceContext;
}

/**
 * Structured refusal reasons for amend. The two are **different next steps** for the model
 * (retry with another run id / give up and run fresh), so they must be distinguishable. The
 * actionable wording lives in the tool layer; the port carries only discriminants.
 *
 * There is no "predecessor in flight" case: an in-flight predecessor is stopped, not refused
 * (the legacy `not_amendable` and its "stop, poll until stopped, resubmit" race disappear).
 *
 * **Refusal means zero side effects**: the precheck finishes before the predecessor is stopped;
 * on refusal there is no dwf_run row, no registry entry, and the predecessor keeps running.
 */
export type DynamicWorkflowRunAmendRefusalReason =
  /** No such predecessor run in the journal. */
  | "run_not_found"
  /** The predecessor has completed asks missing message-boundary bookkeeping; the imported transcript cannot be truncated meaningfully (reject wholesale, no degraded fallback). */
  | "missing_boundaries";

export type DynamicWorkflowRunAmendResult =
  | {
      ok: true;
      runId: string;
      /** Present when a predecessor was in flight and stopped by this amendment (= predecessorRunId); absent if it had long settled. */
      supersededRunId?: string;
    }
  | { ok: false; reason: DynamicWorkflowRunAmendRefusalReason };

/**
 * Initiator of a cancellation. `user` / `model` are the two stop entry points' initiators;
 * `{ superseded }` is what the amend path passes when stopping an in-flight predecessor: the
 * new run's id lands in the predecessor's settlement bag next to the reason (`supersededBy`).
 */
export type DynamicWorkflowRunCancelInitiator = "user" | "model" | { superseded: string };

/**
 * Cap on report items carried by the terminal snapshot (length bound of `reports`). Set to 256 -
 * the value before the report count cap rose from 256 to 65,536: runs with at most that many
 * reports produce byte-identical snapshots and notifications; larger runs state the true total
 * in `reportCount`. The completion notification's character budget (8000) could not fit more anyway.
 */
export const DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS = 256;

/**
 * Byte cap per report item carried by the terminal snapshot (counted as `result_json` bytes in
 * the journal). Set to 8 MiB - the worst case of 256 items at the former 32 KiB per-item cap, so
 * snapshot memory did not grow when the per-item cap rose to 1 MiB. Snapshots only feed the
 * completion notification, which shows at most 2,000 characters per item and 8,000 per section;
 * 8 MiB far exceeds anything usable. The first item is always included, so one 1 MiB report
 * cannot leave the snapshot empty.
 */
export const DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * Run snapshot: keeps the {@link WorkflowTaskSnapshot} shape (the background task tracker and
 * notification pipeline read it) and only widens `output` - a workflow run's product is the
 * script's top-level return value, whose shape the script decides, not the legacy `Workflow`
 * tool's output type. The legacy port itself is not widened (the two workflow mechanisms do
 * not share a port).
 *
 * `reports` holds the **original values** handed to `report(item)` by the script, in report
 * order, from the journal's `kind = "report"` node rows - the persistent home of these entries
 * (`workflowRuns.reports` is only a bounded memory-only display surface). The completion
 * notification projects them in completed / failed / cancelled alike: a run that died on its
 * 12th ask still did the work of 11; recovering it is the point of `report`. It carries only
 * the first {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} items and at most
 * {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES} bytes; the true total is `reportCount`
 * (docs/execution-engine.md "Reading the journal").
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * The run's true terminal state word. The base class's `status` speaks the background task
   * tracker's generic vocabulary (`stopped` folded into `cancelled`, `errored` into `failed`);
   * notifications and tool copy must read these two fields to tell the truth; `stopReason` is
   * present only when `runStatus === "stopped"`.
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
  /** Session that launched this run (journal parent_session_id; taken from the registry entry when present). */
  parentSessionId?: string;
  /** Run this run was amended from; absent when not an amendment. */
  resumedFrom?: string;
  /** Amendment that stopped and replaced this run; absent when not replaced. */
  supersededBy?: string;
  /**
   * This run's own concurrency cap (`dwf_run.caps_max_concurrency`), **present only when below
   * the current ceiling**: a run at the ceiling has nothing to say ("absent when default", same
   * rule as `reports`). `AmendWorkflow`'s `resolveInput` uses it to decide what omission of
   * `max_concurrency` inherits.
   */
  maxConcurrency?: number;
  /**
   * This run's subagent model (the one on journal event `run-launched`), canonical form
   * `providerId/modelId[$reasoningLevel]`, **present only when set**: a run inheriting the
   * session model has nothing to say ("absent when default", same rule as `maxConcurrency`).
   * A string, not {@link ModelSelection}: read surfaces only display and round-trip it; nobody
   * reads fields out of it.
   */
  subagentModel?: string;
  /**
   * Models named by this run's script (the table on journal event `run-launched`): verbatim
   * script name -> canonical string. **Present only when the script named models.**
   * `AmendWorkflow`'s `resolveInput` and the GUI "configure" flow use it to carry same-name
   * bindings forward (docs/dynamic-workflow/launch.md "Models the script names").
   */
  modelBindings?: Record<string, string>;
  /**
   * This run's script file (absolute path, the one on journal event `run-launched`). **Present
   * only when the run recorded a file.**
   *
   * The terminal notification uses it to replace "fix the script, submit inline" with "edit that
   * file in place, then amend with `path`", so it must be readable from the snapshot; user-facing
   * surfaces never show it (unlike `subagentModel`, which appears in the desktop run panel).
   */
  scriptPath?: string;
  /** Structured failure (same source as {@link DynamicWorkflowRunDetail.error}); the base class's `error` is its message. */
  failure?: DynamicWorkflowRunError;
  /**
   * **Active** duration of this run and its lineage (milliseconds): every life of this run plus
   * every life of every predecessor, excluding gaps between lives (rationale in
   * docs/dynamic-workflow/transcript-and-notifications.md "How long it took"). This is the
   * "time" cell of the completion card.
   *
   * Same rule as `reports` / `artifacts`: **terminal states only** (`getTask` is polled
   * repeatedly; consumers only act on terminal notifications), and the whole field is absent
   * when the journal cannot answer - not 0. Absent means read sides fall back to
   * `completedAt - startedAt`: the single life seen by the process that settled it, a more
   * conservative answer that never overreports.
   */
  activeDurationMs?: number;
  /** First {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} report items, in report order; absent when none. */
  reports?: readonly unknown[];
  /**
   * True total number of this run's reports (`count(*)`), present/absent together with `reports`.
   * Notification and manifest `count` read it: when `reports` is truncated at the cap,
   * `count != shown` signals "more exist".
   */
  reportCount?: number;
  /**
   * Escalated questions currently parked on this run, awaiting the main agent's answer.
   *
   * **Projected from the in-memory registry, not a journal replay**: the journal has
   * `escalation-raised` and `escalation-resolved` events, but "who is still owed an answer" is
   * live in-process fact - a replayed unpaired raised event lies once the process is gone (the
   * parked deferred died with it; resume makes the actor ask again under a new qid).
   *
   * This is the **query fallback** after a notification is dropped (stale branch generation /
   * shutdown drop): the main agent can always rediscover pending questions through the existing
   * observation surface. Absent entirely when none (never an empty array).
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * This run's holes ({@link DynamicWorkflowRunHole}): every site reached, waiting or filled.
   * Same rule as `pendingQuestions` - absent when none, `waiting` projected from the engine's
   * parked table rather than replayed events; the hole-notification emitter and `FillWorkflowHole`'s
   * resolveInput both read it.
   */
  holes?: readonly DynamicWorkflowRunHole[];
  /**
   * User-facing artifacts published by this run, in first-appearance order, from the journal's
   * `kind = "artifact"` rows - the persistent home of version history (`workflowRuns.artifacts`
   * carries only latest-version metadata). Same rule as `reports`: read on **terminal states**
   * (`getTask` is polled repeatedly; consumers of artifact rows are the terminal notification
   * and GetWorkflowRun); absent entirely when none.
   *
   * ⚠ Terminology: artifact here is a product the script published to the user via `artifact.*`,
   * unrelated to this type's `output` (the script's top-level return value, `RunSettlement.artifact`
   * in engine terms).
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};

/**
 * One version of a user-facing artifact (JSON mirror of `ArtifactVersionRecord` on the journal's
 * `dwf_node.result_json`). **Deliberately redeclared here** rather than imported from
 * @zcode/dynamic-workflow: the port carries only JSON shapes (same argument as
 * {@link DynamicWorkflowRunLifecycleStatus}).
 *
 * Content artifacts (`file` / `markdown`) fill `contentType` / `bytes` / `uri` / `sourcePath`;
 * preset boards (`chart` / `table` / `metrics` / `board`) fill `spec`. Bytes never appear here -
 * `uri` points into the tool-artifact store.
 */
export interface DynamicWorkflowRunArtifactVersion {
  version: number;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  /** Publication time (epoch ms). Always written by the driver. */
  publishedAt: number;
  /** This version is the run's deliverable. */
  primary?: true;
}

/** Member kinds of user-facing artifacts (the six members of facade `artifact.*`). */
export type DynamicWorkflowRunArtifactKind =
  | "file"
  | "markdown"
  | "chart"
  | "table"
  | "metrics"
  | "board";

/**
 * One user-facing artifact: all versions under an id (ascending by version) + the count of
 * label reports feeding it. `title` / `description` / `contentType` / `sourcePath` / `spec` take
 * the **latest version's** values, so readers who only care about "what is it now" need not
 * walk `versions`.
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
  /** Latest version number (= version of the last entry in versions). */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
  /** Number of `report` entries tagged with this id (data volume of preset boards; always 0 for content artifacts). */
  itemCount: number;
  /** The run's deliverable (at most one). Leads the `artifacts` list; the rest follow first-publication order. */
  primary?: true;
}

/** One `report` entry feeding a preset artifact, addressed by journal sequence (the board's data surface). */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  /** The whole item; absent when the request named `fields`. */
  item?: unknown;
  /** When the request named `fields`: path -> value; unreachable paths are not listed. */
  fields?: Record<string, unknown>;
}

/**
 * Pagination bag of {@link DynamicWorkflowRunPort.listArtifactItems}
 * (cursor = journal sequence, strictly greater). Both bounds mean the same as
 * {@link DynamicWorkflowRunEventPage}: stop at `limit` items, or when one more would exceed
 * `maxBytes`; the first item is always included. Both are given by the caller (gateway); the
 * implementation honors them exactly and does not clamp further.
 */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
  limit: number;
  maxBytes: number;
  /**
   * Only fetch these field paths (rules of `readWorkflowArtifactField`, extracted by SQLite);
   * each result carries `fields` instead of `item`, and `maxBytes` counts the extracted values.
   * Default = the whole item.
   */
  fields?: readonly string[];
}

/** One page of board items. `hasMore` is decided by the storage layer: whether items follow the page. */
export interface DynamicWorkflowRunArtifactItemsResult {
  items: readonly DynamicWorkflowRunArtifactItem[];
  hasMore: boolean;
}

/** Return of {@link DynamicWorkflowRunPort.readArtifact}: all bytes of one version. */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** One parked escalation question. Fields share the source of the `escalation-raised` event, plus the asked-at time. */
export interface DynamicWorkflowRunPendingQuestion {
  /** Globally unique question id (shaped `dwfq-<runId fragment>-<seq>`); the only key `resolveQuestion` accepts. */
  qid: string;
  /** Asking actor, `refToString` form (e.g. `actor#1@1`). Always present and unique within the run. */
  actor: string;
  /**
   * Human-readable name of this actor (the `"poet"` of `agent("poet")` in the script).
   *
   * **Absent for anonymous actors, and no fallback label is synthesized here**: fallback is a
   * rendering decision; the notification surface and the sidebar each have their own fitting
   * form (one reads as a sentence, one fits a column). Synthesizing "actor#1@1" as a name here
   * would stop both consumers from recovering the fact that this actor has no name.
   */
  actorName?: string;
  question: string;
  /** Context added by the actor (optional `context` of `escalate`). */
  context?: string;
  /** Asked-at time (epoch ms). The main agent gauges "how long has this been waiting" from it. */
  askedAt: number;
}

/**
 * Structured refusal reasons of {@link DynamicWorkflowRunPort.resolveQuestion}. The three are
 * **different next steps** for the model, so they must be distinguishable: fetch the right id
 * from the snapshot / do nothing / this run no longer needs an answer.
 */
export type DynamicWorkflowResolveQuestionRefusalReason =
  | /** No such qid in the registry: a typo, or a stale id from a dead process (parked entries are not persisted). */
    "unknown_question" /** Already answered; the actor moved on with that answer long ago. */
  | "already_resolved" /** The qid's run / ask is no longer in flight (cancelled, failed, or finished); nobody waits for this answer. */
  | "run_not_in_flight";

/**
 * Structured result of `resolveQuestion`. Failure returns a reason instead of throwing, same
 * argument as {@link DynamicWorkflowRunSubmitResult}: all three reasons are business branches
 * the caller can expect.
 *
 * `message` is written by the implementation (stating the situation and next step) rather than
 * assembled by the tool layer: discriminants and copy maintained apart, or the two eventually
 * say different things - and the reader here is the model: what it reads is its next step.
 */
export type DynamicWorkflowResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: DynamicWorkflowResolveQuestionRefusalReason; message: string };

export interface DynamicWorkflowRunWaitOptions {
  signal?: AbortSignal;
}

/**
 * Pagination parameters of the event log; cursor = journal sequence (monotonically assigned by
 * appendEvent).
 *
 * Both bounds apply together (docs/execution-engine.md "Reading the journal"): the page stops at
 * `limit` items, or when one more would push the stored serialization past `maxBytes`; the first
 * item is always included, so an event over `maxBytes` forms a page of its own. When the
 * implementation lacks either, it picks a bounded default - an event-log page is always bounded.
 */
export interface DynamicWorkflowRunEventPage {
  /** Only events with sequence strictly greater; default from the start. */
  afterSequence?: number;
  limit?: number;
  maxBytes?: number;
}

/** One page of the event log. `hasMore` is decided by the storage layer: whether events follow the page. */
export interface DynamicWorkflowRunEventsResult {
  events: DynamicWorkflowRunEvent[];
  hasMore: boolean;
}

/**
 * **Protocol shape** of one run event: sequence + event kind + JSON payload.
 *
 * Deliberately not the engine's `RunEvent`: that is the domain package's
 * (@zcode/dynamic-workflow) vocabulary; importing it into contracts would give every layer
 * holding the port a compile-time dependency on engine internals. The port carries only JSON
 * shapes; `type` is an opaque string and `payload` is interpreted by readers as needed.
 */
export interface DynamicWorkflowRunEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  /** Payload trimmed by {@link boundDynamicWorkflowRunEventPayload} (the raw facts remain in the journal). */
  truncated?: boolean;
}

/**
 * Bounds for run event payloads. **Every payload crossing the protocol boundary is bounded**,
 * and two engine event fields are naturally unbounded: `persona.system` of `actor-created` (the
 * whole system prompt) and `finalText` of node-level errors (a full turn of model output).
 * They must not pass on a "probably not too long" basis.
 *
 * Bounds are **structural** (string length / array items / key count / depth), not total bytes:
 * structural bounds apply per field in place, with no serialize-then-retry, and one huge field
 * does not drag the rest away with it.
 */
export const DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS = {
  maxStringLength: 2_048,
  maxArrayItems: 32,
  maxKeys: 32,
  maxDepth: 6,
} as const;

/**
 * Trim one run event payload to {@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS} and, en
 * passant, normalize it into a **JSON-serializable** shape.
 *
 * Two consumers share this one serialization:
 *   1. the event page returned by `listEvents` (the detail page's event log);
 *   2. the `dynamic_workflow_run_progress` session event appended to the parent session
 *      (-> the `workflowRuns` projection).
 *
 * Normalization is required, not optional: any non-finite number (`Infinity` / `NaN`) becomes
 * `null` through `JSON.stringify` - meaning "same payload, unequal before and after storage".
 * Rather than expose that inconsistency to every reader, fold it to `null` once here so the
 * result satisfies structural equality under `JSON.parse(JSON.stringify(x)) === x`.
 */
export function boundDynamicWorkflowRunEventPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  truncated: boolean;
} {
  let truncated = false;
  const markTruncated = (): void => {
    truncated = true;
  };
  const bounded = boundJsonValue(payload, 0, markTruncated);
  return {
    payload: isJsonRecord(bounded) ? bounded : {},
    truncated,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive trim. A return of `undefined` means the value is uncarryable (callers omit it from objects/arrays). */
function boundJsonValue(value: unknown, depth: number, markTruncated: () => void): unknown {
  const limits = DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS;

  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    // Infinity / NaN are not legal JSON numbers; fold to null instead of letting JSON.stringify do it quietly.
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    if (value.length <= limits.maxStringLength) return value;
    markTruncated();
    return truncateSurrogateSafe(value, limits.maxStringLength);
  }
  if (typeof value !== "object") {
    // undefined / function / symbol / bigint: omit (bigint is not JSON-serializable either).
    return undefined;
  }

  if (depth >= limits.maxDepth) {
    markTruncated();
    return undefined;
  }

  if (Array.isArray(value)) {
    const items =
      value.length > limits.maxArrayItems ? value.slice(0, limits.maxArrayItems) : value;
    if (items.length < value.length) markTruncated();
    const out: unknown[] = [];
    for (const item of items) {
      const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
      // Holes would shift index semantics, so uncarryable elements become null rather than being skipped.
      out.push(boundedItem === undefined ? null : boundedItem);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.length > limits.maxKeys ? entries.slice(0, limits.maxKeys) : entries;
  if (kept.length < entries.length) markTruncated();
  const out: Record<string, unknown> = {};
  for (const [key, item] of kept) {
    const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
    if (boundedItem !== undefined) out[key] = boundedItem;
  }
  return out;
}

/**
 * Truncate by UTF-16 code units without ever leaving a lone surrogate behind - neither legal
 * text nor safe for downstream JSON codecs on some runtimes. When the cut lands mid-pair,
 * prefer one code unit fewer.
 */
function truncateSurrogateSafe(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * Any script value in a workflow run (top-level returned product, `report(item)` entries) ->
 * text for the model or a human reader. The implementation moved into
 * `@zcode/shared/zcode-protocol-v4` with the shared workflowRuns reducer (workflow-artifact.ts;
 * rules and rationale in its comments): the reduction behind `reports[].preview` became the
 * fourth consumer once lowered into shared, and with the dependency direction contracts ->
 * shared the function had to move. The re-export stays so the three existing consumers (terminal
 * notification, TaskOutput's resultText, v4 projection) keep compiling unchanged.
 */
export { serializeWorkflowArtifact } from "@zcode/shared/zcode-protocol-v4";

/**
 * The narrow port of a workflow run. Sits beside, not merged with, the legacy
 * {@link import("./workflow.port.js").WorkflowPort}: the latter serves the `Workflow` tool and
 * the legacy `workflow_*` tables; sharing a port would re-couple the "independent of the
 * existing workflow mechanism" boundary at the interface level.
 *
 * Cancellation has no dedicated RPC: the detail-page button and the background panel's stop
 * share the existing v4 `cancelBackgroundWork` command, which lands in {@link cancel}
 * (runId == workId).
 */
export interface DynamicWorkflowRunPort {
  /** Compile once and start the engine; returns the runId (== backgroundTaskId). */
  submit(
    request: DynamicWorkflowRunSubmitRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunSubmitResult>;
  /**
   * Amend a run: precheck predecessor -> mint a new id -> if the predecessor is in flight, cancel
   * it with `{ superseded: newRunId }` and await settlement -> import cache from the predecessor
   * -> launch the new run (see {@link DynamicWorkflowRunAmendRequest}). A refused precheck is a
   * structured failure and **touches nothing**. Older hosts may lack the method (optional
   * member): the tool layer probes capability and normalizes to "amending unsupported in this session".
   */
  amend?(
    request: DynamicWorkflowRunAmendRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunAmendResult>;
  /**
   * Default concurrency D (docs/dynamic-workflow/concurrency.md "Two bounds on a run":
   * `max(4, min(16, availableParallelism() - 2))`, one value per process). Synchronous, side
   * effect free. It is a **floor**, not a cap: runs without `max_concurrency` run on it; runs
   * with one may sit above or below.
   *
   * Tool-layer readers: the confirm dialog and the reply copy ("(default)" / "default N"),
   * `AmendWorkflow`'s same-value check (`null` must be folded to a number to compare), and
   * `GetWorkflowRun` deciding whether a run's cap is worth mentioning (only when != default).
   * **Optional member** (callers `typeof`-probe): port stubs need not implement it; when absent
   * the tool layer simply does not know the default.
   */
  defaultConcurrency?(): number;
  /**
   * In-place change of an **in-flight** run's own concurrency cap
   * (docs/dynamic-workflow/concurrency.md "Retuning a live run"): same runId, no successor
   * minted, no supersede, no cache import, not one in-flight ask lost.
   *
   * Beside {@link amend}, not merged with it: amendment swaps the **script** at the cost of
   * stopping the predecessor, minting a run, and replaying from cache; "slow this run down a
   * little" should not pay that bill. Both callers (`AmendWorkflow`'s handler and the GUI's
   * `amendWorkflowRunSettings`) read the same answer, so "what counts as a retune" has one definition.
   *
   * Three things happen in one synchronous slice or none: swap the engine caps (read live by the
   * scheduler), write `dwf_run.caps_max_concurrency` (resume therefore continues on the new cap),
   * record one `run-caps-changed`. The service also moves its own in-memory cap, so snapshot,
   * detail, and `GetWorkflowRun` report the new value immediately.
   *
   * **Optional member** (callers `typeof`-probe), same rationale as {@link resume}: port stubs
   * need not implement a control-plane method for everyone; to callers, "port absent" and
   * "method absent" are the same business fact - fall back to a real amendment.
   */
  retuneConcurrency?(
    request: DynamicWorkflowRunRetuneRequest,
  ): Promise<DynamicWorkflowRunRetuneResult>;
  getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  waitForTask(
    taskId: string,
    options?: DynamicWorkflowRunWaitOptions,
  ): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /**
   * Stop a run: abort in-flight asks and kill child processes; the run settles `stopped(initiator)`.
   * `initiator` defaults to `user`; stops via TaskStop by the main agent pass `model` (the reason
   * is persisted from now on, no longer living only in the background task registry); the amend
   * path passes `{ superseded: newRunId }`. Unknown runId returns false.
   */
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
  /** Page the event log by cursor; an out-of-range cursor returns an empty page, not an error. */
  listEvents(
    runId: string,
    options: DynamicWorkflowRunEventPage,
  ): Promise<DynamicWorkflowRunEventsResult>;
  /**
   * Enumerate runs by project (cwd), most recently updated first. Serves the `ListWorkflowRuns` tool.
   *
   * **Optional member**, following the pre-{@link cancel} precedent (callers `typeof`-probe):
   * implementers provide it only when the journal carries the introspection query, and existing
   * port stubs need not implement a read-only enumeration for everyone. Callers treat "port
   * absent" and "method absent" as the same business failure - to the model it is one thing
   * (this session lacks the capability).
   */
  listRuns?(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult>;
  /**
   * Single-run detail (progress summary + artifacts / failure). Serves `GetWorkflowRun`. Unknown
   * runId returns `undefined` (callers normalize to `run_not_found`) and there is **no
   * wait/block semantics** - waiting is {@link waitForTask}'s job; this is an immediate snapshot.
   * Optional for the same reason as {@link listRuns}.
   */
  getRunDetail?(runId: string): Promise<DynamicWorkflowRunDetail | undefined>;
  /**
   * Verbatim script of a stored run (`dwf_run.script_text`, the same bytes resume replays),
   * byte-for-byte, untouched. Two readers in `AmendWorkflow`: backfilling the predecessor's
   * script when script is omitted, and the `path` amendment's `script_unchanged` precheck -
   * which must compare bytes, not hashes, because the tool side reads file contents, not
   * compiled artifacts. The GUI "configure" flow shares this read.
   *
   * A dedicated read surface rather than a {@link DynamicWorkflowRunSnapshot} field: snapshots
   * are polled repeatedly by the background tracker, and the script is the largest string on the
   * port (same rationale as {@link DynamicWorkflowRunSummary.label}). Unknown runs and "no
   * script in the record" (runs stored before the column existed) both return `undefined` - the
   * same fact to callers: no script to reuse. Read-only, unaffected by service shutdown.
   * **Optional member** (callers `typeof`-probe), same rationale as {@link listRuns}: when
   * absent, an amendment omitting script fails outright and the `script_unchanged` precheck is
   * skipped (it is a net, not a gate).
   */
  getScript?(runId: string): Promise<string | undefined>;
  /**
   * Resume a cancelled / process-death-interrupted run: rerun under the same runId (the engine
   * takes the resume branch - journal hits short-circuit, unfinished nodes redispatch). The gate
   * is on the implementation side: only `cancelled`, or `failed` with failure coded `Interrupted`, is resumable.
   *
   * **Optional member**, following the pre-{@link listEvents} cancel precedent (callers
   * `typeof`-probe): port stubs need not implement the resume surface for everyone; to callers
   * "port absent" and "method absent" are the same business failure.
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * Enumerate run summaries under **this service's parent session** (most recently updated
   * first, journal-backed). The UI's rediscover-after-restart surface: the `workflowRuns`
   * projection does not survive processes, so tool-card joins and Resume-button availability can
   * only be reconstructed here. Deliberately takes no parentSessionId parameter - the service
   * instance is already constructed per parent session; letting callers pass any session would
   * open a cross-session read hole. Optional for the same reason as {@link resume}.
   */
  listRunsForSession?(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Cold replay: turn runs under **this service's parent session** that this process never ran
   * back into progress-event payloads from the journal - the **same kind** of payload and the
   * same minting chain as live `onRunEvent`; cold materialization feeds them to the same reducer
   * as memory events, so the `workflowRuns` projection is byte-identical across restarts.
   *
   *   - Bound matches the projection's eviction (8 most recently updated), oldest run first;
   *   - `excludeRunIds`: runs already holding events in caller memory (ran / running in this
   *     process) are not replayed;
   *   - rows terminal in the journal whose event stream lacks `run-settled` (rewritten by orphan
   *     reconciliation after process death) get one **in-memory** synthetic settle payload
   *     (carrying status / failure / resumable), never written to the journal.
   *
   * Optional for the same reason as {@link listRunsForSession}: a memory journal has no
   * enumeration surface, so there is nothing to replay.
   */
  replayProgressForSession?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * Answer a blocking question escalated by an actor. Serves the `ResolveWorkflowQuestion` tool.
   *
   * Takes one opaque token rather than a `(runId, qid)` pair: qids are globally unique across
   * runs; making the model pair them itself amid concurrent runs breeds mismatches. The answer
   * verbatim becomes the tool result of that actor's `escalate` call and the actor's turn
   * continues; run state never changes (escalation is a slow tool call inside an ask, not a run
   * lifecycle event).
   *
   * **Optional member**, following the {@link resume} precedent (callers `typeof`-probe): port
   * stubs need not implement the answer surface for everyone; to callers "port absent" and
   * "method absent" are the same business failure.
   */
  resolveQuestion?(qid: string, answer: string): Promise<DynamicWorkflowResolveQuestionResult>;
  /**
   * Fill in the body of a waiting hole (docs/dynamic-workflow/launch.md "The `FillWorkflowHole`
   * tool"; engine docs "The fill service's checks"). Serves the `FillWorkflowHole` tool.
   *
   * One pipeline on the implementation side: read the run's stored script -> find the hole call
   * by site id and splice the body in as its last argument -> compile wholesale (diagnostics ->
   * `compile_failed`, coordinates split by `inFill` into function body / script) -> site
   * stability check (-> `fill_ids_unstable`) -> engine `fillHole` (-> `hole_not_waiting`) ->
   * rewrite the run's draft in place into valid script. **Refusal means zero side effects**: the
   * hole keeps waiting.
   *
   * **Optional member** (callers `typeof`-probe), same rationale as {@link resolveQuestion}:
   * port stubs need not implement it; to callers "port absent" and "method absent" are the same
   * business failure (this session cannot fill holes).
   */
  fillHole?(request: DynamicWorkflowRunFillHoleRequest): Promise<FillWorkflowHoleResult>;
  /**
   * User-facing artifacts of this run (journal `kind = "artifact"` rows grouped by id, versions
   * ascending). The durable read for UI cold-recovery and the hub detail page. Unknown runId
   * returns `undefined`. **Optional member**, same rationale as {@link listRuns} (provided only
   * when the journal carries the artifact read; callers `typeof`-probe).
   */
  listArtifacts?(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * `report` entries feeding a preset artifact, paged by journal sequence ascending (the board's
   * data surface). Out-of-range cursors return an empty page, not an error. Optional, same
   * rationale as {@link listArtifacts}.
   */
  listArtifactItems?(
    runId: string,
    artifactId: string,
    page: DynamicWorkflowRunArtifactItemPage,
  ): Promise<DynamicWorkflowRunArtifactItemsResult>;
  /**
   * Read one artifact version's bytes: **first** confirm a `completed` row for
   * `(runId, artifactId, version)` in the journal, then fetch via the row's `uri` through the
   * tool-artifact store - no caller-supplied id ever becomes a path directly. No such version /
   * not a content artifact / store absent -> `undefined`. Chunking is the gateway's job (v4
   * `workflowRunArtifactRead`, <= 512 KiB per chunk). Optional, same rationale as {@link listArtifacts}.
   */
  readArtifact?(
    runId: string,
    artifactId: string,
    version: number,
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * This run's workspace transcript: journal rows with `kind in {world-read, world-run}` in
   * storage order, **without bodies**.
   *
   * Authorization shares the chain of {@link readArtifact}: the run must belong to this service's
   * parent session, else `undefined` (the same answer as "no such run" - do not tell an
   * unauthorized caller which half it guessed right). Bodies may contain workspace file
   * contents, so the listing is also gated to the same session. Optional, same rationale as
   * {@link listArtifacts}.
   */
  listWorkspaceNodes?(
    runId: string,
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  /**
   * Body of one workspace node, shape-preserving bounded by `maxBytes`. Authorization chain as
   * {@link listWorkspaceNodes}; no such node / not a world row / not your run -> `undefined`.
   * Optional, same rationale as {@link listArtifacts}.
   */
  readWorkspaceNodeResult?(
    runId: string,
    siteId: string,
    ordinal: number,
    query: DynamicWorkflowRunWorkspaceNodeResultQuery,
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
}

// ————————————————————————————————————————————————————————————————
// Run introspection (data surface of ListWorkflowRuns / GetWorkflowRun)
// ————————————————————————————————————————————————————————————————

/**
 * Lifecycle states of a run. Literals match the journal's `dwf_run.status` set but are
 * **deliberately redeclared here** rather than imported from @zcode/dynamic-workflow: the port
 * carries only JSON shapes, and once the engine's vocabulary enters contracts, every layer
 * holding the port gains a compile-time dependency on engine internals (same argument as
 * {@link DynamicWorkflowRunEvent}'s `type`).
 *
 * Deliberately different from {@link DynamicWorkflowRunSnapshot}'s status: the latter speaks the
 * background tracker's vocabulary, folding `pending` into `running`. Introspection must keep
 * `pending` - "submitted, engine has not created the row yet" is a distinction the model
 * understands and finds meaningful.
 */
export type DynamicWorkflowRunLifecycleStatus =
  | "completed"
  | "errored"
  | "pending"
  | "running"
  | "stopped";

/**
 * Why `stopped`: `user` cancelled by the user / `model` TaskStop by the main agent /
 * `provider` deterministic model-side error / `interrupted` owning process death or sandbox
 * failure / `superseded` stopped and replaced by an AmendWorkflow. The first four are resumable,
 * `superseded` is not (its successor is the live one); `errored` (a script error) is not.
 * Literals match the engine's `RunStopReason` set, deliberately redeclared here.
 */
export type DynamicWorkflowRunStopReason =
  | "user"
  | "model"
  | "provider"
  | "interrupted"
  | "superseded";

/** Query bag of {@link DynamicWorkflowRunPort.listRuns}. */
export interface DynamicWorkflowRunListQuery {
  /**
   * Project key, **required**. Literal equality against `dwf_run.cwd` (written verbatim, queried
   * verbatim). The port does not guess a default cwd for callers: the tool surface always
   * queries `context.workingDirectory`; the model has no right to scan projects.
   */
  cwd: string;
  /** Return-count cap, **required**. Clamping policy belongs to the tool surface ([1, 50]); the port does no unbounded enumeration. */
  limit: number;
  /** Optional state subset. Default: no filter; empty array means "match no state" (empty result). */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * The cross-section shared by list and detail. Label, ownership annotation, and timestamps must
 * be field-for-field identical on both read surfaces - the same run showing a different name or
 * ownership in the list vs the detail is the class of inconsistency hardest to catch in tests
 * and most directly trust-eroding. Hence one shared base interface, not two field tables
 * evolving apart.
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * Display label. **Precooked**: the implementation (run service) derives it as name -> first
   * script line -> runId; consumers render it directly. Why not hand out the raw materials
   * (name / scriptText) for the tool layer to assemble: that fallback chain is a read-time
   * heuristic; two tools assembling it twice will drift, and scriptText is the largest string on
   * the port (a list surface should not haul 50 scripts across the boundary to read first lines).
   */
  label: string;
  /** Label source: `"name"` = user-chosen name; `"script"` = derived from the script at read time (runId fallback included). */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
  /** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
  /** Run this run was amended from (`dwf_run.resumed_from`); absent when not an amendment. */
  resumedFrom?: string;
  /** Amendment that stopped and replaced this run (settlement bag of `stopped(superseded)`); absent when not replaced. */
  supersededBy?: string;
  /** Whether this session is the run's origin (journal parent_session_id hit, or in this session's registry). */
  ownedByThisSession: boolean;
  /**
   * "This session cannot prove it is alive": journal non-terminal AND not this session AND not
   * in this session's registry. Could be a dead process's relic or a sibling session's in-flight
   * run - so this is an **annotation, not a state rewrite**; read surfaces never bury others'
   * dead (orphan reconciliation executes only at owning-session construction time). Present only when true.
   */
  possiblyInterrupted?: boolean;
  /** Journal `time_created` / `time_updated` (epoch ms). */
  createdAt: number;
  updatedAt: number;
}

/** One list item: shared cross-section + usage. Deliberately light - no actors, no node counts, no artifact previews. */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
  /** Read straight from `dwf_run.spent_tokens` (the only authority for run-level token usage). */
  spentTokens: number;
}

/**
 * Return of `listRuns`. Deliberately an object, not a bare array: page-level fields (such as
 * {@link truncated}) are pure additions, while a bare array must change shape wholesale.
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
   * This project has more runs beyond this page. **Present only when true.**
   *
   * The test is "one more exists" (implementation queries `limit + 1` and settles), not
   * `length === limit`: the latter false-positives when the count equals the limit exactly, and
   * a false positive sends the model chasing a page of history that does not exist. The same
   * convention already serves v4 gateway event pagination (`hasMore`).
   */
  truncated?: boolean;
}

/**
 * A run's progress and usage (observation surface, no caps). `nodesObserved` is the **row count
 * of stored nodes** (sum of the three states), never pretending to be a total step count:
 * dynamic workflows have no static total, and `queued` exists only as an event phase, never stored.
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** One actor site instance. `persona` deliberately omitted: the whole system prompt is a naturally unbounded field on this port. */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** One `log()` narrative entry. */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
  /** Already bounded by the port's string cap ({@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}). */
  message: string;
  /**
   * When this entry was journaled (`dwf_event.time_created`). Sequence addresses; the timestamp
   * answers "how long ago" - every field group of the situation cross-section ages by this
   * ruler; the narrative tail has no reason to use another. **Absent on journals predating the
   * column**; read sides then show no age and never fall back to `Date.now()` at read time.
   */
  at?: number;
}

/** Structured failure. `code` is the stable discriminant - the model must be able to tell "process died" from "script failed". */
export interface DynamicWorkflowRunError {
  code: string;
  message: string;
  /** Present only when `code === "ProviderStop"` (JSON mirror of the engine's `ProviderStopDetails`). */
  providerStop?: DynamicWorkflowRunProviderStop;
}

/** Structured detail of `ProviderStop` (mirror of the engine's `ProviderStopDetails`; the port carries JSON shapes only). */
export interface DynamicWorkflowRunProviderStop {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  subagent?: string;
  subagentName?: string;
  phase?: string;
  rawMessage?: string;
  resetAt?: number;
}

// The situation cross-section (phases / subagents / health) types live in
// dynamic-workflow-run-roster.port.ts (as above); re-exported verbatim here to keep the
// `@zcode/contracts` import path unchanged.
export type * from "./dynamic-workflow-run-roster.port.js";

// The three retune (in-place cap change of a live run) types live in
// dynamic-workflow-run-retune.port.ts; re-exported verbatim as above.
export type * from "./dynamic-workflow-run-retune.port.js";
// Hole types (snapshot entries, fillHole request / result) live in
// dynamic-workflow-run-hole.port.ts, same split precedent.
export type * from "./dynamic-workflow-run-hole.port.js";

// The six workspace-transcript types live in dynamic-workflow-run-workspace.port.ts,
// re-exported verbatim as above.
export type * from "./dynamic-workflow-run-workspace.port.js";

/** Single-run detail: shared cross-section + progress + situation cross-section + terminal-state-branched artifact / failure. */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  /**
   * This run's own concurrency cap, semantics as {@link DynamicWorkflowRunSnapshot.maxConcurrency}:
   * present only when below the current ceiling. Deliberately not on
   * {@link DynamicWorkflowRunSummary} - list rows should not widen for a rarely set field.
   */
  maxConcurrency?: number;
  /**
   * This run's subagent model, semantics as {@link DynamicWorkflowRunSnapshot.subagentModel}:
   * present only when set. Same reasoning as `maxConcurrency` for staying off
   * {@link DynamicWorkflowRunSummary} - list rows should not widen for a rarely set field.
   */
  subagentModel?: string;
  /** Models named by this run's script, semantics as {@link DynamicWorkflowRunSnapshot.modelBindings}. */
  modelBindings?: Record<string, string>;
  /**
   * This run's script file, semantics as {@link DynamicWorkflowRunSnapshot.scriptPath}: present
   * only when a file was recorded. `GetWorkflowRun` uses it to phrase the next step inside
   * `<amendable>` as "edit this file in place".
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
  /** Tail of `log()` events, in order (sequence ascending). Empty array when there are no log events. */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * Phase table: declared phases in declaration order, followed by those "entered but undeclared".
   *
   * **The whole field is absent when the script declared no phases and entered none** - such a
   * run has no notion of phases, and an empty array would read as "the phase table is empty",
   * a different sentence.
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * Subagent roster, in actor-row order (= minting order). **Always present**; a run with zero
   * actors is an empty array: unlike `phases`, "how many subagents does this run have" always
   * has an answer, and 0 is that answer.
   *
   * Deliberately not merged with the sibling `actors`: `actors` is a constant identity table
   * (siteId / ordinal / name) consumers already join on; each entry here is a **read-time
   * snapshot**, different one second later on the same run.
   */
  subagents: DynamicWorkflowRunSubagentView[];
  /** Whether the run as a whole is still moving (see {@link DynamicWorkflowRunHealth}). Always present. */
  health: DynamicWorkflowRunHealth;
  /**
   * The script's top-level return value, **original** (unserialized). Present only for completed
   * runs; an `undefined` product means the whole field is absent.
   *
   * Why not serialize here: the model-facing text projection already has one implementation
   * (core's `serializeWorkflowArtifact`, shared by the completion notification and TaskOutput).
   * A second one on the port would produce "the same run's product looks different in the
   * notification and in this tool" - exactly the loss class the sharing exists to prevent. So
   * serialization stays in core; the port only carries the original value to the boundary.
   */
  result?: unknown;
  /** Always present for errored; for stopped only provider / interrupted. `code` passes through verbatim, unfolded. */
  error?: DynamicWorkflowRunError;
  /**
   * Escalated questions currently parked on this run, awaiting the main agent's answer.
   *
   * **Same source and projection** as {@link DynamicWorkflowRunSnapshot.pendingQuestions} (both
   * read the in-process escalation parked table, both absent when none) - only a different read
   * surface: the snapshot serves the background task tracker, this field serves `GetWorkflowRun`,
   * the **model side's only discovery surface**. The chain is not optional polish: escalation
   * notifications have two known drop paths (stale branch generation / shutdown); the query is
   * the fallback for both, and `resolveQuestion`'s `unknown_question` copy explicitly sends the
   * model here for qids. Without it, both promises point at a tool that returns nothing.
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * This run's holes, **same source and projection** as
   * {@link DynamicWorkflowRunSnapshot.holes} (absent entirely when none) - only a different read
   * surface: this field serves `GetWorkflowRun`, the model side's only discovery surface after a
   * lost hole notification.
   */
  holes?: readonly DynamicWorkflowRunHole[];
  /**
   * This run's user-facing artifacts (attached in any state; journal-backed, same source as
   * {@link DynamicWorkflowRunSnapshot.artifacts}). `GetWorkflowRun` tells the model "these have
   * been presented to the user as cards; reference them by title". Absent entirely when none.
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/** Structured failure reasons of {@link DynamicWorkflowRunPort.resume}. */
export type DynamicWorkflowRunResumeErrorReason =
  | /** No such run in the journal. */
    "not_found" /** Outside the resumable set (completed or errored; only stopped is resumable). */
  | "not_resumable" /** Stopped and replaced by an AmendWorkflow: the successor is the live one; replaying this would do the same work twice. */
  | "superseded" /** A run with this runId is in flight in this process. */
  | "already_running" /** Record lacks scriptText (pre-column runs); no script to rerun. */
  | "script_missing" /** Stored scriptHash disagrees with one recomputed from scriptText (the record was rewritten by an outside force). */
  | "script_mismatch" /**
     * Stored scriptText no longer typechecks under the **current** facade (pre-refactor runs).
     * Verbatim replay would only fail; the way out is rewriting the script for the current facade
     * via AmendWorkflow. `message` carries a bounded diagnostic.
     */
  | "compile_failed";

/**
 * Structured result of resume. Failure returns a reason instead of throwing: all five reasons
 * are business branches the caller can expect (error codes, not error text, drive control flow -
 * house rule); throw remains for genuine wiring failures.
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };

/**
 * Run summary for {@link DynamicWorkflowRunPort.listRunsForSession}. Literals match the journal's
 * `dwf_run.status` set but are **deliberately redeclared here**: the port carries only JSON
 * shapes, and once engine vocabulary enters contracts, every layer holding the port gains a
 * compile-time dependency on engine internals.
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
  /** CreateWorkflow tool call id that launched the run (tool card -> detail/Resume linkage); absent on legacy runs. */
  toolCallId?: string;
  /**
   * Display label, derived server-side at read time (`name` -> first script line -> runId; see
   * bootstrap's `resolveDynamicWorkflowRunLabel`). Optional for **skew safety**: older servers
   * omit the key and readers fall back to runId - a missing label in a list is degradation, not
   * an error.
   *
   * Centralized server-side for the same reason as `resumable`: assembled in two places, the
   * same run would show different names in `/dwf list` and on the tool card.
   */
  label?: string;
  /**
   * Last update (epoch ms, journal `dwf_run.time_updated`). Optional as above: older servers
   * omit it and readers hide the time column. List ordering stays with the storage layer (most
   * recent first); this field is display-only - do not re-sort by it, or you drift from the
   * server-side tie-break.
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  /** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
  /** Run this run was amended from; absent when not an amendment. */
  resumedFrom?: string;
  /** Amendment that stopped and replaced this run; absent when not replaced. */
  supersededBy?: string;
  /** Structured failure code of errored / stopped(provider|interrupted) (`ProviderStop` / `Interrupted` ...). */
  failureCode?: string;
  failureMessage?: string;
  /**
   * Resumable flag. **Computed server-side by the same predicate as the resume gate**: if the UI
   * re-derives it from status+failureCode, the two predicates eventually disagree - button lit,
   * command refused.
   */
  resumable: boolean;
}
