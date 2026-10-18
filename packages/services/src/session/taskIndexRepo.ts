import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- the task index repo keeps sqlite schema, queries, and state writes together; split by read/write duty only after the migration settles. */
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
  zcodeTaskMetaSchema,
  resolveWorkspaceKey,
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListItem,
} from "#src/session/zcodeTaskListTypes.js";
import type {
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function appendZCodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ZCodeProvider,
): void {
  // Lists filter by the current runtime provider; historical import sources never change that boundary.
  where.push("provider = ?");
  args.push(provider);
}
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface TaskIndexRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

interface TaskGroupRow {
  group_id: string;
  title: string;
  color: string;
  created_at: number;
  updated_at: number;
}

interface TaskGroupMemberRow {
  group_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  sort_order: number | null;
  added_at: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupViewNodeOrderRow {
  node_type: "group" | "task";
  node_key: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupWorkspaceBootstrapRow {
  workspace_key: string;
  group_id: string | null;
}

interface WorkspaceBootstrapScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
  // Only the unread-specific write path may modify existing rows; other metadata/snapshot writes keep the current CAS marker.
  writeUnreadAt?: boolean;
  // searchableText is nullable: undefined keeps the existing row value.
  // Writes without messages context (applyAgentPatch/updateTaskState) then never blank indexed bodies.
  searchableText?: string;
}

interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ZCodeTaskMeta["status"];
  lastError?: ZCodeTaskMeta["lastError"];
  target?: ZCodeTaskMeta["target"];
  updatedAt?: number;
}

// Critical: chat body search needs matchable text only, not entire oversized sessions dumped into the index.
// Cap the length so long tasks cannot balloon tasks-index.sqlite into slow startup/list queries.
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;
const GROUPED_TASK_ORDER_STEP = 1000;
const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY = "__zcode_internal_grouped_workspace_bootstrap_once__";
const DEFAULT_TASK_GROUP_COLOR: ZCodeTaskGroupColor = "gray";
const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies ZCodeTaskGroupColor[];

const logger = createServiceLogger("task-index-repo");

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function shouldPreserveNewerTerminalStatus(
  existingMeta: ZCodeTaskMeta | null,
  incomingMeta: ZCodeTaskMeta,
): boolean {
  if (!existingMeta || !isTerminalTaskStatus(existingMeta.status)) {
    return false;
  }
  if (incomingMeta.status && incomingMeta.status !== "running") {
    return false;
  }
  return existingMeta.updatedAt > incomingMeta.updatedAt;
}

function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key is the real SQLite query/PK isolation basis; once it is a normalized remote identity,
  // the return value must match it, never letting a stale workspace_identity column project the entity to another remote.
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // When the identity projection disagrees with the PK, do not use it and never fall back to workspacePath,
  // or different remotes of the same path cross wires during the sidebar activity join.
  return undefined;
}

function rowToMeta(row: TaskIndexRow): ZCodeTaskMeta {
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  try {
    const parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    if (parsed.success) {
      return {
        ...(parsed.data as ZCodeTaskMeta),
        // SQLite queries/isolates by these columns; identity in old meta_json may be missing or from a former remote.
        // Reads must match the row PK projection so sessions-index can attach running activity
        // by workspaceKey + taskId.
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread is tasks-index shell state; the scalar column must override stale meta_json from other Hosts.
        unreadAt: row.unread_at ?? undefined,
        // cron identity: meta_json is authoritative, cron_automation_id is a fallback index column:
        // old rows may lack the field in meta_json; read the column, the next write backfills meta_json.
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        // Same policy for off-peak identity: meta_json authoritative, column fallback - legacy migration writes the column only.
        offPeakTaskId: parsed.data.offPeakTaskId ?? row.off_peak_task_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    logger.warn(
      undefined,
      `Invalid task index meta_json taskId=${row.task_id}`,
      parsed.error.flatten(),
    );
  } catch (error) {
    logger.warn(undefined, `Failed to read task index meta_json taskId=${row.task_id}`, error);
  }

  return {
    taskId: row.task_id,
    traceId: `zcode-${row.task_id}`,
    title: row.title,
    titleOverridden: row.title_overridden === 1,
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mode: row.mode as ZCodeTaskMeta["mode"],
    model: row.model ?? undefined,
    provider: row.provider === ZCODE_AGENT_PROVIDER ? ZCODE_AGENT_PROVIDER : undefined,
    migrationSource: (row.migration_source as ZCodeTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    offPeakTaskId: row.off_peak_task_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
    status: (row.task_status as ZCodeTaskMeta["status"]) ?? undefined,
  };
}

/** Serialize meta into meta_json. Cron identity writes with meta (single source) and projects into the cron_automation_id index column in writeRecord. */
function serializeMetaJson(meta: ZCodeTaskMeta): string {
  return JSON.stringify(meta);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeWorkspaceBootstrapScopes(
  scopes: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  }>,
): WorkspaceBootstrapScope[] {
  const seen = new Set<string>();
  const result: WorkspaceBootstrapScope[] = [];
  for (const scope of scopes) {
    if (scope.workspacePurpose === "conversation") {
      // The conversation backing workspace is just a cwd, not a project; never synthesize a same-named project group during migration.
      continue;
    }
    const key = workspaceKey(scope);
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      workspaceKey: key,
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
    });
  }
  return result;
}

function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// Global session search (TaskSearchDialog) expects snippets around body hits for the summary view.
// Window centered on the match, near-duplicates merged, at most 4;
// with no body hit (title only), fall back to one whole-body summary so the area below is not blank.
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  let searchStart = 0;

  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // The same keyword at close positions yields heavily overlapping windows; merge near-duplicates server-side.
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // Title hit without body hit still gets one whole-body summary fallback, avoiding blank space under the title.
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

function rowToTaskListItem(row: TaskIndexRow, search: string | null): ZCodeTaskListItem {
  const meta = rowToMeta(row);
  const snippets = buildSearchSnippets(row.searchable_text, search);
  if (snippets.length === 0) {
    return meta;
  }
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

function isTaskGroupColor(value: string): value is ZCodeTaskGroupColor {
  return (
    value === "gray" ||
    value === "red" ||
    value === "orange" ||
    value === "yellow" ||
    value === "green" ||
    value === "blue" ||
    value === "purple"
  );
}

function rowToTaskGroup(row: TaskGroupRow): ZCodeTaskGroup {
  return {
    id: row.group_id,
    title: row.title,
    color: isTaskGroupColor(row.color) ? row.color : DEFAULT_TASK_GROUP_COLOR,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workspaceGroupId(targetWorkspaceKey: string): string {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest("hex");
  return `workspace-group-${hash.slice(0, 24)}`;
}

function workspaceGroupTitle(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  const leaf = normalized.split(/[\\/]/u).filter(Boolean).at(-1);
  return leaf?.trim() || normalized.trim() || "Workspace";
}

function workspaceGroupColor(targetWorkspaceKey: string): ZCodeTaskGroupColor {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest();
  const colorIndex = hash.readUInt8(0) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.length;
  return WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS[colorIndex] ?? DEFAULT_TASK_GROUP_COLOR;
}

function taskNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  return `${workspaceKey(params)}\u0000${params.taskId}`;
}

function taskOrderNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  // task_group_view_node_orders.node_key must not use "\u0000" separators:
  // node:sqlite truncates TEXT at NUL, losing the taskId, so grouped-view order writes never match on query.
  return JSON.stringify([workspaceKey(params), params.taskId]);
}

function groupedTopNodeOrderRef(node: ZCodeGroupedTaskViewNode): {
  nodeType: "group" | "task";
  nodeKey: string;
  mapKey: string;
} {
  if (node.type === "group") {
    return {
      nodeType: "group",
      nodeKey: node.group.id,
      mapKey: `group:${node.group.id}`,
    };
  }
  const nodeKey = taskOrderNodeKey(node.task);
  return {
    nodeType: "task",
    nodeKey,
    mapKey: `task:${nodeKey}`,
  };
}

function compareGroupedNodes(
  left: ZCodeGroupedTaskViewNode,
  right: ZCodeGroupedTaskViewNode,
): number {
  const leftOrder = left.sortOrder ?? 0;
  const rightOrder = right.sortOrder ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return groupedTopNodeOrderRef(left).mapKey.localeCompare(groupedTopNodeOrderRef(right).mapKey);
}

function compareCronGroupTasks(left: ZCodeTaskListItem, right: ZCodeTaskListItem): number {
  // The cron system group is fixed newest-first: latest scheduled results always on top,
  // outside manual ordering (sort_order); new sessions naturally land at the group top.
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return taskNodeKey(right).localeCompare(taskNodeKey(left));
}

function compareGroupTasks(
  left: ZCodeTaskListItem,
  right: ZCodeTaskListItem,
  memberByTaskKey: Map<string, TaskGroupMemberRow>,
): number {
  const leftMember = memberByTaskKey.get(taskNodeKey(left));
  const rightMember = memberByTaskKey.get(taskNodeKey(right));
  const leftOrder = leftMember?.sort_order ?? 0;
  const rightOrder = rightMember?.sort_order ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return taskNodeKey(left).localeCompare(taskNodeKey(right));
}

export class TaskIndexRepo {
  constructor(
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // Release the failed connection; a post-migration repair may be partially committed, retry idempotent init as-is.
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // Multi-window Hosts share tasks-index; let write transactions and first schema upgrade wait briefly, not SQLITE_BUSY at once.
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // The Worker already did raw prep for this path; business connections skip the full-table repair.
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
    this.backfillOffPeakTaskMarkers();
    this.backfillOffPeakGroupMemberships();
    this.cleanupDeletedTaskGroupingReferences();
  }

  /**
   * Backfill (idempotent, self-healing each bootstrap): off-peak session rows created before the marker
   * shipped lack offPeakTaskId. off_peak_tasks shares tasks-index.sqlite with tasks; the session-bound
   * join fills the projection column only - rowToMeta's column fallback makes it live, and the next syncTaskMeta backfills meta_json.
   * On fresh installs off_peak_tasks may not exist yet (OffPeakTaskRepo creates it); guard.
   */
  private backfillOffPeakTaskMarkers(): void {
    const database = this.getDatabase();
    const hasOffPeakTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasOffPeakTable) {
      return;
    }
    database
      .prepare(
        `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
      )
      .run();
  }

  /**
   * Membership backfill (idempotent, per bootstrap): the historical backfill filled only the off_peak_task_id
   * projection column, so syncTaskMeta's first-ownership hook never fires for those rows (existing already
   * marked); bootstrap must add the system-group membership once. OR IGNORE keeps user manual sorting,
   * keeps reruns side-effect free, and creates no empty group (users never using off-peak see no group).
   */
  private backfillOffPeakGroupMemberships(): void {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `SELECT workspace_key, workspace_path, workspace_identity, task_id FROM tasks
         WHERE off_peak_task_id IS NOT NULL AND deleted = 0`,
      )
      .all() as Array<{
      workspace_key: string;
      workspace_path: string;
      workspace_identity: string | null;
      task_id: string;
    }>;
    for (const row of rows) {
      // Off-peak does not support remote workspaces yet: remote rows never join the group. A legacy row's workspace_identity
      // column may be missing, so remote detection must read PK workspace_key - else ensureSystemGroupMembership
      // recomputes a local key from workspacePath and writes membership onto the same-path local workspace.
      if (isRemoteWorkspaceIdentity(row.workspace_key)) {
        continue;
      }
      this.ensureOffPeakGroupMembership({
        workspacePath: row.workspace_path,
        workspaceIdentity: row.workspace_identity ?? undefined,
        taskId: row.task_id,
      });
    }
  }

  private deleteTaskGroupingReferencesReady(workspaceKeyValue: string, taskId: string): void {
    const database = this.getDatabase();
    database
      .prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(workspaceKeyValue, taskId);
    database
      .prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      )
      .run(JSON.stringify([workspaceKeyValue, taskId]), workspaceKeyValue);
  }

  private cleanupDeletedTaskGroupingReferences(): void {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `SELECT workspace_key, task_id
        FROM tasks
        WHERE deleted = 1`,
      )
      .all() as Array<{ workspace_key: string; task_id: string }>;
    if (rows.length === 0) {
      return;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      // Legacy deletes wrote only tasks.deleted, so membership/root order got re-projected by
      // sessions-index history summaries; converge already-persisted stale references idempotently at init.
      for (const row of rows) {
        this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite is not initialized");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  private getNextGroupedTopSortOrder(): number {
    const row = this.getDatabase()
      .prepare(
        `SELECT MIN(sort_order) AS min_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { min_sort_order: number | null } | undefined;
    return (row?.min_sort_order ?? GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP;
  }

  private upsertGroupedTopOrder(params: {
    nodeType: "group" | "task";
    nodeKey: string;
    sortOrder: number;
    now: number;
  }): void {
    this.getDatabase()
      .prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_type, node_key) DO UPDATE SET
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      )
      .run(params.nodeType, params.nodeKey, params.sortOrder, params.now, params.now);
  }

  private normalizeGroupedTopNodeOrders(
    nodes: ZCodeGroupedTaskViewNode[],
    orderByNodeKey: Map<string, TaskGroupViewNodeOrderRow>,
  ): void {
    const missingNodes = nodes
      .filter((node) => !orderByNodeKey.has(groupedTopNodeOrderRef(node).mapKey))
      .sort((left, right) => {
        const leftCreated = left.type === "group" ? left.group.createdAt : left.task.createdAt;
        const rightCreated = right.type === "group" ? right.group.createdAt : right.task.createdAt;
        if (rightCreated !== leftCreated) {
          return rightCreated - leftCreated;
        }
        return groupedTopNodeOrderRef(left).mapKey.localeCompare(
          groupedTopNodeOrderRef(right).mapKey,
        );
      });
    if (missingNodes.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const insertOrder = this.getDatabase().prepare(
      `INSERT INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const node of missingNodes) {
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        const ref = groupedTopNodeOrderRef(node);
        insertOrder.run(ref.nodeType, ref.nodeKey, nextSortOrder, now, now);
        const rowValue: TaskGroupViewNodeOrderRow = {
          node_type: ref.nodeType,
          node_key: ref.nodeKey,
          sort_order: nextSortOrder,
          created_at: now,
          updated_at: now,
        };
        orderByNodeKey.set(ref.mapKey, rowValue);
        node.sortOrder = nextSortOrder;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  private normalizeGroupMemberOrders(
    groupId: string,
    tasks: ZCodeTaskListItem[],
    memberByTaskKey: Map<string, TaskGroupMemberRow>,
  ): void {
    const missingTasks = tasks
      .filter((task) => {
        const member = memberByTaskKey.get(taskNodeKey(task));
        return Boolean(member) && member?.sort_order === null;
      })
      .sort((left, right) => {
        const leftMember = memberByTaskKey.get(taskNodeKey(left));
        const rightMember = memberByTaskKey.get(taskNodeKey(right));
        const leftAdded = leftMember?.added_at ?? left.createdAt;
        const rightAdded = rightMember?.added_at ?? right.createdAt;
        if (rightAdded !== leftAdded) {
          return rightAdded - leftAdded;
        }
        return taskNodeKey(left).localeCompare(taskNodeKey(right));
      });
    if (missingTasks.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_members
        WHERE group_id = ?`,
      )
      .get(groupId) as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const updateMemberOrder = this.getDatabase().prepare(
      `UPDATE task_group_members
      SET sort_order = ?, updated_at = ?
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const task of missingTasks) {
        const memberKey = taskNodeKey(task);
        const member = memberByTaskKey.get(memberKey);
        if (!member) {
          continue;
        }
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        updateMemberOrder.run(nextSortOrder, now, member.workspace_key, member.task_id);
        member.sort_order = nextSortOrder;
        member.updated_at = now;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    await this.ensureReady();
    return this.hasGroupedWorkspaceBootstrapRunSync();
  }

  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
    const where = [
      "workspace_key = ?",
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      "unread_at IS NULL",
      "updated_at < ?",
      "task_status = 'completed'",
    ];
    const args: Array<string | number> = [workspaceKey(params), cutoff];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all(...args) as unknown as TaskIndexRow[];
    if (rows.length === 0) {
      return [];
    }

    const archiveTask = this.getDatabase().prepare(
      `UPDATE tasks
      SET archived = 1
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        archiveTask.run(row.workspace_key, row.task_id);
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
    return rows.map(rowToMeta);
  }

  private hasGroupedWorkspaceBootstrapRunSync(): boolean {
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS found
        FROM task_group_workspace_bootstraps
        LIMIT 1`,
      )
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

  private bootstrapWorkspaceGroupsForActiveTasks(params: {
    scopes: WorkspaceBootstrapScope[];
    activeTasks: TaskIndexRow[];
  }): void {
    if (params.scopes.length === 0 || this.hasGroupedWorkspaceBootstrapRunSync()) {
      return;
    }
    const database = this.getDatabase();
    const candidateRowsByWorkspaceKey = new Map<string, TaskIndexRow[]>();
    for (const row of params.activeTasks) {
      const rows = candidateRowsByWorkspaceKey.get(row.workspace_key) ?? [];
      rows.push(row);
      candidateRowsByWorkspaceKey.set(row.workspace_key, rows);
    }
    const now = Date.now();
    const markBootstrapRun = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, NULL, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        updated_at = excluded.updated_at`,
    );
    if (candidateRowsByWorkspaceKey.size === 0) {
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      return;
    }
    const existingGroupOrderKeys = new Set(
      (
        database
          .prepare(
            `SELECT node_key
            FROM task_group_view_node_orders
            WHERE node_type = 'group'`,
          )
          .all() as Array<{ node_key: string }>
      ).map((row) => row.node_key),
    );
    const maxOrderRow = database
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextGroupSortOrder = maxOrderRow?.max_sort_order ?? 0;
    const insertGroup = database.prepare(
      `INSERT OR IGNORE INTO task_groups (
        group_id,
        title,
        color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertGroupOrder = database.prepare(
      `INSERT OR IGNORE INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES ('group', ?, ?, ?, ?)`,
    );
    const deleteExistingMember = database.prepare(
      `DELETE FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const insertMember = database.prepare(
      `INSERT INTO task_group_members (
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        group_id = excluded.group_id,
        workspace_path = excluded.workspace_path,
        workspace_identity = excluded.workspace_identity,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
    );
    const deleteTopTaskOrder = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'task' AND node_key = ?`,
    );
    const insertBootstrap = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        group_id = excluded.group_id,
        updated_at = excluded.updated_at`,
    );
    const deleteEmptyGroups = database.prepare(
      `DELETE FROM task_groups
      WHERE group_id NOT IN (
        SELECT DISTINCT group_id
        FROM task_group_members
      )`,
    );
    const deleteDanglingGroupOrders = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'group'
        AND node_key NOT IN (
          SELECT group_id
          FROM task_groups
        )`,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      // Grouped workspace bootstrap is a one-time migration init. Record the global marker
      // so later new workspaces do not re-trigger automatic workspace-group creation.
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      for (const scope of params.scopes) {
        const rows = candidateRowsByWorkspaceKey.get(scope.workspaceKey);
        if (!rows) {
          continue;
        }
        // Init rebuild membership from the no-groups workspace perspective,
        // ignoring old groups so historical groups cannot keep tasks in non-workspace groups.
        const groupedRows = rows.sort((left, right) => {
          if (right.updated_at !== left.updated_at) {
            return right.updated_at - left.updated_at;
          }
          if (right.created_at !== left.created_at) {
            return right.created_at - left.created_at;
          }
          return left.task_id.localeCompare(right.task_id);
        });
        if (groupedRows.length === 0) {
          continue;
        }
        const groupId = workspaceGroupId(scope.workspaceKey);
        const title = workspaceGroupTitle(scope.workspacePath);
        insertGroup.run(groupId, title, workspaceGroupColor(scope.workspaceKey), now, now);
        if (!existingGroupOrderKeys.has(groupId)) {
          nextGroupSortOrder += GROUPED_TASK_ORDER_STEP;
          insertGroupOrder.run(groupId, nextGroupSortOrder, now, now);
          existingGroupOrderKeys.add(groupId);
        }
        groupedRows.forEach((row, index) => {
          deleteExistingMember.run(row.workspace_key, row.task_id);
          insertMember.run(
            groupId,
            row.workspace_key,
            row.workspace_path,
            row.workspace_identity,
            row.task_id,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
          deleteTopTaskOrder.run(
            taskOrderNodeKey({
              workspacePath: row.workspace_path,
              workspaceIdentity: row.workspace_identity ?? undefined,
              taskId: row.task_id,
            }),
          );
        });
        insertBootstrap.run(scope.workspaceKey, groupId, now, now);
      }
      deleteEmptyGroups.run();
      deleteDanglingGroupOrders.run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeRecord(record: TaskIndexWriteRecord): ZCodeTaskMeta {
    // searchable_text undefined means keep current value. Read the row once,
    // or ON CONFLICT assigns excluded.searchable_text = "" and blanks indexed bodies.
    const existing =
      record.searchableText === undefined
        ? this.getTaskRow({
            workspacePath: record.meta.workspacePath,
            workspaceIdentity: record.meta.workspaceIdentity,
            taskId: record.meta.taskId,
          })
        : null;
    const searchableText =
      record.searchableText !== undefined
        ? record.searchableText.slice(0, TASK_SEARCH_TEXT_MAX_CHARS)
        : (existing?.searchable_text ?? "");
    this.getDatabase()
      .prepare(
        `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = CASE
            WHEN @write_unread_at = 1 THEN excluded.unread_at
            ELSE tasks.unread_at
          END,
          last_unread_at = MAX(
            tasks.last_unread_at,
            COALESCE(tasks.unread_at, 0),
            CASE WHEN @write_unread_at = 1 THEN excluded.last_unread_at ELSE 0 END
          ),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json`,
      )
      .run({
        workspace_key: workspaceKey(record.meta),
        workspace_path: record.meta.workspacePath,
        workspace_identity: record.meta.workspaceIdentity ?? null,
        task_id: record.meta.taskId,
        title: record.meta.title,
        task_status: record.meta.status ?? null,
        provider: record.meta.provider ?? null,
        mode: record.meta.mode,
        model: record.meta.model ?? null,
        migration_source: record.meta.migrationSource ?? null,
        forked_from_task_id: record.meta.forkedFromTaskId ?? null,
        // Project cron automation identity into the index column (also kept in meta_json, see serializeMetaJson).
        cron_automation_id: record.meta.cronAutomationId ?? null,
        // Same projection for off-peak identity.
        off_peak_task_id: record.meta.offPeakTaskId ?? null,
        created_at: record.meta.createdAt,
        updated_at: record.meta.updatedAt,
        unread_at: record.meta.unreadAt ?? null,
        last_unread_at: record.meta.unreadAt ?? 0,
        write_unread_at: record.writeUnreadAt ? 1 : 0,
        pinned: record.pinned ? 1 : 0,
        archived: record.archived ? 1 : 0,
        deleted: record.deleted ? 1 : 0,
        title_overridden: record.titleOverridden ? 1 : 0,
        searchable_text: searchableText,
        meta_json: serializeMetaJson(record.meta),
      });
    const persisted = this.getTaskRow(record.meta);
    if (!persisted) {
      throw new Error(`task index missing task after write: ${record.meta.taskId}`);
    }
    return rowToMeta(persisted);
  }

  async syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    // Callers may compute bodies from snapshot.messages and pass them in to refresh searchable_text.
    // Omitted keeps sqlite's existing searchable_text (writeRecord is the fallback).
    searchableText?: string;
  }): Promise<ZCodeTaskMeta> {
    const result = await this.syncTaskMetaWithGroupedAdmission(params, false);
    return result.meta;
  }

  /** On first public root task, commit the task row and grouped root order atomically. */
  async syncTaskMetaAtGroupedTop(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    return this.syncTaskMetaWithGroupedAdmission(params, true);
  }

  private async syncTaskMetaWithGroupedAdmission(
    params: {
      meta: ZCodeTaskMeta;
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
      titleOverridden?: boolean;
      searchableText?: string;
    },
    initializeGroupedAtTop: boolean,
  ): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const database = this.getDatabase();
      if (initializeGroupedAtTop) database.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        const existingMeta = existing ? rowToMeta(existing) : null;
        const titleOverridden = params.titleOverridden ?? existing?.title_overridden === 1;
        // A snapshot's updatedAt is the runtime sessionStore's last structural-change time,
        // not necessarily including Date.now() bumps from session.titleUpdated / turn.completed.
        // Overwriting with params.meta.updatedAt would roll the just-written applyAgentPatch timestamp back,
        // pushing the session to the bottom again after its first prompt. Take max with the sqlite value; monotonic.
        const updatedAt = Math.max(params.meta.updatedAt, existingMeta?.updatedAt ?? 0);
        const preserveExistingTerminalStatus = shouldPreserveNewerTerminalStatus(
          existingMeta,
          params.meta,
        );
        const meta: ZCodeTaskMeta = {
          ...params.meta,
          // The agent owns only the session core title; user renames are app-side task state.
          // When syncing agent snapshots, keep the overridden title or background refreshes wash it out.
          title: titleOverridden && existingMeta ? existingMeta.title : params.meta.title,
          titleOverridden,
          // turn.completed writes a newer completed/error via applyAgentPatch first;
          // a later protocol snapshot may still say running - downgrading status here
          // makes phone replayable restore finished tasks as in-progress.
          status: preserveExistingTerminalStatus ? existingMeta?.status : params.meta.status,
          lastError: preserveExistingTerminalStatus
            ? existingMeta?.lastError
            : params.meta.lastError,
          target: Object.prototype.hasOwnProperty.call(params.meta, "target")
            ? params.meta.target
            : existingMeta?.target,
          // After a Claude Code import upgrades to a real ZCode session, the protocol snapshot
          // itself ignores the migration source. Keep the existing migrationSource on runtime sync, or list filters
          // and later model switches reclassify the import as a plain ZCode task.
          migrationSource: params.meta.migrationSource ?? existingMeta?.migrationSource,
          // Keep the cron automation identity on runtime sync: runtime snapshot meta carries no cron mark,
          // and without the stored fallback later syncs wash it, breaking icon/group/lookup.
          cronAutomationId: params.meta.cronAutomationId ?? existingMeta?.cronAutomationId,
          // Same off-peak fallback: preserve ownership when the snapshot has no mark.
          offPeakTaskId: params.meta.offPeakTaskId ?? existingMeta?.offPeakTaskId,
          updatedAt,
          unreadAt: params.meta.unreadAt ?? existingMeta?.unreadAt,
        };
        const persistedMeta = this.writeRecord({
          meta,
          pinned: params.pinned ?? existing?.pinned === 1,
          archived: params.archived ?? existing?.archived === 1,
          deleted: params.deleted ?? existing?.deleted === 1,
          titleOverridden,
          searchableText: params.searchableText,
        });
        // On a cron session's first cronAutomationId, file it into the fixed cron group.
        // In-session CronCreate marks an existing task; testing only !existing would never group it.
        // INSERT OR IGNORE keeps membership - a task dragged out of the cron group stays out.
        if (meta.cronAutomationId && !existingMeta?.cronAutomationId) {
          this.ensureCronGroupMembership(meta);
        }
        // On first offPeakTaskId, file into the fixed off-peak system group (same mechanism as cron).
        if (meta.offPeakTaskId && !existingMeta?.offPeakTaskId) {
          this.ensureOffPeakGroupMembership(meta);
        }
        // Root-draft first send used to commit the task row, then sort_order in a second write;
        // sessions-index exposing the task between writes made the Renderer append the unordered node.
        const initializedGroupedOrder = initializeGroupedAtTop
          ? this.initializeGroupedTaskAtTopReady(meta)
          : false;
        if (initializeGroupedAtTop) database.exec("COMMIT");
        return { meta: persistedMeta, initializedGroupedOrder };
      } catch (error) {
        if (initializeGroupedAtTop) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * File a cron session into the fixed cron system group (see CRON_DEFAULT_GROUP_ID).
   * Idempotent: group row, view order, membership all INSERT OR IGNORE, never overriding manual sorting.
   * Called once from syncTaskMeta on the session's first cronAutomationId.
   */
  private ensureCronGroupMembership(meta: ZCodeTaskMeta): void {
    this.ensureSystemGroupMembership(meta, {
      groupId: CRON_DEFAULT_GROUP_ID,
      title: "cron",
      color: "blue",
    });
  }

  /**
   * File an off-peak session into the fixed off-peak system group (see OFF_PEAK_DEFAULT_GROUP_ID).
   * Mirrors the cron mechanism; called on first offPeakTaskId from syncTaskMeta,
   * or by bootstrap backfill for existing rows.
   */
  private ensureOffPeakGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): void {
    // Off-peak does not support remote workspaces: marked remote sessions never join the off-peak system group.
    if (meta.workspaceIdentity && isRemoteWorkspaceIdentity(meta.workspaceIdentity)) {
      return;
    }
    this.ensureSystemGroupMembership(meta, {
      groupId: OFF_PEAK_DEFAULT_GROUP_ID,
      title: "off-peak",
      color: "purple",
    });
  }

  private ensureSystemGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
    params: { groupId: string; title: string; color: string },
  ): void {
    const database = this.getDatabase();
    const now = Date.now();
    database
      .prepare(
        `INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(params.groupId, params.title, params.color, now, now);
    // Group view order: insert-if-missing (OR IGNORE) so each new system-group session never reshuffles the group.
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at)
        VALUES ('group', ?, ?, ?, ?)`,
      )
      .run(params.groupId, this.getNextGroupedTopSortOrder(), now, now);
    // OR IGNORE: an existing membership (user-grouped) stays untouched.
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        params.groupId,
        workspaceKey(meta),
        meta.workspacePath,
        meta.workspaceIdentity ?? null,
        meta.taskId,
        now,
        now,
        now,
      );
  }

  /**
   * Write baseline metadata only when the index row is missing; existing (incl. deleted) shell state stays.
   *
   * A remote workspace's V4 session path may establish sessions-index later than session creation.
   // The first snapshot must fill a brand-new tasks-index.sqlite, but summary defaults must not
   // override existing pin/archive/unread/manual titles, nor race the full snapshot that follows.
   */
  async seedTaskMetaIfMissing(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(meta, () => {
      const existing = this.getTaskRow(meta);
      if (existing) {
        return rowToMeta(existing);
      }
      return this.writeRecord({
        meta,
        pinned: false,
        archived: false,
        deleted: false,
        titleOverridden: meta.titleOverridden ?? false,
      });
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index has no task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        if (current.unreadAt !== params.expectedUnreadAt) {
          database.exec("COMMIT");
          return { meta: current, cleared: false };
        }

        const nextMeta: ZCodeTaskMeta = {
          ...current,
          unreadAt: undefined,
        };
        // A phone read receipt may land after a newer terminal unread. Compare and write under the same
        // SQLite write transaction, or the old click unconditionally clears the newer unreadAt.
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: row.pinned === 1,
          archived: row.archived === 1,
          deleted: false,
          titleOverridden: row.title_overridden === 1,
          writeUnreadAt: true,
        });
        database.exec("COMMIT");
        return { meta: persistedMeta, cleared: true };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // The confirm dialog may linger while another end restores; archive check and tombstone write share one transaction,
        // never read-then-delete. Skip deleted/missing too, so retries cannot resurrect after the CLI seed.
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      const deleting = params.patch.deleted === true;
      const requestedUnreadAt = params.patch.unreadAt;
      const allocatingUnreadAt = typeof requestedUnreadAt === "number";
      const mutatingUnreadAt = "unreadAt" in params.patch;
      const transactional = deleting || mutatingUnreadAt;
      if (transactional) {
        database.exec("BEGIN IMMEDIATE");
      }
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index has no task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        // Millisecond timestamps can give two logical reads of one task the same version,
        // and after clearing unreadAt the current value alone reuses the old version. Inside the SQLite write lock,
        // allocate strictly increasing markers from a persistent watermark that clearing never resets.
        const lastUnreadAt = Math.max(
          row.last_unread_at,
          row.unread_at ?? 0,
          current.unreadAt ?? 0,
        );
        const unreadAt = allocatingUnreadAt
          ? Math.max(requestedUnreadAt, lastUnreadAt + 1)
          : "unreadAt" in params.patch
            ? undefined
            : current.unreadAt;
        const nextMeta: ZCodeTaskMeta = {
          ...current,
          title: params.patch.title ?? current.title,
          titleOverridden: params.patch.titleOverridden ?? current.titleOverridden,
          model: params.patch.model ?? current.model,
          updatedAt: params.patch.updatedAt ?? current.updatedAt,
          unreadAt,
          status: params.patch.status ?? current.status,
          lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
          target: "target" in params.patch ? params.patch.target : current.target,
        };
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: params.patch.pinned ?? row.pinned === 1,
          archived: params.patch.archived ?? row.archived === 1,
          deleted: params.patch.deleted ?? row.deleted === 1,
          titleOverridden: params.patch.titleOverridden ?? row.title_overridden === 1,
          writeUnreadAt: mutatingUnreadAt,
        });
        if (deleting) {
          // The delete mark and grouped references must commit atomically; any partial failure leaves
          // sessions-index content, task visibility, and SQLite grouping contradictory for a long time.
          this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
        }
        if (transactional) database.exec("COMMIT");
        return persistedMeta;
      } catch (error) {
        if (transactional) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: Pick<TaskIndexStatePatch, "title" | "status" | "lastError" | "target" | "updatedAt">;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const row = this.getTaskRow(params);
      if (!row || row.deleted === 1) {
        return null;
      }
      const current = rowToMeta(row);
      const canAcceptAgentTitle = row.title_overridden !== 1;
      const nextMeta: ZCodeTaskMeta = {
        ...current,
        title: canAcceptAgentTitle && params.patch.title ? params.patch.title : current.title,
        titleOverridden: row.title_overridden === 1,
        updatedAt: params.patch.updatedAt ?? current.updatedAt,
        status: params.patch.status ?? current.status,
        lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
        target: "target" in params.patch ? params.patch.target : current.target,
      };
      return this.writeRecord({
        meta: nextMeta,
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        deleted: row.deleted === 1,
        titleOverridden: row.title_overridden === 1,
      });
    });
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas queries all tasks without workspacePath, but workspaceKey requires the path.
    // Narrow the optional input into an explicit workspace target so types never mix global and scoped queries.
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND (@include_deleted = 1 OR deleted = 0)
          -- filtered by the request's runtime provider; migration source stored separately in migration_source.
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  /**
   * Read the workspace's deletion tombstones.
   *
   // The CLI session store keeps session content; a list join reading only active/pinned/archived
   // misclasses deleted tasks as plain (not in archived) and they reappear after cold start.
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  /**
   * List every cron session of one automation (detail expansion, related lookups).
   // Uses the cron_automation_id index column, returns non-deleted sessions, newest first.
   */
  async listSessionsByAutomation(automationId: string): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE cron_automation_id = @automation_id
          AND deleted = 0
        ORDER BY created_at DESC, task_id DESC`,
      )
      .all({ automation_id: automationId }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    if (workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = ["deleted = 0", `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`];
    const args: Array<string | number> = [...workspaceKeys];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // Title-only matching never hit chat bodies; TaskSearchDialog could not find content for ages.
      // Now a title or searchable_text hit matches; body snippets are built at result time.
      where.push("(LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)");
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    const orderBy =
      params.sortBy === "created"
        ? "created_at DESC, updated_at DESC, task_id DESC"
        : "updated_at DESC, created_at DESC, task_id DESC";
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as TaskIndexRow[];
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > rows.length,
    };
  }

  async createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const now = Date.now();
    const id = `task-group-${randomUUID()}`;
    const title = params?.title?.trim() || "New Group";
    const color = params?.color ?? DEFAULT_TASK_GROUP_COLOR;
    this.getDatabase()
      .prepare(
        `INSERT INTO task_groups (
          group_id,
          title,
          color,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, color, now, now);
    // New content must enter user ordering at once, inserted at the top of the current mixed list;
    // never rely on created_at mixed with legacy sort_order - different scales drift positions after refresh.
    this.upsertGroupedTopOrder({
      nodeType: "group",
      nodeKey: id,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return {
      id,
      title,
      color,
      createdAt: now,
      updatedAt: now,
    };
  }

  async renameTaskGroup(params: { groupId: string; title: string }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const title = params.title.trim() || "New Group";
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET title = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(title, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group not found; cannot rename");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Failed to read task group after rename");
    }
    return rowToTaskGroup(row);
  }

  async updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    if (!isTaskGroupColor(params.color)) {
      throw new Error("Invalid task group color");
    }
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET color = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(params.color, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group not found; cannot update color");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Failed to read task group after color update");
    }
    return rowToTaskGroup(row);
  }

  async deleteTaskGroup(params: { groupId: string }): Promise<void> {
    await this.ensureReady();
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database
        .prepare("DELETE FROM task_groups WHERE group_id = ?")
        .run(params.groupId);
      if (result.changes === 0) {
        throw new Error("Task group not found; cannot delete");
      }
      database
        .prepare(
          `DELETE FROM task_group_view_node_orders
          WHERE node_type = 'group' AND node_key = ?`,
        )
        .run(params.groupId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async initializeGroupedTaskAtTop(params: ZCodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    return this.initializeGroupedTaskAtTopReady(params);
  }

  private initializeGroupedTaskAtTopReady(params: ZCodeGroupedTaskRef): boolean {
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
      return false;
    }
    const database = this.getDatabase();
    const existingMember = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?
        LIMIT 1`,
      )
      .get(workspaceKey(params), params.taskId) as { found: number } | undefined;
    const nodeKey = taskOrderNodeKey(params);
    const existingTopOrder = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_view_node_orders
        WHERE node_type = 'task' AND node_key = ?
        LIMIT 1`,
      )
      .get(nodeKey) as { found: number } | undefined;
    if (existingMember || existingTopOrder) {
      return false;
    }
    const now = Date.now();
    // Session-visible and missing-title rows can both trigger full snapshot re-sync concurrently.
    // Root order initializes on first appearance only; a duplicate re-sync assigning minimal sort_order again
    // lets the slower older task jump over newer tasks, making final order depend on async completion timing.
    this.upsertGroupedTopOrder({
      nodeType: "task",
      nodeKey,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return true;
  }

  // Transition surface: grouped consumers moved to sessions-index + queryGroupedTaskViewStructure;
  // only the applyGroupedTaskViewOrder reply still uses this (the UI no longer trusts it),
  // closing out together with that return surface.
  async queryGroupedTaskView(
    params: ZCodeGroupedTaskViewQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const includeAllWorkspaces = params.includeAllWorkspaces === true;
    const requestedWorkspaceScopes = normalizeWorkspaceBootstrapScopes(params.workspaceScopes);
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    const activeTaskWhere = [
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      ...(includeAllWorkspaces
        ? []
        : [`workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`]),
    ];
    const activeTaskArgs: Array<string | number> = includeAllWorkspaces ? [] : [...workspaceKeys];
    if (params.provider) {
      // Grouped and workspace are both ZCode Agent task list entries and must share the legacy-provider
      // residual filter, or historical claude/codex/gemini index rows resurface only in grouped.
      appendZCodeAgentIndexedProviderFilter(activeTaskWhere, activeTaskArgs, params.provider);
    }
    const activeTasks =
      !includeAllWorkspaces && workspaceKeys.length === 0
        ? []
        : (this.getDatabase()
            .prepare(
              `SELECT
                workspace_key,
                workspace_path,
                workspace_identity,
                task_id,
                title,
                task_status,
                provider,
                mode,
                model,
                migration_source,
                forked_from_task_id,
                cron_automation_id,
                created_at,
                updated_at,
                unread_at,
                pinned,
                archived,
                deleted,
                title_overridden,
                searchable_text,
                meta_json
              FROM tasks
              WHERE ${activeTaskWhere.join(" AND ")}`,
            )
            .all(...activeTaskArgs) as unknown as TaskIndexRow[]);
    const workspaceScopes = includeAllWorkspaces
      ? normalizeWorkspaceBootstrapScopes(
          activeTasks.map((row) => ({
            workspacePath: row.workspace_path,
            workspaceIdentity: row.workspace_identity ?? undefined,
          })),
        )
      : requestedWorkspaceScopes;
    this.bootstrapWorkspaceGroupsForActiveTasks({
      scopes: workspaceScopes,
      activeTasks,
    });
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const visibleWorkspaceKeys = new Set(
      includeAllWorkspaces ? activeTasks.map((task) => task.workspace_key) : workspaceKeys,
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const members = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const orderByNodeKey = new Map(
      orderRows.map((row) => [`${row.node_type}:${row.node_key}`, row]),
    );
    const memberByTaskKey = new Map(
      members.map((member) => [`${member.workspace_key}\u0000${member.task_id}`, member]),
    );
    const membersByGroupId = new Map<string, TaskGroupMemberRow[]>();
    for (const member of members) {
      const groupMembers = membersByGroupId.get(member.group_id) ?? [];
      groupMembers.push(member);
      membersByGroupId.set(member.group_id, groupMembers);
    }

    const activeTaskByKey = new Map(
      activeTasks.map((row) => [
        `${row.workspace_key}\u0000${row.task_id}`,
        rowToTaskListItem(row, null),
      ]),
    );
    const groupedVisibleTaskKeys = new Set<string>();
    const nodes: ZCodeGroupedTaskViewNode[] = groups.map((group) => {
      const groupTasks = (membersByGroupId.get(group.id) ?? [])
        .map((member) => activeTaskByKey.get(`${member.workspace_key}\u0000${member.task_id}`))
        .filter((task): task is ZCodeTaskListItem => Boolean(task));
      if (group.id === CRON_DEFAULT_GROUP_ID) {
        // The cron system group skips manual ordering, fixed newest-first by creation time.
        groupTasks.sort(compareCronGroupTasks);
      } else {
        this.normalizeGroupMemberOrders(group.id, groupTasks, memberByTaskKey);
        groupTasks.sort((left, right) => compareGroupTasks(left, right, memberByTaskKey));
      }
      for (const task of groupTasks) {
        groupedVisibleTaskKeys.add(taskNodeKey(task));
      }
      const order = orderByNodeKey.get(`group:${group.id}`);
      return {
        type: "group",
        group,
        tasks: groupTasks,
        ...(order ? { sortOrder: order.sort_order } : {}),
      };
    });

    for (const task of activeTaskByKey.values()) {
      const key = taskNodeKey(task);
      if (memberByTaskKey.has(key) || groupedVisibleTaskKeys.has(key)) {
        continue;
      }
      const order = orderByNodeKey.get(`task:${taskOrderNodeKey(task)}`);
      nodes.push({
        type: "task",
        task,
        ...(order ? { sortOrder: order.sort_order } : {}),
      });
    }

    // On first query, promote every visible root node into user ordering; afterwards only sort_order counts.
    this.normalizeGroupedTopNodeOrders(nodes, orderByNodeKey);
    nodes.sort(compareGroupedNodes);
    return { nodes };
  }

  /**
   * Grouped raw structure read (no tasks join, no bootstrap/normalize write-back).
   // Task content comes from sessions-index, joined client-side; returns group/member/root-order tables only.
   // Group visibility mirrors queryGroupedTaskView: the bootstrap workspace group is visible in its workspace only.
   */
  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  }): Promise<ZCodeGroupedTaskViewStructure> {
    await this.ensureReady();
    const visibleWorkspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const memberRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const members: ZCodeGroupedTaskViewStructureMember[] = memberRows.map((row) => ({
      groupId: row.group_id,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
      taskId: row.task_id,
      sortOrder: row.sort_order,
      addedAt: row.added_at,
    }));
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[] = [];
    for (const row of orderRows) {
      if (row.node_type === "group") {
        topLevelOrders.push({
          type: "group",
          groupId: row.node_key,
          sortOrder: row.sort_order,
        });
        continue;
      }
      // task node_key = JSON.stringify([workspaceKey, taskId]) (NUL separators truncate in sqlite TEXT).
      try {
        const parsed = JSON.parse(row.node_key) as unknown;
        if (
          Array.isArray(parsed) &&
          typeof parsed[0] === "string" &&
          typeof parsed[1] === "string"
        ) {
          topLevelOrders.push({
            type: "task",
            workspaceKey: parsed[0],
            taskId: parsed[1],
            sortOrder: row.sort_order,
          });
        }
      } catch {
        // Skip legacy dirty node_keys; the client orders by createdAt in memory, no crash.
      }
    }
    return { groups, members, topLevelOrders };
  }

  async applyGroupedTaskViewOrder(
    params: ZCodeGroupedTaskViewOrderInput & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const workspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const now = Date.now();
    const database = this.getDatabase();

    const groupIds = new Set(
      (
        database.prepare("SELECT group_id FROM task_groups").all() as Array<{
          group_id: string;
        }>
      ).map((row) => row.group_id),
    );
    const validateTaskRef = (task: ZCodeGroupedTaskRef): string | null => {
      const key = workspaceKey(task);
      if (!workspaceKeys.has(key)) {
        throw new Error("Grouped task order contains a task outside the current scope");
      }
      const row = this.getTaskRow(task);
      if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
        throw new Error("Grouped task order contains an invisible task");
      }
      if (params.provider && row.provider !== params.provider) {
        // Grouped order saves had no provider boundary; legacy gemini/codex/claude orderings resurfaced after save.
        // The provider-bearing ZCode Agent view accepts current glm tasks only; legacy references skip as invisible legacy.
        return null;
      }
      return key;
    };

    const topLevelTaskKeys = new Set<string>();
    const groupedTaskKeys = new Set<string>();
    const visibleTopLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[] = [];
    const visibleGroups: Array<{ groupId: string; taskRefs: ZCodeGroupedTaskRef[] }> = [];
    for (const node of params.topLevelNodes) {
      if (node.type === "group") {
        if (!groupIds.has(node.groupId)) {
          throw new Error("Grouped task order contains a missing group");
        }
        visibleTopLevelNodes.push(node);
        continue;
      }
      const workspaceKey = validateTaskRef(node.task);
      if (!workspaceKey) {
        continue;
      }
      const key = `${workspaceKey}\u0000${node.task.taskId}`;
      topLevelTaskKeys.add(key);
      visibleTopLevelNodes.push(node);
    }
    for (const group of params.groups) {
      if (!groupIds.has(group.groupId)) {
        throw new Error("Grouped task order contains a missing group");
      }
      const visibleTaskRefs: ZCodeGroupedTaskRef[] = [];
      for (const taskRef of group.taskRefs) {
        const workspaceKey = validateTaskRef(taskRef);
        if (!workspaceKey) {
          continue;
        }
        const key = `${workspaceKey}\u0000${taskRef.taskId}`;
        if (groupedTaskKeys.has(key)) {
          throw new Error("Grouped task order cannot put one task into multiple groups");
        }
        groupedTaskKeys.add(key);
        visibleTaskRefs.push(taskRef);
      }
      visibleGroups.push({ groupId: group.groupId, taskRefs: visibleTaskRefs });
    }

    const scopedTaskOrderKeys =
      workspaceKeys.size === 0
        ? []
        : (
            database
              .prepare(
                `SELECT workspace_key, task_id
              FROM tasks
              WHERE workspace_key IN (${[...workspaceKeys].map(() => "?").join(", ")})`,
              )
              .all(...workspaceKeys) as Array<{
              workspace_key: string;
              task_id: string;
            }>
          ).map((row) => `${row.workspace_key}\u0000${row.task_id}`);

    database.exec("BEGIN IMMEDIATE");
    try {
      const markWorkspaceBootstrapDisabled = database.prepare(
        `INSERT INTO task_group_workspace_bootstraps (
          workspace_key,
          group_id,
          created_at,
          updated_at
        ) VALUES (?, NULL, ?, ?)
        ON CONFLICT(workspace_key) DO UPDATE SET
          updated_at = excluded.updated_at`,
      );
      // Once the user saves grouped order explicitly, later queries must not run workspace auto-init.
      // Write the global marker so new workspaces never re-trigger migration-style workspace-group init.
      markWorkspaceBootstrapDisabled.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      const deleteMembership = database.prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      );
      const upsertMembership = database.prepare(
        `INSERT INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          group_id = excluded.group_id,
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      );
      for (const key of topLevelTaskKeys) {
        const [targetWorkspaceKey, taskId] = key.split("\u0000");
        if (!targetWorkspaceKey || !taskId) {
          throw new Error("Grouped task order has an invalid root task key");
        }
        deleteMembership.run(targetWorkspaceKey, taskId);
      }
      for (const group of visibleGroups) {
        group.taskRefs.forEach((taskRef, index) => {
          const targetWorkspaceKey = workspaceKey(taskRef);
          upsertMembership.run(
            group.groupId,
            targetWorkspaceKey,
            taskRef.workspacePath,
            taskRef.workspaceIdentity ?? null,
            taskRef.taskId,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
        });
      }

      // Commit final order once, so menu/draft/ungroup changes never leave partial writes.
      database.prepare("DELETE FROM task_group_view_node_orders WHERE node_type = 'group'").run();
      const deleteTaskOrder = database.prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      );
      // Clean task order within the current workspace scope only, or this change wipes mixed order of remote/unexpanded workspaces.
      for (const nodeKey of scopedTaskOrderKeys) {
        const [targetWorkspaceKey, taskId] = nodeKey.split("\u0000");
        if (!targetWorkspaceKey || !taskId) {
          continue;
        }
        deleteTaskOrder.run(JSON.stringify([targetWorkspaceKey, taskId]), targetWorkspaceKey);
      }
      const insertOrder = database.prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      visibleTopLevelNodes.forEach((node, index) => {
        const nodeType = node.type;
        const nodeKey = node.type === "group" ? node.groupId : taskOrderNodeKey(node.task);
        insertOrder.run(nodeType, nodeKey, (index + 1) * GROUPED_TASK_ORDER_STEP, now, now);
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return this.queryGroupedTaskView({
      workspaceScopes: params.workspaceScopes,
      provider: params.provider,
    });
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
