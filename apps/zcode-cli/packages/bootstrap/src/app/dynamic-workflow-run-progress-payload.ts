// ============================================================
// RunEvent -> session event payload (bounding + derived fields)
// ============================================================
// Split from dynamic-workflow-run-launch.ts (max-lines gate): the launcher emits events, cold replay mints payloads; both roads pass
// through this one function, so payloads are byte-identical on both sides (apps/zcode-cli/packages/dynamic-workflow/docs/
// execution-engine.md, "Events"). Pure function: no journal, no runtime.

import {
  boundDynamicWorkflowRunEventPayload,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunProgressPayload,
} from "@zcode/contracts";
import type { ActorRef, RunEvent } from "@zcode/dynamic-workflow";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import { mintActorSessionId } from "./workflow-driver.js";

/**
 // * RunEvent -> protocol-event mapping (THIS COMMENT IS THE CONTRACT): type is the event discriminant, payload the same
 event object minus type, bounded via {@link boundDynamicWorkflowRunEventPayload}.
 // * Field names deliberately unreshaped -- the reader (detail page event log) interprets payload per event kind, and the engine's vocabulary is that schema.
 *
 * Kinds the engine actually emits: run-started / actor-created / node-queued / node-dispatched /
 * node-repairing / node-nudged / node-settled / usage-updated / log / report / phase-entered /
 * run-settled。
 // * (executing is not an observable event; compaction is never emitted in v1.) Two more are emitted by the DRIVER
 // * over the same two tracks: escalation-raised / escalation-resolved (workflow-driver.ts's escalation bridge).
 *
 * Adding a kind is zero-change HERE — that's what "don't reshape field names" buys: type from the
 * discriminant, payload the rest, no per-kind branch to miss. But downstream DOES have a per-kind
 * switch: zcode-protocol-v4/product-projection.ts's applyWorkflowRunEvent reduces per kind with an
 * eventType param typed `string`, not RunEvent["type"] — a missed branch is tsc-silent. When adding
 * kinds, read that switch; don't trust the compiler.
 */
export function toProtocolEvent(sequence: number, event: RunEvent): DynamicWorkflowRunEvent {
  const { type, ...rest } = event;
  const { payload, truncated } = boundDynamicWorkflowRunEventPayload(
    rest as Record<string, unknown>,
  );
  return { sequence, type, payload, ...(truncated ? { truncated } : {}) };
}

/**
 * RunEvent -> session event payload. `payload` shares one serialization with {@link toProtocolEvent};
 * derived fields live outside the payload, preserving the engine event verbatim.
 *
 // * Derived fields live OUTSIDE the payload on purpose: the payload must stay "what the engine emitted" verbatim, or the event log
 * displays our own processing. Each alone is not an observable fact, but without them downstream would re-create a contract:
 *
 // *   - actorSessionId: Boundary C events carry no session id (the driver mints it). Having the
 // *     renderer compose it from (runId, actorRef) copies the sanitize contract into the UI layer; call
 // *     the SAME minting function here and the two sides cannot drift (test-pinned equal). EVERY event naming a subagent gets it
 // *     (see {@link actorSessionRefOf}): actor-created, plus the repeat-birth-fact ask node-dispatched
 // *     and cache-hit node-settled -- the read side pulls a dispatching instance plus its subagent into the bounded
 // *     table, and points the subagent's sessionId back at this run's session via these two; that id can come only from here.
 // *   (A second derived field once existed, spentTokens: legacy budget-updated carried only the remainder. usage-updated
 // *   now carries the spent total itself, produced in the same synchronous step as dwf_run.spent_tokens; derivation retired.)
 */
export function toProgressPayload(input: {
  event: RunEvent;
  runId: string;
  sequence: number;
  toolCallId?: string;
  /** The run's anchor inputId; derived only on actor-created / run-settled (the two subagent-attribution moments). */
  launchInputId?: string;
  /** The amended run's predecessor; derived only on run-started (the card's "tuned from run X"). */
  resumedFrom?: string;
  /**
   //   * The process default concurrency D at payload-minting time (key predates the "default concurrency" concept, kept for old clients); derived on
   //   * run-started and run-caps-changed (docs/dynamic-workflow/concurrency.md
   * 「Two bounds on a run」）。
   *
   //   * Engine events carry only its own caps.maxConcurrency; "is this number worth displaying" compares against the default --
   //   * a host fact (machine cores) the engine neither sees nor should. The projection records this run's own bound when caps.maxConcurrency !=
   //   * concurrencyCeiling (higher or lower), and the UI concurrency chip takes
   //   * min(shared cap, run bound).
   *
   //   * An in-place retune's run-caps-changed carries the NEW caps; same criterion: != default writes the bound,
   bound, == default clears it (lift this run own bound). Both events must therefore get the same default: this one.
   */
  concurrencyCeiling?: number;
  /**
   //   * This run's subagent model (canonical picker string); derived on run-started, present ONLY if set.
   //   * Unlike concurrencyCeiling it compares against no default:
   //   * the engine does not know the concept at all (the model surface is host-side), so absent = subagents on the session model.
   //   * Cold replay emits the same key from the same run-launched; payloads byte-identical.
   */
  subagentModel?: string;
  /**
   //   * Model bindings the script names (name -> canonical string); used on actor-created (derived model) and ask
   //   * node-dispatched (derived actorModel): when the persona names a model, the subagent's canonical string
   //   * (docs/dynamic-workflow/presentation.md, "Reduction"). Like
   //   * subagentModel: the engine records names only, never resolutions; the mapping is a host fact.
   */
  modelBindings?: Record<string, string>;
  /**
   //   * A hole's type-argument source (site id -> Verdict); derives type on hole-reached only
   //   * (docs/execution-engine.md, "Holes"). Engine events lack it -- types are compile-time facts, the engine knows site ids only;
   //   * readers (notification emitter, timeline type badge) must read it at arrival. Lookup miss = no fill; the UI falls back to the
   //   * payload's holes[].type.
   */
  holeTypeOf?: (siteId: string) => string | undefined;
  /**
   //   * The stamp set when this event persisted (epoch ms); derives reachedAt on hole-reached. Live reads
   //   * timeCreated of the just-appended event from the sequence-capture layer; cold replay has StoredEvent.timeCreated
   //   * -- the same number on both sides, payloads byte-identical. Absent (legacy journal without the column) = no fill.
   */
  reachedAt?: number;
}): DynamicWorkflowRunProgressPayload {
  const {
    event,
    runId,
    sequence,
    toolCallId,
    launchInputId,
    resumedFrom,
    concurrencyCeiling,
    subagentModel,
    modelBindings,
    holeTypeOf,
    reachedAt,
  } = input;
  const protocolEvent = toProtocolEvent(sequence, event);
  const actorRef = actorSessionRefOf(event);
  return {
    runId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sequence,
    eventType: protocolEvent.type,
    // run-settled carries one extra bit, resumable:
    // the resume gate's predicate exists only in the CLI; projection and UI carry the bit, never re-derive from status.
    // Predicate = stopped AND NOT superseded; cold replay gives orphan-converged
    // rows the same key -- two roads, one predicate (isResumableSettlement). stopReason/supersededBy pass through on the payload.
    // run-started adds resumedFrom: engine events lack it (the engine reads no lineage), but the card must draw that edge.
    // The same seam adds concurrencyCeiling (= default concurrency): the engine emits its own caps only, and "is this bound
    // the default" compares against the host's (field docs above). Independent of each other; each absent when not derivable.
    // run-caps-changed rides the SAME seam and default: after an in-place retune the read side needs it to decide write-or-clear for the new bound,
    // else the event is two numbers without a scale.
    payload:
      event.type === "run-settled" && isResumableSettlement(event.status, event.stopReason)
        ? { ...protocolEvent.payload, resumable: true }
        : event.type === "run-started"
          ? {
              ...protocolEvent.payload,
              ...(resumedFrom === undefined ? {} : { resumedFrom }),
              ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              ...(subagentModel === undefined ? {} : { subagentModel }),
            }
          : event.type === "run-caps-changed"
            ? {
                ...protocolEvent.payload,
                ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              }
            : event.type === "actor-created"
              ? withActorModel(protocolEvent.payload, "model", event.persona?.model, modelBindings)
              : event.type === "node-dispatched"
                ? withActorModel(
                    protocolEvent.payload,
                    "actorModel",
                    event.actorPersonaModel,
                    modelBindings,
                  )
                : event.type === "hole-reached"
                  ? withHoleFacts(
                      protocolEvent.payload,
                      holeTypeOf?.(event.instance.siteId),
                      reachedAt,
                    )
                  : protocolEvent.payload,
    ...(protocolEvent.truncated ? { truncated: true } : {}),
    ...(actorRef === undefined ? {} : { actorSessionId: mintActorSessionId(runId, actorRef) }),
    // The third derived field (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "Token telemetry for subagents"): the telemetry fact layer only on these two events
    // actor-created registers subagent ownership, run-settled settles the run's subagents.
    ...((event.type === "actor-created" || event.type === "run-settled") &&
    launchInputId !== undefined
      ? { launchInputId }
      : {}),
  };
}

/**
 // * Adds the subagent's canonical model string: actor-created writes model; the repeat-birth ask node-dispatched writes
 // * actorModel (the read side builds the dispatched subagent, model included, from it). Present only when the persona names a model AND this
 // * run's binding table knows it; on miss (only an assertion bypassing 9010 can) no fill -- session creation will say so with a DriverError;
 // * never guess on its behalf.
 */
function withActorModel(
  payload: Record<string, unknown>,
  key: "model" | "actorModel",
  personaModel: string | undefined,
  modelBindings: Record<string, string> | undefined,
): Record<string, unknown> {
  const model = personaModel === undefined ? undefined : modelBindings?.[personaModel];
  return model === undefined ? payload : { ...payload, [key]: model };
}

/**
 // * hole-reached gains two host-derived fields (docs/execution-engine.md, "Holes"; key names pinned by shared's
 // * v4 reducer): type, the hole's type-argument source; reachedAt, the arrival instant. Each absent when not derivable.
 */
function withHoleFacts(
  payload: Record<string, unknown>,
  type: string | undefined,
  reachedAt: number | undefined,
): Record<string, unknown> {
  return {
    ...payload,
    ...(type === undefined ? {} : { type }),
    ...(reachedAt === undefined ? {} : { reachedAt }),
  };
}

/**
 * Names the subagent needing the actorSessionId backfill (that ref); unnamed -> undefined.
 *
 // * Three events: actor-created (the subagent's birth) plus the two repeat-birth-fact ask events carrying actor
 // * (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "Events") -- dispatch, and
 // * cache-hit settlement. When the latter's answer was read from a predecessor the payload carries sourceSessionId and the read side prefers it; this fills
 // * this run's own, so once an answer was produced in-run the read side points here (docs/dynamic-workflow/presentation.md,
 // * "Reduction"). world-read dispatch/settlement carry no actor, no fill -- no transcript to open; a live
 // * settlement is no birth event and carries no actor; no fill either.
 */
function actorSessionRefOf(event: RunEvent): ActorRef | undefined {
  if (event.type === "actor-created") return event.actor;
  if (event.type === "node-dispatched") return event.actor;
  if (event.type === "node-settled" && event.cached === true) return event.actor;
  return undefined;
}
