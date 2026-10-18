import { spawnSync } from "node:child_process";

const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export function resolveSpawnRuntimeOptions(command, platform = process.platform) {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return {
      // On Windows runners, bare `pnpm` / `npm` are actually provided via cmd shims.
      // Rewriting the command name to `pnpm.cmd` first made some `pnpm exec` cases fall back
      // to the wrong package cwd, resolving the tsup entry to scripts/src/... and failing with
      // "Cannot find src/main/index.ts". Keep the original command name and let shell/cmd.exe
      // resolve the shim, avoiding another change of pnpm's package context.
      shell: true,
    };
  }

  return {};
}

// With shell:true, Node just joins args with spaces into the command line without escaping
// (the DEP0190 warning). On Windows, when the repo path contains spaces (e.g. E:\Z Code\...),
// cmd truncates the pnpm --dir path at the first space to E:\Z and fails with ENOENT: lstat.
// Double-quote args containing spaces per cmd.exe rules; space-free args are untouched, so
// existing space-free paths and CI behavior are unaffected.
export function quoteArgsForWindowsShell(args) {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}

export function runCommand(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    stdio: "inherit",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result;
}

export function runCommandAndReadStdout(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  const result = spawnSync(command, spawnArgs, {
    encoding: "utf8",
    ...options,
    ...runtimeOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result.stdout;
}
