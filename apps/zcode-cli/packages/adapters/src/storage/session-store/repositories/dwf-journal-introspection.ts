/**
 * dwf-journal.ts hit the oxlint max-lines cap (400), so the host-side run-introspection readers
 * (DwfRunIntrospectionQueries and SQL) live here; the public surface still exports from dwf-journal.ts,
 * SqliteDwfJournalStore merely delegates.
 *
 * Same split as dwf-journal-artifacts.ts: these queries need one db handle, no shared state with
 * run/actor/node/event IO, each with a full source/ordering rationale.
 * The engine's JournalStorePort write face is not here: no writers at all.
 */

import type { DatabaseSync } from "node:sqlite";
import type { NodeRecord, NodeRecordStatus, RunStatus, StoredEvent } from "@zcode/dynamic-workflow";
import type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
import type { DwfEventPageQuery } from "./dwf-journal-pages.js";
import {
  decodeEvent,
  decodeNode,
  decodeRunDetailRow,
  decodeRunListItem,
  decodeRunSessionListItem,
  type DwfEventRow,
  type DwfNodeRow,
  type DwfWorldNodeRow,
  type DwfRunDetailRow,
  type DwfRunListItem,
  type DwfRunMetadataRow,
  type DwfRunRow,
  type DwfRunSessionListItem,
  type DwfRunSessionRow,
  encodeRunStatusPredicate,
} from "./dwf-journal-codecs.js";

/** Query bag of DwfRunIntrospectionQueries.listRuns. */
export interface DwfListRunsQuery {
  /**
   * Project key: literal equality on dwf_run.cwd (written as-is, queried as-is).
   *
   * Optional: without it no cwd predicate, enumerating across projects. A global workflow's history spans
   * every project that ran it (workflows/runs scope global); project-scoped variants still pass cwd, unchanged.
   */
  cwd?: string;
  /**
   * Row cap, required. Clamping is the caller's job (the tool clamps to [1, 50]); the storage layer never
   * guesses a default, an unbounded enum is the one forbidden shape.
   *
   * But no private ceiling (Math.min(50, limit)): callers legally pass tool-cap+1;
   * the run service fetches one extra to detect truncated. A hard 50 eats the probe so truncated is
   * permanently absent at exactly limit 50, the very page size where
   * more-exist matters most, and no test at another limit would notice.
   */
  limit: number;
  /** Optional status subset. Absent = no filter; empty = matches nothing (empty page). */
  statuses?: readonly RunStatus[];
  /**
   * Optional run name (dwf_run.name literal equality). The hub attributes history by workflow name = run name,
   * pushed down to SQL rather than filter-after-fetch, or a hot workflow pushes others off-page and last-run lies.
   */
  name?: string;
}

/** dwf_node tri-state counts (every NodeRecordStatus value, all three keys present). */
export interface DwfNodeStatusCounts {
  completed: number;
  failed: number;
  running: number;
}

/**
 * Start/end of one life of a run (run-started to its last event), epoch ms.
 *
 * A life is one engine liveness: the crashed/stopped life has no run-settled, so the end is the last
 * event that life recorded, exactly its last touch. Both bounds come from dwf_event.time_created
 // (the only clock for every "how long ago" in the event log), so differences never cross clocks.
 */
export interface DwfRunLifeSpan {
  startedAt: number;
  lastActivityAt: number;
}

/**
 * Host-side run introspection (the data plane of the ListWorkflowRuns/GetWorkflowRun read-only tools).
 *
 * Deliberately not widening the engine's JournalStorePort, same argument as listNonTerminalRuns verbatim:
 * the engine touches its own row by id, never enumerating or aggregating; putting these on the
 * domain port would charge every journal implementation (in-memory included) with host duties.
 *
 * Consumers capability-probe (typeof journal.listRuns === function), so this interface is the
 * single signature source between host and adapter: duplicated signatures drift, and drift silently
 * degrades the tool to no-such-capability.
 */
export interface DwfRunIntrospectionQueries {
  countNodesByStatus(runId: string): DwfNodeStatusCounts;
  getRunRow(runId: string): DwfRunDetailRow | undefined;
  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): { items: DwfArtifactItem[]; hasMore: boolean };
  /** One event-log page: count and byte bounds (dwf-journal-pages.ts); `hasMore` is the store's call. */
  listEventPage(
    runId: string,
    query: DwfEventPageQuery,
  ): { events: StoredEvent[]; hasMore: boolean };
  listArtifactRows(runId: string): NodeRecord[];
  /** Tag-report count per preset artifact (`group by artifact_id`, no row reads). */
  countTaggedReports(runId: string): ReadonlyMap<string, number>;
  listRecentLogEvents(runId: string, limit: number): StoredEvent[];
  listRuns(query: DwfListRunsQuery): DwfRunListItem[];
  /**
   // This run's per-incarnation active spans, in order (the completion card's time cell, see
   // docs/dynamic-workflow/transcript-and-notifications.md, "How long it took"). One run's
   * one span per life (each resume a life), and only the event log knows a life's wall clock.
   */
  listRunLifeSpans(runId: string): DwfRunLifeSpan[];
  /**
   // This run's world-read / world-run rows, persistence order (`order by id`), with journal timestamps
   // (the workflowRunWorkspace row of docs/dynamic-workflow/transcript-and-notifications.md). Not fetching
   * result_json: this is the list (op/args/status/time); bodies have their own (siteId, ordinal)
   * reader, else a 256-node page decodes 256 stdout blobs into memory.
   */
  listWorldNodes(runId: string): DwfWorldNodeRow[];
}

/**
 * Enumerate runs by project (cwd), most recently updated first. Same argument as listNonTerminalRuns: the engine
 * never enumerates; this is a host need (ListWorkflowRuns), so it stays off the domain port.
 *
 * cwd/statuses/order/limit all push down into SQL: dwf_run_cwd_idx (0021) is exactly this shape;
 * fetch-all-then-filter wastes both index and limit. cwd is literal equality, written
 * as context.workingDirectory and queried as-is; one-sided normalization only creates mismatches.
 *
 * Rows are the narrow projection (DwfRunListItem, no failure/result): lists never show artifacts,
 * and artifacts can be huge.
 */
export function listRuns(db: DatabaseSync, query: DwfListRunsQuery): DwfRunListItem[] {
  // An empty status set means matches-nothing, not no-filter; the latter would silently disable an
  // explicitly passed filter. Likewise limit <= 0 is an empty page (listEvents' -1 idiom
  // does not apply: enumeration is always bounded).
  //
  // Floor here, no ceiling: callers pass tool-cap+1 as the truncation probe; a
  // Math.min(50, ...) would hide truncated at exactly limit 50. See DwfListRunsQuery.limit.
  if (query.statuses !== undefined && query.statuses.length === 0) return [];
  if (query.limit <= 0) return [];

  // No cwd means no predicate: global runs span projects (the global variant never filters by cwd).
  // With cwd, literal equality via dwf_run_cwd_idx, behavior unchanged.
  const cwdFilter = query.cwd === undefined ? "" : " and cwd = ?";
  // Logical -> physical predicate (stopped/errored share physical failed, told apart in SQL
  // by failure_json code; see encodeRunStatusPredicate in dwf-journal-codecs.ts).
  const statusPredicate =
    query.statuses === undefined ? undefined : encodeRunStatusPredicate(query.statuses);
  const statusFilter = statusPredicate === undefined ? "" : ` and ${statusPredicate.sql}`;
  const nameFilter = query.name === undefined ? "" : " and name = ?";
  const rows = db
    .prepare(
      `
      select
        id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
        args_json, resumed_from, caps_max_concurrency,
        spent_tokens, status, failure_json, time_created, time_updated
      from dwf_run
      where 1 = 1${cwdFilter}${statusFilter}${nameFilter}
      order by time_updated desc
      limit ?
      `,
    )
    .all(
      ...(query.cwd === undefined ? [] : [query.cwd]),
      ...(statusPredicate?.params ?? []),
      ...(query.name === undefined ? [] : [query.name]),
      query.limit,
    ) as unknown as DwfRunMetadataRow[];
  return rows.map(decodeRunListItem);
}

/**
 * One run's full row + journal timestamps. getRun's RunRecord has no times (engine indifferent),
 * but detail must report createdAt/updatedAt and must read the journal directly:
 * in-memory snapshots lie about start times once entries evaporate.
 */
export function getRunRow(db: DatabaseSync, runId: string): DwfRunDetailRow | undefined {
  const row = db.prepare("select * from dwf_run where id = ?").get(runId) as DwfRunRow | undefined;
  return row ? decodeRunDetailRow(row) : undefined;
}

/**
 * Per-status node counts for one run, computed in SQL: detail needs three numbers, and reading every
 * dwf_node row to count is the expensive same answer (node counts have no bound).
 *
 * All three keys always present (0 when none): downstream sums them into nodesObserved, and a missing
 * key turns no-nodes-yet into NaN. The vocabulary is NodeRecordStatus's three values,
 */
export function countNodesByStatus(db: DatabaseSync, runId: string): DwfNodeStatusCounts {
  const rows = db
    .prepare("select status, count(*) as total from dwf_node where run_id = ? group by status")
    .all(runId) as unknown as { status: NodeRecordStatus; total: number }[];
  const counts: DwfNodeStatusCounts = { running: 0, completed: 0, failed: 0 };
  for (const row of rows) counts[row.status] = Number(row.total);
  return counts;
}

/**
 * The run's last N log events, chronologically (ascending sequence).
 *
 * order by sequence desc limit ? then reverse in JS: a long run's dwf_event is its biggest
 * table, and reading it all for the tail is what paging exists to avoid. The type filter pushes
 * down too, the type column is stored redundancy for exactly that (also in payload_json).
 */
export function listRecentLogEvents(db: DatabaseSync, runId: string, limit: number): StoredEvent[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      "select * from dwf_event where run_id = ? and type = 'log' order by sequence desc limit ?",
    )
    .all(runId, limit) as unknown as DwfEventRow[];
  return rows.reverse().map(decodeEvent);
}

/**
 * Active spans per run life (run-started to that life's last event), chronological.
 *
 * Basis: docs/dynamic-workflow/transcript-and-notifications.md, "How long it took" - the completion card's
 // duration sums the lineage's **active** time, each incarnation its own segment — gaps between
 * between lives (process dead, not yet resumed) run nothing and count nothing.
 *
 * One SQL statement, zero payloads decoded: lead() pairs each life's start with the next life's start,
 * and a correlated subquery takes the max-sequence time inside each span. Both predicates hit
 * unique(run_id, sequence); the type column is stored redundancy for such filters. An 18k-event run
 * thus reads a few rows instead of decoding 2.8MB of payload, why this reader avoids listEvents.
 *
 * The subquery always matches (the span contains run-started itself), so normal rows are never null;
 * still narrow defensively, this crosses a storage boundary and null becomes NaN ms silently.
 */
export function listRunLifeSpans(db: DatabaseSync, runId: string): DwfRunLifeSpan[] {
  const rows = db
    .prepare(
      `
      with lives as (
        select sequence, time_created,
               lead(sequence) over (order by sequence) as next_sequence
        from dwf_event
        where run_id = ? and type = 'run-started'
      )
      select
        l.time_created as started_at,
        (
          select e.time_created
          from dwf_event e
          where e.run_id = ?
            and e.sequence >= l.sequence
            and (l.next_sequence is null or e.sequence < l.next_sequence)
          order by e.sequence desc
          limit 1
        ) as last_activity_at
      from lives l
      order by l.sequence
      `,
    )
    .all(runId, runId) as unknown as { started_at: number; last_activity_at: number | null }[];
  return rows.map((row) => ({
    startedAt: Number(row.started_at),
    lastActivityAt:
      typeof row.last_activity_at === "number"
        ? Number(row.last_activity_at)
        : Number(row.started_at),
  }));
}

/**
 * Runs under one parent session (newest first, up to limit). Feeds the host enumeration
 * (DynamicWorkflowRunPort.listRunsForSession, the post-restart discovery query): the workflowRuns
 * projection does not survive processes, so card joins and Resume availability rebuild from this table.
 *
 * Kin to listNonTerminalRuns: a host-narrow query, deliberately off the engine's JournalStorePort.
 * No index: dwf_run holds workflows-per-session quantities (single digits); a scan is fine,
 * and if that changes the index shape is (parent_session_id, time_updated).
 *
 * Narrow projection (DwfRunSessionListItem): no result_json, the script's
 * top-level return, truly unbounded, and lists never show artifacts. failure_json must come:
 * the session view reports failureCode and resumable means failed+Interrupted, else every
 * interrupted run silently counts unrecoverable. Timestamps ride along (RunRecord has none).
 */
export function listRunsByParentSession(
  db: DatabaseSync,
  parentSessionId: string,
  limit: number,
): DwfRunSessionListItem[] {
  const rows = db
    .prepare(
      `
      select
        id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
        args_json, resumed_from, caps_max_concurrency,
        spent_tokens, status, failure_json, time_created, time_updated
      from dwf_run
      where parent_session_id = ?
      order by time_updated desc, id desc
      limit ?
      `,
    )
    .all(parentSessionId, Math.max(0, limit)) as unknown as DwfRunSessionRow[];
  return rows.map(decodeRunSessionListItem);
}

export function listWorldNodes(db: DatabaseSync, runId: string): DwfWorldNodeRow[] {
  const rows = db
    .prepare(
      `
      select
        run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash,
        status, error_json, stats_json, message_boundary, artifact_id, input_json,
        length(cast(result_json as blob)) as result_bytes,
        case when json_type(result_json) = 'array' then json_array_length(result_json) end
          as result_count,
        case when json_type(result_json) = 'object' then json_extract(result_json, '$.exitCode') end
          as exit_code,
        case when json_type(result_json) = 'object'
          then length(cast(json_extract(result_json, '$.stdout') as blob)) end as stdout_bytes,
        case when json_type(result_json) = 'object'
          then length(cast(json_extract(result_json, '$.stderr') as blob)) end as stderr_bytes,
        time_created, time_updated
      from dwf_node
      where run_id = ? and kind in ('world-read', 'world-run')
      order by id
      `,
    )
    .all(runId) as unknown as (Omit<DwfNodeRow, "id" | "result_json"> & {
    result_bytes: number | null;
    result_count: number | null;
    exit_code: number | null;
    stdout_bytes: number | null;
    stderr_bytes: number | null;
  })[];
  return rows.map((row) => {
    const record = decodeNode({ ...row, id: 0, result_json: null });
    return {
      ...record,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      ...(row.result_bytes === null ? {} : { resultBytes: row.result_bytes }),
      ...(row.result_count === null ? {} : { resultCount: row.result_count }),
      ...(typeof row.exit_code === "number" ? { exitCode: row.exit_code } : {}),
      ...(row.stdout_bytes === null ? {} : { stdoutBytes: row.stdout_bytes }),
      ...(row.stderr_bytes === null ? {} : { stderrBytes: row.stderr_bytes }),
    };
  });
}
