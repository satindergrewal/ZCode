/**
 * Single resolution point for the Node dist mirror (inside this package).
 *
 * Same convention and default as the `ZCODE_NODE_DIST_MIRROR` CI variable in
 * `.gitlab/ci/00-workflow.yml`, `nodeDistBase()` in `scripts/prepare-prebuilds.mjs`, and
 * `DEFAULT_MIRROR` in `scripts/cua-helper-sea-base.mjs`. All four must stay in sync: the CI
 * variable overrides the code default, so once they differ, changing the code default is a
 * no-op in CI.
 *
 * Both `stageCli.ts` and `scripts/prepare-prebuilds.mjs` used to hardcode
 * `https://nodejs.org/dist`, which macOS CI runners cannot reach (`UND_ERR_CONNECT_TIMEOUT`, 10s);
 * the prepare-prebuilds and stage:remote-assets jobs both tripped on this, usually surviving only
 * because a cache hit avoided the network.
 *
 * A separate module instead of living in stageCli.ts: the latter ends with a top-level
 * `await main()`, so importing it executes it and tests cannot reference the export.
 */
export const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";

export function resolveNodeDistBase(env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
