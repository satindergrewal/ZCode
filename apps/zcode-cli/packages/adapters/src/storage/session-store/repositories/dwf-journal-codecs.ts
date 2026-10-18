/**
 * dwf_* journal row <-> record mapping.
 *
 * Record types are type-only imports from @zcode/dynamic-workflow: the port lives in the domain package,
 * the SQLite store is one adapter, and the runtime must never depend on the domain package.
 *
 * Decode rule: a NULL nullable column omits the key entirely, never undefined/null.
 * Contract tests toEqual whole records, so absent optional inputs must come back absent.
 */

import type {
  ActorRecord,
  AskStats,
  Caps,
  NodeKind,
  NodeRecord,
  NodeRecordStatus,
  PersonaSpec,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
  WorkflowErrorJson,
  WorldReadInput,
} from "@zcode/dynamic-workflow";
import { decodeJson, encodeJson } from "../json.js";

/**
 * Physical vocabulary of dwf_run.status (migration 0019 CHECK set, never migrated). The logical
 * vocabulary is the engine's RunStatus (errored/stopped); the mapping lives only here:
 *
 * | logical                  | physical status | failure_json                                        |
 * | ----------------------- | ----------- | --------------------------------------------------- |
 * | stopped{reason, error?}  | cancelled       | {stopReason, error?: WorkflowErrorJson} envelope    |
 * | errored{error}           | failed          | WorkflowErrorJson as-is                             |
 * | completed/pending/running| same name       | unchanged                                           |
 *
 * Decode (no historical backfill): cancelled -> stopped with the envelope's stopReason, absent (old rows) means user;
 * failed + code Interrupted -> stopped(interrupted) (legacy orphan-convergence rows); other failed -> errored.
 * Accepted imprecision: reason-less historical cancelled always decodes as user (TaskStop stops included).
 */
export type DwfRunPhysicalStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type RunStopReason = NonNullable<RunRecord["stopReason"]>;

/**
 * Envelope inside a stopped row's failure_json (distinguished from WorkflowErrorJson by the stopReason key).
 * supersededBy is written in the same stroke as stopReason superseded (the envelope is rewritten wholesale),
 * so it lives here with zero migration.
 */
interface DwfStoppedEnvelope {
  stopReason: RunStopReason;
  supersededBy?: string;
  error?: WorkflowErrorJson;
}

/** Logical terminal triple: status + stop reason (+ successor) + structured failure. */
interface DwfRunSettlementFields {
  status: RunStatus;
  stopReason?: RunStopReason;
  supersededBy?: string;
  failure?: WorkflowErrorJson;
}

const INTERRUPTED_CODE = "Interrupted";
// Envelope-sniffing allowlist: one missing value and that reason's envelope fails to decode, degrading the row to stopped(user).
const STOP_REASONS: ReadonlySet<string> = new Set([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);

/** Logical status (+ settlement bag) to physical columns. The only write-side entry (createRun/updateRunStatus). */
export function encodeRunSettlement(
  status: RunStatus,
  settlement?: Pick<RunSettlementRecord, "stopReason" | "supersededBy" | "failure">,
): { status: DwfRunPhysicalStatus; failureJson: string | null } {
  switch (status) {
    case "stopped": {
      const envelope: DwfStoppedEnvelope = { stopReason: settlement?.stopReason ?? "user" };
      if (settlement?.supersededBy !== undefined) envelope.supersededBy = settlement.supersededBy;
      if (settlement?.failure !== undefined) envelope.error = settlement.failure;
      return { status: "cancelled", failureJson: JSON.stringify(envelope) };
    }
    case "errored":
      return { status: "failed", failureJson: encodeJson(settlement?.failure) };
    case "completed":
      return { status: "completed", failureJson: encodeJson(settlement?.failure) };
    case "pending":
    case "running":
      return { status, failureJson: null };
  }
}

/** Physical columns to logical terminal triple. The only read-side entry (full record and enum rows). */
function decodeRunSettlement(
  status: DwfRunPhysicalStatus,
  failureJson: string | null,
): DwfRunSettlementFields {
  const raw = decodeJson<Record<string, unknown>>(failureJson);
  switch (status) {
    case "cancelled": {
      const fields: DwfRunSettlementFields = { status: "stopped", stopReason: "user" };
      if (raw !== undefined && isStoppedEnvelope(raw)) {
        fields.stopReason = raw.stopReason;
        if (typeof raw.supersededBy === "string" && raw.supersededBy.length > 0) {
          fields.supersededBy = raw.supersededBy;
        }
        if (raw.error !== undefined) fields.failure = raw.error;
      }
      return fields;
    }
    case "failed": {
      const failure = raw as WorkflowErrorJson | undefined;
      if (failure?.code === INTERRUPTED_CODE) {
        return { status: "stopped", stopReason: "interrupted", failure };
      }
      return failure === undefined ? { status: "errored" } : { status: "errored", failure };
    }
    case "completed": {
      const failure = raw as WorkflowErrorJson | undefined;
      return failure === undefined ? { status: "completed" } : { status: "completed", failure };
    }
    case "pending":
    case "running":
      return { status };
  }
}

function isStoppedEnvelope(
  value: Record<string, unknown>,
): value is DwfStoppedEnvelope & Record<string, unknown> {
  return typeof value.stopReason === "string" && STOP_REASONS.has(value.stopReason);
}

/**
 * Logical status filter to SQL predicate (listRuns statuses pushdown). stopped/errored share the physical
 * failed value, discriminated by failure_json code via SQLite json_extract in SQL,
 * not fetch-then-filter (that would skew limit and truncation probes).
 */
export function encodeRunStatusPredicate(statuses: readonly RunStatus[]): {
  sql: string;
  params: string[];
} {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const status of statuses) {
    switch (status) {
      case "stopped":
        clauses.push(
          "(status = 'cancelled' or (status = 'failed' and json_extract(failure_json, '$.code') = ?))",
        );
        params.push(INTERRUPTED_CODE);
        break;
      case "errored":
        clauses.push(
          "(status = 'failed' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)",
        );
        params.push(INTERRUPTED_CODE);
        break;
      default:
        clauses.push("status = ?");
        params.push(status);
    }
  }
  return { sql: clauses.length === 0 ? "0" : `(${clauses.join(" or ")})`, params };
}

export interface DwfRunRow {
  args_json: string | null;
  caps_max_concurrency: number;
  cwd: string | null;
  failure_json: string | null;
  id: string;
  name: string | null;
  parent_session_id: string | null;
  result_json: string | null;
  /** amend-resume lineage pointer (newer migration). Narrow projections select it too: see DwfRunMetadataRow. */
  resumed_from: string | null;
  script_hash: string | null;
  script_text: string | null;
  /** Run-level token usage (legacy name budget_spent; same number, no longer a budget). */
  spent_tokens: number;
  /** Physical vocabulary (see the file-header table); logical status decoded by decodeRunSettlement plus failure_json. */
  status: DwfRunPhysicalStatus;
  time_created: number;
  time_updated: number;
  tool_call_id: string | null;
}

/**
 * Metadata columns of dwf_run (result_json excluded, it can be huge). Enum queries select only these:
 * decoding result_json for a 50-row page reads every artifact into memory the list never shows.
 *
 * Physical failed may be errored or
 * stopped(interrupted); logical status is decodable only with failure_json, a small structured
 * object (code + message + envelope) safe to decode per row. Enum rows still carry no failure field.
 *
 * The argument is a declaration-validated
 * small JSON bag displayed by the GUI hub's run history; failure/result are the unbounded artifact columns.
 *
 * resumed_from belongs in this layer (not an omitted big column): a short string, and the
 * absent-means-not-an-amend decode rule requires the column to be selected; otherwise row.resumed_from is
 * undefined in narrow queries, a different branch from NULL, putting an undefined-valued key on enum rows.
 */
export type DwfRunMetadataRow = Omit<DwfRunRow, "result_json">;

/** Journal-side row timestamps. RunRecord deliberately carries none (engine indifferent) but reads must report created/updated. */
export interface DwfRunTimestamps {
  timeCreated: number;
  timeUpdated: number;
}

/**
 * One enum-query row: run metadata + timestamps, no failure/result.
 * Detail rows are a superset, so list and get share one label/attribution derivation.
 */
export type DwfRunListItem = Omit<RunRecord, "failure" | "result"> & DwfRunTimestamps;

/** Detail-query row: full RunRecord (failure/result included) + timestamps. */
export type DwfRunDetailRow = RunRecord & DwfRunTimestamps;

/**
 * Session-enum row: DwfRunListItem + failure, still no result.
 *
 * Why not DwfRunListItem alone: the session enumeration (listRunsForSession -> /dwf list)
 * reports failureCode/failureMessage and resumable means failed with code
 * Interrupted; dropping failure_json would mark every interrupted run unrecoverable,
 * a silently wrong answer, not a missing display column.
 *
 * Why still no result_json: that column is truly unbounded (the script's top-level return) and lists never
 * show artifacts. failure_json is a small structured object (code + message), per-row decoding is safe.
 */
export type DwfRunSessionRow = DwfRunMetadataRow;

/** Record shape of DwfRunSessionRow. */
export type DwfRunSessionListItem = DwfRunListItem & Pick<RunRecord, "failure">;

export interface DwfActorRow {
  id: number;
  name: string | null;
  ordinal: number;
  persona_json: string | null;
  resolved_model: string | null;
  run_id: string;
  session_id: string | null;
  site_id: string;
  time_created: number;
  time_updated: number;
}

export interface DwfNodeRow {
  actor_ordinal: number | null;
  actor_seq: number | null;
  actor_site_id: string | null;
  /**
   * User-facing artifact id (newer migration). kind=artifact rows carry the published/declared artifact;
   * labeled kind=report rows carry the preset artifact they feed. Other rows NULL.
   * Unrelated to RunSettlement.artifact (the script's top-level return).
   */
  artifact_id: string | null;
  error_json: string | null;
  id: number;
  input_hash: string;
  /** Bounded {op, args} of world-read/world-run rows (newer migration); others and legacy rows NULL. */
  input_json: string | null;
  kind: NodeKind;
  /** Actor session message-log length after ask settles (count offset; newer migration). */
  message_boundary: number | null;
  ordinal: number;
  result_json: string | null;
  run_id: string;
  site_id: string;
  stats_json: string | null;
  status: NodeRecordStatus;
  time_created: number;
  time_updated: number;
}

/**
 * One workspace-read row: the world-read/world-run
 * NodeRecord (no result; body has its own (siteId, ordinal) reader) + journal timestamps +
 * result_json byte size (the how-big on the list, reportable without decoding the body).
 */
export interface DwfWorldNodeRow extends Omit<NodeRecord, "result">, DwfRunTimestamps {
  /** UTF-8 byte size of result_json; absent until settled or on settlement failure. */
  resultBytes?: number;
  /**
   * Element count when the body is a JSON array (glob files, grep hits, git.changedFiles paths).
   * Computed in-query via SQLite JSON functions; the body never leaves the DB.
   */
  resultCount?: number;
  /** exitCode on the body after world.run settles; absent for other ops and unsettled rows. */
  exitCode?: number;
  /** UTF-8 byte size of stdout/stderr after world.run settles. */
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface DwfEventRow {
  id: number;
  payload_json: string;
  run_id: string;
  sequence: number;
  time_created: number;
  type: string;
}

/**
 * result-column encoding. null is a legal ask result (ask<T | null> returns it),
 * but shared encodeJson collapses undefined and null into SQL NULL, turning a stored
 * result null into no-result on read. Only undefined maps to SQL NULL here.
 */
export function encodeResultJson(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : text;
}

/**
 * Shared run-metadata decode. Full records and enum rows both start here, so the two readers
 * cannot diverge on which optional columns count as absent.
 */
function decodeRunMetadata(row: DwfRunMetadataRow): Omit<RunRecord, "failure" | "result"> {
  const caps: Caps = { maxConcurrency: row.caps_max_concurrency };

  const settlement = decodeRunSettlement(row.status, row.failure_json);
  const record: Omit<RunRecord, "failure" | "result"> = {
    runId: row.id,
    caps,
    spentTokens: row.spent_tokens,
    status: settlement.status,
  };
  if (settlement.stopReason !== undefined) record.stopReason = settlement.stopReason;
  if (settlement.supersededBy !== undefined) record.supersededBy = settlement.supersededBy;
  if (row.parent_session_id !== null) record.parentSessionId = row.parent_session_id;
  if (row.cwd !== null) record.cwd = row.cwd;
  // Rows predating the column have NULL name (new column, no backfill): decode as an absent key; readers fall back to the script's first line.
  if (row.name !== null) record.name = row.name;
  // Early rows have no value (NULL = absent): decode as absent, legacy runs read fine.
  if (row.tool_call_id !== null) record.toolCallId = row.tool_call_id;
  if (row.script_text !== null) record.scriptText = row.script_text;
  if (row.script_hash !== null) record.scriptHash = row.script_hash;
  // Early rows and every non-amend run (the vast majority) have NULL: decode as an absent key.
  // Readers use it to decide import-cache rebuilds.
  if (row.resumed_from !== null) record.resumedFrom = row.resumed_from;
  // Early rows have no value (NULL = absent): decode as an absent key, not {}, keeping no-args
  // and empty-args-bag distinguishable at the record level; the sandbox reads absent as {} (invariant 7).
  if (row.args_json !== null) record.args = JSON.parse(row.args_json) as Record<string, unknown>;
  return record;
}

export function decodeRun(row: DwfRunRow): RunRecord {
  const record: RunRecord = decodeRunMetadata(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) record.failure = failure;
  // Early rows have no value (new column, NULL): must decode as an absent key, never an undefined
  // value nor a throw, or no legacy run survives the upgrade. result null takes the same JSON.parse
  // path, so legal null artifacts still appear (same convention as node result_json).
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  return record;
}

/** Enum row: metadata + timestamps. */
export function decodeRunListItem(row: DwfRunMetadataRow): DwfRunListItem {
  return {
    ...decodeRunMetadata(row),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}

/** Detail row: full record + timestamps. */
export function decodeRunDetailRow(row: DwfRunRow): DwfRunDetailRow {
  return { ...decodeRun(row), timeCreated: row.time_created, timeUpdated: row.time_updated };
}

/** Session-enum row: metadata + timestamps + failure (result_json not selected, hence not decoded). */
export function decodeRunSessionListItem(row: DwfRunSessionRow): DwfRunSessionListItem {
  const item: DwfRunSessionListItem = decodeRunListItem(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) item.failure = failure;
  return item;
}

export function decodeActor(row: DwfActorRow): ActorRecord {
  const record: ActorRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
  };
  if (row.name !== null) record.name = row.name;
  const persona = decodeJson<PersonaSpec>(row.persona_json);
  if (persona !== undefined) record.persona = persona;
  if (row.session_id !== null) record.sessionId = row.session_id;
  // Rows predating the column are NULL: decode as an absent key, legacy actor records still read back.
  if (row.resolved_model !== null) record.resolvedModel = row.resolved_model;
  return record;
}

export function decodeNode(row: DwfNodeRow): NodeRecord {
  const record: NodeRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
    kind: row.kind,
    inputHash: row.input_hash,
    status: row.status,
  };
  if (row.actor_site_id !== null) record.actorSiteId = row.actor_site_id;
  if (row.actor_ordinal !== null) record.actorOrdinal = row.actor_ordinal;
  if (row.actor_seq !== null) record.actorSeq = row.actor_seq;
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  const error = decodeJson<WorkflowErrorJson>(row.error_json);
  if (error !== undefined) record.error = error;
  const stats = decodeJson<AskStats>(row.stats_json);
  if (stats !== undefined) record.stats = stats;
  // Early rows, non-ask nodes and asks whose boundary the driver has not backfilled are NULL -> absent key.
  // 0 is a legal boundary (zero messages copied): test !== null, never truthiness.
  if (row.message_boundary !== null) record.messageBoundary = row.message_boundary;
  // Early rows and every report/ask/world-* row that is neither an artifact nor labeled are NULL
  // -> absent key, not an undefined value. The board filters on artifact_id match;
  // an undefined-valued key fails the contract test's whole toEqual.
  if (row.artifact_id !== null) record.artifactId = row.artifact_id;
  // Pre-0030 rows and ask/report/artifact rows are NULL -> absent key (readers fall back to the static label).
  const input = decodeJson<WorldReadInput>(row.input_json);
  if (input !== undefined) record.input = input;
  return record;
}

export function decodeEvent(
  row: Pick<DwfEventRow, "payload_json" | "sequence" | "time_created">,
): StoredEvent {
  return {
    sequence: row.sequence,
    event: JSON.parse(row.payload_json) as RunEvent,
    // The event log's only clock: row ages and the subagent's
    // last-action time derive from it. The column is NOT NULL since 0019, so write unconditionally.
    timeCreated: row.time_created,
  };
}
