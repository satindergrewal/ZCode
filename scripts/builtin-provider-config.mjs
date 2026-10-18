import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ZCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const filename = environment === "production" ? "zcode-builtin.json" : "zcode-builtin.test.json";
  const sourcePath = resolve(root, "config/provider", filename);
  try {
    const content = await readFile(sourcePath, "utf8");
    // Reuse the runtime's full Release validation at build time, so schema incompatibilities
    // surface before packaging succeeds. tsx exists only for build tooling to load repo TS; it
    // never enters the product bundle and the validation rules are not duplicated.
    // ESM treats a Windows absolute path's drive letter as a protocol; a file URL gives every
    // platform the same loading entry.
    const { decodeZCodeBuiltinRelease } = await tsImport(
      pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/zcode-builtin-release.ts"))
        .href,
      import.meta.url,
    );
    decodeZCodeBuiltinRelease(JSON.parse(content));
    return { environment, sourcePath, content };
  } catch (error) {
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap may reuse the JS, but must not reuse the previous environment's/version's standalone config assets.
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
