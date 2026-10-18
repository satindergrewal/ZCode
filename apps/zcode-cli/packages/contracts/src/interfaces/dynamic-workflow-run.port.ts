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
 * A workflow run submit request. The script text is the authoritative input (compilation, site
 * tables, schema synthesis, lowering all derive from it), so only the script and execution context
 * are passed here, never compiled artifacts - "compile once" happens on the port implementation
 */
export interface DynamicWorkflowRunSubmitRequest {
/** Workflow script source. Stored byte-for-byte (dwf_run.script_text); resume keys off its hash. */
  scriptText: string;
/** Working directory for the run (sandbox child process cwd, world-read root). */
  cwd: string;
  /**
   * run's display name (the optional `input.name` of `CreateWorkflow`). Stored in `dwf_run.name`,
   * used as a label by enumeration surfaces. Pure display metadata: unused by execution and resume
   */
  name?: string;
  /**
   * Args for this run (saved-workflow declaratory params; the tool side has validated them and
   *
   * Unlike `name`, this is **not** display metadata: it is stored in `dwf_run.args_json` and injected
   * into the sandbox as the script-readable `args` global, part of the run identity - resume replays
   * the stored copy and never accepts a new one. Inline scripts take no args; absent means `{}`.
   */
  args?: Record<string, unknown>;
/** Session that launched this run; engine events are projected back into it. */
  parentSessionId?: SessionId | string;
/** CreateWorkflow tool call that started this run (tool card -> detail page correlation key). */
  toolCallId?: ToolCallId | string;
  /**
   * inputId of the turn that launched the run: the subagent's
   * `agent_step` entries attribute to this message. Only the hub-direct launch sets it (the UUID v7
   * minted by `startSavedWorkflowRun`, shared with the controlOnly launch turn); absent on the chat path, where the run service resolves it from the parent runtime's active turn.
   */
  launchInputId?: string;
  /**
   * Phase table declared by the script (named phases of the causal graph, declaration order,
   * <= 32 x 128; `createWorkflowPhaseNames`). Recorded in `run-launched` with the anchors; the sessions-index projection
   * draws upcoming stations on the sidebar mini-track. Pure display metadata: no execution role,
   */
  phaseNames?: string[];
  /**
   * This run's own concurrency cap: the number of
   * in-flight asks. Stored in `dwf_run.caps_max_concurrency`, reused by resume. **Absent means the
   * ceiling** (machine-derived, `resolveWorkflowConcurrencyCeiling`); if given, clamped into
   * the confirm dialog shows the effective value); clamping again here is the port's own contract.
   */
  maxConcurrency?: number;
  /**
   * Which model this run's subagents run on. Recorded in journal event
   * `run-launched` in canonical form, reused by resume; **absent means inherit the launching session's model**.
   *
   * Takes structured {@link ModelSelection}, not a string: the tool layer has **already** resolved the user's name once via the model catalog
   * (failures return before the confirm dialog); the port must not match names again - that would give "where
   * resolution happens" two answers. The main agent is unaffected: it always stays on the session model.
   */
  subagentModel?: ModelSelection;
  /**
   * Absolute path of the file this run's script **came from**. Same path as {@link subagentModel}: recorded once on `run-launched`, never read by the engine,
   * zero SQL (no column on `dwf_run`); both read surfaces read it back from the event.
   *
   * warning Unrelated to the artifacts' `sourcePath` in this file: that is where artifacts land; this is the **script**'s home.
   *
   * Absent means this run has no editable script file (projects where drafts cannot be written, runs predating the upgrade); the model surface
   * falls back to the old "fix the script, submit inline" wording. Pure model-surface metadata: desktop and TUI never show it.
   */
  scriptPath?: string;
  /**
   * "Running alongside" table **positionally aligned** with {@link DynamicWorkflowRunSubmitRequest.phaseNames}
   * (`createWorkflowPhaseAlongside`): `phaseAlongside[i]` holds the **indices** of other phases still
   * running when the strand entered `phaseNames[i]` (indices into the same `phaseNames`). The sidebar mini-track
   * draws the two parallel stations as a double segment.
   *
   * Same posture as `phaseNames`: pure display metadata, stored with the anchor in `run-launched`, unread by the engine; with no parallel phases
   * the whole field is absent (absent means "this track is a straight line").
   */
  phaseAlongside?: number[][];
  trace: TraceContext;
}

export interface DynamicWorkflowRunSubmitOptions {
  signal?: AbortSignal;
}

/**
 * Result of submit. Success carries only runId: it is simultaneously the backgroundTaskId and the
 * workId of cancelBackgroundWork (runId = taskId = workId), so the three paths need no identity mapping tables. A brand-new run has nothing to reject:
 * wiring faults (corrupted build artifacts, unavailable journal) still throw.
 */
export type DynamicWorkflowRunSubmitResult = { ok: true; runId: string };

/**
 * Request for {@link DynamicWorkflowRunPort.amend}.
 *
 * Amend is **supersede**: mint a **new run** from the new script, importing per-named-actor completed ask
 * prefixes and world nodes from the predecessor journal as cache. The predecessor **may still be in flight** - that is
 * why this method exists: the service stops it, waits for settlement, imports, launches - one call, so the model no longer needs TaskStop + poll + resubmit.
 * Fully orthogonal to `scriptText`: the amended run redeclares the script; args (saved-source only) do not carry over.
 */
export interface DynamicWorkflowRunAmendRequest {
  scriptText: string;
  cwd: string;
/** The predecessor run being amended. Any state. */
  predecessorRunId: string;
/** Display name for the new run; when absent the service keeps the predecessor's name. */
  name?: string;
  parentSessionId?: SessionId | string;
/** AmendWorkflow tool call that started this amendment (new run's tool card -> detail page key). */
  toolCallId?: ToolCallId | string;
/** Declared phase table of the **new script**; semantics as {@link DynamicWorkflowRunSubmitRequest.phaseNames}. */
  phaseNames?: string[];
  /**
   * Concurrency cap for the new run; semantics as {@link DynamicWorkflowRunSubmitRequest.maxConcurrency} (absent means ceiling).
   * "Omit keeps predecessor, `null` clears" is a **tool-surface** tri-state, normalized in `AmendWorkflow`'s `resolveInput`
   * into a number or absence here - the confirm dialog must show the inherited value, so that rule lives before the handler.
   */
  maxConcurrency?: number;
  /**
   * Subagent model for the new run; semantics as {@link DynamicWorkflowRunSubmitRequest.subagentModel} (absent means
   * inherit the session model). "Omit keeps predecessor, `null` clears" is a **tool-surface** tri-state, normalized in `AmendWorkflow`'s
   * `resolveInput` together with one re-resolution into a single choice or absence here.
   */
  subagentModel?: ModelSelection;
  /**
   * Absolute path of the file the **new script** came from; semantics as {@link DynamicWorkflowRunSubmitRequest.scriptPath}.
   *
   * Unlike the concurrency cap and subagent model, no **tri-state**: an amend always records the file this
   * amendment's script came from (`path` submit: that file; inline submit: the draft just written), never the
   * predecessor's - the predecessor path points at the **old script**; recording it would make the model edit a file no longer running.
   */
  scriptPath?: string;
  /**
   * "Running alongside" table of the **new script**; semantics as {@link DynamicWorkflowRunSubmitRequest.phaseAlongside}
   * (indices refer to this request's `phaseNames`, not the predecessor's table).
   */
  phaseAlongside?: number[][];
  /**
   * Reuse the predecessor's stored args (`dwf_run.args_json`) for the new run. Absent means the amendment carries no args (tool-path contract unchanged).
   * Only the GUI "Configure" flow sends it: it reruns the predecessor's own script, which reads the args captured at its launch; without
   * inheritance, a saved workflow launched from the hub with args would rerun with empty `args`.
   */
  inheritArgs?: true;
  trace: TraceContext;
}

/**
 * Structured refusal reasons for amend. The two are **two different next steps** for the model (retry another run id / give up and run fresh),
 * so they must be distinguishable. Actionable copy lives in the tool layer; the port carries only discriminants.
 *
 * No "predecessor in flight" case: an in-flight predecessor is stopped, not refused (the legacy `not_amendable` and its
 * "poll to stopped, then resubmit" race disappear with it).
 *
 * **Refusal is side-effect free**: the precheck finishes before the predecessor is stopped; on refusal there is no dwf_run row, no registry entry,
 * the predecessor keeps running.
 */
export type DynamicWorkflowRunAmendRefusalReason =
/** No such predecessor run in the journal. */
  | "run_not_found"
/** Predecessor has completed asks missing message-boundary bookkeeping; imported transcript truncation is undefined (refuse wholesale, no degraded fallback). */
  | "missing_boundaries";

export type DynamicWorkflowRunAmendResult =
  | {
      ok: true;
      runId: string;
/** Present when an in-flight predecessor was stopped by this amendment (= predecessorRunId); absent once it had already settled. */
      supersededRunId?: string;
    }
  | { ok: false; reason: DynamicWorkflowRunAmendRefusalReason };

/**
 * Who initiated the cancellation. `user` / `model` are the initiators of the two stop entries; `{ superseded }` is passed on the amend path
 * when stopping an in-flight predecessor: the new run's id lands in the predecessor's settlement bag with the reason (`supersededBy`).
 */
export type DynamicWorkflowRunCancelInitiator = "user" | "model" | { superseded: string };

/**
 * Run snapshot: keeps the {@link WorkflowTaskSnapshot} shape (the background task tracker and notification pipeline read it),
 * only widening `output` - a workflow run's artifact is the script's top-level return value, shaped by the script, not the legacy
 * `Workflow` tool's output type. The legacy port itself is not widened (the two workflow mechanisms share no port).
 *
 * `reports` are the verbatim progressive artifacts handed over by the script's `report(item)`, in report order, from the journal's
 * `kind = "report"` node rows - the persistent home of these entries (`workflowRuns.reports` is only a bounded
 * memory-only display). The completion notification projects them back across completed / failed / cancelled alike:
 * a run that died on ask 12 still did the work of 11; recovering it is the point of `report`.
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * The run's true terminal-state words. The base class's `status` speaks the background task
   * tracker's generic vocabulary (`stopped` folded into `cancelled`, `errored` into `failed`); notifications and tool copy
   * must read these two fields to tell the truth; `stopReason` present only when `runStatus === "stopped"`.
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
/** Session that launched this run (journal parent_session_id; from the registry entry when present). */
  parentSessionId?: string;
/** The run this run was amended from; absent when not an amend. */
  resumedFrom?: string;
/** The amend that stopped and replaced this run; absent when not replaced. */
  supersededBy?: string;
  /**
   * This run's own concurrency cap (`dwf_run.caps_max_concurrency`), **present only below the current ceiling**:
   * a run at the ceiling has nothing to say ("absent when unset", same rule as `reports`). `AmendWorkflow`'s
   * `resolveInput` reads it to decide what applies when `max_concurrency` is omitted.
   */
  maxConcurrency?: number;
  /**
   * This run's subagent model (the one on journal event `run-launched`), canonical
   * `providerId/modelId[$reasoningLevel]`, **present only when set**: a run inheriting the session model has
   * nothing to say (same rule as `maxConcurrency`).
   * A string, not {@link ModelSelection}: read surfaces only display or echo it; nobody reads fields off it.
   */
  subagentModel?: string;
  /**
   * This run's script file (absolute path, the one on journal event `run-launched`). **Present only when the run recorded a file**.
   *
   * Terminal notifications use it to turn "fix the script, submit inline" into "edit that file in place, then amend via `path`", so it must
   * be readable off the snapshot; user surfaces never show it (unlike `subagentModel`, which feeds the desktop run panel).
   */
  scriptPath?: string;
/** Structured failure (same source as {@link DynamicWorkflowRunDetail.error}); the base class's `error` is its message. */
  failure?: DynamicWorkflowRunError;
  /**
   * **Active** duration of this run and its lineage (ms): every life of this run plus every life of each
   * predecessor, gaps between lives excluded. The completion card's "duration" cell reports this.
   *
   * Same rule as `reports` / `artifacts`: **present only in terminal states** (`getTask` is polled repeatedly; consumers act on
   * terminal notifications), and the whole field is absent when the journal cannot answer - not 0. Absent means the read side falls back to `completedAt - startedAt`:
   * one life, as seen by the process that settled it - conservative, never overstated.
   */
  activeDurationMs?: number;
  reports?: readonly unknown[];
  /**
   * Escalated questions currently parked on this run, awaiting the main agent's answer.
   *
   * **Projected from the in-memory registry, not a journal replay**: the journal has `escalation-raised` and
   * `escalation-resolved` events, but "who is still owed an answer" is live in-process state - a replayed
   * unpaired raised would lie once the process dies (parked deferreds vanish with it; resume has the actor
   * ask again under a new qid).
   *
   * The **query fallback** for dropped notifications (stale branch generation / shutdown drop): the main agent can
   * always rediscover pending questions via the existing observation surface. Wholly absent at zero (no empty arrays).
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * **User-facing artifacts** published by this run, first-seen order, from the journal's
   * `kind = "artifact"` rows - the persistent home of version history (`workflowRuns.artifacts` carries only
   * latest-version metadata). Same rule as `reports`: read **only in terminal states** (`getTask` is polled repeatedly; artifact rows
   * feed terminal notifications and GetWorkflowRun); wholly absent when empty.
   *
   * Terminology warning: "artifact" here is output the script published to the user via `artifact.*`, unrelated to this type's `output`
   * (the script's top-level return value, `RunSettlement.artifact` inside the engine).
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};

/**
 * One version of a user-facing artifact (JSON mirror of `ArtifactVersionRecord` on the journal's
 * `dwf_node.result_json`). **Deliberately redeclared here**, not imported from @zcode/dynamic-workflow: the port carries
 * JSON shapes only (same argument as {@link DynamicWorkflowRunLifecycleStatus}).
 *
 * Content artifacts (`file` / `markdown`) fill `contentType` / `bytes` / `uri` / `sourcePath`; preset dashboards
 * (`chart` / `table` / `metrics` / `board`) fill `spec`. Bytes never live here - `uri` points into the
 * tool-artifact store.
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
 * One user-facing artifact: all versions under an id (version ascending) + count of label reports feeding it.
 * `title` / `description` / `contentType` / `sourcePath` / `spec` take the **latest version's** values, so readers
 * caring only about "what is it now" need not walk `versions`.
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
/** Latest version number (= `version` of the last `versions` entry). */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
/** Count of `report` entries tagged with this id (preset-dashboard data volume; always 0 for content artifacts). */
  itemCount: number;
/** The run's deliverable (at most one). Leads the `artifacts` list; the rest follow in first-published order. */
  primary?: true;
}

/** A `report` entry fed to a preset artifact, located by journal sequence (the dashboard data surface). */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
}

/** Pagination bag for {@link DynamicWorkflowRunPort.listArtifactItems} (cursor = journal sequence, strictly greater). */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
/** Required; callers may pass limit+1 to probe hasMore; implementers must not clamp again. */
  limit: number;
}

/** Return of {@link DynamicWorkflowRunPort.readArtifact}: all bytes of one version. */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** A parked escalation question. Fields mirror the `escalation-raised` event, plus ask time. */
export interface DynamicWorkflowRunPendingQuestion {
/** Globally unique question id (shaped `dwfq-<runId fragment>-<seq>`); the only key `resolveQuestion` accepts. */
  qid: string;
/** The asking actor, `refToString` form (e.g. `actor#1@1`). Always present, unique within the run. */
  actor: string;
  /**
   * The actor's human-readable name (the `"poet"` of `agent("poet")` in the script).
   *
   * **Absent for anonymous actors; no fallback label is synthesized here**: a fallback is a rendering decision; notification surface and sidebar
   * each have their own right phrasing (one reads as a sentence, one fits a column). Synthesizing "actor#1@1" as a name here
   * would rob both consumers of the fact that this actor has no name.
   */
  actorName?: string;
  question: string;
/** Context added by the actor (optional `context` of `escalate`). */
  context?: string;
/** Ask time (epoch ms). The main agent reads it to judge how long the question has waited. */
  askedAt: number;
}

/**
 * Structured refusal reasons for {@link DynamicWorkflowRunPort.resolveQuestion}. The three are **three different
 * next steps** for the model, hence distinguishable: fetch the right id from the snapshot / do nothing / this run no longer needs an answer.
 */
export type DynamicWorkflowResolveQuestionRefusalReason =
/** No such qid in the registry: a typo, or a stale id from a dead process (parked entries are not persisted). */
  | "unknown_question"
/** Already answered; the actor long moved on with that answer. */
  | "already_resolved"
/** The qid's run / ask is no longer in flight (cancelled, failed, or finished); nobody awaits this answer. */
  | "run_not_in_flight";

/**
 * Structured result of resolveQuestion. Failure carries a reason, not a throw - same argument as
 * {@link DynamicWorkflowRunSubmitResult}: all three reasons are business branches the caller can expect.
 *
 * `message` is written by the implementer (stating the situation and next step), not assembled by the tool layer: keep discriminant and copy apart,
 * or the two will eventually disagree - and the reader here is the model; what it reads is its next step.
 */
export type DynamicWorkflowResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: DynamicWorkflowResolveQuestionRefusalReason; message: string };

export interface DynamicWorkflowRunWaitOptions {
  signal?: AbortSignal;
}

/** Pagination params for the event log; cursor = journal sequence (monotonically assigned by appendEvent). */
export interface DynamicWorkflowRunEventPage {
/** Only events with sequence strictly greater; default from the beginning. */
  afterSequence?: number;
  limit?: number;
}

/**
 * The **protocol shape** of a run event: sequence + event kind + JSON payload.
 *
 * Deliberately not the engine's `RunEvent`: that is the domain package's (@zcode/dynamic-workflow) vocabulary; importing it
 * into contracts would make every port-holding layer compile-time depend on engine internal types. The port carries
 * JSON shapes only; `type` is an opaque string, `payload` interpreted by readers as needed.
 */
export interface DynamicWorkflowRunEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
/** Payload trimmed by {@link boundDynamicWorkflowRunEventPayload} (raw facts remain in the journal). */
  truncated?: boolean;
}

/**
 * Bounds for run event payloads. **Every payload at the protocol boundary is bounded**; two engine event
 * fields are naturally unbounded: `actor-created`'s `persona.system` (a whole system prompt) and
 * the node error's `finalText` (a full turn of model output). They must not pass on a "probably short enough" basis.
 *
 * Bounds are **structural** (string length / array items / key count / depth), not byte totals: structural bounds
 * apply per field in place, no serialize-then-fallback, and one huge field cannot drag the rest away.
 */
export const DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS = {
  maxStringLength: 2_048,
  maxArrayItems: 32,
  maxKeys: 32,
  maxDepth: 6,
} as const;

/**
 * Trim a run event payload to within {@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS} and
 * normalize it into a **JSON-serializable** shape along the way.
 *
 * Two consumers share this one serialization:
 *   1. the event page returned by `listEvents` (the detail page's event log);
 *   2. the `dynamic_workflow_run_progress` session event appended to the parent session (-> the `workflowRuns` projection).
 *
 * Normalization is required, not incidental: any non-finite number (`Infinity` / `NaN`) becomes `null` through `JSON.stringify`
 * - "same payload, unequal across storage". Rather than have every reader face that inconsistency,
 * fold it to `null` once here so the result is structurally stable under `JSON.parse(JSON.stringify(x))`.
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

/** Recursive trimmer. `undefined` return = value unrepresentable (callers omit it from objects/arrays). */
function boundJsonValue(value: unknown, depth: number, markTruncated: () => void): unknown {
  const limits = DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS;

  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
// Infinity / NaN are not legal JSON numbers; fold to null, not let JSON.stringify do it silently.
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
// Holes change array index semantics, so unrepresentable items become null, never skipped.
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
 * Truncate by UTF-16 code unit but never leave a lone surrogate - that is neither legal text
 * nor safe for downstream JSON codecs on some runtimes. Mid-surrogate-pair cuts prefer one code unit fewer.
 */
function truncateSurrogateSafe(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * An **arbitrary script value** from a workflow run (top-level returned artifact, `report(item)` entries) -> text
 * for the model or a human reader. The implementation moved into `@zcode/shared/zcode-protocol-v4` with the shared workflowRuns reducer
 * (workflow-artifact.ts; rationale in comments there): the `reports[].preview` reduction became a fourth consumer
 * once sunk into shared, and dependency direction contracts -> shared forces the function to move. The re-export stays,
 * so the three existing consumers (completion notification, TaskOutput resultText, v4 projection) change nothing.
 */
export { serializeWorkflowArtifact } from "@zcode/shared/zcode-protocol-v4";

/**
 * The narrow port for workflow runs. Alongside, not merged with, legacy
 * {@link import("./workflow.port.js").WorkflowPort}: the latter serves the `Workflow` tool and legacy `workflow_*` tables; a shared port
 * would re-couple the "independent of the legacy workflow mechanism" boundary at the interface layer.
 *
 * Cancellation has no dedicated RPC: the detail page button and background panel stop share the existing v4 `cancelBackgroundWork`
 * command, landing here as {@link cancel} (runId = workId).
 */
export interface DynamicWorkflowRunPort {
/** Compile once and start the engine; returns the runId (= backgroundTaskId). */
  submit(
    request: DynamicWorkflowRunSubmitRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunSubmitResult>;
  /**
   * Amend a run: precheck predecessor -> mint new id -> predecessor in flight: cancel with `{ superseded: newRunId }` and await settlement
   * -> import cache from predecessor -> launch new run (see {@link DynamicWorkflowRunAmendRequest}). A refused precheck is a
   * structured failure with **nothing touched**. Older hosts may lack the method (optional member): the tool layer probes capability and
   * normalizes to "amending unsupported in this session".
   */
  amend?(
    request: DynamicWorkflowRunAmendRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunAmendResult>;
  /**
   * Ceiling for a run's own concurrency cap (`max(1, min(16, availableParallelism() - 2))`, one value per process). Synchronous, side-effect free.
   *
   * Two tool-layer readers: `CreateWorkflow` / `AmendWorkflow` `resolveInput` clamps the model's
   * `max_concurrency` under it (the confirm dialog must show the value that will take effect); `GetWorkflowRun` decides by it
   * whether a run's cap is worth mentioning. **Optional member** (consumers `typeof`-probe): port stubs need not
   * carry it; when absent the tool layer does not clamp, passes through (the port implementation clamps again anyway).
   */
  concurrencyCeiling?(): number;
  /**
   * Change an **in-flight** run's own concurrency cap in place: same runId, no successor, no supersede, no cache import, no in-flight ask lost.
   *
   * Kept beside, not merged into, {@link amend}: amend swaps the **script**, paying predecessor-stop + new run + cache replay;
   * "just slow this run down" should not pay that. Both callers (`AmendWorkflow`'s handler and the GUI's
   * `amendWorkflowRunSettings`) read the same answer, so "what is a retune" has one definition.
   *
   * Three things in one synchronous slice or none: swap engine caps (scheduler reads live), write
   * `dwf_run.caps_max_concurrency` (resume continues on the new cap), record `run-caps-changed`.
   * The service moves its own in-memory cap too, so snapshot, detail, and `GetWorkflowRun` report the new value at once.
   *
   * **Optional member** (consumers `typeof`-probe), reason as {@link resume}: a port stub need not carry a control surface for all,
   * and "port absent" vs "method absent" is one business fact to callers - fall back to a real amend.
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
   * Stop a run: abort in-flight asks, kill child processes; the run settles `stopped(initiator)`. `initiator`
   * defaults `user`; main-agent TaskStop passes `model` (the reason is now persisted, no longer only in the background task registry); the amend path passes `{ superseded: newRunId }`.
   * Unknown runId returns false.
   */
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
/** Page the event log by cursor; out-of-range cursor returns an empty page, not an error. */
  listEvents(
    runId: string,
    options: DynamicWorkflowRunEventPage,
  ): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * Enumerate runs by project (cwd), most recently updated first. Serves `ListWorkflowRuns`.
   *
   * **Optional member**, per the {@link cancel} precedent (consumers `typeof`-probe): implementers provide it only when the journal
   * carries introspection queries; existing port stubs need not carry a read-only enumeration either. Consumers treat
   * "port absent" and "method absent" as one business failure - to the model, one thing: this session lacks the capability.
   */
  listRuns?(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult>;
  /**
   * Single-run detail (progress summary + artifacts / failure). Serves `GetWorkflowRun`. Unknown runId returns
   * `undefined` (consumers normalize to `run_not_found`), **no wait/block semantics** - waiting is
   * {@link waitForTask}'s job; this is the immediate snapshot. Optional, reason as {@link listRuns}.
   */
  getRunDetail?(runId: string): Promise<DynamicWorkflowRunDetail | undefined>;
  /**
   * The run's archived script text (`dwf_run.script_text`, the same bytes resume replays), byte-for-byte, untouched.
   * `AmendWorkflow` reads it twice: backfilling the predecessor's script on omission, and the
   * `script_unchanged` precheck of a `path` amend -
   * bytes, not hashes: the tool side reads file content, not build artifacts. GUI "Configure" shares the read.
   *
   * A dedicated read surface, not a {@link DynamicWorkflowRunSnapshot} field: snapshots are polled repeatedly by the background tracker, and
   * the script is the port's largest string (same reason as {@link DynamicWorkflowRunSummary.label}). Unknown run and
   * "no script on record" (pre-column runs) both return `undefined` - one fact to the caller: no script
   * to reuse. Read-only, no closed-service check. **Optional member** (consumers `typeof`-probe), reason as {@link listRuns}:
   * absent, a script-less amend fails outright; the `script_unchanged` precheck is skipped (a net, not a gate).
   */
  getScript?(runId: string): Promise<string | undefined>;
  /**
   * Resume a cancelled / process-death-interrupted run: rerun under the same runId (engine resume branch: journal
   * hits short-circuit, unfinished nodes redispatch). The gate is the implementer's: only `cancelled`, or `failed` coded
   * `Interrupted`, is resumable.
   *
   * **Optional member**, per the pre-{@link listEvents} cancel precedent (consumers `typeof`-probe):
   * port stubs need not carry a resume surface; to consumers "port absent" vs "method absent" is one business failure.
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * Enumerate run summaries under **this service's parent session** (most recent first, journal-backed). The UI's post-restart discovery surface:
   * the `workflowRuns` projection does not survive processes; tool-card joins and Resume availability rebuild only from here.
   * Deliberately no parentSessionId param - the service instance is per parent session (per-app); letting callers
   * pass arbitrary sessions opens a cross-session read hole. Optional, reason as {@link resume}.
   */
  listRunsForSession?(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Cold replay: runs under **this service's parent session** that this process
   * never ran, replayed from the journal into progress event payloads - the **same** payload kind and minting chain as `onRunEvent` when live; cold materialization feeds them to the same reducer as in-memory events, so the
   * payload kind and the same minting chain; cold materialization feeds them to the reducer as in-memory events, so the
   * `workflowRuns` projection is byte-identical across restarts.
   *
   *   - cap and eviction as the projection (8 most recently updated), oldest run first;
   *   - `excludeRunIds`: runs whose events the caller already holds (ran / running in this process) are not replayed;
   *   - rows terminal without a `run-settled` event (rewritten by orphan reaping post-mortem) get an
   *     in-memory synthetic settle payload (status / failure / resumable), never written to the journal.
   *
   * Optional, reason as {@link listRunsForSession}: an in-memory journal has no enumeration, nothing to replay.
   */
  replayProgressForSession?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * Answer a blocking question escalated by an actor. Serves
   * `ResolveWorkflowQuestion`.
   *
   * One opaque token, not a `(runId, qid)` pair: qids are globally unique (across runs); model-side pairing
   * invites mismatch under concurrent runs. The answer becomes, verbatim, the tool result of the actor's `escalate` call;
   * the actor's turn then continues; run state untouched (an escalation is a slow tool call inside an ask,
   * not a run lifecycle event).
   *
   * **Optional member**, per the {@link resume} precedent (consumers `typeof`-probe): a port stub need not
   * carry an answer surface for all; "port absent" vs "method absent" is one business failure to callers.
   */
  resolveQuestion?(qid: string, answer: string): Promise<DynamicWorkflowResolveQuestionResult>;
  /**
   * This run's user-facing artifacts (journal `kind = "artifact"` rows grouped by id, version ascending). Durable read for UI cold recovery and hub detail.
   * Unknown runId returns `undefined`. **Optional member**, reason as {@link listRuns} (provided once the journal
   * carries artifact reads; consumers `typeof`-probe).
   */
  listArtifacts?(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * `report` entries fed to one preset artifact, paged by journal sequence ascending (the dashboard data surface).
   * Out-of-range cursor returns an empty page, not an error. Optional, reason as {@link listArtifacts}.
   */
  listArtifactItems?(
    runId: string,
    artifactId: string,
    page: DynamicWorkflowRunArtifactItemPage,
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * Read one artifact version's bytes: **first** confirm a `completed` row for `(runId, artifactId, version)`
   * in the journal, then fetch via the row's `uri` through the tool-artifact store - no caller-supplied id
   * becomes a path directly. No such version / not a content artifact /
   * store absent -> `undefined`. Chunking is the gateway's (v4 `workflowRunArtifactRead`, <= 512 KiB per chunk).
   * Optional, reason as {@link listArtifacts}.
   */
  readArtifact?(
    runId: string,
    artifactId: string,
    version: number,
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * This run's workspace transcript: journal
   * rows `kind in {world-read, world-run}`, storage order, **bodies excluded**.
   *
   * Authorization as {@link readArtifact}: the run must belong to this service's parent session, else `undefined`
   * (same answer as "no such run" - do not tell a foreign caller which half it guessed). Bodies may carry workspace file
   * contents, so the listing too is gated to the owning session. Optional, reason as {@link listArtifacts}.
   */
  listWorkspaceNodes?(
    runId: string,
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  /**
   * One workspace node's body, shape-preserving bounded by `maxBytes`. Authorization as {@link listWorkspaceNodes};
   * no such node / not a world row / not your run -> `undefined`. Optional, reason as {@link listArtifacts}.
   */
  readWorkspaceNodeResult?(
    runId: string,
    siteId: string,
    ordinal: number,
    query: DynamicWorkflowRunWorkspaceNodeResultQuery,
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
}

// ————————————————————————————————————————————————————————————————
// run introspection (data surface of ListWorkflowRuns / GetWorkflowRun)
// ————————————————————————————————————————————————————————————————

/**
 * Lifecycle states of a run. Literals match the journal's `dwf_run.status` set, but **deliberately redeclared
 * here**, not imported from @zcode/dynamic-workflow: the port carries JSON shapes only; once the engine
 * vocabulary enters contracts, every port-holding layer compile-time depends on engine internals (same argument as `type` on {@link DynamicWorkflowRunEvent}).
 * same argument as the `type` field).
 *
 * Deliberately unlike the status on {@link DynamicWorkflowRunSnapshot}: that one speaks the background task
 * tracker's vocabulary, folding `pending` into `running`. Introspection keeps `pending` - "submitted, engine
 * has not created the row" is a distinction the model understands and cares about.
 */
export type DynamicWorkflowRunLifecycleStatus =
  | "completed"
  | "errored"
  | "pending"
  | "running"
  | "stopped";

/**
 * Why `stopped`: `user` user cancelled / `model` main agent
 * TaskStop / `provider` deterministic model-side error / `interrupted` owner process death or sandbox failure / `superseded`
 * stopped and replaced by an AmendWorkflow. First four resumable, `superseded` not (the successor is live);
 * `errored` (the script's fault) not. Literals match engine `RunStopReason`, redeclared here deliberately.
 */
export type DynamicWorkflowRunStopReason =
  | "user"
  | "model"
  | "provider"
  | "interrupted"
  | "superseded";

/** Query bag for {@link DynamicWorkflowRunPort.listRuns}. */
export interface DynamicWorkflowRunListQuery {
  /**
   * Project key, **required**. Literal equality vs `dwf_run.cwd` (written verbatim, queried verbatim).
   * The port guesses no default cwd: the tool surface always queries `context.workingDirectory`; the model may not sweep projects.
   */
  cwd: string;
/** Result cap, **required**. Clamping belongs to the tool surface ([1, 50]); the port never enumerates unbounded. */
  limit: number;
/** Optional status subset. Absent: no filter; empty array: match no status (empty list). */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * The section shared by list and detail. Label, attribution, timestamps must be field-for-field identical across both read surfaces -
 * one run showing different name/attribution in list vs detail is the inconsistency class hardest to catch in tests and most directly
 * trust-eroding. Hence one shared base interface, not two independently evolving field tables.
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * Display label. **Pre-cooked**: the implementer (run service) derives name -> script first line -> runId;
   * consumers render directly. Why not hand ingredients (name / scriptText) to the tool layer: that fallback chain
   * is a read-time heuristic; two tools assembling independently drift, and scriptText is the port's largest string
   * (the list surface should not haul 50 scripts across the boundary for one first line).
   */
  label: string;
/** Label source: `name` = user-given name; `script` = derived from the script at read time (runId fallback included). */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
/** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
/** The run this run was amended from (`dwf_run.resumed_from`); absent when not an amend. */
  resumedFrom?: string;
/** The amend that stopped and replaced this run (the `stopped(superseded)` settlement bag); absent otherwise. */
  supersededBy?: string;
/** Whether this session is the run's origin (journal parent_session_id match, or in this session's registry). */
  ownedByThisSession: boolean;
  /**
   * "This session cannot prove the run alive": journal non-terminal, not this session, not in this session's registry. Either a dead
   * process's relic or a sibling session's in-flight run in the same process - an **annotation, not a state rewrite**; read surfaces never
   * bury others' dead (orphan reaping executes only at owning-session construction). Present only when true.
   */
  possiblyInterrupted?: boolean;
/** Journal `time_created` / `time_updated` (epoch ms). */
  createdAt: number;
  updatedAt: number;
}

/** One list item: common section + usage. Deliberately light - no actors, node counts, or artifact previews. */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
/** Read straight from `dwf_run.spent_tokens` (sole authority for run-level token usage). */
  spentTokens: number;
}

/**
 * Result of `listRuns`. An object, not a bare array, deliberately: page-level fields (e.g. {@link truncated}) are pure
 * additive changes; a bare array can only change shape wholesale.
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
/** More runs remain beyond this page for this project. **Present only when true**. */
   *
   * The test is "fetch one extra" (implementation queries `limit + 1`, falls back), not `length === limit`: the latter
   * false-positives at exactly limit, sending the model chasing a nonexistent history page. The same convention
 already served the v4 gateway's event pagination (`hasMore`).
   */
  truncated?: boolean;
}

/**
 * Progress and usage of a run (observation surface, uncapped). `nodesObserved`
 * is the **persisted-node row count** (three-state sum), never a pretend total: dynamic workflows have no static total, and
 * `queued` lives only in the event phase, never persisted.
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** One actor site instance. `persona` deliberately omitted: a whole system prompt is naturally unbounded on this port. */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** One `log()` narrative entry. */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
/** Already bounded by the port's string limit ({@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}). */
  message: string;
  /**
   * When the event entered the journal (`dwf_event.time_created`). Sequence locates; time answers "how long ago" -
   * every situation-section field group ages by that ruler; the narrative tail gets no other. **Absent on journals
   * without the column**; read surfaces then show no age, never falling back to read-time `Date.now()`.
   */
  at?: number;
}

/** Structured failure. `code` is the stable discriminant - the model must tell "process died" from "script failed". */
export interface DynamicWorkflowRunError {
  code: string;
  message: string;
/** Present only when `code === "ProviderStop"` (JSON mirror of engine `ProviderStopDetails`). */
  providerStop?: DynamicWorkflowRunProviderStop;
}

/** Structured `ProviderStop` detail (mirror of engine `ProviderStopDetails`; JSON shapes only on the port). */
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

// Situation section types (phases / subagents / health) live in dynamic-workflow-run-roster.port.ts (as above);
// re-exported verbatim to keep `@zcode/contracts` import paths unchanged.
export type * from "./dynamic-workflow-run-roster.port.js";

// The three retune (in-flight cap change) types live in dynamic-workflow-run-retune.port.ts;
// re-exported verbatim as above.
export type * from "./dynamic-workflow-run-retune.port.js";

// The six workspace-transcript types live in dynamic-workflow-run-workspace.port.ts, re-exported verbatim as above.
export type * from "./dynamic-workflow-run-workspace.port.js";

/** Single-run detail: common section + progress + situation section + terminal-forked artifacts / failure. */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  /**
   * This run's own concurrency cap, semantics as {@link DynamicWorkflowRunSnapshot.maxConcurrency}: present only below the current
   * ceiling. Deliberately off {@link DynamicWorkflowRunSummary} - list rows should not widen for a rarely set field.
   */
  maxConcurrency?: number;
  /**
   * This run's subagent model, semantics as {@link DynamicWorkflowRunSnapshot.subagentModel}: present only when
   * set. Same reasoning as `maxConcurrency` for staying off {@link DynamicWorkflowRunSummary} - list rows should not
   * widen for a rarely set field.
   */
  subagentModel?: string;
  /**
   * This run's script file, semantics as {@link DynamicWorkflowRunSnapshot.scriptPath}: present only once a file was recorded.
   * `GetWorkflowRun` phrases the next step in `<amendable>` as "edit this file in place". 
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
/** Tail of `log()` events, in order (sequence ascending). Empty array when none. */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * Phase table: declared phases in declaration order, then those "entered but never declared"
   *
   * **Wholly absent when the script declared no phases and entered none** - such a run has no phase notion;
   * an empty array would read "the phase table is empty", a different sentence.
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * Subagent roster, actor-row order (= minting order). **Always present**; zero actors is an empty
   * array: unlike `phases`, "how many subagents" always has an answer, and 0 is it.
   *
   * Deliberately unmerged with sibling `actors`: that is a constant identity table (siteId / ordinal / name)
   * consumers already join on; each entry here is a **read-time snapshot**, different a second later on the same run.
   */
  subagents: DynamicWorkflowRunSubagentView[];
/** Whether the run as a whole still moves (see {@link DynamicWorkflowRunHealth}). Always present. */
  health: DynamicWorkflowRunHealth;
  /**
   * The script's top-level return value, **verbatim** (unserialized). Present only for completed runs; a `undefined`
   * artifact means the field is wholly absent.
   *
   * Why not serialize here: the model-facing text projection has one implementation (core's
   * `serializeWorkflowArtifact`, shared by completion notification and TaskOutput). A second one on the port yields
   * "same run, artifact differs between notification and tool" - the loss class the sharing exists to prevent.
   * Serialization stays in core; the port carries the raw value to the boundary.
   */
  result?: unknown;
/** Always present on errored; on stopped only provider / interrupted. `code` passes through verbatim, unfolded. */
  error?: DynamicWorkflowRunError;
  /**
   * Escalated questions currently parked on this run, awaiting the main agent's answer.
   *
   * **Same source and projection as {@link DynamicWorkflowRunSnapshot.pendingQuestions}** (both read the in-process escalation
   * park table, both wholly absent at zero); only the read surface differs: the snapshot serves the background task tracker, this field serves
   * `GetWorkflowRun` - the **model side's only discovery surface**. Not optional polish: escalation notifications
   * have two known drop paths (stale branch generation / shutdown); query is the fallback for both, and `resolveQuestion`'s `unknown_question` copy sends the model here for the qid.
   * Without it, both promises point at a tool that returns nothing.
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * This run's user-facing artifacts (attached in any state; journal-backed, same source as {@link DynamicWorkflowRunSnapshot.artifacts}).
   * `GetWorkflowRun` tells the model: already shown to the user as cards; reference by title. Wholly absent when empty.
   * Wholly absent when empty.
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/** Structured failure reasons for {@link DynamicWorkflowRunPort.resume}. */
export type DynamicWorkflowRunResumeErrorReason =
/** No such run in the journal. */
  | "not_found"
/** Not in the resumable set (completed or errored; only stopped resumes). */
  | "not_resumable"
/** Stopped and replaced by an AmendWorkflow: the successor is live; replaying does the work twice. */
  | "superseded"
/** A run with this runId is already in flight in this process. */
  | "already_running"
/** Record lacks scriptText (pre-column run); no script to rerun. */
  | "script_missing"
/** Record scriptHash disagrees with the hash recomputed from scriptText (record rewritten externally). */
  | "script_mismatch"
  /**
   * The record's scriptText no longer type-checks under the **current** facade (pre-refactor run). Verbatim replay
   * would only fail; the way out is rewriting the script on the current facade via AmendWorkflow. `message` carries a bounded diagnostic.
   */
  | "compile_failed";

/**
 * Structured resume result. Failure carries a reason, not a throw: all five reasons are expected business branches
 * (error codes, not text, drive control flow - house rule); throw is for genuine wiring faults.
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };

/**
 * A run summary for {@link DynamicWorkflowRunPort.listRunsForSession}. Literals match the journal's
 * `dwf_run.status` set, but **deliberately redeclared here**: JSON shapes only on the port; engine vocabulary
 * in contracts would make every port-holding layer compile-time depend on engine internals.
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
/** CreateWorkflow tool call id that started the run (tool card -> detail/Resume key); absent on old runs. */
  toolCallId?: string;
  /**
   * Display label, derived server-side at read time (`name` -> script first line -> runId; bootstrap's
   * `resolveDynamicWorkflowRunLabel`). Optional for **skew safety**: old servers omit the key, read side
   * falls back to runId - a missing label is degradation, not error.
   *
   * Centralized server-side, same reason as `resumable`: two independent fallback assemblies show
   * different names for one run on `/dwf list` vs the tool card.
   */
  label?: string;
  /**
   * Last update (epoch ms, journal `dwf_run.time_updated`). Optional as above:
   * old servers omit it, read side hides the time column. Ordering stays with storage (most recent first);
   * display only - do not re-sort by it, or drift from the server tie-break.
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
/** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
/** The run this run was amended from; absent when not an amend. */
  resumedFrom?: string;
/** The amend that stopped and replaced this run; absent when not replaced. */
  supersededBy?: string;
/** Structured failure code of errored / stopped(provider|interrupted) (`ProviderStop` / `Interrupted` ...). */
  failureCode?: string;
  failureMessage?: string;
  /**
   * Resumable flag. **The server computes it with the same predicate as the resume gate**: UI-side rederivation from status+failureCode
   * eventually disagrees - button lit, command refused.
   */
  resumable: boolean;
}
