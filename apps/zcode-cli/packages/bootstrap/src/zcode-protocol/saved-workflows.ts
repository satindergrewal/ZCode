// The GUI hub for saved workflows: workspace-scoped, session-less methods.
//
// Same precedent as skills/referenceCatalog: no sessionId; every call scans the directory fresh -- a mount-time snapshot misses
// user edits / files a model just SaveWorkflow'd.
// Parsers and serializers come only from @zcode/core: no frontmatter parsing, no YAML assembly here.
//
// Global scope: the five methods take an optional `scope` (default
// `project`). `global` operates on the machine-global root (`~/.zcode/workflows/`); `workspace` is only the **carrier** --
// handlers never read its path for global entries. `workflows/move` moves a global entry back into the `workspace` project (the only direction).
import { unlink, writeFile } from "node:fs/promises";
import { SavedWorkflowMetaSchema, isValidSavedWorkflowName } from "@zcode/contracts";
import {
  listSavedWorkflows,
  moveSavedWorkflow,
  resolveSavedWorkflow,
  savedWorkflowPath,
  savedWorkflowRoot,
  serializeSavedWorkflow,
  type SavedWorkflowResolveFailure,
} from "@zcode/core";
import {
  ZCODE_WORKFLOWS_RUNS_MAX_LIMIT,
  zcodeWorkflowsDeleteParamsSchema,
  zcodeWorkflowsGetParamsSchema,
  zcodeWorkflowsListParamsSchema,
  zcodeWorkflowsMoveParamsSchema,
  zcodeWorkflowsRunsParamsSchema,
  zcodeWorkflowsUpdateMetaParamsSchema,
  type ZCodeSavedWorkflowRun,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkflowsDeleteResult,
  type ZCodeWorkflowsGetResult,
  type ZCodeWorkflowsListResult,
  type ZCodeWorkflowsMoveResult,
  type ZCodeWorkflowsRunsResult,
  type ZCodeWorkflowsUpdateMetaResult,
} from "@zcode/shared";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { artifactsOf } from "../app/dynamic-workflow-run-observation.js";
import {
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
} from "../app/dynamic-workflow-run-service.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

// Default is `project`: legacy GUI and project-entry calls without a scope hit this project's root verbatim, shape unchanged (version skew).
function scopeOf(params: { scope?: ZCodeSavedWorkflowScope }): ZCodeSavedWorkflowScope {
  return params.scope ?? "project";
}

export async function listSavedWorkflowsOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsListResult> {
  const params = parseParams(zcodeWorkflowsListParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const scope = scopeOf(params);
    // The hub's PROJECT group lists only this project's copy, the global group only the global one -- **always** pass a directed scope, never the
    // direction-less variant (two-root first-wins would leak global into the project group and hide the shadowed global from the global group).
  const listed = listSavedWorkflows({ cwd, scope });
    // The scanned dirs, returned even when absent: the GUI's file watcher needs them to watch.
  return {
    workflows: listed.entries,
    invalid: listed.invalid,
    dir: savedWorkflowRoot(cwd, scope).dir,
  };
}

export async function getSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsGetResult> {
  const params = parseParams(zcodeWorkflowsGetParamsSchema, rawParams);
    // Directed scope: `global` checks only the global root, no shadowing -- the hub's global group must see the entry shadowed by the project copy.
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  return {
    ok: true,
    name: resolved.name,
    path: resolved.path,
    scope: resolved.scope,
    meta: resolved.meta,
    script: resolved.script,
  };
}

/**
  * Rewrites only the header metadata: read the current script body, then overwrite the file with `serialize(newMeta, script)`.
  * Read-modify-write within one call; no three-way merge (small file, one machine, the user is editing).
 */
export async function updateSavedWorkflowMetaOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsUpdateMetaResult> {
  const params = parseParams(zcodeWorkflowsUpdateMetaParamsSchema, rawParams);
    // shared's and contracts' meta schemas match verbatim, but the serializer takes contracts' type; one more pass makes
    // any drift explode here as -32602 instead of writing a file we could not read back.
  const meta = SavedWorkflowMetaSchema.parse(params.meta);
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  await writeFile(resolved.path, serializeSavedWorkflow(meta, resolved.script), "utf8");
  return { ok: true, path: resolved.path };
}

/**
  * Delete by name only: `isValidSavedWorkflowName` precedes path joins -- that order IS the path-traversal defense
  * (store.ts's argument again), so the protocol takes no paths and no `..`. Root by scope (no more hardcoded roots[0]):
  * `global` deletes the machine-global copy. A same-named legacy `.workflow.js` belongs to another parser; out of scope.
 */
export async function deleteSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsDeleteResult> {
  const params = parseParams(zcodeWorkflowsDeleteParamsSchema, rawParams);
  if (!isValidSavedWorkflowName(params.name)) {
    return { ok: false, reason: "invalid_name" };
  }
  const root = savedWorkflowRoot(params.workspace.workspacePath, scopeOf(params));
  const path = savedWorkflowPath(root, params.name);
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "read_error", detail: describeError(error) };
  }
  return { ok: true, path };
}

/**
  * Run history, attributed to workflows by `dwf_run.name`. Journal only: the hub lives outside any session and cannot see
  * the registry gap of "submit returned, row not yet written" -- those microtasks are healed by the next refresh; not worth binding the hub to a session.
  * Without a journal (injected test stores, impls without introspection) return an empty page, not a throw: the hub shows "never run".
 *
  * `project` (default): only `dwf_run.cwd === workspacePath`. `global`: **no** cwd filter -- the name's history across all
  * projects (global workflows run anywhere, so history spans cwds); each row returns `cwd` for the GUI to label the project.
 */
export async function listSavedWorkflowRunsOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsRunsResult> {
  const params = parseParams(zcodeWorkflowsRunsParamsSchema, rawParams);
  const journal = resolveDynamicWorkflowJournalStore(context.deps.sessionStore);
  if (journal === undefined || !supportsRunIntrospection(journal)) return { runs: [] };
  const limit = Math.min(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT, params.limit);
  const global = scopeOf(params) === "global";
    // One extra row **only to decide truncated** (the same convention as run service and v4 event paging).
    // The global variant drops the cwd predicate (journal cwd optional = across all projects); the project variant passes cwd, verbatim.
  const rows = journal.listRuns({
    ...(global ? {} : { cwd: params.workspace.workspacePath }),
    limit: limit + 1,
    ...(params.name === undefined ? {} : { name: params.name }),
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
    // Artifact summary: one `listArtifactRows` per row (the journal's durable home), only when the capability exists -- absent means
    // the whole field is absent and the hub draws no chips. Fetched **only for this page's rows**, so cost scales with page size (<=50).
  const artifactsByRun = savedWorkflowRunArtifacts(journal, page);
  const runs: ZCodeSavedWorkflowRun[] = page.map((row) => ({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    status: row.status,
    ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
    spentTokens: row.spentTokens,
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    ...(row.args === undefined ? {} : { args: row.args }),
        // The project dir that actually ran: the global variant labels each row with it; in the project variant it always equals workspacePath, harmless.
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    ...(artifactsByRun.get(row.runId) === undefined
      ? {}
      : { artifacts: artifactsByRun.get(row.runId)! }),
  }));
  return { runs, ...(truncated ? { truncated: true } : {}) };
}

/** Hub chips bound: how many kind icons fit on one row (same as the protocol schema's `.max(8)`). */
const SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT = 8;

/**
  * One page of run rows -> each row's **user-facing artifact** summary.
 *
  * Terminology: artifact = what the script published for the user via `artifact.*`, not the script's top-level return
  * (the engine-internal `RunSettlement.artifact`).
 *
  * Fetched via {@link artifactsOf}: the **same merge rules** as snapshot / `GetWorkflowRun` (completed rows only,
  * per-id version ascending, top-level fields from the latest); the hub reimplementing them would make one run's artifacts differ
  * between hub and side panel. `listArtifactRows` is not on the engine port, so capability probing happens inside `artifactsOf`:
  * absent => no row gets entries => the field is absent entire (legacy CLIs / injected test stores unchanged verbatim).
 *
  * Runs without parts stay out of the table -- callers make the whole field absent rather than emit an empty array.
 */
function savedWorkflowRunArtifacts(
  journal: JournalStorePort,
  page: readonly { runId: string }[],
): Map<string, ZCodeSavedWorkflowRun["artifacts"]> {
  const byRun = new Map<string, ZCodeSavedWorkflowRun["artifacts"]>();
  for (const row of page) {
    const { artifacts } = artifactsOf(row.runId, journal);
    if (artifacts === undefined || artifacts.length === 0) continue;
    byRun.set(
      row.runId,
      artifacts.slice(0, SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT).map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        ...(artifact.title === undefined ? {} : { title: artifact.title }),
        version: artifact.version,
        ...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
      })),
    );
  }
  return byRun;
}

/**
  * Moves the same-named file from the machine-global root into the `workspace` project root (one direction only: project->global is the model's "promote to global", not a file move). Byte-exact
  * copy (frontmatter stores no scope), no overwrite (target exists => reject, invariant 7). Name validated before the path join.
  * `workspace` is both carrier and target project: core derives both roots from its cwd and the machine home.
 */
export async function moveSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsMoveResult> {
  const params = parseParams(zcodeWorkflowsMoveParamsSchema, rawParams);
  const result = moveSavedWorkflow({ cwd: params.workspace.workspacePath, name: params.name });
  if (result.ok) {
    return { ok: true, from: result.from, to: result.to };
  }
    // core's failure branches align verbatim with the protocol result; path / detail pass through when present (absent = key omitted).
  switch (result.reason) {
    case "invalid_name":
      return { ok: false, reason: "invalid_name", detail: result.detail };
    case "not_found":
      return { ok: false, reason: "not_found" };
    case "target_exists":
      return { ok: false, reason: "target_exists", path: result.path };
    case "read_error":
    case "write_error":
      return { ok: false, reason: result.reason, path: result.path, detail: result.detail };
  }
}

function toFailure(failure: SavedWorkflowResolveFailure) {
  switch (failure.reason) {
    case "invalid_name":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
    case "not_found":
      return { ok: false as const, reason: failure.reason };
    case "parse_error":
    case "read_error":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
