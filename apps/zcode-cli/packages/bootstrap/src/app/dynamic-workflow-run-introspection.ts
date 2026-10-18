// ============================================================
// Dynamic Workflow Run Service: run introspection read side (ListWorkflowRuns / GetWorkflowRun)
// ============================================================
// dynamic-workflow-run-service.ts hits oxlint's max-lines cap (400), so the two OPTIONAL port members listRuns/
// getRunDetail and their pendingQuestions slice move here; the public surface still exports from
// dynamic-workflow-run-service.ts. Both members join the service object only when the journal has the introspection queries --
// the absent-means-unimplemented verdict stays in the service (see its introspection field docs).

import type {
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunHole,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunListItem,
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPort,
} from "@zcode/contracts";
import { NON_REPORT_NODE_KINDS, type JournalStorePort } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type { DynamicWorkflowIntrospectableJournal } from "./dynamic-workflow-run-journal.js";
import {
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import {
  artifactsOf,
  journalRunSummary,
  registryRunSummary,
  runConcurrencyField,
  runScriptPathField,
  runModelBindingsField,
  runSubagentModelField,
  terminalErrorField,
  terminalResultField,
  toLogTailEntry,
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import {
  COLD_REPLAY_EVENT_READ,
  replayRunProgressFromEvents,
} from "./dynamic-workflow-run-replay.js";
import { runHolesOf } from "./dynamic-workflow-run-holes.js";
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
   //   * This process's default concurrency (the service's own implementation). The detail surface uses it for the not-worth-mentioning test
   //   * ({@link runConcurrencyField}). A function, not a number: introspection members are built once at service construction, while the default
   * number: introspection members are built once at service construction, while the ceiling is a
   */
  defaultConcurrency: () => number;
}

/** Builds the `listRuns` / `getRunDetail` pair; the service spreads them into the returned port object. */
export function createRunIntrospectionMethods(
  ctx: DynamicWorkflowRunIntrospectionContext,
): Required<Pick<DynamicWorkflowRunPort, "listRuns" | "getRunDetail">> {
  const { introspection, journal, parentSessionId, runs, escalations, defaultConcurrency } = ctx;
  return {
    /**
     * Enumerate runs for the project: journal rows union this session's registry. **Read-only** -
     * `possiblyInterrupted` is a read-side annotation and never rewrites the journal (reaping a
     * sibling session's in-flight run would mean marking a living run dead; orphan reaping
     */
    async listRuns(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult> {
      const limit = Math.max(0, query.limit);
      // Fetch one extra row SOLELY to decide truncated; it never enters the result page. Never length === limit:
      // exact-equal would misreport, and a misreport sends the model chasing a nonexistent history page. The same convention
      // already exists in the v4 gateway's event pagination (hasMore).
      const rows = introspection.listRuns({
        cwd: query.cwd,
        limit: limit + 1,
        ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
      });
      const journalItems = rows.map((row) => ({
        ...journalRunSummary(row, runs.get(row.runId), parentSessionId),
        spentTokens: row.spentTokens,
      }));

      // Registry complement: in the few microtasks after submit returns and before the engine createRun, the journal has
      // no trace at all. Without this branch a just-launched run would vanish from its own project list.
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

      // A gap-window run is necessarily the newest submitted (only microtasks before the journal row), so order it
      // by submit time desc BEFORE the time_updated-desc journal rows; limit bounds the whole page.
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
        // The gap-window cross-section: one event, zero node rows, hence no phase table, empty roster,
        // health all zero. The only content: pendingQuestionsKnown -- the entry is in this session's hand,
        // the stall table is readable (and this is precisely when a question is MOST likely stalled; see pendingQuestions below).
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
          // The concurrency bound's gap copy (see RunRegistryEntry.maxConcurrency): the row is not landed, but the value was
          // fixed at submit; no reason for the detail surface to pretend not knowing during these microtasks.
          ...runConcurrencyField(entry.maxConcurrency, defaultConcurrency()),
          // Gap copy of the subagent model, same argument (see RunRegistryEntry.subagentModel).
          ...runSubagentModelField(entry.subagentModel),
          // The script-named models' gap copy, same argument.
          ...runModelBindingsField(entry.modelBindings),
          // Gap copy of the script file, same argument (see RunRegistryEntry.scriptPath).
          ...runScriptPathField(entry.scriptPath),
          // Usage has no authority yet: honestly 0; the usage BASELINE is known though (a revised run inherits the predecessor's
          // total, see RunRegistryEntry.inheritedTokens) -- reporting 0 would say "this lineage spent nothing".
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
          // This gap branch is exactly run-in-flight-journal-row-pending, i.e. when a question is MOST
          // likely stalled -- missing it, a just-started run's blocked actor is invisible model-side.
          ...pendingQuestionsField(escalations, runId),
          // Holes and stalled questions, same argument: in the gap the entry is in hand, the engine stall table readable; zero rows = field absent.
          ...holesField(runHolesOf(runId, entry, journal)),
          // Artifacts: in this gap branch the dwf_run row has not landed, but **node rows may
          // have** - the engine can putNode an artifact row immediately after createRun. So query
          // once here instead of assuming empty: a run whose dashboard was just declared should not
          // look productless in the model's eyes. artifactsOf drops the whole field when empty.
          ...artifactsOf(runId, journal),
        };
      }

      const summary = journalRunSummary(row, entry, parentSessionId);
      const counts = introspection.countNodesByStatus(runId);
      // Events are read ONCE: the same sequence
      // first reduces through the cold-replay minting chain into run-panel state, then feeds the situation cross-section with node/actor rows.
      // Reading twice pays twice for one dataset, and on long runs this query is the most expensive leg.
      // report items read only to the projection's bound (same read as cold replay, see dynamic-workflow-run-replay.ts).
      const stored = journal.listEvents(runId, COLD_REPLAY_EVENT_READ);
      // Actor rows read once, without persona (the whole system prompt is the naturally unbounded field; no reader here).
      const actorRows = journal.listActors(runId, { withPersona: false });
      const pendingQuestions = pendingQuestionsOf(escalations, runId, summary.status, entry);
      return {
        ...summary,
        // The persisted bound (dwf_run.caps_max_concurrency), present only when != default. Deliberately NOT into
        // journalRunSummary -- that is the list row cross-section; a rarely-set field must not widen every row.
        ...runConcurrencyField(row.caps.maxConcurrency, defaultConcurrency()),
        // This run's subagent model, present only if set. Not a dwf_run column (no migration, by decision) --
        // the authority is the run-launched event. Snapshot rule: entry present -> read entry (all three creation paths set it),
        // only cold rows scan event headers once. Like the bound, deliberately not in journalRunSummary: a rarely-set
        // field must not widen every list row.
        ...runSubagentModelField(
          entry === undefined ? readRunSubagentModel(journal, runId) : entry.subagentModel,
        ),
        // This run's script file, present only if recorded. Per-entry same as the subagent model: authority is run-launched
        // (no dwf_run column), entry present -> read it, cold rows scan event headers once; also deliberately
        // not in journalRunSummary -- list rows should not widen for a field only AmendWorkflow uses.
        ...runModelBindingsField(
          entry === undefined ? readRunModelBindings(journal, runId) : entry.modelBindings,
        ),
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
        actors: actorRows.map((actor) => ({
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          // persona deliberately withheld: the whole system prompt is the port's naturally-unbounded field class.
          ...(actor.name === undefined ? {} : { name: actor.name }),
        })),
        logTail: introspection
          .listRecentLogEvents(runId, DEFAULT_LOG_TAIL_LIMIT)
          .map(toLogTailEntry),
        ...buildWorkflowRunRoster({
          run: reduceRunState(row, stored, defaultConcurrency()),
          events: stored,
          // The roster reads kind/status/coords only: no results, no report rows.
          nodes: journal.listNodes(runId, { kinds: NON_REPORT_NODE_KINDS, withResult: false }),
          actors: actorRows,
          status: summary.status,
          ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
          now: Date.now(),
        }),
        ...terminalResultField(summary.status, entry, row),
        ...terminalErrorField(summary.status, entry, row),
        ...(pendingQuestions === undefined || pendingQuestions.length === 0
          ? {}
          : { pendingQuestions }),
        // Holes (docs/execution-engine.md, "The run snapshot"): same source and projection as the snapshot -- the model-side
        // discovery surface of choice when a hole notification was lost. Cold-row facts rebuild from the row's script (only on real arrivals).
        ...holesField(runHolesOf(runId, entry, journal, row.scriptText)),
        // The artifact cross-section attaches in any state, failed/cancelled included
        // -- a run that died at step 12 still delivered the graph it made en route. Uses the SAME artifactsOf as listArtifacts and the
        // terminal snapshot use the SAME artifactsOf: one list in all three places (three merges would eventually fork on
        // does-a-failed-row-count-as-a-version). Zero rows = field absent.
        ...artifactsOf(runId, journal),
      };
    },
  };
}

/**
 // * getRunDetail's pendingQuestions slice.
 *
 // * SAME projection source as the getTask snapshot (the in-memory escalation stall table), deliberately not journal replay: the journal has
 // * raised/resolved events, but who still owes an answer is a live in-process fact -- replayed unpaired
 // * raised events lie once the process died (the stalled deferred died with it).
 *
 // * Zero rows = field absent (no empty array, same as the snapshot): an empty array reads asked-and-answered; absence
 // * reads nobody-waiting.
 */
function pendingQuestionsField(
  escalations: WorkflowEscalationRegistry,
  runId: string,
): Pick<DynamicWorkflowRunDetail, "pendingQuestions"> {
  const pendingQuestions = escalations.pendingFor(runId);
  return pendingQuestions.length === 0 ? {} : { pendingQuestions };
}

/** Zero rows = field absent (same rule as pendingQuestions). */
function holesField(
  holes: readonly DynamicWorkflowRunHole[],
): Pick<DynamicWorkflowRunDetail, "holes"> {
  return holes.length === 0 ? {} : { holes };
}

/**
 // * Whether THIS read can answer are-questions-awaiting, and the answer itself.
 * （`health.pendingQuestionsKnown`）。
 *
 * `undefined` = cannot know, not none. The parking table lives in **this process's memory** (see
 * {@link pendingQuestionsField}), so only two cases let this read tell the truth: the run sits in
 * this session's registry, or the run is terminal - a terminal run has by definition no one still
 * listening. Otherwise (a sibling session's in-flight run, a dead process's relic) an empty table
 * and don't-know look identical, yet for the model they are different next moves: one may keep
 */
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
 *
 * Events are fetched by the caller and passed in; `replayRunProgressFromEvents` is the cold-replay
 * minting chain itself, so the reduced state here is byte-identical to what the UI sees after a
 */
function reduceRunState(
  row: Parameters<typeof replayRunProgressFromEvents>[0],
  stored: Parameters<typeof replayRunProgressFromEvents>[1],
  defaultConcurrency: number,
): WorkflowRunsState["runs"][number] | undefined {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgressFromEvents(row, stored, defaultConcurrency)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  return state?.runs.find((run) => run.runId === row.runId);
}
