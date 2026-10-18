// ============================================================
// The script file, in three model-facing sentences.
// ============================================================
//
// The tool response is one of three readers (terminal notification and GetWorkflowRun are the others), and
 all three must push the model the same way: **go edit that file**. So this file carries one thing -- once
 the script's file is known, how to word the diagnostics and the NOTE. Shared by CreateWorkflow and
 AmendWorkflow: "amend, hand back via path" is one sentence on both; written twice it would fork.
//
// Unknown file (unwritable draft project): silence here -- callers keep the pre-existing copy asking to
// fix and resubmit the script.

import type { CreateWorkflowDiagnostic } from "@zcode/contracts";

/**
 * The script file's model-facing identity. kind picks one verb: `draft` = the copy **the tool just wrote**
 ("saved at"); `path` = the file the model itself named ("The script file is") -- "saved to" on a
 pre-existing file reads as if the tool just touched it.
 */
export interface WorkflowScriptLocation {
  kind: "draft" | "path";
  /** Model-facing form (workspace-relative or absolute), from {@link describeWorkflowScriptPath}. */
  described: string;
  /** Body line -> file line offset; 0 without a metadata block. */
  lineOffset: number;
}

/**
 * Model-facing diagnostic line. With a file: `{path}:L{line}:C{column} {message}`, numbered by **file** --
 paste-ready into an Edit on that file. Without: legacy `L:C` (body line).
 *
 * The output `diagnostics` and display payload keep body numbering: the transcript draws the body, whose lines are its coordinates.
 */
export function formatWorkflowDiagnosticLines(
  diagnostics: readonly CreateWorkflowDiagnostic[],
  location: WorkflowScriptLocation | undefined,
): string[] {
  if (location === undefined) {
    return diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    );
  }
  return diagnostics.map(
    (diagnostic) =>
      `${location.described}:L${diagnostic.line + location.lineOffset}:C${diagnostic.column} ${diagnostic.message}`,
  );
}

/**
 * NOTE when the script does not compile and has a file (inline and `path` sources). The last clause is the
 feature's whole point: **do not paste the script again**.
 */
export function workflowScriptFileNote(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}.`
      : `The script file is ${location.described}.`;
  return `NOTE: The workflow was NOT executed. ${where} Edit that file in place and resubmit with \`path: "${location.described}"\` — do not paste the script inline again.`;
}

/**
 * NOTE when the source is a saved def and it does not compile. Two extra facts: this copy came **from that
 def** (edit the copy, not the def), and changing the def itself goes through SaveWorkflow. Args must be
 passed again -- the copy carries the metadata block, declarations intact, so path-submission validates them too.
 */
export function workflowSavedDraftNote(options: {
  savedName: string;
  savedPath: string;
  draft: string;
}): string {
  return `NOTE: The workflow was NOT executed. A working copy of the saved workflow '${options.savedName}' (${options.savedPath}) was written to ${options.draft}. Edit that copy in place and resubmit with \`path: "${options.draft}"\` (pass its \`args\` again); to change the saved definition itself, use SaveWorkflow.`;
}

/** Appended after a successful launch: the next amendment starts by editing this file. */
export function workflowLaunchedScriptSentence(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}`
      : `The script file is ${location.described}`;
  return ` ${where}; to revise it later, edit that file and pass \`path\` to AmendWorkflow.`;
}

/** Appended after an amend-launch: re-amending is the same move again. */
export function workflowAmendedScriptSentence(location: WorkflowScriptLocation): string {
  return ` The revision's script is at ${location.described}; edit it there for a further revision.`;
}
