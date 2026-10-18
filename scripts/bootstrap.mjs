#!/usr/bin/env node

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const gitCommand = "git";
const withRemoteAssets = process.argv.includes("--with-remote");

function prependPathEntries(pathValue, entries) {
  const currentEntries = pathValue ? pathValue.split(delimiter) : [];
  return [...entries, ...currentEntries].join(delimiter);
}

function resolvePinnedNodeBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const miseConfigPath = resolve(rootDir, "mise.toml");
  if (!existsSync(miseConfigPath)) {
    return undefined;
  }

  const miseConfig = readFileSync(miseConfigPath, "utf8");
  const match = miseConfig.match(/^\s*node\s*=\s*"([^"]+)"/m);
  const version = match?.[1]?.trim();
  if (!version) {
    return undefined;
  }

  const nvmNodeBin = join(homedir(), ".nvm", "versions", "node", `v${version}`, "bin");
  return existsSync(nvmNodeBin) ? nvmNodeBin : undefined;
}

function resolveUserPnpmBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const pnpmBin = join(homedir(), "Library", "pnpm");
  return existsSync(join(pnpmBin, "pnpm")) ? pnpmBin : undefined;
}

function resolvePnpmCommand() {
  if (!withRemoteAssets) {
    return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  }

  const userPnpmBin = resolveUserPnpmBin();
  if (userPnpmBin) {
    return join(userPnpmBin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  }

  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveBootstrapWithRemoteEnv(baseEnv = process.env) {
  if (!withRemoteAssets) {
    return {};
  }

  const pathEntries = [resolvePinnedNodeBin(), resolveUserPnpmBin()].filter(Boolean);

  return {
    // bootstrap:with-remote is the manual remote-asset initialization entry; in non-TTY
    // environments such as automation, pnpm install may prompt to confirm a node_modules purge.
    // Disable the confirmation for this entry only; CI/production build commands are unchanged.
    HUSKY: "0",
    PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
    npm_config_confirm_modules_purge: "false",
    // The remote assets and bootstrap build rounds trigger many workspace builds.
    // Peak-shaving is scoped to the bootstrap:with-remote subprocess; build/build:bootstrap
    // semantics are untouched.
    PNPM_CONFIG_WORKSPACE_CONCURRENCY: "1",
    ZCODE_BOOTSTRAP_WITH_REMOTE: "1",
    ...(pathEntries.length > 0
      ? {
          PATH: prependPathEntries(baseEnv.PATH, pathEntries),
        }
      : {}),
  };
}

const bootstrapWithRemoteEnv = resolveBootstrapWithRemoteEnv();
const pnpmCommand = resolvePnpmCommand();

function runGit(args) {
  runCommand(gitCommand, args, {
    cwd: rootDir,
    env: process.env,
  });
}

function runPnpm(args, options = {}) {
  runCommand(pnpmCommand, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
      ...options.env,
    },
  });
}

function runBootstrapServerBuild() {
  const serverDir = resolve(rootDir, "packages/server");

  // bootstrap:with-remote's final build used to reuse build:bootstrap, making @zcode/server build
  // nest another pnpm run build:remote internally; on low-memory machines the tsx/esbuild children
  // stall or get killed. Also, do not skip the build just because dist exists: in dev the version
  // often stays unchanged and a stale entry-http or remote bundle keeps local/remote on the old
  // protocol. Only the low-memory optimization of running the equivalent entries directly is kept;
  // CI and production build scripts are untouched.
  runCommand(process.execPath, [resolve(rootDir, "node_modules/tsup/dist/cli-default.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
}

function runBootstrapE2eReportBuild() {
  const e2eReportDir = resolve(rootDir, "packages/e2e-report");
  // Bugfix: bootstrap:with-remote 的最终构建不能再嵌套 pnpm build:node。
  // 低内存环境中 pnpm shim + tsc 会被 SIGKILL；这里只在 bootstrap runner 中直接执行等价入口。
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    {
      cwd: e2eReportDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
  runCommand(process.execPath, [resolve(rootDir, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: e2eReportDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
}

function runBootstrapStreamAnimateBuild() {
  const streamAnimateDir = resolve(rootDir, "packages/stream-animate");
  // Bugfix: bootstrap:with-remote 串行最终构建时，继续通过 pnpm 执行 stream-animate 的 tsc
  // 仍可能命中 shim 被 SIGKILL；这里仅在 bootstrap runner 中直接执行等价入口。
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.server.json"],
    {
      cwd: streamAnimateDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
  runCommand(process.execPath, [resolve(rootDir, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: streamAnimateDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
}

function runBootstrapDesktopBuild() {
  const desktopDir = resolve(rootDir, "packages/desktop");
  // bootstrap:with-remote only needs remote assets and local runtime initialization.
  // Also triggering the desktop app bundle would enter the production build's tsup/vite path and
  // get SIGKILLed on low-memory machines. Only build meta runs in the bootstrap runner; the
  // production/CI build:no-runtime-assets keeps its original semantics.
  runCommand(process.execPath, ["scripts/build-metadata.mjs"], {
    cwd: desktopDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  console.log("[bootstrap:with-remote] skip desktop app bundle build; runtime assets are prepared");
}

function runBootstrapWithRemoteBuild() {
  for (const filter of ["@zcode/rpc", "@zcode/web", "@zcode/formal-proof"]) {
    // pnpm -r starts multiple Vite/esbuild/tsup builds concurrently during bootstrap:with-remote's
    // final build. Remote assets already consumed one memory peak; build packages serially here,
    // leaving build:bootstrap/CI commands unchanged.
    runPnpm(["--filter", filter, "build"]);
  }
  runBootstrapE2eReportBuild();
  runBootstrapStreamAnimateBuild();
  runBootstrapServerBuild();
  runBootstrapDesktopBuild();
}

runGit(["submodule", "update", "--init", "--recursive", "apps/zcode-cli"]);

runPnpm(withRemoteAssets ? ["install", "--config.confirmModulesPurge=false"] : ["install"]);

runPnpm(["prepare:desktop-runtime"], {
  env: withRemoteAssets
    ? {}
    : {
        // Local bootstrap used to prepare the remote mock-cdn by default, re-packaging
        // cross-platform components every run and slowing plain initialization down.
        // Prepare only the desktop local runtime by default; use bootstrap:with-remote for
        // remote assets.
        ZCODE_SKIP_REMOTE_ASSETS: "1",
      },
});

if (withRemoteAssets) {
  runBootstrapWithRemoteBuild();
} else {
  runPnpm(["run", "build:bootstrap"]);
}
