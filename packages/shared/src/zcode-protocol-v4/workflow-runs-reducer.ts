// ============================================================
// Pure workflowRuns reduction: one dwf progress event -> new workflowRuns state
// ============================================================
// Lives next to workflow-runs.ts (the state schema): two halves of one vocabulary. The schema
// says what the state looks like; this says how events advance it one step. The reduction must
// have a single implementation: if it grew inside bootstrap's v4 product projection while the
// TUI needed the same state...
// Extracted to enforce the single-clock principle (workflow-runs.ts): projection and TUI mirror
// may not each own a reduction.
//
// This module is pure: no Date.now, no randomness, no I/O. The impure parts of the projection
// (identity gates, recordDynamicWorkflowRunProgress wiring, cold-hydration classification,
// state.updated emission) stay in bootstrap.
//
// Dependency direction: contracts -> shared, so the input event type is structurally defined
// here instead of importing contracts' DynamicWorkflowRunProgressPayload; bootstrap assigns the
// contracts payload to WorkflowRunProgressEnvelope, and that assignment is the compile-time gate
// keeping both shapes from drifting.
//
// Three structural facts from engine Boundary C, worth knowing before reading; otherwise several
// spots below look like fallbacks:
//   1. Node phases are the events the engine actually emits:
//      queued/dispatched/executing/waiting/repairing/nudged/settled. executing/waiting are driver
//      observations: request really sent / waiting on a process-level slot or backoff; the two
//      flip back and forth after dispatched.
//   2. A resume hit on settle short-circuits straight to node-settled, never node-queued (ask:
//      releaseCachedAsk/tryImportedSettle in scheduler.ts; world-read: replay and import hits in
//      engine-world.ts). The ask resend carries birth facts
//      (kind/actor/actorSeq/instructionsHead); world-read and older-journal rows do not, hence
//      node.kind and the actor ref being optional by design, not omitted by accident.
//   3. Run-level usage (docs/dynamic-workflow/authoring.md): usage-updated carries the spent token
//      total directly; nodesUsed counts an instance's first phase transition on node-dispatched
//      (replays of the same instance never double count). No cap allows back-computation, and
//      none is needed.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunPendingQuestion,
  type WorkflowRunReport,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

import { serializeWorkflowArtifact } from "./workflow-artifact.js";
import { actorsWithTranscriptSession } from "./workflow-runs-actor-session.js";
import { withDerivedWorkflowActorStatuses } from "./workflow-runs-actor-status.js";
import {
  countTaggedReport,
  upsertBoundedByArtifactId,
  workflowArtifactSummary,
} from "./workflow-runs-artifacts.js";
import {
  countUnlistedInstance,
  discountUnlistedInstance,
  evictForEntryBudget,
} from "./workflow-runs-caps.js";
import {
  absorbRefusedActor,
  absorbRefusedSettledNode,
  admitsNewEntry,
  seatWorkflowNode,
  withRoomForActor,
  type WorkflowRunEntryLimits,
} from "./workflow-runs-eviction.js";
import {
  reduceConcurrencyChanged,
  reduceRunCapsChanged,
  withoutCooldown,
} from "./workflow-runs-concurrency.js";
import {
  boundedActorName,
  boundedPhaseName,
  nonEmptyString,
  workflowActorEntry,
  workflowInstanceRef,
} from "./workflow-runs-entries.js";
import { canonicalWorkflowRun, workflowRunUnchanged } from "./workflow-runs-delta.js";
import { readRunIdField, readWorkflowRunStopReason } from "./workflow-runs-lineage.js";
import { carryNodeProgress, reduceNodeProgress } from "./workflow-runs-node-progress.js";
import { reduceHoleFilled, reduceHoleReached, withoutWaitingHoles } from "./workflow-runs-holes.js";
import { reducePhaseEntered, reduceRunLaunched } from "./workflow-runs-phases.js";
import { reduceRunStarted } from "./workflow-runs-started.js";
import { upsertBoundedByInstance, upsertBoundedByQid } from "./workflow-runs-tables.js";

/**
 * Node event -> phase. Not eventType.slice("node-".length) (the name happens to equal the phase):
 * an explicit table shows every node event and its phase at a glance, so future events do not
 * gamble on string slicing.
 */
const NODE_EVENT_PHASE: Readonly<Record<string, WorkflowRunNode["phase"]>> = {
  "node-queued": "queued",
  "node-dispatched": "dispatched",
  "node-executing": "executing",
  "node-waiting": "waiting",
  "node-repairing": "repairing",
  "node-nudged": "nudged",
  "node-settled": "settled",
};

/**
 * Structured input for one workflow run progress event. Shape matches contracts'
 * DynamicWorkflowRunProgressPayload, but every field is optional here: no schema validation in
 * this module; partial input reduces as far as it can (missing runId/eventType invalidates the
 * whole event).
 *
 * actorSessionId is a derived field the run service attaches outside the payload (see
 * toProgressPayload in dynamic-workflow-run-launch.ts): the deterministically minted actor session
 * id. Not an engine-observable fact, but without it downstream would have to reinvent the
 * contract.
 */
export interface WorkflowRunProgressEnvelope {
  runId?: string;
  toolCallId?: string;
  sequence?: number;
  eventType?: string;
  payload?: Record<string, unknown>;
  actorSessionId?: string;
}

/**
 * Reduces one progress event into the workflowRuns state key.
 *
 * Returns null on no semantic change: an invalid event (missing runId/eventType) or a replay that
 * is byte-identical. Callers skip state.updated/UI refresh accordingly; revision rises only on
 * real change (idempotent replays never bump it).
 *
 * Missing previous equals the empty state { revision: 0, runs: [] }. limits is a test-only
 * injection point defaulting to {@link WORKFLOW_RUNS_LIMITS} (no second production bound).
 */
export function reduceWorkflowRunsState(
  previous: WorkflowRunsState | undefined,
  envelope: WorkflowRunProgressEnvelope,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunsState | null {
  const runId = envelope.runId;
  if (!runId || typeof envelope.eventType !== "string") return null;
  const sequence = typeof envelope.sequence === "number" ? envelope.sequence : 0;
  const payload = isPlainRecord(envelope.payload) ? envelope.payload : {};

  const prior: WorkflowRunsState = previous ?? { revision: 0, runs: [] };
  const existing = prior.runs.find((run) => run.runId === runId);
  const base: WorkflowRunState = existing ?? {
    runId,
    ...(envelope.toolCallId ? { toolCallId: envelope.toolCallId } : {}),
    status: "pending",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: sequence,
  };

  // Canonical key order (workflow-runs-delta.ts): the reducer advances via {...run, newKey: v},
  // so newly appearing optional keys append in arrival order, and the delta consumer has no such
  // history. Both sides re-sort to schema order once, so
  // JSON.stringify(apply(prior, diff(prior, next))) === JSON.stringify(next) holds byte-for-byte.
  const next = canonicalWorkflowRun(
    applyWorkflowRunEvent(base, envelope.eventType, payload, {
      ...(envelope.actorSessionId === undefined ? {} : { actorSessionId: envelope.actorSessionId }),
      ...(envelope.toolCallId === undefined ? {} : { toolCallId: envelope.toolCallId }),
      // Monotonic: late/replayed events never pull the watermark back.
      sequence: Math.max(base.lastEventSequence, sequence),
      // Rejected-instance counters are additive with no deduplicable identity, so only events
      // beyond the watermark count (see workflow-runs-caps.ts). The watermark is the value before
      // this event.
      advancesWaterMark: sequence > base.lastEventSequence,
      limits,
    }),
  );

  // Idempotence: no semantic change, no delta (a replay never bumps revision). The test is
  // structural equality, not JSON.stringify of the whole run: that serializes the entire table per
  // event (the O(N) bytes this rework removes) and misreads key-order-only differences as
  // changes. Same predicate as diff's did-this-key-change.
  if (existing !== undefined && workflowRunUnchanged(existing, next)) return null;

  const runs = existing
    ? prior.runs.map((run) => (run.runId === runId ? next : run))
    : [...prior.runs, next];
  // Last ~8, oldest evicted first. A terminal run's full facts remain in the journal (the detail
  // page reads them via the event-log query). These two cross-run bounds are hard constants, not
  // the limits injection point: that exists to shrink one run's tables; run count and entry
  // budgets are unrelated to those injected rules.
  const bounded =
    runs.length > WORKFLOW_RUNS_LIMITS.maxRuns
      ? runs.slice(runs.length - WORKFLOW_RUNS_LIMITS.maxRuns)
      : runs;
  // The entry budget applies after the run-count bound: 8 maxed-out runs come too close to the
  // snapshot cap (workflow-runs-caps.ts).
  return { revision: prior.revision + 1, runs: evictForEntryBudget(bounded, runId) };
}

function applyWorkflowRunEvent(
  base: WorkflowRunState,
  eventType: string,
  payload: Record<string, unknown>,
  derived: {
    actorSessionId?: string;
    toolCallId?: string;
    sequence: number;
    advancesWaterMark: boolean;
    limits: WorkflowRunEntryLimits;
  },
): WorkflowRunState {
  const run: WorkflowRunState = {
    ...base,
    ...(derived.toolCallId && !base.toolCallId ? { toolCallId: derived.toolCallId } : {}),
    lastEventSequence: derived.sequence,
  };

  switch (eventType) {
    /**
     * run-started: back to running, usage zeroed, last generation's settlement ghosts stripped,
     * and this run's own concurrency bound recorded. Rules in sibling workflow-runs-started.ts
     * (resume re-arm semantics deserve a whole file header).
     */
    case "run-started":
      return reduceRunStarted(run, payload);
    case "actor-created": {
      const ref = workflowInstanceRef(payload.actor);
      if (!ref) return run;
      // Birth phase (addendum 2026-09-09): actor-created is the actor's birth event; the stamp
      // only arrives here and no later event carries or rewrites it.
      const phaseName = boundedPhaseName(nonEmptyString(payload.phaseName));
      const { actorSessionId } = derived;
      const actor = workflowActorEntry(ref, payload.name, phaseName, actorSessionId, payload.model);
      // Make room for this live newcomer on a full table (workflow-runs-eviction.ts); if none
      // frees up, reject as before. Replays neither evict nor seat (seating tightens only on
      // overflowed runs, see admitsNewEntry).
      const seated = derived.advancesWaterMark ? withRoomForActor(run, ref, derived.limits) : run;
      const upserted = upsertBoundedByInstance(seated.actors, actor, derived.limits.maxActors, {
        admitNew: admitsNewEntry(run, derived.advancesWaterMark),
      });
      // Rejected subagents must stay countable: there is no run-level actor counter, so the only
      // trace is the actor's birth-phase bucket.
      const absorbed =
        upserted.truncated && derived.advancesWaterMark
          ? absorbRefusedActor(seated, phaseName, derived.limits)
          : seated;
      return withDerivedWorkflowActorStatuses({
        ...absorbed,
        actors: upserted.list,
        ...(upserted.truncated || seated.truncated ? { truncated: true } : {}),
      });
    }
    case "node-queued":
    case "node-dispatched":
    case "node-executing":
    case "node-waiting":
    case "node-repairing":
    case "node-nudged":
    case "node-settled": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      const phase = NODE_EVENT_PHASE[eventType]!;
      // Two birth events exist (verbatim the same predicate as workflow-runs-caps.ts):
      // node-queued, and the direct node-settled { cached: true } on a replay hit. Overflowed runs
      // accept new keys only from live birth events (see admitsNewEntry): replays and an
      // off-table instance's intermediate phase must not re-seat it, or it is both listed and
      // counted (already in nodesUnlisted).
      const born =
        eventType === "node-queued" || (eventType === "node-settled" && payload.cached === true);
      const actorRef = workflowInstanceRef(payload.actor);
      // node-dispatched carrying birth facts (activation, docs/dynamic-workflow/presentation.md
      // "Reduction"): at dispatch the engine re-sends the same facts its node-queued and the
      // subagent's actor-created once carried, so an off-table instance returns to the table at
      // the moment it is given work, subagent included. Missing actor ref = bare dispatch from an
      // old journal or world-read; handle as before.
      const dispatchActor =
        eventType === "node-dispatched" && actorRef !== null
          ? workflowActorEntry(
              actorRef,
              payload.actorName,
              boundedPhaseName(nonEmptyString(payload.actorPhaseName)),
              derived.actorSessionId,
              payload.actorModel,
            )
          : null;
      // Single entry point for eviction, the B2 rejection, and activation
      // (workflow-runs-eviction.ts).
      const seating = seatWorkflowNode(
        run,
        {
          eventType,
          ref,
          actorRef,
          actor: dispatchActor,
          born,
          advancesWaterMark: derived.advancesWaterMark,
        },
        derived.limits,
      );
      const seated = seating.run;
      const previousNode = seated.nodes.find(
        (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
      );
      const kind =
        payload.kind === "ask" || payload.kind === "world-read" ? payload.kind : previousNode?.kind;
      // Birth phase name: the engine stamps it only on birth events, node-queued and the direct
      // node-settled { cached: true } on a replay hit (that node has no queued; it is the birth).
      // Other node-* events carry it forward, same precedent as kind/actorSiteId above.
      const phaseName =
        boundedPhaseName(nonEmptyString(payload.phaseName)) ?? previousNode?.phaseName;
      const node: WorkflowRunNode = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        ...(kind === undefined ? {} : { kind }),
        phase,
        ...(payload.outcome === "ok" ||
        payload.outcome === "failed" ||
        payload.outcome === "cancelled"
          ? { outcome: payload.outcome }
          : {}),
        ...(payload.cached === true ? { cached: true } : {}),
        ...(actorRef
          ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal }
          : previousNode?.actorSiteId !== undefined
            ? { actorSiteId: previousNode.actorSiteId, actorOrdinal: previousNode.actorOrdinal }
            : {}),
        ...(phaseName === undefined ? {} : { phaseName }),
        // Task summary and progress readouts: node-queued takes the payload, other events carry
        // forward, birth events clear the previous generation's counters. Rules in sibling
        // workflow-runs-node-progress.ts (which also explains the explicit carrying).
        ...carryNodeProgress(eventType, payload, previousNode),
      };
      const upsertedNodes = upsertBoundedByInstance(seated.nodes, node, derived.limits.maxNodes, {
        admitNew: seating.admitNew,
      });
      // Steps: an instance counts one step on its FIRST dispatch. A replay of the same
      // node-dispatched finds previousNode already past dispatched and does not recount; the
      // reduction must stay idempotent (the top level judges no-change structurally).
      // An instance rejected at the cap has no previousNode and still counts: steps are run-level
      // fact, not bound by display limits. That same missing previousNode defeats the phase dedup,
      // so replaying that dispatched pushes the count ever higher (caught by a property test). On
      // overflowed runs this counter therefore follows the nodesUnlisted rule: only events beyond
      // the watermark. Below the cap every instance has its own row, phase dedup suffices, and
      // not a byte needs to change.
      const firstDispatch =
        eventType === "node-dispatched" &&
        admitsNewEntry(run, derived.advancesWaterMark) &&
        (previousNode === undefined || previousNode.phase === "queued");
      // An instance returning to the table is subtracted from nodesUnlisted first, or being both
      // listed and counted adds a phantom step.
      const restored = seating.activated ? discountUnlistedInstance(seated.usage) : seated.usage;
      // The rejected-instance counter pair (workflow-runs-caps.ts): upsertedNodes.truncated means
      // exactly that this instance failed to enter the table; the run-level truncated flag is
      // computed separately below. Never conflate the two.
      const usage = countUnlistedInstance(
        firstDispatch ? { ...restored, nodesUsed: restored.nodesUsed + 1 } : restored,
        {
          rejected: upsertedNodes.truncated,
          advancesWaterMark: derived.advancesWaterMark,
          eventType,
          cached: payload.cached === true,
        },
      );
      // A rejected born-settled instance: the run-level counters are recorded above; here record
      // its birth-phase bucket and, per the orphan rule, drop the actor that cannot carry into its
      // own node (workflow-runs-eviction.ts).
      const absorbed =
        upsertedNodes.truncated && derived.advancesWaterMark && born && phase === "settled"
          ? absorbRefusedSettledNode(seated, node, derived.limits)
          : seated;
      return withDerivedWorkflowActorStatuses({
        ...absorbed,
        // Which session holds the transcript (workflow-runs-actor-session.ts): cache-hit settles
        // and dispatches each state it once.
        actors: actorsWithTranscriptSession(
          absorbed.actors,
          eventType,
          payload,
          actorRef,
          derived.actorSessionId,
        ),
        ...(usage === seated.usage ? {} : { usage }),
        nodes: upsertedNodes.list,
        ...(upsertedNodes.truncated || seated.truncated ? { truncated: true } : {}),
      });
    }
    /**
     * node-progress: one ask turn resolved (the driver emits one per resolved turn).
     *
     * Not a lifecycle event: no phase, no step, no actor state; it writes three readouts onto the
     * node. Hence deliberately outside the case group above and absent from NODE_EVENT_PHASE.
     * Rules in workflow-runs-node-progress.ts.
     */
    case "node-progress": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      return reduceNodeProgress(run, ref, payload);
    }
    /**
     * report: one incremental artifact handed over by the script's report(item) (feeds the detail
     * page's Results section).
     *
     * Deliberately never touches nodes[]: reports have no node-queued/node-settled lifecycle, and
     * counting them inflates step counts for chatty workflows (the compact card and task list read
     * settled/observed from nodes) and drags an order-less entry into the state overlay. Same for
     * actor state: a report is no evidence that an actor is moving.
     */
    case "report": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      // Second arg of report(item, artifactId): which preset board this entry feeds. Absent =
      // plain report; the counting branch below is skipped entirely.
      const artifactId = nonEmptyString(payload.artifactId);
      const report: WorkflowRunReport = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        preview: workflowReportPreview(payload.item),
        ...(artifactId === undefined ? {} : { artifactId }),
      };
      const existingReports = run.reports ?? [];
      // The counting dedup key is the reports table's own: (siteId, ordinal). Judge before the
      // upsert, or every entry reads as already-present afterwards. See countTaggedReport below
      // for why this check goes wrong past the cap, and why that direction of wrongness is safe.
      const firstSighting = !existingReports.some(
        (item) => item.siteId === ref.siteId && item.ordinal === ref.ordinal,
      );
      // Upsert by (siteId, ordinal): on script replay every report call re-runs (the engine
      // silently skips the already-recorded one by the same key), so one instance must land as one
      // row, not two. Cap semantics match actors/nodes: reject new entries, keep updating existing
      // ones; beyond-cap facts remain in the journal.
      const upserted = upsertBoundedByInstance(
        existingReports,
        report,
        WORKFLOW_RUNS_LIMITS.maxReports,
      );
      // Tagged entries still enter reports: one channel, one cap. Tagging adds a destination, it
      // does not reroute.
      const counted =
        artifactId !== undefined && firstSighting
          ? countTaggedReport(run.artifacts, artifactId)
          : run.artifacts;
      return {
        ...run,
        reports: upserted.list,
        ...(counted === undefined ? {} : { artifacts: counted }),
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-published: the script published a user-facing artifact version via artifact.*, or
     * declared a preset board. Successful content-member publishes and preset-member declarations
     * both land here; cache hits do not re-emit (same as report).
     *
     * Terminology: the artifact here is the user-visible deliverable. The script top-level return
     * value behind resultPreview is also called artifact inside the engine, but that one is for
     * the model; the two are unrelated. See workflow-artifacts.ts.
     *
     * Like report, never touches nodes[] or actor state: artifact sites live in no graph and have
     * no node lifecycle (not even node-settled, precisely so no untracked node grows on the side
     * panel). No step count either: delivering an artifact is not an extra step.
     *
     * Dedup key is the artifact id, not the site instance: re-publishing an id is a new version,
     * and a new version must overwrite the same card, not grow a second one. Different family from
     * the three (siteId, ordinal)-keyed tables nodes/actors/reports: two versions of one id come
     * from two different site instances, and instance-keyed dedup would yield two cards.
     */
    case "artifact-published": {
      const summary = workflowArtifactSummary(payload.artifact);
      if (summary === undefined) return run;
      const upserted = upsertBoundedByArtifactId(
        run.artifacts ?? [],
        summary,
        WORKFLOW_RUNS_LIMITS.maxArtifacts,
      );
      return {
        ...run,
        artifacts: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-failed: a content publish was rejected (missing file / out of bounds / over cap /
     * store absent).
     *
     * Deliberately changes no state. A failed publish claims no id, no kind, no version (only
     * completed rows claim those; otherwise the live path would claim what the resume path cannot:
     * two ledgers). Nothing to upsert here: a failure card for a never-existing artifact shows the
     * user a deliverable that does not exist, while the script has likely caught the error, had
     * the subagent rewrite, and republished successfully.
     *
     * This event's reader is the event log (the detail page's audit view pages the journal
     * directly, not through this reduction). Explicit cases instead of a default make
     * no-state-change a visible ruling, not a forgotten branch.
     */
    case "artifact-failed":
      return run;
    case "usage-updated": {
      // The event carries the spent total directly (the engine writes dwf_run.spent_tokens one
      // line before emit); absent keeps the known value.
      if (typeof payload.spentTokens !== "number") return run;
      return { ...run, usage: { ...run.usage, spentTokens: payload.spentTokens } };
    }
    /**
     * escalation: an actor escalates a blocking question to the main agent and waits inside its
     * own ask.
     *
     * Like report, never touches nodes[] or actor state: escalations have no node lifecycle and no
     * step count (waiting is not work; same doctrine as the report exemption). Nor may the asking
     * actor flip to idle: its ask is still dispatched, state stays derived from node phases, and
     * this event changes none of that.
     *
     * Dedup key is qid, not a site instance: escalations have no site identity. upsert (not push)
     * makes replays idempotent: the same raised event twice yields a byte-identical table, and the
     * top-level JSON compare returns null.
     */
    case "escalation-raised": {
      const qid = nonEmptyString(payload.qid);
      const question = nonEmptyString(payload.question);
      // qid is the identity and question the entire reason this record exists; missing either is
      // unrenderable, so only the watermark moves.
      if (qid === undefined || question === undefined) return run;
      // An unreadable actor ref must not drop the record: identity is the qid, the actor is an
      // attribute. Hiding a question over a broken ref destroys the one fallback value, blocked
      // questions stay visible (the renderer carries its own fallback label).
      const actorRef = workflowInstanceRef(payload.actor);
      const actorName = boundedActorName(nonEmptyString(payload.actorName));
      const context = nonEmptyString(payload.context);
      // Asked-at can only ride on the event: this module is clockless (purity compact in the file
      // header). Required event-side, but old-journal replays may lack it; when absent the whole
      // field is omitted and the renderer hides the waiting duration.
      const askedAt =
        typeof payload.askedAt === "number" && Number.isFinite(payload.askedAt)
          ? payload.askedAt
          : undefined;
      const pending: WorkflowRunPendingQuestion = {
        qid,
        ...(actorRef ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal } : {}),
        ...(actorName === undefined ? {} : { actorName }),
        question: boundedQuestionText(question),
        ...(context === undefined ? {} : { context: boundedQuestionText(context) }),
        ...(askedAt === undefined ? {} : { askedAt }),
      };
      const upserted = upsertBoundedByQid(
        run.pendingQuestions ?? [],
        pending,
        WORKFLOW_RUNS_LIMITS.maxPendingQuestions,
      );
      return {
        ...run,
        pendingQuestions: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * The main agent answered: that actor's turn continues in place and the question is no longer
     * owed.
     *
     * The answer itself never enters the projection: it lives in the actor turn's transcript as
     * the escalate tool result (cache hits replay the turn byte-for-byte). Here the question only
     * leaves the owed table. The event-log row keeps the verbatim answer; that is the audit view,
     * distinct from the live who-is-still-owed fact.
     */
    case "escalation-resolved": {
      const qid = nonEmptyString(payload.qid);
      if (qid === undefined) return run;
      return withoutPendingQuestions(run, (pending) => pending.qid !== qid);
    }

    /**
     * concurrency-changed: the process-level governor changed the cap for this run's provider key.
     * No nodes[]/actor state: the cap is a gate, not any node's business. Rules in
     * workflow-runs-concurrency.ts.
     */
    case "concurrency-changed":
      return reduceConcurrencyChanged(run, payload);

    /**
     * run-caps-changed: the run's own concurrency bound changed in flight (a max_concurrency-only
     * revision applies in place, neither stopping the run nor starting another;
     * docs/dynamic-workflow/concurrency.md). The payload matches run-started and the rule is the
     * same one, so both live in workflow-runs-concurrency.ts. Also no nodes[]/actor state: a bound
     * is a gate, not any node's business.
     */
    case "run-caps-changed":
      return reduceRunCapsChanged(run, payload);

    /** phase-entered / run-launched: the phase reduction lives in sibling workflow-runs-phases.ts (which only relays declared phase tables). */
    case "phase-entered":
      return reducePhaseEntered(run, payload);
    case "run-launched":
      return reduceRunLaunched(run, payload);

    /**
     * hole-reached / hole-filled: a timeline hole's stall and fill
     * (docs/dynamic-workflow/presentation.md "Holes on the timeline"). No nodes/actors: holes have
     * no node rows; rules in sibling workflow-runs-holes.ts.
     */
    case "hole-reached":
      return reduceHoleReached(run, payload);
    case "hole-filled":
      return reduceHoleFilled(run, payload);

    case "run-settled": {
      const status = payload.status;
      const error = isPlainRecord(payload.error) ? payload.error : undefined;
      const message = typeof error?.message === "string" ? error.message : undefined;
      // Terminal states clear stalled questions: the truth is an in-process pending deferred, and
      // a terminal run by definition has no one listening (cancel already made cancelAsk reject
      // them; a dead process takes the whole registry with it, so resolved never comes). Keeping
      // them puts an unanswerable question on the sidebar, worse than hiding it because it reads
      // as someone still waiting. Cleared on every terminal, completed included: a finished run
      // with pending entries is just a ghost with no continuation.
      // Cooldown is until-when-are-new-dispatches-frozen; a terminal run dispatches nothing, so
      // keeping it shows an objectless countdown in the status header. cap/ceiling stay: they are
      // the historical fact of what concurrency this run ran under.
      // Stalled holes share the stalled questions' fate: an in-process deferred truth and nobody
      // waiting on a terminal run; already-filled ones stay.
      const cleared = withoutWaitingHoles(
        withoutCooldown(withoutPendingQuestions(run, () => false)),
      );
      // The actor trichotomy's waiting/completed split depends on run terminality, so terminals
      // rederive it: an actor created but never asked flips from waiting to completed the moment
      // the run ends.
      // Three terminal words; stopReason rides only on stopped,
      // and the successor pointer only on superseded (the card links replaced-by-run-X from it).
      const carriedStopReason =
        status === "stopped" ? readWorkflowRunStopReason(payload.stopReason) : undefined;
      const supersededBy =
        carriedStopReason === "superseded" ? readRunIdField(payload.supersededBy) : undefined;
      // Older journals wrote the legacy words cancelled/failed into run-settled status. This used
      // to ignore any word outside the closed set, so cold replays left a long-stopped run on
      // running: lit card, enabled Cancel, nothing to cancel. Once a settle arrives the run must
      // not stay alive: unknown words terminal as errored (unrecoverable, no Resume), copy
      // preserved, naming the word when absent. CLI cold replay now mints settles per row
      // (dynamic-workflow-run-replay.ts); this is the live second gate.
      const terminal = status === "completed" || status === "errored" || status === "stopped";
      const settledMessage = terminal
        ? message
        : (message ?? `run settled with an unrecognized status: ${String(status)}`);
      return withDerivedWorkflowActorStatuses({
        ...cleared,
        status: terminal ? status : "errored",
        ...(carriedStopReason === undefined ? {} : { stopReason: carriedStopReason }),
        ...(supersededBy === undefined ? {} : { supersededBy }),
        ...(settledMessage === undefined
          ? {}
          : { error: settledMessage.slice(0, WORKFLOW_RUNS_LIMITS.maxErrorLength) }),
        // Resumability is adjudicated CLI-side on the payload (same predicate as the resume
        // gate); relayed as-is, present only when true.
        ...(payload.resumable === true ? { resumable: true as const } : {}),
      });
    }
    // log/compaction are not steps and have no site id: watermark only (event log, never the graph).
    default:
      return run;
  }
}

/**
 * Keeps stalled questions matching the predicate and drops the whole key once none remain
 * (never an empty array).
 *
 * Zero-entries-means-key-absent is the field's protocol contract (see the schema comment); the
 * sidebar skips the whole section on it. It is also the idempotence pivot: resolving a qid no
 * longer in the table yields a byte-identical run, the top-level JSON compare returns null, no
 * revision bump, no refresh.
 */
function withoutPendingQuestions(
  run: WorkflowRunState,
  keep: (pending: WorkflowRunPendingQuestion) => boolean,
): WorkflowRunState {
  const current = run.pendingQuestions;
  if (current === undefined) return run;
  const remaining = current.filter(keep);
  if (remaining.length === current.length) return run;
  if (remaining.length > 0) return { ...run, pendingQuestions: remaining };
  const { pendingQuestions: _emptied, ...withoutKey } = run;
  return withoutKey;
}

/** Display cap for question/note text. The ellipsis makes truncation visible; same idiom as the report preview. */
function boundedQuestionText(text: string): string {
  const limit = WORKFLOW_RUNS_LIMITS.maxQuestionLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Display preview for one report entry.
 *
 * Serialization is shared with the run-artifact projection (serializeWorkflowArtifact: strings
 * verbatim, else pretty JSON; originally in contracts, moved here with this reduction, re-exported
 * there): the same value appears both in the completion notice's reports block and the detail
 * page's Results section, and any mismatch is a bug. Computed reduction-side, not renderer-side:
 * the preview is a bounded protocol field, and copying the serialization contract into the UI
 * would eventually drift from the notice/TaskOutput text.
 */
function workflowReportPreview(item: unknown): string {
  // The payload already passed boundDynamicWorkflowRunEventPayload (strings 2048 / depth 6 /
  // 32 keys), so overflow here comes only from wide objects growing under pretty JSON. The
  // ellipsis makes truncation visible in the UI, so no per-entry protocol field is needed
  // (run-level truncated means some entry never entered; a different thing).
  const text = serializeWorkflowArtifact(item) ?? "";
  const limit = WORKFLOW_RUNS_LIMITS.maxReportPreviewLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
