import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Logger, SkillRoot } from "@zcode/contracts";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import { candidateBaseDirs } from "./bundled-plugins.js";

/**
  * The skill bundle shipped with the CLI (apps/zcode-cli/packages/bundled-skills).
 *
  * Not a plugin: no marketplace listing, no enable/disable, not uninstallable, absent from settings and the `$` reference panel.
  * Product features register their tools in the runtime; companion skills ship with the CLI so uninstalling a plugin never orphans its tool docs.
 *
  * All three runtime shapes resolve to the same skills directory:
  * - dev / Electron desktop: located next to the entry via the same candidate dirs as official plugins, read in place, no copy.
  * - SEA binary: assets embedded under the `zcode-bundled-skills/` prefix; on first start extracted by content hash to
  *   `<cli storage>/bundled-skills/<hash>/`; the dir name is the content identity, restarts are idempotent, and concurrency has a single winner.
  * - remote hosts: prepare-prebuilds stages the dir next to the remote zcode.cjs, same path as desktop.
 */

export const BUNDLED_SKILL_PACK_DIRECTORY_NAME = "bundled-skills";
export const BUNDLED_SKILL_PACK_SKILLS_DIRECTORY = "skills";
/** Gate and bundle share one name: the constant lives in contracts (core's skill gate reads it too); this only re-exports. */
export { DYNAMIC_WORKFLOW_SKILL_NAME };

/** Every file in the bundle is a required asset: one missing file rejects the whole bundle, never a skill with dangling references. */
export const BUNDLED_SKILL_PACK_REQUIRED_PATHS = [
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/SKILL.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/patterns.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/examples.md`,
] as const;

/** Same shape as official-plugin-definitions' rootCandidates, covering monorepo src/dist, cli/dist, and desktop resources/glm layouts. */
const BUNDLED_SKILL_PACK_ROOT_CANDIDATES = [
  `packages/${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
] as const;

export const SEA_BUNDLED_SKILL_ASSET_PREFIX = "zcode-bundled-skills/";
const SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY = `${SEA_BUNDLED_SKILL_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-bundled-skills-seed.json";

/**
  * Ordered after every plugin root (adapters plugin roots start at FIRST_PLUGIN_PRIORITY): same-name skills resolve by discovery order,
  * so user/project/plugin skills always outrank the bundle.
 */
const BUNDLED_SKILL_ROOT_PRIORITY = 1_000_000;

interface SeaBundledSkillManifest {
  files: Array<{ mode?: number; path: string; sha256: string }>;
  hash: string;
  version: 1;
}

type SeaModule = typeof import("node:sea");

export interface ResolveBundledSkillRootsOptions {
    /** `getCliStorageRoot(storage.dir)`; needed only for the SEA extraction. */
  cliStorageRoot: string;
  logger?: Logger;
}

export async function resolveBundledSkillRoots(
  options: ResolveBundledSkillRootsOptions,
): Promise<SkillRoot[]> {
  const packRoot =
    (await materializeSeaBundledSkillPack(options)) ??
    (await resolveFilesystemBundledSkillPackRoot());
  if (!packRoot) {
        // A missing bundle makes script writing fail the skill gate; log a diagnostic to locate incomplete distributions.
    options.logger?.warn("Bundled skill pack unavailable", {
      module: "bootstrap.bundled_skills",
      requiredPaths: [...BUNDLED_SKILL_PACK_REQUIRED_PATHS],
    });
    return [];
  }
  return [
    {
      path: join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY),
      priority: BUNDLED_SKILL_ROOT_PRIORITY,
      scope: "system",
      source: "bundled",
    },
  ];
}

export async function findMissingBundledSkillPackPaths(packRoot: string): Promise<string[]> {
  const present = await Promise.all(
    BUNDLED_SKILL_PACK_REQUIRED_PATHS.map((requiredPath) =>
      pathExists(join(packRoot, ...requiredPath.split("/"))),
    ),
  );
  return BUNDLED_SKILL_PACK_REQUIRED_PATHS.filter((_, index) => !present[index]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveFilesystemBundledSkillPackRoot(): Promise<string | undefined> {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of BUNDLED_SKILL_PACK_ROOT_CANDIDATES) {
      const packRoot = resolve(baseDir, relativePath);
      if (
        (await pathExists(join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY))) &&
        (await findMissingBundledSkillPackPaths(packRoot)).length === 0
      ) {
        return packRoot;
      }
    }
  }
  return undefined;
}

async function materializeSeaBundledSkillPack(
  options: ResolveBundledSkillRootsOptions,
): Promise<string | undefined> {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;
  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;

  const packsRoot = join(options.cliStorageRoot, BUNDLED_SKILL_PACK_DIRECTORY_NAME);
  const targetRoot = join(packsRoot, manifest.hash);
  if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;

    // The dir name is the content hash: write into a unique temp dir, then rename. A failed rename with a complete target means the concurrent
    // winner arrived first -- reuse it; any other failure falls back to a complete older bundle (skills survive a crash mid-upgrade).
  const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(temporaryRoot, { recursive: true });
    for (const file of manifest.files) {
      const bytes = Buffer.from(sea.getRawAsset(`${SEA_BUNDLED_SKILL_ASSET_PREFIX}${file.path}`));
      if (hashBytes(bytes) !== file.sha256) {
        throw new Error(`Bundled skill asset hash mismatch: ${file.path}`);
      }
      const outputPath = join(temporaryRoot, ...file.path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes, { mode: file.mode ?? 0o644 });
    }
    await writeFile(
      join(temporaryRoot, SEED_MARKER_FILE),
      JSON.stringify({ hash: manifest.hash, version: 1 }, null, 2),
    );
    await mkdir(packsRoot, { recursive: true });
    await rename(temporaryRoot, targetRoot);
    return targetRoot;
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;
    const fallbackRoot = await findUsableSeededPack(packsRoot);
    options.logger?.warn("Bundled skill pack seed degraded", {
      error: error instanceof Error ? error.message : String(error),
      fallbackRoot,
      module: "bootstrap.bundled_skills",
      targetRoot,
    });
    return fallbackRoot;
  }
}

async function isSeedComplete(targetRoot: string, expectedHash: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(targetRoot, SEED_MARKER_FILE), "utf8")) as {
      hash?: unknown;
    };
    if (marker.hash !== expectedHash) return false;
  } catch {
    return false;
  }
  return (await findMissingBundledSkillPackPaths(targetRoot)).length === 0;
}

async function findUsableSeededPack(packsRoot: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes(".tmp-")) continue;
    const packRoot = join(packsRoot, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(packRoot, SEED_MARKER_FILE), "utf8")) as {
        hash?: unknown;
      };
      if (typeof marker.hash === "string" && (await isSeedComplete(packRoot, marker.hash))) {
        return packRoot;
      }
    } catch {
            // A corrupt old cache never participates in degradation; keep looking for a complete bundle.
    }
  }
  return undefined;
}

function readSeaManifest(sea: SeaModule): SeaBundledSkillManifest | undefined {
  try {
    const manifest = JSON.parse(
      sea.getAsset(SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY, "utf8"),
    ) as SeaBundledSkillManifest;
    return manifest.version === 1 &&
      typeof manifest.hash === "string" &&
      Array.isArray(manifest.files)
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
