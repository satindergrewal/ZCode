/**
 * Compile-time validation of phase markers.
 *
 * Two rules, one reason -- **a marker must state what it refers to before submit**. The name is a compile-time literal
 * because the phase set is shown in the confirmation dialog (same posture as world.run's cmd: a runtime-formed name has
 * nothing showable); the call must be a standalone statement because the marker means from-here-to-block-end -- one buried in an initializer /
 * argument / ternary arm has no range to refer to. Both are **pinning diagnostics**, not runtime fallbacks: the teaching
 * happens on the cheap side.
 *
 * Alias escape (const p = phase) is not here: phase is a facade function declaration, and facade-misuse's
 * pass 1 already rejects any reference outside a direct call.
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** Phase-marker diagnostic codes (9001 facade-siting, 9002 schema, 9003 world-run, and on). */
export const PHASE_MARKER_CODE = 9004;

const LITERAL_MESSAGE =
  'phase()\'s argument must be a compile-time string literal ("gate" or a no-substitution ' +
  "template): the script's phase names are fixed when it is submitted, because they label " +
  "the graph the user confirms before anything runs. Write the name inline — a name that " +
  "only exists at run time cannot be drawn.";

const EMPTY_MESSAGE =
  'phase("") has no name to show: the phase label is what the confirmation graph draws. ' +
  'Give the group a word ("preflight", "gate", "wrap-up"), or drop the marker — a script ' +
  "with no markers is perfectly legal and is drawn step by step.";

const STATEMENT_MESSAGE =
  'phase("…") must stand alone as its own statement. The marker claims the rest of the block ' +
  "it stands in, so one in expression position (a variable initializer, an argument, a " +
  "ternary arm) has no rest-of-block to claim. Put the call on its own line at the head of " +
  "the steps it names.";

/**
 * Validate the collected phase markers. Non-empty means the script cannot be submitted (handled alongside misuse /
 * world.run in analyzeWorkflowScript).
 *
 * One marker can break both rules (const x = phase(bad)); report both, so one look shows every needed fix.
 */
export function collectPhaseMarkerDiagnostics(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const push = (loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code: PHASE_MARKER_CODE, column: loc.column, line: loc.line, message });
  };

  for (const marker of table.phases) {
    // The name's diagnostic lands on **the offending expression** (the call site when absent): that is what the author edits.
    const nameLoc =
      marker.nameExpr === undefined
        ? marker.loc
        : workflow.toScriptLoc(marker.nameExpr.getStart(workflow.scriptFile));
    if (marker.name === undefined) {
      push(nameLoc, LITERAL_MESSAGE);
    } else if (marker.name.trim() === "") {
      push(nameLoc, EMPTY_MESSAGE);
    }
    if (!ts.isExpressionStatement(marker.call.parent)) {
      push(marker.loc, STATEMENT_MESSAGE);
    }
  }
  return diagnostics;
}
