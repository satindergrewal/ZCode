// ============================================================
// AgentRuntime-backed WorkflowDriver: shared types
// ============================================================
// workflow-driver.ts sits at the oxlint max-lines cap (400 lines), so the driver's dependency bag
// (AgentRuntimeWorkflowDriverDeps), the runtime factory signature (ActorRuntimeFactory), and the
// per-actor-session run state (SessionState) live here, shared by workflow-driver.ts /
// workflow-driver-escalation.ts / workflow-driver-helpers.ts; the public surface
// (ActorRuntimeFactory) is still re-exported from workflow-driver.ts. Types only, zero runtime
// code in this file.

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
 * Actor runtime factory: given session id / actor / persona / session-level submit port, produces
 * a fully assembled child AgentRuntime. Injecting submitPort registers the submit_result tool for
 * that session (core's registration gate keys on the port's presence).
 *
 * "How to build a runtime" is an injection point: production wraps createScriptWorkflowAgentRuntime
 * (with the real model adapter and the full deps bag); tests use a minimal deps bag plus a
 * scripted model adapter. The driver proper only handles lifecycle and bridging.
 *
 * Returning a Promise is allowed: production must persist the actor session and create the task
 * link before returning, and `session_task_link.child_session_id` has an FK to `session(id)`, so
 * "create the session row" must precede "create the link". The engine's ensureSession awaits
 * createActorSession, so awaiting here is naturally safe - by the first ask dispatch the session
 * is already persisted.
 */
export type ActorRuntimeFactory = (input: {
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * This actor's submit profile. The factory picks the submit_result flavor from it:
   * `untyped` -> do **not** inject submitPort (core's gate keys on port presence, so no tool);
   * `mono` -> inject the port + `workflowSubmitSchema` (typed declaration); `generic` -> inject
   * the port only (today's generic declaration). The driver looks it up per actor site in
   * deps.actorSubmitProfiles; absent means generic.
   */
  submitProfile: ActorSubmitProfile;
  /**
   * Session-level escalation port. Injected exactly like submitPort: port presence registers the
   * `escalate` tool for that session (core's gate keys on port presence), **always injected, no
   * opt-in** - the actor most likely to hit an unforeseen wall is precisely the one its author
   * did not flag.
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * Amend-resume session seed, present only when this actor consumed at least one imported ask
   * entry.
   *
   * The factory needs one thing from it: `resolvedModel` is the **predecessor's resolved model
   * pin** and must outrank tier re-resolution just like a journal pin (silently switching models
   * under a continuing transcript is exactly the identity mutation pins guard against). The
   * transcript copy itself is not the factory's job - the driver does it **after** the factory
   * returns (the session row must exist first; `message.session_id` has an FK to `session(id)`).
   */
  seed?: ActorSessionSeed;
  /**
   * Model-request admission port for this actor runtime: present only when the driver holds a
   * governor port; the factory puts it into the runtime deps' `modelRequestAdmission`, and every
   * runner model-request attempt passes the gate first. Absent means this runtime is ungated.
   */
  modelRequestAdmission?: ModelRequestAdmission;
}) => AgentRuntime | Promise<AgentRuntime>;

/** Dependencies for building the AgentRuntime-backed driver (journal and emit are provided and owned by the caller/harness). */
export interface AgentRuntimeWorkflowDriverDeps {
  journal: JournalStorePort;
  emit: (event: RunEvent) => void;
  /** File system port backing world-read (files.glob / files.read / files.grep). */
  fileSystemPort: FileSystemPort;
  /**
   * Child-process execution port backing git.* world-read (cwd = workspace root).
   *
   * **Required, not optional**: optional invites a silently degraded run path - `git.*` works in
   * production but silently becomes "not a git repository" in some assembly that forgot the
   * wiring, and both failures look identical from a script. Prefer the wiring error surfacing at
   * compile time (the existing approach for fileSystemPort in this package too).
   */
  executionPort: ExecutionPort;
  /**
   * Parking registry for escalation Q&A. The driver registers pending questions here, and the
   * run service's `resolveQuestion` delivers answers back through the same table.
   *
   * **Required, not optional**, same reasoning as executionPort above: optional invites a
   * silently degraded run path - without the table, `escalate` either hangs forever (worst case)
   * or silently degrades to "this capability does not exist", indistinguishable to the model
   * from "the author gave this actor no escalation rights". Prefer the wiring error surfacing at
   * compile time.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /** Base directory for path resolution shared by world-read and artifact publishing (the workspace root). */
  cwd: string;
  /**
   * Byte destination for user-facing artifacts (`artifact.file` / `artifact.markdown`). Note:
   * "artifact" here is the **deliverable shown to the user**, not the engine-internal artifact
   * (the top-level `RunSettlement.artifact` return value, which is for the model).
   *
   * **Optional**, same argument as `actorTranscriptStore`: assemblies without a store (pure
   * replay, fake driver, minimal stub) have nowhere to put bytes in the first place. Absence is
   * **not a silent degradation** - content members reject the node with a named
   * `ArtifactStoreUnavailable` (catchable by the script; the node lands in the journal as
   * failed) instead of falling back to workspace writes or publishing an empty artifact.
   * Preset members (chart/table/...) are unaffected: they are declarations and never touch the
   * driver.
   */
  artifactStore?: ToolArtifactStorePort;
  /**
   * The parent session id of this run, **used only for artifact publishing**: store writes are
   * accounted per session scope (`zcode-artifact://<session>/<id>`), and that scope is the
   * parent session.
   *
   * Pair with `artifactStore` (production provides both from the same app session via the run
   * service); giving only one still fails loudly with `ArtifactStoreUnavailable` at publish
   * time, see {@link ArtifactPublishDeps}. Actor session ids do not flow through this field -
   * those are minted by mintActorSessionId.
   */
  parentSessionId?: SessionId;
  /**
   * Approved world.run command set (compile-time literal collection). Lands structurally in
   * {@link WorldReadDeps}: absent means all world.run rejected (fail-closed).
   */
  declaredRunCommands?: ReadonlySet<string>;
  /**
   * Per actor-site submit profiles, derived at compile time by `deriveActorSubmitProfiles` (the
   * run submission path's compileOnce). Optional: absent = every actor generic (the historical
   * behavior), so assemblies without profiles (snippets, fake drivers, existing tests) stay
   * untouched.
   */
  actorSubmitProfiles?: ReadonlyMap<string, ActorSubmitProfile>;
  runtimeFactory: ActorRuntimeFactory;
  /**
   * Narrow port to the process-wide concurrency governor. When present, the driver gives every
   * actor runtime a `ModelRequestAdmission` (passed down through the runtimeFactory input into
   * the runtime deps): every **model-request attempt** in the runner passes the gate first; it
   * also fans this run's cap changes out as `concurrency-changed`. Absent means actors are
   * ungated (fake / pure-replay assemblies unchanged). Invisible to the engine side (v1's
   * `acquireSlot` is gone).
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * This run's seat gate: when the run's **own** concurrency cap is lowered mid-flight, surplus
   * subagents halt before their next turn step. When present the driver does two things - wrap
   * each actor's admission port in the gate, and feed it ask start/stop (startAsk and the
   * engine's `node-settled`; see workflow-driver.ts).
   *
   * Optional: absent means this run's cap never changes mid-flight (e.g. snippet assemblies
   * without dynamic concurrency), and the admission port stays verbatim. **Presence also does
   * not change behavior for runs whose cap was never lowered**: requests above the cap pass
   * through in place; the gate emits nothing and holds no tickets.
   */
  seatGate?: WorkflowRunSeatGate;
  /**
   * Transcript access surface for actor sessions (production: the session store itself). Two
   * consumers share it, and it **must** be the same one: the ask-boundary accounting counts, and
   * the seed-truncation copy (see the module note in workflow-actor-transcript.ts).
   *
   * Optional because assemblies without a session store (pure-replay tests, minimal stub
   * runtimes) have no transcript to count in the first place: when absent, boundary accounting
   * is absent wholesale, at the cost that **this run can no longer serve as a revision
   * predecessor** (the service-side "no marker predecessor: reject wholesale" gate blocks it),
   * rather than producing a wrong boundary. Seeded session creation fails loudly when absent -
   * the engine has already decided to continue a transcript based on the import facts, so no
   * access surface there is a wiring error.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
  /**
   * This run's id. Actor session ids are scoped by it - a scheme without runId lets the same
   * site x ordinal actor across two concurrent runs collide onto one session id
   * (`createSessionId("wf-actor-" + refToString(actor))` was exactly that bug). The default
   * "run" exists only to keep existing test assemblies unbroken.
   */
  runId?: string;
  /**
   * Clock and timers: the run-level stall clock, transient-failure backoff re-drives, and the
   * bounded wait for session quiescence all use it. Supports an injected clock; `stallAfterMs`
   * defaults to 20 minutes; `quiesceMs` defaults to {@link AMEND_TRANSCRIPT_QUIESCE_MS};
   * `random` feeds backoff jitter.
   */
  clock?: WorkflowClock & {
    stallAfterMs?: number;
    quiesceMs?: number;
    random?: () => number;
  };
  /**
   * Hands over this driver's **session quiescence probe**
   * (workflow-driver-quiescence.ts). Called exactly once at construction; the caller attaches
   * the probe to its own run's registry entry - amend continuation consults it before in-flight
   * asks.
   *
   * A callback rather than having `createAgentRuntimeWorkflowDriver` return a pair: the driver
   * instance is only built by the **engine** at `makeDriver(sink)` time, so the assembly never
   * sees that return value. Absent means the caller does not care about quiescence (e.g. paths
   * using the harness directly).
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 * Per-actor-session run state. Per-actor FIFO (guaranteed by the engine) means at most one
 * in-flight ask per session, so currentInstance / pendingSubmit / accepted / cancelled all mean
 * "current instance" and need no per-instance splitting.
 */
export interface SessionState {
  readonly ref: SessionRef;
  /** Same value as `ref.id`, keeping the branded type (the transcript access surface queries by SessionId). */
  readonly sessionId: SessionId;
  readonly runtime: AgentRuntime;
  /**
   * The submit_result flavor actually registered for this session. Taken from the static profile
   * at creation; the **only** path that changes it is the runtime guard
   * (ensureSubmitProfileFits in workflow-driver.ts): a mono declaration mismatching the actual
   * ask schema downgrades to generic, never back up.
   */
  submitProfile: ActorSubmitProfile;
  /** Instance of the current in-flight ask; set by startAsk. */
  currentInstance?: InstanceRef;
  /** Whether the current ask is typed (untyped bypasses the submit bridge). */
  currentTyped: boolean;
  /** Verdict deferred the submit_result handler blocks on; at most one (single front instance). */
  pendingSubmit?: Deferred<ContractsSubmitVerdict>;
  /**
   * Parked escalation Q&As, keyed by qid. Unlike pendingSubmit these **must be plural**: within
   * one round the model may issue several escalate tool calls in parallel, each an independent
   * Q&A (bounded by escalationsUsed).
   */
  readonly pendingEscalations: Map<string, Deferred<string>>;
  /**
   * Escalations consumed by this ask (short-capped ones not counted - see makeEscalatePort).
   * Per-ask counter, reset by startAsk; nudge rounds do **not** reset it (a nudge is still the
   * same ask).
   */
  escalationsUsed: number;
  /** Turn cancellation controller for the current ask; rebuilt per ask by startAsk. */
  abortController?: AbortController;
  /** The engine accepted the current ask: its turn resolve no longer reports askTurnEnded (settled by the engine). */
  accepted: boolean;
  /** The engine cancelled the current ask: turn rejection no longer reports askFailed (already settled failed/cancelled). */
  cancelled: boolean;
  /**
   * Turn generations started on this session. Single purpose: tell whether the engine started
   * **another round** after `askTurnEnded` (the nudge path), i.e. whether this ask's exchange
   * truly ended - boundary accounting wants the end of the whole exchange, not of an arbitrary
   * turn.
   */
  turnGeneration: number;
  /**
   * Finalization chain of the in-flight turn (executeTurn plus onTurnResolved / onTurnRejected).
   * Single reader: dispose waits for it to land before closing the runtime - the accept path's
   * askStats arrives after settle (the turn resolves after submit), and closing synchronously
   * would race that tail.
   */
  turn?: Promise<void>;
  /**
   * Model-activity surface for this actor: admission port + session-event observation (the
   * source of the waiting / executing badges).
   */
  modelActivity: ActorModelActivity;
  /** This session's actor identity (ProviderStop details name the subagent that triggered the stop). */
  readonly actor: ActorRef;
  readonly actorName: string | undefined;
  /**
   * Driver-side transient re-drive count within the current ask: transient failures surfaced by
   * the runner (stream-recovery budget exhausted etc.) do not settle the node; another round
   * starts after the backoff curve. Reset by startAsk.
   */
  transientAttempts: number;
  /** Redrive alarm while backing off; torn down by cancelAsk / dispose. */
  cancelRedrive?: () => void;
}
