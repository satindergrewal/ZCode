// ============================================================
// Dynamic Workflow Run Service: fill one waiting hole's body.
// ============================================================
// docs/dynamic-workflow/launch.md "The FillWorkflowHole tool"; engine docs "Holes" -> "The fill
// service checks. This is DynamicWorkflowRunPort.fillHole body, sharing retuneConcurrency posture,
// opposite of the three launch entries: it mints no run, it speaks to one already in flight.
//
// The order is the whole semantics, and REJECTION = ZERO SIDE EFFECTS (the hole keeps waiting):
//   1. find the run (journal row U registry) -> run_not_found; not in flight in this process -> hole_not_waiting;
//   2. read the run's current script, collect the site table, find the open hole by site id -> missing/filled -> hole_not_waiting;
//   3. splice the body as the call's last arg (spliceHoleBody), run the submit-grade analysis over the WHOLE effective script,
//      then check named models against this run's binding table (diagnostics split body/draft by position) -> compile_failed;
//   4. site stability recheck (checkSiteStability): every old id present, positions shifted only by inserted lines, new ids all
//      written by this fill (the filled hole's prefix, or holes newly left in the body and their inner sites) -> otherwise a host fault ->
//      `fill_ids_unstable`；
//   5. via the control surface hand holeBodies[siteId], the effective script and its site/phase tables to the engine (fillHole, one
//      synchronous step: rewrite the run row, record hole-filled, release the stalled branch) -> not_waiting/settled ->
//      `hole_not_waiting`；
//   6. only after the engine accepts, touch host state: the registry entry takes the effective script's facts, the draft is rewritten IN PLACE,
//      scriptPath unchanged. A draft-write failure never undoes the fill -- the journal is truth; the draft is a handle.
//
// The only host-side persistence BEFORE the engine is the new draft for a run WITHOUT one: its path must ride hole-filled into the journal
// (cold readers find the draft by it after restart), and the event is recorded in the engine's same synchronous step, so mint first. If the engine
// then rejects (race: just settled / not waiting) delete that just-minted file -- "never delete drafts" means ones
// the MODEL edited; a file minted milliseconds ago by this call, seen by nobody, is not that.

import { rm, writeFile } from "node:fs/promises";
import type { DynamicWorkflowRunFillHoleRequest, FillWorkflowHoleResult } from "@zcode/contracts";
import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectPhaseNames,
  collectSites,
  createWorkflowProgram,
  interpret,
  projectControlFlow,
  spliceHoleBody,
  type SiteTable,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { compileProgram } from "./dynamic-workflow-run-compile.js";
import { mapFillDiagnostics, unboundFillModelDiagnostics } from "./dynamic-workflow-run-holes.js";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

/** Service-internal state borrowed by this module; all references -- this file holds no state of its own. */
export interface DynamicWorkflowRunFillContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  /**
   //   * Per-run fill serial chain (see {@link fillDynamicWorkflowHole}): runId -> that run's last queued
   //   * fill. The key deletes when the chain drains; not resident for the run's life. Held by the service, one table.
   */
  fillQueues: Map<string, Promise<unknown>>;
}

/**
 // * Fills of one run run SERIALLY. Root cause (2026-09-28 review): one run can wait at two holes
 // * (two futures, or two branches), and the model may put both FillWorkflowHole calls in one parallel batch;
 // * between reading entry.scriptText and handing the engine the effective script there is an await (draft minting), so the second
 // * call would splice against PRE-first-fill text and the engine's updateRunScript would overwrite the first body whole.
 // * So each fill starts only after the previous one FULLY returns, and reads the script at its own turn; a rejected
 // * (even thrown) predecessor never blocks the next. Different runs never queue each other.
 */
export function fillDynamicWorkflowHole(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { runId } = request;
  const previous = ctx.fillQueues.get(runId) ?? Promise.resolve();
  const turn = previous.then(
    () => fillOnce(ctx, request),
    () => fillOnce(ctx, request),
  );
  // The chain holds the fact ended, success or failure; key deletes on drain (only if still ours).
  const settled: Promise<unknown> = turn.then(
    () => undefined,
    () => undefined,
  );
  ctx.fillQueues.set(runId, settled);
  void settled.then(() => {
    if (ctx.fillQueues.get(runId) === settled) ctx.fillQueues.delete(runId);
  });
  return turn;
}

/** Fallback name for minting a draft when the run has no name and empty phases (same word as the tool side's fallback). */
const DRAFT_FALLBACK_NAME = "workflow";

type Refusal = Extract<FillWorkflowHoleResult, { ok: false }>;

async function fillOnce(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { deps, runs } = ctx;
  const { runId, holeId } = request;
  const entry = runs.get(runId);
  const record = deps.journal.getRun(runId);
  if (entry === undefined && record === undefined) {
    return refuse("run_not_found", `No run with id ${runId}.`);
  }
  // In-flight reads THIS process's registry: journal running + absent here = another process's (or dead process's) run;
  // this service cannot reach its engine. Point stopped runs at ResumeWorkflowRun -- resume re-reaches the hole and asks again.
  if (entry === undefined || entry.terminal !== undefined || entry.control === undefined) {
    const status = entry?.terminal?.status ?? record?.status;
    const hint =
      status === "stopped"
        ? `Run ${runId} is stopped; ResumeWorkflowRun it first, after which the hole asks again.`
        : status === "completed" || status === "errored"
          ? `Run ${runId} has ended (${status}); nothing is waiting.`
          : `Run ${runId} is not in flight in this session.`;
    return refuse("hole_not_waiting", hint);
  }

  // 2. The run's current script (the entry's copy IS the engine's: a fill swaps it synchronously). Read at own turn --
  //    earlier queued fills already made it the effective script including that body.
  const scriptText = entry.scriptText;
  const workflow = createWorkflowProgram(scriptText);
  const before = collectSites(workflow);
  const site = before.holes.find((hole) => hole.id === holeId);
  if (site === undefined) {
    const known = before.holes.map((hole) => `${hole.id} (${hole.name ?? "?"})`).join(", ");
    return refuse(
      "hole_not_waiting",
      `${holeId} is not a hole of run ${runId}${known === "" ? "" : `; its holes are ${known}`}.`,
    );
  }
  if (site.body !== undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} is already filled.`);
  }

  // 3. Splice + submit-grade analysis (9012 and the rest of the authoring rules live there).
  const spliced = spliceHoleBody(scriptText, before, holeId, request.body);
  if (spliced === undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} cannot take a body.`);
  }
  // Model names resolve only against this run's binding table (see unboundFillModelDiagnostics): the table sits on the entry and fills serialize per run,
  // so this is the very table the subagent session creation will consult.
  const analysis = analyzeWorkflowScript(spliced.text);
  const diagnostics = analysis.ok
    ? unboundFillModelDiagnostics(analysis.modelReferences, entry.modelBindings)
    : analysis.diagnostics;
  if (diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: `The effective script does not compile (${diagnostics.length} diagnostic${
        diagnostics.length === 1 ? "" : "s"
      }); nothing was spliced and the hole is still waiting.`,
      diagnostics: mapFillDiagnostics({
        diagnostics,
        effectiveText: spliced.text,
        body: request.body,
        insertedAtLine: spliced.insertedAtLine,
        insertedLines: spliced.insertedLines,
      }),
    };
  }

  // 4. Stability recheck precedes compile artifacts: compiling (schema synthesis, lowering) a script with shifted ids is wasted work.
  const effective = createWorkflowProgram(spliced.text);
  const after = collectSites(effective);
  const stability = checkSiteStability(
    before,
    after,
    holeId,
    spliced.insertedAtLine,
    spliced.insertedLines,
  );
  if (!stability.ok) {
    deps.logger?.error?.("Dynamic workflow hole fill renumbered an existing site", undefined, {
      detail: stability.detail,
      event: "dynamic_workflow.fill.ids_unstable",
      holeId,
      module: "bootstrap.app",
      runId,
    });
    return refuse(
      "fill_ids_unstable",
      `The compiled effective script renumbered an existing site (${stability.detail}). This is a host fault, not a problem with the body; the hole is still waiting.`,
    );
  }
  const compiled = compileProgram(spliced.text, effective, after);
  const code = compiled.holeBodies[holeId];
  if (code === undefined) {
    // Splice and stability fine yet lowering produced no body for this hole: only analyzer/lowering
    // contract drift. Report as a host fault instead of handing undefined to the engine.
    return refuse(
      "fill_ids_unstable",
      `Lowering produced no body for ${holeId}; this is a host fault and the hole is still waiting.`,
    );
  }

  // 5. Hand to the engine (one synchronous step: swap tables, rewrite the effective script, record hole-filled, release the stalled branch). A run without
  //    a draft gets one minted (file header); the path journals with the event.
  const minted =
    entry.scriptPath === undefined ? await mintDraft(ctx, entry, spliced.text) : undefined;
  const filledBy =
    request.parentSessionId === undefined ? {} : { filledBy: String(request.parentSessionId) };
  const result = entry.control.fillHole({
    siteId: holeId,
    code,
    script: { text: spliced.text, hash: compiled.scriptHash },
    askSpecs: compiled.askSpecs,
    sitePhases: compiled.sitePhases,
    phaseNames: compiled.phases.phaseNames,
    ...(compiled.phases.holes.length === 0 ? {} : { holes: compiled.phases.holes }),
    ...filledBy,
    ...(minted === undefined ? {} : { scriptPath: minted }),
  });
  if (result === undefined || !result.ok) {
    if (minted !== undefined) await discardMintedDraft(ctx, runId, minted);
    const reason = result?.reason;
    deps.logger?.info?.("Dynamic workflow hole fill refused by the engine", {
      event: "dynamic_workflow.fill.refused",
      holeId,
      module: "bootstrap.app",
      reason: reason ?? "engine_unbound",
      runId,
    });
    return refuse(
      "hole_not_waiting",
      reason === "settled"
        ? `Run ${runId} has already settled; nothing is waiting.`
        : `Run ${runId} is not waiting at ${holeId}: it has not reached it yet, or it is already filled.`,
    );
  }

  // 6. Engine accepted: host-side facts follow (script, hole table, phase table must describe one script), then the draft.
  const previousPhases = phaseNamesOf(workflow, before);
  entry.scriptText = spliced.text;
  entry.holes = compiled.holes;
  entry.phaseNames = compiled.phases.phaseNames;
  if (minted !== undefined) entry.scriptPath = minted;
  else await rewriteDraft(ctx, entry, runId, spliced.text);
  const scriptPath = entry.scriptPath;
  deps.logger?.info?.("Dynamic workflow hole filled", {
    event: "dynamic_workflow.fill.applied",
    holeId,
    module: "bootstrap.app",
    runId,
    ...(scriptPath === undefined ? {} : { scriptPath }),
  });
  return {
    ok: true,
    phasesAdded: compiled.phases.phaseNames.filter((name) => !previousPhases.has(name)),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    scriptText: spliced.text,
  };
}

function refuse(reason: Refusal["reason"], message: string): Refusal {
  return { ok: false, reason, message };
}

/** The pre-splice script's phase table (same projection rule); the baseline phasesAdded compares against. */
function phaseNamesOf(workflow: WorkflowProgram, table: SiteTable): Set<string> {
  return new Set(collectPhaseNames(projectControlFlow(interpret(workflow, table))).phaseNames);
}

/**
 // * In-place draft rewrite (docs/dynamic-workflow/launch.md, "The draft after a fill"): with a draft, rewrite
 // * that file at the same path -- the ONE exception to never-overwrite-behind-the-model; this write is what the model asked for.
 // * Best effort: failure logs warn, path unchanged (file exists, content stale, the log says why).
 */
async function rewriteDraft(
  ctx: DynamicWorkflowRunFillContext,
  entry: RunRegistryEntry,
  runId: string,
  text: string,
): Promise<void> {
  if (entry.scriptPath === undefined) return;
  try {
    await writeFile(entry.scriptPath, text, "utf8");
  } catch (error) {
    ctx.deps.logger?.warn?.("Dynamic workflow draft could not be rewritten after a fill", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.fill.draft_rewrite_failed",
      module: "bootstrap.app",
      runId,
      scriptPath: entry.scriptPath,
    });
  }
}

/**
 // * A run without a draft mints one by the inline rule (the rule lives in the tool layer, injected via deps); unmintable (not injected/unwritable) returns
 // * undefined -- the fill still succeeds, the reply just lacks a path.
 */
async function mintDraft(
  ctx: DynamicWorkflowRunFillContext,
  entry: RunRegistryEntry,
  text: string,
): Promise<string | undefined> {
  const minted = await ctx.deps.writeWorkflowDraft?.({
    cwd: entry.cwd,
    name: entry.name ?? entry.phaseNames?.[0] ?? DRAFT_FALLBACK_NAME,
    source: text,
  });
  return minted?.path;
}

/** The engine rejected the fill: the just-minted draft is unseen; delete it (file header); failure to delete logs only. */
async function discardMintedDraft(
  ctx: DynamicWorkflowRunFillContext,
  runId: string,
  path: string,
): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    ctx.deps.logger?.warn?.(
      "Dynamic workflow draft minted for a refused fill could not be removed",
      {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.fill.minted_draft_orphaned",
        module: "bootstrap.app",
        runId,
        scriptPath: path,
      },
    );
  }
}
