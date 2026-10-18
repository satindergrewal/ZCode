// ============================================================
// AgentRuntime-backed WorkflowDriver: shared types
// ============================================================
// workflow-driver.ts hits oxlint's max-lines cap (400), so the driver's dependency bag
// (AgentRuntimeWorkflowDriverDeps), the runtime factory signature (ActorRuntimeFactory) and each actor session's
// live state (SessionState) move here, shared by workflow-driver.ts / workflow-driver-escalation.ts /
// workflow-driver-helpers.ts; the public surface (ActorRuntimeFactory) still exports from workflow-driver.ts.
// Types only here; zero runtime code.

import type {
  ExecutionPort,
  FileSystemPort,
  Logger,
  ModelRequestAdmission,
  SessionId,
  SubmitVerdict as ContractsSubmitVerdict,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  ActorSubmitProfile,
  ActorRef,
  ActorSessionSeed,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
} from "@zcode/dynamic-workflow";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { ActorModelActivity, WorkflowClock } from "./workflow-driver-concurrency.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

/** A promise settleable from outside. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 // * The actor runtime factory: given session id/actor/persona and the session submit port, produce an assembled
 // * child AgentRuntime. Injecting submitPort registers submit_result for that session (core's gate is port presence).
 *
 // * "How to build a runtime" as an injection point: production wraps createScriptWorkflowAgentRuntime (real model adapter
 // + full deps); tests use a minimal deps bag + scripted model adapter. The driver owns lifecycle and bridging only.
 *
 // * May return a Promise: production persists the actor session and creates the task link before returning, and
 // * session_task_link.child_session_id has an FK to session(id), so the session row must exist before the link.
 // The engine's ensureSession awaits createActorSession, so awaiting here is safe -- by the first ask's
 // dispatch the session is fully persisted.
 */
export type ActorRuntimeFactory = (input: {
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   //   * The actor's submit profile. The factory picks the submit_result kind: untyped -> do NOT inject submitPort (core's
   //   * gate is port presence, so no tool); mono -> port + workflowSubmitSchema (typed);
   //   generic -> port only (today's generic schema). The driver looks it up per actor site in deps.actorSubmitProfiles;
   //   absent = generic.
   */
  submitProfile: ActorSubmitProfile;
  /**
   //   * Session escalate port. Injection isomorphic to submitPort:
   //   port presence registers escalate for the session (core's gate is port presence); ALWAYS injected, never
   //   opt-in -- the actor most likely to hit an unforeseen wall is the one the author did not mark.
   */
  escalatePort: WorkflowEscalatePort;
  /**
   //   * The amend-resume session seed, present only when this actor consumed >= 1 imported ask entry.
   *
   //   One thing the factory needs from it: resolvedModel is the PREDECESSOR-resolved model pin, to outrank
   //   tier re-resolution like a journal pin (silently switching models under a continued transcript is what pins prevent). The transcript copy itself is not the factory's job -- the driver does it AFTER the factory returns (the session row must exist first;
   //   message.session_id has an FK to session(id)).
   */
  seed?: ActorSessionSeed;
  /**
   * Model-request admission port for this actor runtime: provided by the driver when the governor
   * governor port; the factory puts it into the runtime deps' `modelRequestAdmission`, and every
   * runner model-request attempt passes the gate first. Absent means this runtime is ungated.
   */
  modelRequestAdmission?: ModelRequestAdmission;
}) => AgentRuntime | Promise<AgentRuntime>;

/** Dependencies for building the AgentRuntime-backed driver (journal and emit are provided and owned by the caller/harness). */
export interface AgentRuntimeWorkflowDriverDeps {
  journal: JournalStorePort;
  emit: (event: RunEvent) => void;
  /** Filesystem port for world-read (files.glob / files.read / files.grep). */
  fileSystemPort: FileSystemPort;
  /**
   * Child-process execution port backing git.* world-read (cwd = workspace root).
   *
   //   REQUIRED, not optional: optionality invites a silent-degradation runtime path -- git.* works in production but silently
   //   becomes "not a git repo" in a half-wired assembly, and both failures look identical in the script. Prefer the wiring error
   //   surfacing at compile time (this package's existing practice for fileSystemPort).
   */
  executionPort: ExecutionPort;
  /**
   * Parking registry for escalation Q&A. The driver registers pending questions here, and the
   * run service's `resolveQuestion` delivers answers back through the same table.
   *
   //   REQUIRED, not optional, same argument as executionPort: optionality invites silent degradation -- without the table
   //   escalate either hangs forever (worst) or silently degrades to "capability absent", indistinguishable to the model from
   //   "the author gave no escalation". Prefer the wiring error at compile time.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /** Base directory for path resolution shared by world-read and artifact publishing (the workspace root). */
  cwd: string;
  /**
   * Byte destination for user-facing artifacts (`artifact.file` / `artifact.markdown`). Note:
   * "artifact" here is the **deliverable shown to the user**, not the engine-internal artifact
   * (the top-level `RunSettlement.artifact` return value, which is for the model).
   *
   //   OPTIONAL, same argument as actorTranscriptStore: assemblies without a store (pure replay, fake driver,
   //   minimal stub) have nowhere to put bytes. Absence is NOT silent degradation -- content members reject the node with a named
   //   ArtifactStoreUnavailable (script-catchable; the node journals as failed) instead of
   //   falling back to the workspace or publishing an empty artifact. Preset members (chart/table/...) unaffected: declarations,
   //   they never pass through the driver.
   */
  artifactStore?: ToolArtifactStorePort;
  /**
   //   This run's parent session id, used ONLY for artifact publishing: the store scopes writes by session
   //   (zcode-artifact://<session>/<id>); that scope is the parent session.
   *
   //   Paired with artifactStore (production provides both from the same app session); half-provided publishing fails
   //   loudly with ArtifactStoreUnavailable, see {@link ArtifactPublishDeps}. The actor session id does not use this field -- mintActorSessionId mints that.
   * {@link ArtifactPublishDeps}. The actor session id does not use this field -- mintActorSessionId mints that.
   */
  parentSessionId?: SessionId;
  /**
   //   Per actor-site submit profiles, computed at compile time by deriveActorSubmitProfiles (the submit path's
   //   compileOnce). Optional: absent = every actor generic (legacy behavior), so assemblies without profiling
   //   (snippet, fake driver, existing tests) stay byte-identical.
   */
  actorSubmitProfiles?: ReadonlyMap<string, ActorSubmitProfile>;
  runtimeFactory: ActorRuntimeFactory;
  /**
   //   The process governor's narrow port. Present, the driver gives every actor runtime a ModelRequestAdmission (via the
   //   runtimeFactory input down into runtime deps): every model-request ATTEMPT passes the gate first, and cap changes fan out as
   //   concurrency-changed. Absent = actors ungated (zero changes for fake/pure-replay assemblies). The engine is unaware
   //   (v1's acquireSlot deleted).
   * (v1 acquireSlot deleted).
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   //   This run's seat gate (docs/dynamic-workflow/concurrency.md, "Retuning a live run"): this run's
   * subagents halt before their next turn step. When present the driver does two things - wrap
   * each actor's admission port in the gate, and feed it ask start/stop (startAsk and the
   * engine's `node-settled`; see workflow-driver.ts).
   *
   //   Optional: absent = this run's bound never changes mid-flight (snippet/fake/legacy assemblies), admission byte-identical
   //   to before. PRESENCE also never changes a never-lowered run: requests above the bound pass in place; the gate emits
   //   no event and holds no ticket.
   */
  seatGate?: WorkflowRunSeatGate;
  /**
   //   The actor sessions' transcript access (production: the session store itself). Two users, and MUST be the same one:
   //   the ask-boundary count, and the seed-truncation copy (see workflow-actor-transcript.ts's module docs).
   *
   //   Optional: assemblies without session storage (pure-replay tests, minimal stub runtimes) have no transcript to count;
   //   absent = no boundary accounting, the cost being THIS RUN CANNOT BE A REVISION'S PREDECESSOR (the service-side
   //   no-marker-predecessor gate blocks it), never a wrong boundary. Seeded session creation fails loudly when absent --
   //   the engine already decided to continue a transcript from the import facts; no access surface then is a wiring error.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
  /**
   //   This run's id. Actor session ids scope by it -- a runId-less scheme would collide the same
   //   site x ordinal actor of two concurrent runs into one session id (createSessionId("wf-actor-" + refToString(actor))
   //   is that bug). Default "run" only preserves legacy test assemblies.
   */
  runId?: string;
  /**
   //   Clock and timers (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md): the run stall clock, transient-failure backoff
   //   re-dispatch and the bounded wait for session quiet. Injectable for fake test time; stallAfterMs defaults 20 min;
   //   quiesceMs defaults {@link AMEND_TRANSCRIPT_QUIESCE_MS}; random for backoff jitter.
   */
  clock?: WorkflowClock & {
    stallAfterMs?: number;
    quiesceMs?: number;
    random?: () => number;
  };
  /**
   //   Hands over this driver's SESSION-QUIET PROBE (workflow-driver-quiescence.ts). Called exactly once, at construction;
   //   the caller hangs the probe on its run's registry entry -- amend asks it before continuing an in-flight ask.
   *
   //   A callback rather than a tuple from createAgentRuntimeWorkflowDriver: the driver instance is built by the ENGINE
   //   in makeDriver(sink), so the assembly never sees the return value. Absent = the caller does not care about quiet
   //   (test assemblies, direct-harness paths).
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 // * Per-actor-session live state. per-actor FIFO (engine-guaranteed) -> at most one in-flight ask per session, so
 //   currentInstance/pendingSubmit/accepted/cancelled are all "current instance" semantics; no per-instance split needed.
 */
export interface SessionState {
  readonly ref: SessionRef;
  /** Same value as `ref.id`, keeping the branded type (the transcript access surface queries by SessionId). */
  readonly sessionId: SessionId;
  readonly runtime: AgentRuntime;
  /**
   //   The submit_result shape actually registered for this session. Taken from the static profile at creation; the ONLY mutating path is the runtime guard
   //   (workflow-driver.ts ensureSubmitProfileFits): mono schema mismatching the actual ask downgrades to
   //   generic, never back up.
   */
  submitProfile: ActorSubmitProfile;
  /** Instance of the current in-flight ask; set by startAsk. */
  currentInstance?: InstanceRef;
  /** Whether the current ask is typed (untyped bypasses the submit bridge). */
  currentTyped: boolean;
  /** Verdict deferred the submit_result handler blocks on; at most one (single front instance). */
  pendingSubmit?: Deferred<ContractsSubmitVerdict>;
  /**
   //   Stalled escalation Q&As, keyed by qid. Unlike pendingSubmit these MUST be plural: one turn may fire several
   //   escalate calls in parallel, each an independent Q&A (bounded by escalationsUsed).
   */
  readonly pendingEscalations: Map<string, Deferred<string>>;
  /**
   //   Escalations used by the current ask (cap-short-circuited attempts excluded -- see makeEscalatePort).
   //   Per-ask counter, reset in startAsk; NOT reset by nudge turns (a nudge stays in the same ask).
   */
  escalationsUsed: number;
  /** Turn cancellation controller for the current ask; rebuilt per ask by startAsk. */
  abortController?: AbortController;
  /** The engine accepted the current ask: its turn resolve no longer reports askTurnEnded (settled by the engine). */
  accepted: boolean;
  /** The engine cancelled the current ask: turn rejection no longer reports askFailed (already settled failed/cancelled). */
  cancelled: boolean;
  /**
   //   Turn ordinals started on this session. One use: telling whether the engine started ANOTHER turn after askTurnEnded
   //   (nudge takes exactly that road), i.e. whether this ask's exchange truly ended -- boundary accounting wants the END of the whole
   //   exchange, not any single turn's end.
   */
  turnGeneration: number;
  /**
   //   The current in-flight turn's tail chain (executeTurn with onTurnResolved/onTurnRejected). One reader:
   //   dispose waits for it before closing the runtime -- the accept path's askStats lands after settle (the turn resolves
   //   only after submit), and a synchronous close would race that tail.
   */
  turn?: Promise<void>;
  /**
   //   This actor's model-activity surface: admission port + session-event observation (the source of waiting/executing badges).
   */
  modelActivity: ActorModelActivity;
  /** This session's actor identity (ProviderStop details name the subagent that triggered the stop). */
  readonly actor: ActorRef;
  readonly actorName: string | undefined;
  /**
   //   Driver-side transient re-dispatches in the current ask: runner-reported transient failures (stream-recovery exhausted etc.) do not settle the node; re-run per the backoff curve.
   //   Reset in startAsk.
   */
  transientAttempts: number;
  /** Redrive alarm while backing off; torn down by cancelAsk / dispose. */
  cancelRedrive?: () => void;
}
