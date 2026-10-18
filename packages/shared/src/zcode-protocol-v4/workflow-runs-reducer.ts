// ============================================================
// Pure reduction of workflowRuns: one dwf progress event -> the next workflowRuns state
// ============================================================
// Cohabits with workflow-runs.ts (the state schema) because they are two halves of one vocabulary: the schema says what the state looks like,
// this file says how events advance it one step. The reduction must stay single-implementation: if it grew inside bootstrap's v4 product-projection
// while the TUI needs the same state--
// it was extracted to uphold the **single clock** principle (workflow-runs.ts): the projection and the TUI mirror must not each keep a reducer.
//
// This module is pure: no Date.now, no randomness, no I/O. The **impure** parts of the projection (identity gating,
// recordDynamicWorkflowRunProgress wiring, cold-hydration classification, state.updated emission) stay in bootstrap.
//
// Dependency direction: contracts -> shared. So the input event type is **structurally defined** here instead of importing contracts'
// DynamicWorkflowRunProgressPayload; bootstrap assigns contracts' bounded payload to
// WorkflowRunProgressEnvelope -- the assignment itself is the compile-time gate keeping both shapes from drifting.
//
// Three **structural** facts from engine Boundary C are worth knowing before reading, otherwise several spots below look like fallbacks:
//   1. Node phases are the events the engine actually emits: queued/dispatched/executing/waiting/repairing/nudged/settled.
//      `executing` / `waiting` are driver observations:
//      the model request truly went out / is waiting on a process-level slot or backoff; the two alternate after dispatched.
//   2. A resume's completion-hit short-circuit **emits node-settled directly**, skipping node-queued (ask lives in scheduler.ts'
//      releaseCachedAsk / tryImportedSettle; world-read hits in engine-world.ts' replay and import),
//      and `kind` rides only on queued--so node.kind is optional by design, not an omission.
//   3. Run-level usage: `usage-updated` carries the spent-token total directly;
//      `nodesUsed` counts the first phase transition of `node-dispatched` (replays of the same instance do not double count);
//      there is no cap to back-compute from, and none is needed.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunPendingQuestion,
  type WorkflowRunReport,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

import { serializeWorkflowArtifact } from "./workflow-artifact.js";
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
} from "./workflow-runs-entries.js";
import { canonicalWorkflowRun, workflowRunUnchanged } from "./workflow-runs-delta.js";
import { readRunIdField, readWorkflowRunStopReason } from "./workflow-runs-lineage.js";
import { carryNodeProgress, reduceNodeProgress } from "./workflow-runs-node-progress.js";
import { reducePhaseEntered, reduceRunLaunched } from "./workflow-runs-phases.js";
import { reduceRunStarted } from "./workflow-runs-started.js";
import { upsertBoundedByInstance, upsertBoundedByQid } from "./workflow-runs-tables.js";

/**
 * Node event -> phase. Instead of `eventType.slice("node-".length)` (the event name happens to be the phase name), an explicit table
 * keeps every node event and its phase visible at a glance, so future events do not depend on string-slicing luck.
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
 * The **structured** input of one workflow run progress event. Fields mirror contracts'
 * `DynamicWorkflowRunProgressPayload` but are all optional: this module does no schema validation,
 * and treats partial input as "reduce as much as possible" (missing runId / eventType invalidates the whole event).
 *
 * `actorSessionId` is a derived field the run service attaches **outside** the payload
 * (see toProgressPayload in dynamic-workflow-run-launch.ts): the deterministically minted actor
 * session id. Not an engine-observable fact, but without it downstream would have to reinvent the contract.
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
 * Reduce one progress event into the `workflowRuns` state key.
 *
 * Returning `null` means **no semantic change**: an invalid event (missing runId / eventType), or a replay whose
 * content is byte-identical. Callers skip `state.updated` / UI refresh accordingly--revision rises only on
 * real changes (idempotent replays do not bump the revision).
 *
 * Absent `previous` equals the empty state `{ revision: 0, runs: [] }`. `limits` defaults to
 * {@link WORKFLOW_RUNS_LIMITS} (production has no second set of bounds).
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

  // Canonical key order (workflow-runs-delta.ts): reduction advances via `{...run, newKey: v}`, so newly appearing optional keys are appended
  // in **arrival order**, while the key-level delta consumer never saw that history. Each side re-orders by schema order once,
  // making `JSON.stringify(apply(prior, diff(prior, next))) === JSON.stringify(next)` hold byte-for-byte.
  const next = canonicalWorkflowRun(
    applyWorkflowRunEvent(base, envelope.eventType, payload, {
      ...(envelope.actorSessionId === undefined ? {} : { actorSessionId: envelope.actorSessionId }),
      ...(envelope.toolCallId === undefined ? {} : { toolCallId: envelope.toolCallId }),
      // Monotonic: late/replayed events never pull the watermark back.
      sequence: Math.max(base.lastEventSequence, sequence),
      // The rejected-instance counters are **additive** with no dedupable identity, so only watermark-raising events count
      // (see workflow-runs-caps.ts). The watermark used is the value **before** this event.
      advancesWaterMark: sequence > base.lastEventSequence,
      limits,
    }),
  );

  // Idempotence: no semantic change, no delta (replays of one event do not bump the revision). The test is **structural** comparison, not
  // JSON.stringify of the whole run--the latter would serialize the entire table per event (exactly the O(N) bytes this refactor removes),
  // and would misread "different key order, same content" as a change. Shares the same predicate as diff's "did this key change".
  if (existing !== undefined && workflowRunUnchanged(existing, next)) return null;

  const runs = existing
    ? prior.runs.map((run) => (run.runId === runId ? next : run))
    : [...prior.runs, next];
  // Last ~8 entries, oldest evicted. The full facts of terminal runs remain in the journal (the detail page fetches via event-log query).
  // These two **cross-run** bounds are hard constants, not the `limits` injection point: that exists only to shrink a single run's table,
  // and the run count and entry budget are unrelated to those injected rules.
  const bounded =
    runs.length > WORKFLOW_RUNS_LIMITS.maxRuns
      ? runs.slice(runs.length - WORKFLOW_RUNS_LIMITS.maxRuns)
      : runs;
  // The entry budget applies after the run count: 8 runs at full entry budget come too close to the snapshot cap (workflow-runs-caps.ts).
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
     * run-started: back to running, usage zeroed, last life's settlement residue stripped, and this run's own concurrency cap recorded.
     * The rules live in sibling workflow-runs-started.ts (resume's re-arm semantics deserve a whole file header).
     */
    case "run-started":
      return reduceRunStarted(run, payload);
    case "actor-created": {
      const ref = workflowInstanceRef(payload.actor);
      if (!ref) return run;
      // Birth stage: `actor-created` is the actor's birth event; the stamp only arrives here,
      // no later event carries or rewrites it.
      const phaseName = boundedPhaseName(nonEmptyString(payload.phaseName));
      const actor = workflowActorEntry(ref, payload.name, phaseName, derived.actorSessionId);
      // Make room for this live newcomer when the table is full (workflow-runs-eviction.ts); if no room, keep rejecting new ones.
      // Replayed events neither make room nor take a seat (the latter only tightens on **overflowed** runs, see admitsNewEntry).
      const seated = derived.advancesWaterMark ? withRoomForActor(run, ref, derived.limits) : run;
      const upserted = upsertBoundedByInstance(seated.actors, actor, derived.limits.maxActors, {
        admitNew: admitsNewEntry(run, derived.advancesWaterMark),
      });
      // Rejected subagents must stay countable: run level has no actor counter; its only trace is its birth-stage cell.
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
      // There are two birth events (verbatim the same rule as workflow-runs-caps.ts): `node-queued`, and the `node-settled { cached: true }`
      // emitted on replay hits. An **overflowed** run only accepts new keys brought by live birth events (see admitsNewEntry):
      // replayed events, or an intermediate phase of an off-table instance, must not readmit it--
      // it is already counted in nodesUnlisted; listing it again would both list and count.
      const born =
        eventType === "node-queued" || (eventType === "node-settled" && payload.cached === true);
      const actorRef = workflowInstanceRef(payload.actor);
      // `node-dispatched` carrying birth facts: at dispatch the engine re-emits the same facts its `node-queued` and the subagent's `actor-created`
      // carried, so an off-table instance can return to the table **at the moment it gets work**, person and job together.
      // A missing actor ref means a legacy journal or bare world-read dispatch; handle as before.
      const dispatchActor =
        eventType === "node-dispatched" && actorRef !== null
          ? workflowActorEntry(
              actorRef,
              payload.actorName,
              boundedPhaseName(nonEmptyString(payload.actorPhaseName)),
              derived.actorSessionId,
            )
          : null;
      // The single entry point for eviction, B2 rejection, and activation (workflow-runs-eviction.ts).
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
      // Birth phase name: the engine stamps it only on birth events--`node-queued`, and the `node-settled { cached: true }`
      // emitted on replay hits (that node has no queued; it is the birth event). Other
      // `node-*` events lack it and carry it forward, the same precedent as kind / actorSiteId above.
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
        // Task summary and progress reading: node-queued takes the payload, other events carry it forward, birth events clear the previous life's counters.
        // Rule in sibling workflow-runs-node-progress.ts (which also explains why explicit carrying is required).
        ...carryNodeProgress(eventType, payload, previousNode),
      };
      const upsertedNodes = upsertBoundedByInstance(seated.nodes, node, derived.limits.maxNodes, {
        admitNew: seating.admitNew,
      });
      // Steps: an instance counts one step on its **first** dispatch. On replay of the same node-dispatched, previousNode is already
      // past dispatched, so no count--the reduction must stay idempotent (the top level judges "no change" structurally).
      // A cap-rejected instance has no previousNode and still counts: the step count is a run-level fact, not bound by display caps.
      // And precisely because it has no previousNode, phase dedupe cannot help it--replaying that dispatched would push the count
      // ever higher. So on **overflowed** runs this counter follows the nodesUnlisted rule,
      // trusting only watermark-raising events; below the cap every instance has its own row and phase dedupe suffices, byte-for-byte unchanged.
      const firstDispatch =
        eventType === "node-dispatched" &&
        admitsNewEntry(run, derived.advancesWaterMark) &&
        (previousNode === undefined || previousNode.phase === "queued");
      // An instance returning to the table is first subtracted from `nodesUnlisted`: list+count would inflate the step count by one.
      const restored = seating.activated ? discountUnlistedInstance(seated.usage) : seated.usage;
      // The rejected instance's two counters (workflow-runs-caps.ts): `upsertedNodes.truncated` means exactly
      // "this instance failed to enter the table"--the run-level truncated bit is counted separately below; do not conflate them.
      const usage = countUnlistedInstance(
        firstDispatch ? { ...restored, nodesUsed: restored.nodesUsed + 1 } : restored,
        {
          rejected: upsertedNodes.truncated,
          advancesWaterMark: derived.advancesWaterMark,
          eventType,
          cached: payload.cached === true,
        },
      );
      // A rejected born-settled instance: the run-level counter above already recorded it; record its birth-stage cell here and, per the orphan rule,
      // strip the actor that cannot be attached to its own node (workflow-runs-eviction.ts).
      const absorbed =
        upsertedNodes.truncated && derived.advancesWaterMark && born && phase === "settled"
          ? absorbRefusedSettledNode(seated, node, derived.limits)
          : seated;
      return withDerivedWorkflowActorStatuses({
        ...absorbed,
        ...(usage === seated.usage ? {} : { usage }),
        nodes: upsertedNodes.list,
        ...(upsertedNodes.truncated || seated.truncated ? { truncated: true } : {}),
      });
    }
    /**
     * node-progress: one round of an ask resolved (the driver emits one per resolved round).
     *
     * **Not a lifecycle event**: no phase, no step count, no actor state; it writes three readings onto that node.
     * Hence it deliberately stays out of the case group above and out of NODE_EVENT_PHASE. Rules in
     * workflow-runs-node-progress.ts。
     */
    case "node-progress": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      return reduceNodeProgress(run, ref, payload);
    }
    /**
     * report: one progressive artifact handed over by the script's `report(item)` (feeds the detail page Results section).
     *
     * It **deliberately never touches `nodes[]`**: report has no node-queued/node-settled lifecycle, and counting it would inflate the step
     * count of a chatty workflow (the compact card and task list read `settled/observed` from nodes),
     * and drag an order-less instance into the state overlay. Likewise it leaves actor state alone--it is not evidence of an actor doing work.
 * actor doing work.
     */
    case "report": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      // Second argument of `report(item, artifactId)`: which preset dashboard receives this entry. Absent = plain report; the counting branch below is skipped entirely.
      const artifactId = nonEmptyString(payload.artifactId);
      const report: WorkflowRunReport = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        preview: workflowReportPreview(payload.item),
        ...(artifactId === undefined ? {} : { artifactId }),
      };
      const existingReports = run.reports ?? [];
      // The count dedupe key is the **same** as the reports table: (siteId, ordinal). Must be judged **before** the upsert,
      // otherwise post-upsert every entry is "already present". See below for why that check goes wrong after the cap
      // and why that direction of error is safe.
      const firstSighting = !existingReports.some(
        (item) => item.siteId === ref.siteId && item.ordinal === ref.ordinal,
      );
      // Upsert by (siteId, ordinal): on script replay every report call re-runs (the engine silently skips the recorded one by the same key),
      // so one instance must land as one row, not two. Cap semantics match the actors/nodes family: reject new entries, update existing ones,
      // over-cap facts remain in the journal.
      const upserted = upsertBoundedByInstance(
        existingReports,
        report,
        WORKFLOW_RUNS_LIMITS.maxReports,
      );
      // Tagged entries **still enter reports**: one channel, one cap; a tag is another destination, not a diversion.
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
     * artifact-published: the script published a version of a **user-facing** artifact via `artifact.*`, or
     * declared a preset dashboard. Successful content-member publishes and preset-member
     * declarations both ride this event; cache hits do not re-emit (same as report).
     *
     * Terminology: artifact here is the **user-facing** deliverable. The "script top-level
     * return value" behind `resultPreview` is also called artifact inside the engine, but it is for the **model**--unrelated. See workflow-artifacts.ts.
     *
     * Like report, **never touches `nodes[]` or actor state**: artifact sites live in no graph and have no node
     * lifecycle events (not even node-settled, precisely to avoid an untracked node in the side panel). No step count either--
     * delivering an artifact is not "one more step".
     *
     * The dedupe key is the **artifact id**, not the site instance: re-publishing the same id is a **new version**, and a new version must overwrite
     * the same card, not grow a second one. This is a different family from the nodes/actors/reports tables deduped by (siteId, ordinal)--
     * two versions of one id come from two distinct site instances; instance-level dedupe would yield two cards.
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
     * artifact-failed: a content artifact publish was rejected (missing file / out of bounds / over cap / store absent).
     *
     * **Deliberately changes no state.** A failed publish claims no id, no kind, no version
     * (only completed rows claim those; otherwise the live path would claim things the resume path cannot, two ledgers).
     * So there is nothing to upsert: a "failure card" for an artifact that never existed would show the user a deliverable
     * that does not exist, while the script has likely caught it, had the subagent rewrite, and re-published successfully.
     *
     * The reader of this event is the **event log** (the detail page's audit view pages the journal; it does not pass through this reduction). The
     * explicit case instead of default makes "no state change" a **visible verdict**,
     * not a forgotten branch.
     */
    case "artifact-failed":
      return run;
    case "usage-updated": {
      // The event carries the spent total directly (the engine writes dwf_run.spent_tokens one line before emit); absent keeps the known value.
      if (typeof payload.spentTokens !== "number") return run;
      return { ...run, usage: { ...run.usage, spentTokens: payload.spentTokens } };
    }
    /**
     * escalation: an actor escalates a blocking question to the main agent and parks inside its own ask awaiting the answer.
     *
     * Like report, **never touches `nodes[]` or actor state**: escalation has no node lifecycle and no step count
     * (waiting is not work, same doctrine as the report exemption). It must not flip the asking actor to idle either--
     * that actor's ask is still dispatched; its state keeps deriving from the node phase, unchanged here.
     *
     * The dedupe key is `qid`, not the site instance: escalation has no site identity. Upsert (not push) makes replays idempotent--
     * the same raised event twice yields a byte-identical table, and the top-level JSON compare returns null.
     */
    case "escalation-raised": {
      const qid = nonEmptyString(payload.qid);
      const question = nonEmptyString(payload.question);
      // qid is the identity; question is the entire reason this record exists. Either missing = nothing to show, watermark only.
      if (qid === undefined || question === undefined) return run;
      // An unreadable actor ref does **not** drop the record: identity is qid, the actor is an attribute. Hiding the question over a broken ref
      // would destroy the one fallback value of "blocked questions stay visible" (the renderer has its own fallback label).
      const actorRef = workflowInstanceRef(payload.actor);
      const actorName = boundedActorName(nonEmptyString(payload.actorName));
      const context = nonEmptyString(payload.context);
      // The asked-at time can only ride the event: this module is clockless (purity contract in the header). The event side requires it, but
      // replays of legacy journals may lack it--when absent the whole field is omitted and the renderer hides the waiting duration.
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
     * The main agent answered: that actor's round continues in place, the question is no longer owed.
     *
     * The answer itself **never lands in the projection**: it lives in the actor round's transcript as the `escalate` tool result (on cache hits
     * the whole round replays byte-for-byte); here the question only leaves the "awaiting answer" table. The event-log row still carries the answer text--
     * that is the audit view, a different thing from the live "who is still owed" fact.
     */
    case "escalation-resolved": {
      const qid = nonEmptyString(payload.qid);
      if (qid === undefined) return run;
      return withoutPendingQuestions(run, (pending) => pending.qid !== qid);
    }

    /**
     * concurrency-changed: the process-level governor adjusted the cap for this run's provider key. Never touches `nodes[]` or actor state:
     * the cap is a gate, not any node's business. Rules in workflow-runs-concurrency.ts.
     */
    case "concurrency-changed":
      return reduceConcurrencyChanged(run, payload);

    /**
     * run-caps-changed: the run's **own** concurrency cap changed in flight (a max_concurrency-only revision applies in place, neither stopping
     * this run nor starting another). Payload and rule match `run-started`, so it cohabits in workflow-runs-concurrency.ts.
     * Likewise never touches `nodes[]` or actor state: the cap is a gate, not any node's business.
     */
    case "run-caps-changed":
      return reduceRunCapsChanged(run, payload);

    /** phase-entered / run-launched: phase reduction lives in sibling workflow-runs-phases.ts (the latter only carries the declared phase table). */
    case "phase-entered":
      return reducePhaseEntered(run, payload);
    case "run-launched":
      return reduceRunLaunched(run, payload);

    case "run-settled": {
      const status = payload.status;
      const error = isPlainRecord(payload.error) ? payload.error : undefined;
      const message = typeof error?.message === "string" ? error.message : undefined;
      // Terminal states clear parked questions: the truth is the in-process parked deferred, and a terminal run by definition has no one listening
      // (cancel already rejected them via cancelAsk; a process death takes the whole registry with it, so `resolved` events
      // never come). Keeping them would park an unanswerable question in the sidebar--worse than hiding it,
      // because it reads as "someone is still waiting". Clearing happens on **every** terminal state, completed included: a completed run
      // with pending questions is just a residue that will never get an answer.
      // The cooldown is "until when are new dispatches frozen"; a terminal run dispatches nothing--keeping it would show a countdown
      // with no referent in the state header. cap / ceiling stay: they are historical facts about the concurrency this ran under.
      const cleared = withoutCooldown(withoutPendingQuestions(run, () => false));
      // In the actor tri-state, the waiting/completed boundary depends on terminality, so terminal states re-derive it:
      // an actor created but never asked flips from waiting to completed at the moment the run ends.
      // The three terminal words; `stopReason` is carried only for stopped,
      // the successor pointer arrives only with superseded (the card renders the "superseded by run X" link from it).
      const carriedStopReason =
        status === "stopped" ? readWorkflowRunStopReason(payload.stopReason) : undefined;
      const supersededBy =
        carriedStopReason === "superseded" ? readRunIdField(payload.supersededBy) : undefined;
      // In earlier journals the `run-settled` status used
      // the legacy words cancelled / failed. This used to "ignore anything outside the closed set", so cold replay left an already-stopped run
      // in running: the card lit up, Cancel clickable, nothing to cancel backend-side. Once the settle event arrives the run must not stay alive:
      // unrecognized words settle as errored (unrecoverable, no Resume lit), copy preserved, stating which word when absent.
      // The CLI's cold replay now mints settles per row (dynamic-workflow-run-replay.ts); this is the second gate on the live path.
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
        // Resumability is adjudicated CLI-side on the payload (the same predicate as the resume gate); carried here, present only when true.
        ...(payload.resumable === true ? { resumable: true as const } : {}),
      });
    }
    // log / compaction are not steps and have no site id, so watermark only (event log only, never the graph).
    default:
      return run;
  }
}

/** Isomorphic to the engine's `InstanceRef` / `ActorRef`: site id x ordinal. Either missing = unlocatable, return null. */
function workflowInstanceRef(value: unknown): { siteId: string; ordinal: number } | null {
  if (!isPlainRecord(value)) return null;
  const siteId = nonEmptyString(value.siteId);
  const ordinal = value.ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return null;
  return { siteId, ordinal };
}

/**
 * Keep parked questions matching the predicate, and **drop the whole key when none remain** (not an empty array).
 *
 * "Zero => key absent" is the field's protocol contract (see the schema comment); the sidebar renders nothing for it. It is also
 * the pivot of idempotence: resolving a qid no longer in the table yields a byte-identical run object, the top-level JSON compare
 * returns null--no revision bump, no UI refresh.
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

/** Display cap for question/notes. The ellipsis makes truncation visible, same idiom as the report preview. */
function boundedQuestionText(text: string): string {
  const limit = WORKFLOW_RUNS_LIMITS.maxQuestionLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Display preview of one report entry.
 *
 * The serialization rule is the **same origin** as artifact echo-back (`serializeWorkflowArtifact`: strings as-is, everything else pretty
 * JSON--native to contracts, moved here with this reduction, re-exported by contracts), because the same value appears
 * both in the completion notice's `<reports>` and the detail page's Results section; a mismatch is a bug. Computed in the
 * reduction rather than the renderer: the preview is a **bounded** protocol field, and copying the serialization contract into the UI layer
 * would eventually drift from the notice/TaskOutput text.
 */
function workflowReportPreview(item: unknown): string {
  // The payload already passed boundDynamicWorkflowRunEventPayload (string 2048 / depth 6 / 32 keys), so the only way to exceed the cap
  // is "a key-heavy object growing via pretty JSON". The ellipsis keeps truncation visible in the UI,
  // so no extra protocol field per entry is needed (run-level truncated means "entries did not fit", a different thing).
  const text = serializeWorkflowArtifact(item) ?? "";
  const limit = WORKFLOW_RUNS_LIMITS.maxReportPreviewLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
