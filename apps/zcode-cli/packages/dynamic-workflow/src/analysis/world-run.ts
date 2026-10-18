/**
  * Compile-time command collection for world.run.
 *
  * world.run's authorization face is **approve + pin**: cmd must be a compile-time string literal, so the script's command set
  * is a closed set before submit -- the confirmation dialog shows it, the driver re-verifies it. A runtime-formed cmd
  * has no showable authorization object, hence a pinning diagnostic rather than a runtime rejection (teach the rewrite on the cheap side,
  * the same posture as the facade-siting rules).
 *
  * Only the first arg: the args array and opts may carry runtime values (ask artifacts interpolated into args are exactly the data-edge
  * source); what is pinned is which command runs, not what it runs with.
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** Diagnostic code for a non-literal world.run cmd (9001 facade-siting, 9002 schema, and on). */
export const WORLD_RUN_LITERAL_CODE = 9003;

export interface WorldRunCommands {
    /** The script's declared command set: deduped, lexicographic (shared by confirmation dialog and driver re-check). */
  commands: string[];
    /** Pinning diagnostics for non-literal cmd; non-empty means the script cannot be submitted. */
  diagnostics: CompileDiagnostic[];
}

/**
  * Collect world.run's command set from the site table. cmd must be a hole-free string literal (quoted or
  * backtick -- ts.isStringLiteralLike covers both; holey templates and any expression are rejected).
 */
export function collectWorldRunCommands(
  workflow: WorkflowProgram,
  table: SiteTable,
): WorldRunCommands {
  const commands = new Set<string>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const site of table.worldReads) {
    if (site.op !== "run") continue;
    const cmd = site.args[0];
    if (cmd !== undefined && ts.isStringLiteralLike(cmd)) {
      commands.add(cmd.text);
      continue;
    }
        // Arity errors (missing cmd) are caught by typecheck first: absence here means the call site should not even compile,
        // yet diagnosis must not rely on that inference -- report at the site; an extra locatable error beats silence.
    const loc = cmd === undefined ? site.loc : workflow.toScriptLoc(cmd.getStart());
    diagnostics.push({
      code: WORLD_RUN_LITERAL_CODE,
      column: loc.column,
      line: loc.line,
      message:
        "world.run's first argument must be a compile-time string literal (\"lean\" or a " +
        "no-substitution template): the script's command set is shown to the user at " +
        "confirmation and only those commands are executable. Move the command name out of " +
        "the variable/template, and put runtime values in the args array instead.",
    });
  }
  return { commands: [...commands].sort(), diagnostics };
}
