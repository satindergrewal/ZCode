/**
 * SQLite JournalStorePort (dwf_* tables).
 *
 * The port is synchronous and repository-shaped, matching node:sqlite DatabaseSync, so the engine needs no
 * async seams for persistence and replay determinism is storage-independent.
 *
 * Dependency direction vs @zcode/dynamic-workflow: type-only imports. The port belongs to the domain package;
 * this file is one adapter and the runtime takes no values from it (implements erases at compile time).
 *
 * Transactionality is not on the port: scenarios needing atomicity with session writes compose via driver begin immediate.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ActorRecord,
  Caps,
  GetNodeOptions,
  JournalStorePort,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import { encodeJson } from "../json.js";
// Artifact readers are their own module: one db handle, no shared state with run/actor/node/event writes,
// and each query carries a full rationale for source, ordering and cursor.
import {
  countTaggedReports,
  listArtifactItems,
  listArtifactRows,
  type DwfArtifactItem,
  type DwfArtifactItemsQuery,
} from "./dwf-journal-artifacts.js";
import { listEventPage, type DwfEventPageQuery } from "./dwf-journal-pages.js";
import {
  countNodeRows,
  getNodeRow,
  listActorRows,
  listEventRows,
  listNodeRows,
  sumResultBytes,
} from "./dwf-journal-reads.js";
import {
  decodeActor,
  decodeRun,
  encodeResultJson,
  encodeRunSettlement,
  type DwfActorRow,
  type DwfEventRow,
  type DwfWorldNodeRow,
  type DwfRunDetailRow,
  type DwfRunListItem,
  type DwfRunRow,
  type DwfRunSessionListItem,
} from "./dwf-journal-codecs.js";
import {
  countNodesByStatus,
  getRunRow,
  listRecentLogEvents,
  listRunLifeSpans,
  listRuns,
  listRunsByParentSession,
  listWorldNodes,
  type DwfListRunsQuery,
  type DwfNodeStatusCounts,
  type DwfRunIntrospectionQueries,
  type DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

export type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
// Run introspection readers (DwfRunIntrospectionQueries and SQL) live in dwf-journal-introspection.ts
// (max-lines split); types still export from here so importers keep their paths.
export type {
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

class SqliteDwfJournalStore implements JournalStorePort, DwfRunIntrospectionQueries {
  constructor(private readonly db: DatabaseSync) {}

  createRun(record: RunRecord): void {
    const now = Date.now();
    // Logical -> physical (zero-migration terminal encoding, see the dwf-journal-codecs.ts header).
    const settlement = encodeRunSettlement(record.status, record);
    try {
      this.db
        .prepare(
          `
          insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
            args_json, resumed_from, caps_max_concurrency,
            spent_tokens, status, failure_json, result_json, time_created, time_updated
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.runId,
          record.parentSessionId ?? null,
          record.cwd ?? null,
          // name rides the same metadata path as scriptText/cwd: written once at run creation,
          // never touched again (updateRunStatus deliberately omits the column).
          record.name ?? null,
          record.scriptText ?? null,
          record.scriptHash ?? null,
          record.toolCallId ?? null,
          // args ride the same metadata path as scriptText: written once at creation, never touched;
          // resume must replay exactly the approved copy.
          encodeJson(record.args),
          // lineage joins the write-once metadata path: an amend supersedes, predecessor rows untouched,
          // so amended-from is writable only at creation.
          record.resumedFrom ?? null,
          // caps differ from the columns above: not write-once. updateRunCaps is the column's second
          // writer: a max_concurrency-only amend edits the living run in place, while resume
          // the row's value (docs/dynamic-workflow/concurrency.md, "Two bounds on a run").
          record.caps.maxConcurrency,
          record.spentTokens,
          settlement.status,
          settlement.failureJson,
          encodeResultJson(record.result),
          now,
          now,
        );
    } catch (error) {
      // A duplicate run is a caller contract error worth a readable message; other failures (FK, disk, constraints) bubble.
      if (this.getRun(record.runId) !== undefined) {
        throw new Error(`dwf journal: run already exists: ${record.runId}`, { cause: error });
      }
      throw error;
    }
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("select * from dwf_run where id = ?").get(runId) as
      | DwfRunRow
      | undefined;
    return row ? decodeRun(row) : undefined;
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const now = Date.now();
    // Non-terminal = no settlement: flipping a run back to running on resume must clear the previous life's failure_json/
    // result_json. The engine's resume carries no settlement bag, and absent-key-means-no-touch would leave the
    // orphan-convergence Interrupted failure alongside running. Contradictory bags (terminal fields on non-terminal)
    // are cleared likewise (pinned by contract tests, both implementations).
    if (status === "pending" || status === "running") {
      const { changes } = this.db
        .prepare(
          `
          update dwf_run set
            status = ?,
            failure_json = null,
            result_json = null,
            time_updated = ?
          where id = ?
          `,
        )
        .run(status, now, runId);
      this.assertRunTouched(changes, runId);
      return;
    }
    // Terminal and artifact in one stroke: two UPDATEs open a crash window producing completed runs with
    // empty result_json, exactly the loss class 0020's column closes.
    //
    // failure_json is rewritten wholesale (no coalesce). A second desktop instance's orphan
    // convergence writes failed+Interrupted over a run this engine still has alive; the engine then completes normally, and
    // coalesce would leave the foreign failure, the row claiming completed and interrupted at once. The settlement bag is
    // the whole truth at that moment: stopped always writes the envelope, errored its failure (absent = NULL, the truth),
    // completed NULL.
    //
    // result_json keeps coalesce: artifact semantics are absent-means-no-touch (contract case
    // keeps an already-settled artifact when a later write omits it); a settlement without artifact must not erase it.
    const encoded = encodeRunSettlement(status, settlement);
    const { changes } = this.db
      .prepare(
        `
        update dwf_run set
          status = ?,
          failure_json = ?,
          result_json = coalesce(?, result_json),
          time_updated = ?
        where id = ?
        `,
      )
      .run(encoded.status, encoded.failureJson, encodeResultJson(settlement?.result), now, runId);
    this.assertRunTouched(changes, runId);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const { changes } = this.db
      .prepare("update dwf_run set spent_tokens = ?, time_updated = ? where id = ?")
      .run(spentTokens, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   //   In-place update of this run's concurrency bound (docs/dynamic-workflow/concurrency.md, "Two bounds on a run").
   * A narrow write kin to updateRunUsage: only caps_max_concurrency is listed; status, usage and the settlement
   * envelope have their own paths, and mixing them in would let a cap tweak roll back a settlement.
   * Zero migration: the column long exists; this method is merely its second writer.
   */
  updateRunCaps(runId: string, caps: Caps): void {
    const { changes } = this.db
      .prepare("update dwf_run set caps_max_concurrency = ?, time_updated = ? where id = ?")
      .run(caps.maxConcurrency, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   //   Writes the **valid script** back to the run row (docs/execution-engine.md, "Holes" -> "The engine's part"). It is the
   //   second writer of `script_text` / `script_hash` after `createRun`: one fill splices the hole's body
   //   into the script, and resume later checks the row's hash against the row's text — so both columns **must share one UPDATE**;
   //   two statements open a "new text, old hash" crash window, and resume hitting it reports ScriptHashMismatch.
   //   A narrow write kin to `updateRunUsage`: status, usage, bound, and the settlement bag are not in this statement. Zero migration: both
   //   columns long exist; this method is only their second writer.
   */
  updateRunScript(runId: string, scriptText: string, scriptHash: string): void {
    const { changes } = this.db
      .prepare("update dwf_run set script_text = ?, script_hash = ?, time_updated = ? where id = ?")
      .run(scriptText, scriptHash, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * Every non-terminal run of one parent session. Deliberately not on JournalStorePort: the engine never finds
   * runs by parent; this serves host-side orphan convergence only, since a killed process' run sticks at running
   * until the next app construction of the same session converges it
   * (bootstrap/src/app/dynamic-workflow-run-service.ts, via capability probe).
   *
   * SQL only: the terminal set here is an index-friendly prefilter; the service is the authority
   * (it re-checks against its own terminal set). parent_session_id must be in the predicate or a sweep would
   * kill sibling sessions' in-flight runs (one sqlite, separate in-memory registries). SQL =? never matches
   // NULL, so parentless rows belong to no session and no convergence touches them.
   */
  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    // Physical terminal set (failed/cancelled store logical errored/stopped; never migrated).
    const rows = this.db
      .prepare(
        `
        select * from dwf_run
        where parent_session_id = ?
          and status not in ('completed', 'failed', 'cancelled')
        order by id
        `,
      )
      .all(parentSessionId) as unknown as DwfRunRow[];
    return rows.map(decodeRun);
  }

  // ---- Host-side run introspection: SQL and rationale in dwf-journal-introspection.ts; delegate only.

  listRuns(query: DwfListRunsQuery): DwfRunListItem[] {
    return listRuns(this.db, query);
  }

  getRunRow(runId: string): DwfRunDetailRow | undefined {
    return getRunRow(this.db, runId);
  }

  countNodesByStatus(runId: string): DwfNodeStatusCounts {
    return countNodesByStatus(this.db, runId);
  }

  listRecentLogEvents(runId: string, limit: number): StoredEvent[] {
    return listRecentLogEvents(this.db, runId, limit);
  }

  listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
    return listRunLifeSpans(this.db, runId);
  }

  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[] {
    return listRunsByParentSession(this.db, parentSessionId, limit);
  }

  putActor(record: ActorRecord): void {
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_actor (
          run_id, site_id, ordinal, name, persona_json, session_id, resolved_model,
          time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          name = excluded.name,
          persona_json = excluded.persona_json,
          session_id = excluded.session_id,
          resolved_model = excluded.resolved_model,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.name ?? null,
        encodeJson(record.persona),
        record.sessionId ?? null,
        record.resolvedModel ?? null,
        now,
        now,
      );
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const row = this.db
      .prepare("select * from dwf_actor where run_id = ? and site_id = ? and ordinal = ?")
      .get(runId, siteId, ordinal) as DwfActorRow | undefined;
    return row ? decodeActor(row) : undefined;
  }

  listActors(runId: string, opts: ListActorsOptions): ActorRecord[] {
    return listActorRows(this.db, runId, opts);
  }

  putNode(record: NodeRecord): void {
    // Admit (running), settle, stats backfill: one upsert keyed (run_id, site_id, ordinal).
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_node (
          run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq,
          input_hash, status, result_json, error_json, stats_json, message_boundary,
          artifact_id, input_json, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          kind = excluded.kind,
          actor_site_id = excluded.actor_site_id,
          actor_ordinal = excluded.actor_ordinal,
          actor_seq = excluded.actor_seq,
          input_hash = excluded.input_hash,
          status = excluded.status,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          stats_json = excluded.stats_json,
          message_boundary = excluded.message_boundary,
          artifact_id = excluded.artifact_id,
          input_json = excluded.input_json,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.kind,
        record.actorSiteId ?? null,
        record.actorOrdinal ?? null,
        record.actorSeq ?? null,
        record.inputHash,
        record.status,
        encodeResultJson(record.result),
        encodeJson(record.error),
        encodeJson(record.stats),
        // Driver-backfill column kin to stats_json: the upsert replaces whole rows, so the backfiller must
        // getNode then rewrite the full record (contract tests pin this read-modify-write shape).
        record.messageBoundary ?? null,
        // artifact_id and kind are engine-carried identity columns on both writes (admit running and settle
        // completed/failed write the same id); the upsert replaces whole rows, so omitting it once
        // erases the settled row's artifact attribution from the this-run's-artifacts reader.
        record.artifactId ?? null,
        // 0030: bounded input joins kind/artifact_id as engine-carried on both writes; upsert replaces whole rows,
        // so a settlement missing it NULLs the admitted op/args.
        encodeJson(record.input),
        now,
        now,
      );
  }

  // ---- node / event / actor list reads: SQL and rationale live in dwf-journal-reads.ts (read-face options fully pushed down).

  getNode(
    runId: string,
    siteId: string,
    ordinal: number,
    opts?: GetNodeOptions,
  ): NodeRecord | undefined {
    return getNodeRow(this.db, runId, siteId, ordinal, opts);
  }

  listNodes(runId: string, opts: ListNodesOptions): NodeRecord[] {
    return listNodeRows(this.db, runId, opts);
  }

  countNodes(runId: string, kind: NodeKind): number {
    return countNodeRows(this.db, runId, kind);
  }

  sumResultBytes(runId: string, kind: NodeKind): number {
    return sumResultBytes(this.db, runId, kind);
  }

  listArtifactRows(runId: string): NodeRecord[] {
    return listArtifactRows(this.db, runId);
  }

  countTaggedReports(runId: string): ReadonlyMap<string, number> {
    return countTaggedReports(this.db, runId);
  }

  listWorldNodes(runId: string): DwfWorldNodeRow[] {
    return listWorldNodes(this.db, runId);
  }

  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): { items: DwfArtifactItem[]; hasMore: boolean } {
    return listArtifactItems(this.db, runId, artifactId, query);
  }

  listEventPage(
    runId: string,
    query: DwfEventPageQuery,
  ): { events: StoredEvent[]; hasMore: boolean } {
    return listEventPage(this.db, runId, query);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // The time written into time_created must return to the caller verbatim: decodeEvent yields the same
    // number on read, else a just-written event has no time until read back, a two-faced invariant.
    const timeCreated = Date.now();
    // Sequence assignment and insert must be one statement: a separate MAX(sequence)+1 read races across
    // processes (WAL lets several agents share one DB) into duplicate sequences.
    const row = this.db
      .prepare(
        `
        insert into dwf_event (run_id, sequence, type, payload_json, time_created)
        values (
          ?,
          coalesce((select max(sequence) + 1 from dwf_event where run_id = ?), 0),
          ?, ?, ?
        )
        returning sequence
        `,
      )
      .get(runId, runId, event.type, JSON.stringify(event), timeCreated) as
      | Pick<DwfEventRow, "sequence">
      | undefined;
    if (row === undefined) {
      throw new Error(`dwf journal: event insert returned no sequence for run: ${runId}`);
    }
    return { sequence: row.sequence, event, timeCreated };
  }

  listEvents(runId: string, opts: ListEventsOptions): StoredEvent[] {
    return listEventRows(this.db, runId, opts);
  }

  /** Zero updated rows means unknown-run; SQLite does not raise, so detect and fail loudly. */
  private assertRunTouched(changes: number | bigint, runId: string): void {
    if (Number(changes) === 0) throw new Error(`dwf journal: unknown run: ${runId}`);
  }
}

/** Opens a dwf journal view over an existing session DB; tables come from migration 0019_dwf_journal. */
export function createDwfJournalStore(db: DatabaseSync): JournalStorePort {
  return new SqliteDwfJournalStore(db);
}
