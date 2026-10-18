import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { runCommand } from "./spawn-command.mjs";

// adapters tsc OOMs on memory-constrained machines (exit 134); raise the heap cap for the whole build chain.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--max-old-space-size=8192`;
import {
  stageBuiltinProviderConfig,
  resolveBuiltinProviderBuildEnvironment,
} from "./builtin-provider-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useTurboBuild = process.env.ZCODE_DESKTOP_AGENT_BUILD_MODE === "turbo";
const useBootstrapWithRemoteBuild = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";
const pnpmRunEnv = {
  ...process.env,
  ZCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot }),
  // pnpm 11's verify-deps-before-run runs a pnpm install in the apps/zcode-cli sub-workspace
  // before every run; that sub-workspace depends on the root repo's @zcode/shared at runtime and
  // auto-install cannot resolve root workspace packages, breaking dev:desktop:test and E2E onPrepare.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
// The desktop Agent build has two paths: plain pnpm and bootstrap:with-remote's direct tsc.
// They used to maintain dependency orders separately; when a new workspace dependency was added
// only the bootstrap list got updated, so on clean CI its dist did not exist yet and bootstrap
// failed to resolve the types entry. Both paths now derive from this single ordered list.
const cliWorkspaceBuilds = [
  { packageName: "@zcode/shared-types", packageDir: "shared-types" },
  { packageName: "@zcode/contracts", packageDir: "contracts" },
  // dynamic-workflow's tsc build depends on the gitignored libs.generated.ts, and the bare-tsc
  // path (runBootstrapWithRemoteBuild) skips package build scripts, so run the generator first;
  // must come before @zcode/core, which depends on dynamic-workflow.
  {
    packageName: "@zcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  // dynamic-workflow-runtime's types entry is dist/index.d.ts; must build before bootstrap.
  { packageName: "@zcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@zcode/core", packageDir: "core" },
  { packageName: "@zcode/adapters", packageDir: "adapters" },
  { packageName: "@zcode/i18n", packageDir: "i18n" },
  { packageName: "@zcode/telemetry", packageDir: "telemetry" },
  { packageName: "@zcode/bootstrap", packageDir: "bootstrap" },
];
// Official plugin manifests can be filesystem-seeded even when server.js is missing and only
// fail once the session connects to MCP — a half-started "Helper ready but no CUA tools" state.
// Every standalone MCP runtime required for normal Dev must be registered here and verified
// against its real entry file after the build, before the Agent bundle is allowed to start.
const requiredDevPluginRuntimeBuilds = [
  {
    // node_repl host: shared by Browser Use and Computer Use; shipped as a standalone package.
    packageName: "@zcode/node-repl-host",
    artifactPath: "node-repl-host/dist/mcp/server.js",
  },
  {
    // browser-use's own runtime is now just browser-client; the host no longer ships with it.
    packageName: "@zcode/browser-use-plugin",
    artifactPath: "browser-use-plugin/scripts/browser-client.mjs",
  },
];
const defaultBuildFilters = [
  ...cliWorkspaceBuilds.map(({ packageName }) => packageName),
  ...requiredDevPluginRuntimeBuilds.map(({ packageName }) => packageName),
];

async function verifyRequiredDevPluginRuntimeArtifacts() {
  for (const runtime of requiredDevPluginRuntimeBuilds) {
    const artifactPath = resolve(repoRoot, "apps/zcode-cli/packages", runtime.artifactPath);
    try {
      await access(artifactPath);
    } catch (error) {
      throw new Error(
        `[build-desktop-agent-cli] ${runtime.packageName} build succeeded without required MCP runtime: ${artifactPath}`,
        { cause: error },
      );
    }
  }
}

/**
 * Stage the freshly built agent bundle into bundled-agents.
 *
 * Required: when dev is not packaged, the agent binary is resolved by
 * resolveBundledZCodeAgentBinaryPath() in desktopRuntimeEnv.ts, whose **only** candidate is
 * bundled-agents/ — there is no cli/dist/. Relying solely on the packaging chain to stage means
 * dev keeps running the bundle left by the last package — measured 3 days stale, so any agent
 * CLI change silently never applies in dev, disguising "change not picked up" as "code has no
 * effect". The implementation is shared with the packaging chain via stage-agent-bundle.mjs, so
 * the two can no longer drift.
 *
 * Dev only runs on the host platform, so platformKey comes from process; the packaging chain
 * resolves its own cross-platform targets.
 */
function stageDevAgentBundle() {
  stageAgentBundle({
    repoRoot,
    platformKey: `${process.platform}-${process.arch}`,
  });
}

async function runBootstrapWithRemoteBuild() {
  if (existsSync(resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"))) {
    await stageBuiltinProviderConfig({
      root: repoRoot,
      env: pnpmRunEnv,
      directory: resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/provider"),
    });
    console.log("[build-desktop-agent-cli] reuse existing zcode-cli desktop agent bundle");
    return;
  }

  for (const { packageDir, prepareScript } of cliWorkspaceBuilds) {
    // bootstrap:with-remote builds the agent bundle during the remote assets phase.
    // Running tsc per package via pnpm goes through the shim/env node layers again and stalls
    // for a long time on low-memory machines. Only bootstrap-specific env vars apply here;
    // reuse the current Node to invoke the TypeScript CLI directly. bare tsc bypasses package
    // build scripts, so a package with prepareScript (dynamic-workflow) must run its generator
    // first to restore the gitignored libs.generated.ts, else tsc fails on the missing file.
    if (prepareScript) {
      runCommand(process.execPath, [prepareScript], {
        cwd: `apps/zcode-cli/packages/${packageDir}`,
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }
    runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: `apps/zcode-cli/packages/${packageDir}`,
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  runCommand(process.execPath, ["scripts/build.mjs", "--desktop-agent"], {
    cwd: "apps/zcode-cli/packages/cli",
    env: pnpmRunEnv,
    stdio: "inherit",
  });
}

if (useBootstrapWithRemoteBuild) {
  await runBootstrapWithRemoteBuild();
  stageDevAgentBundle();
  process.exit(0);
}

if (!useTurboBuild) {
  // The Linux container demo has no repo-level turbo root: `turbo --cwd apps/zcode-cli`
  // treats apps/zcode-cli as the root and rejects turbo.json inputs pointing at
  // ../../packages/shared. The agent sub-workspace also lacks the root packages/shared while
  // the agent package depends on @zcode/shared. So default to an explicit pnpm package order
  // from the repo root workspace, keeping the WDIO pre-build off sub-workspace resolution.
  for (const filter of defaultBuildFilters) {
    runCommand("pnpm", ["--filter", filter, "build"], {
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  await verifyRequiredDevPluginRuntimeArtifacts();
  runCommand("pnpm", ["--filter", "@zcode/cli", "build:desktop-agent"], {
    env: pnpmRunEnv,
    stdio: "inherit",
  });
  stageDevAgentBundle();
  process.exit(0);
}

runCommand(
  "pnpm",
  [
    "exec",
    "turbo",
    "--skip-infer",
    "--cwd",
    "apps/zcode-cli",
    "run",
    "build:desktop-agent",
    "--filter=@zcode/cli",
  ],
  {
    env: pnpmRunEnv,
    stdio: "inherit",
  },
);
stageDevAgentBundle();
