// ============================================================
// Dynamic Workflow Run Service: run introspection read side (ListWorkflowRuns / GetWorkflowRun)
// ============================================================
// dynamic-workflow-run-service.ts sits at the oxlint max-lines cap (400 lines), so the optional
// `listRuns` / `getRunDetail` port members and their pendingQuestions slice live here; the public
// surface is still exported from dynamic-workflow-run-service.ts. Both members join the service
// object only when the journal carries the introspection queries - the absent-means-unimplemented
// decision stays in the service (see the `introspection` field comment there).

import type {
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunListItem,
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPort,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type { DynamicWorkflowIntrospectableJournal } from "./dynamic-workflow-run-journal.js";
import { readRunScriptPath, readRunSubagentModel } from "./dynamic-workflow-run-launch-anchor.js";
import {
  artifactsOf,
  journalRunSummary,
  registryRunSummary,
  runConcurrencyField,
  runScriptPathField,
  runSubagentModelField,
  terminalErrorField,
  terminalResultField,
  toLogTailEntry,
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import { replayRunProgressFromEvents } from "./dynamic-workflow-run-replay.js";
import { buildWorkflowRunRoster } from "./dynamic-workflow-run-roster.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";

/**
 * Default `log()` tail length for `getRunDetail`. The tail samples narrative progress, it is not
 * the full log - full event history has the {@link DynamicWorkflowRunPort.listEvents} pagination.
 */
const DEFAULT_LOG_TAIL_LIMIT = 20;

/** Service-internal state the introspection side reads: registry and parking table are references to the **same instances**, not copies. */
interface DynamicWorkflowRunIntrospectionContext {
  /** Capability-probed narrow journal (same object as `journal`, wider type). */
  introspection: DynamicWorkflowIntrospectableJournal;
  journal: JournalStorePort;
  parentSessionId: string;
  /** The service's in-memory registry (in-flight plus bounded terminal). */
  runs: ReadonlyMap<string, RunRegistryEntry>;
  /** Escalation Q&A parking table, the sole projection source of the pendingQuestions slice. */
  escalations: WorkflowEscalationRegistry;
  /**
   * This process's concurrency ceiling (the service's own resolver). The detail side uses it to
   * decide a run cap is not worth mentioning ({@link runConcurrencyField}). A function, not a
   * number: introspection members are built once at service construction, while the ceiling is a
   * read-time fact.   */
  concurrencyCeiling: () => number;
}

/** Builds the `listRuns` / `getRunDetail` pair; the service spreads them into the returned port object. */
export function createRunIntrospectionMethods(
  ctx: DynamicWorkflowRunIntrospectionContext,
): Required<Pick<DynamicWorkflowRunPort, "listRuns" | "getRunDetail">> {
  const { introspection, journal, parentSessionId, runs, escalations, concurrencyCeiling } = ctx;
  return {
    /**
     * Enumerate runs for the project: journal rows union this session's registry. **Read-only** -
     * `possiblyInterrupted` is a read-side annotation and never rewrites the journal (reaping a
     * sibling session's in-flight run would mean marking a living run dead; orphan reaping
     * belongs to the owning session's construction moment, file-header invariant 4).     */
    async listRuns(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult> {
      const limit = Math.max(0, query.limit);
      // Fetch one extra row solely to decide `truncated`; it never enters the result page. The
      // test must not be `length === limit`: an exact-fit page would false-positive, sending the
      // model chasing a nonexistent history page. The same convention already exists in the v4
      // gateway event pagination (hasMore).
      const rows = introspection.listRuns({
        cwd: query.cwd,
        limit: limit + 1,
        ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
      });
      const journalItems = rows.map((row) => ({
        ...journalRunSummary(row, runs.get(row.runId), parentSessionId),
        spentTokens: row.spentTokens,
      }));

      // Registry complement: in the few microtasks between submit returning and the engine's
      // createRun, the journal holds no trace. Without this branch a just-launched run would
      // vanish entirely from its own project list.
      const listed = new Set(rows.map((row) => row.runId));
      const gapItems: DynamicWorkflowRunListItem[] = [];
      for (const [runId, entry] of runs) {
        if (listed.has(runId) || entry.cwd !== query.cwd) continue;
        // A row that exists but was not selected was excluded by limit / statuses - the
        // complement must not fish it back (that would silently defeat an explicit filter).
        if (journal.getRun(runId) !== undefined) continue;
        const summary = registryRunSummary(runId, entry);
        if (query.statuses !== undefined && !query.statuses.includes(summary.status)) continue;
        // Usage: no row yet, but an amendment run's baseline is fixed at submit time (see
        // RunRegistryEntry.inheritedTokens). A fresh run has no baseline => 0, as before.
        gapItems.push({ ...summary, spentTokens: entry.inheritedTokens ?? 0 });
      }

      // Gap runs are necessarily the newest submitted (only a few microtasks before the journal
      // row lands), so they sort by submit time desc ahead of the time_updated desc journal rows;
      // limit bounds the whole page.
      gapItems.sort((left, right) => right.createdAt - left.createdAt);
      const merged = [...gapItems, ...journalItems];
      const truncated = merged.length > limit;
      return {
        runs: truncated ? merged.slice(0, limit) : merged,
        // Present only when true: `false` is per-page noise.
        ...(truncated ? { truncated: true } : {}),
      };
    },

    /** Single-run detail: dwf_run row + node counts + actors + log tail + in-memory terminal artifact. */
    async getRunDetail(runId: string): Promise<DynamicWorkflowRunDetail | undefined> {
      const row = introspection.getRunRow(runId);
      const entry = runs.get(runId);
      if (row === undefined) {
        // Neither => truly unknown (the tool layer normalizes to run_not_found). Registry only =>
        // exactly the gap above: the run exists, and not_found would be a lie.
        if (entry === undefined) return undefined;
        const gapSummary = registryRunSummary(runId, entry);
        // Gap shape of the situation snapshot: no event, no node row yet, so no phase table, empty
        // roster, zeroed health. The only populated member is `pendingQuestionsKnown` - the entry
        // lives in this session, so the parking table answers (and this is precisely when a
        // question is **most likely** parked, see the pendingQuestions note below).
        const gapRoster = buildWorkflowRunRoster({
          run: undefined,
          events: [],
          nodes: [],
          actors: [],
          status: gapSummary.status,
          pendingQuestions: escalations.pendingFor(runId),
          now: Date.now(),
        });
        return {
          ...gapSummary,
          // Gap copy of the concurrency cap (see RunRegistryEntry.maxConcurrency): no row yet, but
          // the value was fixed at submit; the detail side has no reason to play ignorant for a few
          // microtasks.
          ...runConcurrencyField(entry.maxConcurrency, concurrencyCeiling()),
          // Gap copy of the subagent model, same argument (see RunRegistryEntry.subagentModel).
          ...runSubagentModelField(entry.subagentModel),
          // Gap copy of the script file, same argument (see RunRegistryEntry.scriptPath).
          ...runScriptPathField(entry.scriptPath),
          // No authoritative count source yet, honestly 0; the usage baseline is known though (an
          // amendment inherits the predecessor total, see RunRegistryEntry.inheritedTokens), and
          // reporting 0 would claim this lineage spent nothing.
          usage: {
            spentTokens: entry.inheritedTokens ?? 0,
            nodesObserved: 0,
            nodesRunning: 0,
            nodesCompleted: 0,
            nodesFailed: 0,
          },
          actors: [],
          logTail: [],
          ...gapRoster,
          ...terminalResultField(gapSummary.status, entry),
          ...terminalErrorField(gapSummary.status, entry),
          // This gap branch is exactly the run-in-flight-row-not-landed moment, when a question is
          // **most likely** parked - skipping it hides a blocked actor of a just-started run from
          // the model.
          ...pendingQuestionsField(escalations, runId),
          // Artifacts: in this gap branch the dwf_run row has not landed, but **node rows may
          // have** - the engine can putNode an artifact row immediately after createRun. So query
          // once here instead of assuming empty: a run whose dashboard was just declared should not
          // look productless in the model's eyes. artifactsOf drops the whole field when empty.
          ...artifactsOf(runId, journal),
        };
      }

      const summary = journalRunSummary(row, entry, parentSessionId);
      const counts = introspection.countNodesByStatus(runId);
      // Events are **read once**: the same sequence is first reduced by the cold-replay minting
      // chain into run-dashboard-shaped state, then fed - with node/actor rows - to the situation
      // snapshot. Reading twice pays twice for one dataset, and this query is the priciest segment
      // on long runs.
      const stored = journal.listEvents(runId, {});
      const pendingQuestions = pendingQuestionsOf(escalations, runId, summary.status, entry);
      return {
        ...summary,
        // Persisted cap (`dwf_run.caps_max_concurrency`), present only below the ceiling.
        // Deliberately kept out of journalRunSummary - that is the shared list-row shape; a
        // rarely-set field must not widen every row.
        ...runConcurrencyField(row.caps.maxConcurrency, concurrencyCeiling()),
        // This run's subagent model, present only when set. Not a dwf_run column (no migration, on
        // purpose) - the authority is the `run-launched` event. Same rule as the snapshot: entry if
        // present (all three entry-creating paths set it), event-header scan only for cold rows.
        // Like the cap, deliberately kept out of journalRunSummary: a rarely-set field must not
        // widen every list row.
        ...runSubagentModelField(
          entry === undefined ? readRunSubagentModel(journal, runId) : entry.subagentModel,
        ),
        // This run's script file, present only when recorded. Clause-for-clause the same rules as
        // the subagent model: authority is the `run-launched` event (no dwf_run column), entry if
        // present, event-header scan only for cold rows; likewise kept out of journalRunSummary -
        // list rows must not widen for a field only AmendWorkflow consumes.
        ...runScriptPathField(
          entry === undefined ? readRunScriptPath(journal, runId) : entry.scriptPath,
        ),
        usage: {
          // Straight from dwf_run.spent_tokens: the sole authority for run-level token usage.
          spentTokens: row.spentTokens,
          // Sum of persisted node row counts, **not** a total-step count: dynamic workflows have no
          // static total, and queued exists only in the event phase, never persisted.
          nodesObserved: counts.running + counts.completed + counts.failed,
          nodesRunning: counts.running,
          nodesCompleted: counts.completed,
          nodesFailed: counts.failed,
        },
        actors: journal.listActors(runId).map((actor) => ({
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          // persona deliberately omitted: a full system prompt is the naturally unbounded field
          // class on this port.
          ...(actor.name === undefined ? {} : { name: actor.name }),
        })),
        logTail: introspection
          .listRecentLogEvents(runId, DEFAULT_LOG_TAIL_LIMIT)
          .map(toLogTailEntry),
        ...buildWorkflowRunRoster({
          run: reduceRunState(row, stored, concurrencyCeiling()),
          events: stored,
          nodes: journal.listNodes(runId),
          actors: journal.listActors(runId),
          status: summary.status,
          ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
          now: Date.now(),
        }),
        ...terminalResultField(summary.status, entry, row),
        ...terminalErrorField(summary.status, entry, row),
        ...(pendingQuestions === undefined || pendingQuestions.length === 0
          ? {}
          : { pendingQuestions }),
        // Artifact snapshot: attached in any state, failed / cancelled included - a run that died
        // on step 12 still delivered the image produced before it. Uses the **same** artifactsOf as
        // `listArtifacts` and the terminal snapshot so all three agree (three private merges would
        // eventually diverge on questions like does-a-failed-row-count-as-a-version). The whole
        // field is absent when empty.
        ...artifactsOf(runId, journal),
      };
    },
  };
}

/**
 * The pendingQuestions slice of `getRunDetail`. *
 * Same projection source as the `getTask` snapshot (the in-memory escalation parking table);
 * deliberately not a journal replay: raised/resolved events exist, but who-owes-whom-an-answer-now
 * is a live in-process fact - replayed unpaired raised events lie once the process is gone (the
 * parked deferreds died with it). *
 * Whole field absent at zero (no empty arrays, same rule as the snapshot): an empty array reads
 * as asked-and-answered; absence reads as nobody-waiting. */
function pendingQuestionsField(
  escalations: WorkflowEscalationRegistry,
  runId: string,
): Pick<DynamicWorkflowRunDetail, "pendingQuestions"> {
  const pendingQuestions = escalations.pendingFor(runId);
  return pendingQuestions.length === 0 ? {} : { pendingQuestions };
}

/**
 * Whether this read **can** answer are-questions-pending, and the answer itself. * （`health.pendingQuestionsKnown`）。
 *
 * `undefined` = cannot know, not none. The parking table lives in **this process's memory** (see
 * {@link pendingQuestionsField}), so only two cases let this read tell the truth: the run sits in
 * this session's registry, or the run is terminal - a terminal run has by definition no one still
 * listening. Otherwise (a sibling session's in-flight run, a dead process's relic) an empty table
 * and don't-know look identical, yet for the model they are different next moves: one may keep
 * waiting, the other must ask another way. */
function pendingQuestionsOf(
  escalations: WorkflowEscalationRegistry,
  runId: string,
  status: DynamicWorkflowRunLifecycleStatus,
  entry: RunRegistryEntry | undefined,
): readonly DynamicWorkflowRunPendingQuestion[] | undefined {
  const known = entry !== undefined || TERMINAL_RUN_STATUSES.has(status);
  return known ? escalations.pendingFor(runId) : undefined;
}

/**
 * Journal events -> run-dashboard-shaped reduced state. The node-queued task summary and
 * node-progress figures live only on events, and the extraction rules already exist in the
 * reducer - reuse them rather than writing a second parser in the read side (two parsers
 * eventually diverge on does-requeue-clear-rounds-style questions). *
 * Events are fetched by the caller and passed in; `replayRunProgressFromEvents` is the cold-replay
 * minting chain itself, so the reduced state here is byte-identical to what the UI sees after a
 * restart. */
function reduceRunState(
  row: Parameters<typeof replayRunProgressFromEvents>[0],
  stored: Parameters<typeof replayRunProgressFromEvents>[1],
  concurrencyCeiling: number,
): WorkflowRunsState["runs"][number] | undefined {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgressFromEvents(row, stored, concurrencyCeiling)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  return state?.runs.find((run) => run.runId === row.runId);
}
