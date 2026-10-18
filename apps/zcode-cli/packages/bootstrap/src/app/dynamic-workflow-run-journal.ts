// ============================================================
// Dynamic Workflow Run Service: journal capability probing and store narrowing
// ============================================================
// dynamic-workflow-run-service.ts hit the oxlint max-lines cap (400), so the structural narrowing of journal /
// task-link stores and the four capability probes moved here; the public surface is still exported from
// dynamic-workflow-run-service.ts.
//
// Every probe here follows one discipline: the store is a port, implementations replaceable -- probe by capability, never instanceof;
// absence means **visible degradation** (read face unimplemented / returns empty / not constructed), never a silent fallback to an in-memory impl.

import type { DwfRunIntrospectionQueries, DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { CreateSessionTaskLinkInput, Logger, SessionStorePort } from "@zcode/contracts";
import type { JournalStorePort, RunRecord, StoredEvent } from "@zcode/dynamic-workflow";

/** The task-link persistence face (production: SqliteSessionStore; tests pass a spy). */
export interface DynamicWorkflowTaskLinkStore {
  createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<unknown>;
}

/**
 * Structural narrowing of the task-link persistence face, same treatment as {@link resolveDynamicWorkflowJournalStore}:
 * the store is a port, implementations replaceable -- probe by capability, not instanceof. When missing, skip the link:
 * the actor session still persists; the session tree just lacks one attribution edge (degradable; run correctness unaffected).
 */
export function isDynamicWorkflowTaskLinkStore(
  store: SessionStorePort | undefined,
): store is SessionStorePort & DynamicWorkflowTaskLinkStore {
  return (
    typeof (store as { createSessionTaskLink?: unknown } | undefined)?.createSessionTaskLink ===
    "function"
  );
}

/**
 * Narrows the dwf journal out of the session store. A structural check, not instanceof -- the store is a port,
 * implementations replaceable (precedent: isScriptWorkflowStore, script-workflow-utils.ts).
 */
export function resolveDynamicWorkflowJournalStore(
  sessionStore: SessionStorePort | undefined,
  logger?: Logger,
): JournalStorePort | undefined {
  const candidate = sessionStore as
    | (SessionStorePort & { workflowJournalStore?: () => JournalStorePort })
    | undefined;
  if (typeof candidate?.workflowJournalStore !== "function") {
    // Visible degradation: port not constructable -> CreateWorkflow returns the placeholder diagnostic. Never an in-memory journal fallback --
    // the run would look alive while everything silently vanishes at process exit.
    logger?.info?.("Dynamic workflow run service disabled: session store has no dwf journal", {
      event: "dynamic_workflow.run_service.unavailable",
      module: "bootstrap.app",
      reason: "session_store_missing_workflow_journal_store",
    });
    return undefined;
  }
  return candidate.workflowJournalStore();
}

/**
 * The host-side journal face: the engine port plus the narrow queries for orphan convergence and enumeration.
 *
 * Deliberately **not widening** the engine's {@link JournalStorePort}: the engine reads/writes its own row by runId and never
 * finds runs by parent session -- these two queries are host needs; putting them on the domain port would make every journal impl
 * answer for things the engine does not do (the in-memory impl provides none). As in {@link isDynamicWorkflowTaskLinkStore}:
 * capability probes, not instanceof; the store is a port, implementations replaceable.
 */
interface DynamicWorkflowJournalStore extends JournalStorePort {
  listNonTerminalRuns(parentSessionId: string): RunRecord[];
  /**
   * Runs of one parent session, most recent first, at most limit (the enumeration face, servicing listRunsForSession).
   *
   * Returns {@link DwfRunSessionListItem}, not `RunRecord`: `RunRecord` deliberately omits timestamps (the engine does
   * not care) while enumeration reports `updatedAt`. The narrow projection skips `result_json` (unbounded artifacts, not shown in lists)
   * but **keeps failure** -- the `resumable` predicate needs failure.code.
   */
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
}

/** Whether the journal has the narrow queries orphan convergence needs (production SQLite yes; the engine's in-memory impl no). */
export function supportsNonTerminalRunQuery(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DynamicWorkflowJournalStore, "listNonTerminalRuns"> {
  return (
    typeof (journal as Partial<DynamicWorkflowJournalStore>).listNonTerminalRuns === "function"
  );
}

/** Whether the journal has the enumeration queries. Probed independently: one missing degrades only its own read face. */
export function supportsRunEnumeration(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DynamicWorkflowJournalStore, "listRunsByParentSession"> {
  return (
    typeof (journal as Partial<DynamicWorkflowJournalStore>).listRunsByParentSession === "function"
  );
}

/**
 * Journal with run-introspection queries (the fetch base of `ListWorkflowRuns` / `GetWorkflowRun`).
 *
 * The signature's **single source** is adapters' {@link DwfRunIntrospectionQueries} (`import type`, zero runtime
 * deps). Never redeclared here: those four queries are not on the engine's {@link JournalStorePort} (the engine never
 * enumerates runs nor aggregates counts), so only capability probing can attach them -- a signature drift would compile silently
 * and quietly degrade both tools to "no such capability in this session".
 */
export interface DynamicWorkflowIntrospectableJournal
  extends JournalStorePort, DwfRunIntrospectionQueries {}

/**
 * Whether the journal exposes a per-incarnation active-span read face (the completion card's duration basis, see
 * `docs/dynamic-workflow/transcript-and-notifications.md`「How long it took」）。
 *
 * **Probed separately, not merged into {@link supportsRunIntrospection}'s four**: those four are probed together because they
 * jointly back two tools' availability; this one backs a single number. Without it, duration falls back to this-generation wall clock --
 * a more conservative answer, not a broken tool -- so it must not drag `GetWorkflowRun`'s availability
 * (the engine's own in-memory journal lacks it, and in-memory runs never outlive the process anyway).
 */
export function supportsRunLifeSpans(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DwfRunIntrospectionQueries, "listRunLifeSpans"> {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listRunLifeSpans === "function";
}

/**
 * Whether the journal exposes a page-by-count-and-bytes event read face (the event log, docs/execution-engine.md
 * "Reading the journal"). Probed separately, same reason as {@link supportsRunLifeSpans}: without it the event log degrades to
 * count-only paging (the in-memory journal's case; its runs never outlive the process nor grow large pages).
 */
export function supportsEventPages(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DwfRunIntrospectionQueries, "listEventPage"> {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listEventPage === "function";
}

/**
 * An event page over a journal without {@link supportsEventPages}: count-only, one extra row decides `hasMore`.
 * The byte bound cannot be honored here — knowing an event's size requires reading it — and such journals (in-memory)
 * never grow large pages anyway.
 */
export function pageByCountOnly(
  journal: JournalStorePort,
  runId: string,
  page: { afterSequence?: number; limit: number },
): { events: StoredEvent[]; hasMore: boolean } {
  const read = journal.listEvents(runId, {
    types: "all",
    reportItems: "all",
    ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
    limit: page.limit + 1,
  });
  const hasMore = read.length > page.limit;
  return { events: hasMore ? read.slice(0, page.limit) : read, hasMore };
}

/**
 * Whether the journal has run introspection. **All four probed together**: the capability is whole (list needs listRuns, detail the other three);
 * a partially-present impl would explode one tool at runtime instead of visibly degrading.
 */
export function supportsRunIntrospection(
  journal: JournalStorePort,
): journal is DynamicWorkflowIntrospectableJournal {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  return (
    typeof candidate.countNodesByStatus === "function" &&
    typeof candidate.getRunRow === "function" &&
    typeof candidate.listRecentLogEvents === "function" &&
    typeof candidate.listRuns === "function"
  );
}
