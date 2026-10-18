// ============================================================
// The workflow script file, model-facing form.
// ============================================================
// The journal always stores the **absolute path**: it is part of the run identity, and the session cwd
 moves (cd, another session reading the run) -- a stored relative path would point elsewhere later.
//
// But the model should see the workspace form: its next act is Edit on that file, and workspace-relative
 is exactly the path style it uses everywhere else. One pure function apart -- minted once, shared by
 three model faces (terminal notification, GetWorkflowRun, tool response), so no drift.

import path from "node:path";

/**
 * Write the script's absolute path as the model face should see it: workspace-relative when under the
 session workdir, absolute otherwise.
 *
 * "Under the workdir" = path.relative result starts neither with `..` nor is absolute -- which also
 excludes two non-relativizable cases: outside siblings (`../other/x.dwf.ts`, whose relative form reads
 like a workspace member) and Windows cross-drive (C: -> D:, where path.relative returns absolute).
 An empty result (path == workdir) also falls back to absolute: an empty string is not an Editable name.
 * `Edit` file name.
 *
 * Absent cwd = the host has no workdir notion (some port stubs / no session context); nothing to relativize.
 */
export function describeWorkflowScriptPath(absolutePath: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return absolutePath;
  const relative = path.relative(cwd, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}
