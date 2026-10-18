// Two methods from one run (docs/dynamic-workflow/transcript-and-notifications.md
// "Saving the run, and running it again"): save the script this run executed as a definition, and answer
// "which saved workflow this run corresponds to".
//
// Same discipline as saved-workflows.ts (parser, serializer, name rules, typechecker all from @zcode/core only,
// invariant 3); the split only guards the 400-line gate.
//
// Why save takes a runId, not the script: the body worth writing is the one this run actually executed, and it lives in the journal
// (`scriptText`). A detour through the caller breaks twice: a revised run must store the settling copy, and the tool row
// In conversations whose input the snapshot trimmed to a preview, the caller holds no full script at all.
import {
  SavedWorkflowMetaSchema,
  isValidSavedWorkflowName,
  type SavedWorkflowScope,
} from "@zcode/contracts";
import {
  analyzeScript,
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowPath,
  savedWorkflowRoot,
  type ResolvedSavedWorkflow,
} from "@zcode/core";
import {
  zcodeWorkflowsForRunParamsSchema,
  zcodeWorkflowsSaveParamsSchema,
  type ZCodeSavedWorkflowEntry,
  type ZCodeWorkflowsForRunResult,
  type ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import type { RunRecord } from "@zcode/dynamic-workflow";
import { resolveDynamicWorkflowJournalStore } from "../app/dynamic-workflow-run-service.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Bound on diagnostics returned to the GUI: the dialog fits only the first few; the full set belongs to the model path. */
const SAVE_DIAGNOSTICS_MAX_LINES = 5;
const SAVE_DIAGNOSTICS_MAX_CHARS = 1_000;

/**
 * Cap on files the script comparison scans. A project's definitions number in the tens; a constant only keeps a pathological
 // dir (thousands of files dumped into .zcode/workflows/) from turning one query into a full disk read.
 */
const SCRIPT_MATCH_SCAN_LIMIT = 50;

function scopeOf(params: { scope?: SavedWorkflowScope }): SavedWorkflowScope {
  return params.scope ?? "project";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDiagnostics(
  diagnostics: readonly { line: number; column: number; message: string }[],
): string {
  const text = diagnostics
    .slice(0, SAVE_DIAGNOSTICS_MAX_LINES)
    .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
    .join("\n");
  return text.length > SAVE_DIAGNOSTICS_MAX_CHARS
    ? `${text.slice(0, SAVE_DIAGNOSTICS_MAX_CHARS)}…`
    : text;
}

/** Resolution -> protocol entry (same shape as a `workflows/list` row, no script body). */
function entryOf(resolved: ResolvedSavedWorkflow): ZCodeSavedWorkflowEntry {
  return {
    name: resolved.name,
    description: resolved.meta.description,
    ...(resolved.meta.whenToUse === undefined ? {} : { whenToUse: resolved.meta.whenToUse }),
    ...(resolved.meta.args === undefined ? {} : { args: resolved.meta.args }),
    scope: resolved.scope,
    path: resolved.path,
  };
}

function runRecordOf(
  context: ZCodeProtocolAgentServerContext,
  runId: string,
): RunRecord | undefined {
  const journal = resolveDynamicWorkflowJournalStore(context.deps.sessionStore);
  return journal?.getRun(runId);
}

/**
 * The completion card's direct-save: fetch the script by runId, persist under SaveWorkflow's rules.
 *
 // Order mirrors the tool: name validity -> script availability -> overwrite check -> typecheck -> write. Overwrite precedes typecheck
 // because "a same-named one exists" is the caller's question to answer first, and a compile failure writes nothing anyway.
 */
export async function saveSavedWorkflowFromRunOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsSaveResult> {
  const params = parseParams(zcodeWorkflowsSaveParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const scope = scopeOf(params);
  // Name first, path built second: that order is itself the path-traversal defense (store.ts's same argument).
  if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
  // shared's and contracts' meta schemas are verbatim-aligned, but the serializer trusts contracts'; re-run it so a
  // drift explodes here, not as an unreadable file (updateMeta's same rule).
  const meta = SavedWorkflowMetaSchema.parse(params.meta);

  const record = runRecordOf(context, params.runId);
  if (record === undefined) return { ok: false, reason: "run_not_found" };
  const script = record.scriptText;
  // scriptText persistence began with workflow-live-run; older records have no savable script.
  if (script === undefined) return { ok: false, reason: "script_missing" };

  const path = savedWorkflowPath(savedWorkflowRoot(cwd, scope), params.name);
  // Overwrite is the user's decision, not a save's side effect: without an explicit yes, refuse and let the caller surface the warning for another round.
  if (params.overwrite !== true && savedWorkflowExists({ cwd, name: params.name, scope })) {
    return { ok: false, reason: "target_exists", path };
  }

  const analysis = analyzeScript(script);
  if (!analysis.ok) {
    return {
      ok: false,
      reason: "compile_failed",
      path,
      detail: boundedDiagnostics(analysis.diagnostics),
    };
  }

  const shadowing = findSavedWorkflowShadowing({ cwd, name: params.name, scope });
  try {
    const written = saveSavedWorkflow({ cwd, name: params.name, meta, script, scope });
    return {
      ok: true,
      name: params.name,
      scope: written.scope,
      path: written.path,
      // Decided at write time, never copied from the input (SaveWorkflow handler's same reason).
      overwritten: written.overwritten,
      ...(shadowing === undefined ? {} : { shadowing }),
    };
  } catch (error) {
    // A write failure (read-only mount, permissions) is a business branch, not a protocol error: the GUI renders it in the dialog.
    return { ok: false, reason: "write_error", path, detail: describeError(error) };
  }
}

/**
 * "Which saved workflow does this run correspond to?" Three rules, first hit wins (the spec's order):
 *
 * 1. **what the conversation said**: the model saved via SaveWorkflow and claimed this run (input `run_id`), the caller passing the name
 // as a candidate. Still resolved here — if the user deleted it since, it is no longer a fact.
 * 2. **what the run ran**: some definition's body is byte-identical to the script this run persisted. The GUI's direct-save lands here
 // by construction, and holds after the conversation is gone.
 * 3. **what the run is called**: some definition's name equals the run's — the hub attributes run history to workflows by this rule,
 // so hub-launched runs are saved by construction.
 *
 // With no run record, skip 2 and 3 (candidates still count): a missing run record never fails the whole query.
 */
export async function findSavedWorkflowForRunOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsForRunResult> {
  const params = parseParams(zcodeWorkflowsForRunParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const record = runRecordOf(context, params.runId);
  // Args regardless of match: they serve the run-again dialog prefill; present when the run is.
  const runArgs = record?.args === undefined ? {} : { runArgs: record.args };

  for (const candidate of params.candidates ?? []) {
    if (!isValidSavedWorkflowName(candidate.name)) continue;
    const resolved = resolveSavedWorkflow({
      cwd,
      name: candidate.name,
      ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
    });
    if (resolved.ok) return { entry: entryOf(resolved), match: "candidate", ...runArgs };
  }

  const script = record?.scriptText;
  if (script !== undefined) {
    // Project scope before global: same-name shadowing points this way, and identical content still reports the project's copy.
    for (const scope of ["project", "global"] as const) {
      const listed = listSavedWorkflows({ cwd, scope });
      for (const entry of listed.entries.slice(0, SCRIPT_MATCH_SCAN_LIMIT)) {
        const resolved = resolveSavedWorkflow({ cwd, name: entry.name, scope });
        if (resolved.ok && resolved.script === script) {
          return { entry: entryOf(resolved), match: "script", ...runArgs };
        }
      }
    }
  }

  const name = record?.name;
  if (name !== undefined && isValidSavedWorkflowName(name)) {
    // Unanchored: project scope first-wins, like every name lookup outside the hub.
    const resolved = resolveSavedWorkflow({ cwd, name });
    if (resolved.ok) return { entry: entryOf(resolved), match: "name", ...runArgs };
  }

  return { ...runArgs };
}
