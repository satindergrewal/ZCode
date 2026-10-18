// Agent bundle staging: copy apps/zcode-cli/packages/cli/dist/zcode.cjs into
// bundled-agents/<platform>/glm and write the meta sidecar.
//
// dev and packaging MUST share this one staging implementation.
// Staging only in the packaging path (prepare-agent-node-bundle.mjs) is not enough; the dev path
// (scripts/build-desktop-agent-cli.mjs) must call it too, because dev's unpacked agent binary resolves via
// desktopRuntimeEnv.ts resolveBundledZCodeAgentBinaryPath(), whose candidates are ONLY bundled-agents/, never cli/dist/.
// Dev therefore kept running the copy left by the previous package run — observed 3 days stale, silently ignoring
// every agent CLI change and sending debugging down the wrong path. One shared implementation cannot drift.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * Cleanly rebuilds the glm dir, then copies. Wiping is deliberate: electron-builder copies the whole
 * bundled-agents/<platform>/glm -> resources/glm dir, so native binaries left by a previous local build
 * (zcode-agent / zcode-acp etc.) and stale meta would ship in the installer (clean CI checkouts avoid this; local runs do not).
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle source artifact missing: ${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
