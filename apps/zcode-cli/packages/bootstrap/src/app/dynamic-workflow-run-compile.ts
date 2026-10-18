// ============================================================
// "Compile once": one ts.Program feeds the site table, schema synthesis, and lowering
// ============================================================
// Split from dynamic-workflow-run-submit.ts (max-lines gate): submit / amend use compileOnce; resume first takes diagnostics from the same
// Program for boundedResumeDiagnostics, then compileProgram. Pure compilation; no registry, no journal.

import { createHash } from "node:crypto";
import {
  buildAskSpecs,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  collectPhaseNames,
  collectSitePhases,
  deriveActorSubmitProfiles,
  interpret,
  lowerWorkflow,
  projectControlFlow,
  synthesizeAskSchemas,
  type CompileDiagnostic,
  type SiteTable,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { projectSiteGraph } from "@zcode/dynamic-workflow/projections";
import { compiledHolesOf } from "./dynamic-workflow-run-holes.js";
import type { CompiledDynamicWorkflowScript } from "./dynamic-workflow-run-launch.js";

/**
 * Compile once: one ts.Program feeds the site table, schema synthesis, and lowering.
 *
 * A dirty script hard-fails here **without creating a run**: the handler calls submit only on `ok`, so a dirty script reaching this point
 * can only be a wiring error. The defensive check reads the same compilation's program diagnostics, never a second Program
 * (that would break "compile once"). Resume recompiles the journal's original through the same function — a byte-identical
 * script necessarily passes the same checks.
 */
export function compileOnce(scriptText: string): CompiledDynamicWorkflowScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText));
}

/** Diagnostic cap inside resume-rejection text (same magnitude as the hub's compile_failed). */
const RESUME_DIAGNOSTICS_MAX_CHARS = 2000;

/** Human-readable compile_failed diagnostics: one `L:C message` per line, bounded overall. */
export function boundedResumeDiagnostics(runId: string, diagnostics: CompileDiagnostic[]): string {
  const body = [
    `The stored script of run ${runId} no longer compiles against the current workflow facade:`,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > RESUME_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, RESUME_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

/**
 * The back half of compileOnce: site table / schema synthesis / lowering on the **already-built** Program. Resume takes diagnostics from the same
 * Program before handing over here — still "compile once" (the Program caches its diagnostics; re-reading does not recompute).
 */
export function compileProgram(
  scriptText: string,
  workflow: WorkflowProgram,
  /**
   * Site tables already collected (the fill service collects once before the stability re-check; the same Program need not walk again).
   * Absent means collect here.
   */
  collected?: SiteTable,
): CompiledDynamicWorkflowScript {
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`,
    );
  }

  const table = collected ?? collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  // world.run's authorization surface is the compile-time literals (9003) plus dialog display; the driver keeps no second command list to re-verify
  // (workflow-world-read.ts header, item 2). Non-literal cmds were already bounced in the handler's analyze phase;
  // one here is a wiring error: hard-fail without creating a run.
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`,
    );
  }

  // buildAskSpecs is the only correct construction of askSpecs: untyped sites are recorded explicitly as {typed:false}.
  // Building from schemas' keys would drop untyped sites entirely, and the engine hard-fails on that absence as a wiring error.
  const askSpecs = buildAskSpecs(table, schemas);

  // One interpretation on the **same** Program (analyzeWorkflowScript already ran on this exact
  // text in the handler's analyze phase) — still "compile once"; both artifacts read from that one core: the submit profile via the site-graph projection,
  // the lexical birth-phase table straight from the trace (docs/execution-engine.md "Identity: sites, ordinals, phases").
  // Resume re-runs the same function on byte-identical text, so determinism holds.
  const core = interpret(workflow, table);
  const lowered = lowerWorkflow(workflow, table);

  return {
    askSpecs,
    // Each actor site's submit profile (docs/execution-engine.md "Submit profiles").
    actorSubmitProfiles: deriveActorSubmitProfiles(projectSiteGraph(core), askSpecs),
    sitePhases: collectSitePhases(core),
    lowered: lowered.code,
    // Holes (docs/execution-engine.md "Holes"): a filled hole's body text is the `code` handed to the engine by the fill
    // — same lowering pass as the rest of the script, so now and in any later replay the executed text is byte-identical; the hole's
    // compile-time fact table (name / type / line) feeds snapshots and progress payloads; the phase table comes from the control-flow projection (holes
    // placeholder by name, same source as contracts' createWorkflowPhaseNames), so the post-fill table aligns with the launch-time
    // one under the same rule.
    holeBodies: lowered.holeBodies,
    holes: compiledHolesOf(table),
    phases: collectPhaseNames(projectControlFlow(core)),
    // Ownership of scriptHash lives **here**, not in the harness. The harness receives both scriptText and lowered,
    // and deliberately does not verify their consistency — verifying means compiling again, exactly the pass "compile once" exists to skip
    // (harness.ts encodes this as a caller invariant). So the hash must be taken over the author's original text:
    // let the harness hash "the text it saw" and the lowered path persists the lowered body's hash,
    // while resume compares author originals — the comparison silently misaligns. This function produces
    // lowered and hash from one compilation, consistent by construction.
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}
