import { delimiter, dirname } from "node:path";

/**
 * Make every child process use the same Node runtime as the launcher.
 *
 * `mise run` executes TOML tasks through a shell; when another Node ends up in front of the
 * subshell's PATH, pnpm starts package scripts with the wrong runtime even though the task
 * itself already selected the right version via mise. Putting the launcher's Node directory
 * first pins the whole child-process chain without depending on the user's home layout.
 */
export function withPinnedNodePath(env, nodeExecutablePath) {
  const nodeDirectory = dirname(nodeExecutablePath);
  // On Windows the Node env object usually carries `Path`; reading only uppercase `PATH`
  // would drop pnpm.cmd's directory from the child env and break dev:desktop's internal pnpm calls.
  const pathKey = typeof env.PATH === "string" ? "PATH" : "Path";
  const existingPath = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const pathEntries = existingPath
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => entry !== nodeDirectory);

  return {
    ...env,
    [pathKey]: [nodeDirectory, ...pathEntries].join(delimiter),
  };
}
