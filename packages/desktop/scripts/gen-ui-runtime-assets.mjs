import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const source = new URL(
  "../../../apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/",
  import.meta.url,
);

/** Inline builds and the export share the same physical assets, avoiding a second subtly-different runtime. */
export async function copyGenUiRuntimeAssets(destination) {
  const manifest = JSON.parse(await readFile(new URL("vendor/manifest.json", source), "utf8"));
  const vendorFiles = new Map();
  for (const resource of manifest.resources) {
    vendorFiles.set(resource.file, resource.sha256);
    vendorFiles.set(resource.licenseFile, resource.licenseSha256);
  }
  // Offline runs need the complete pinned snapshot; missing or drifted files fail the build, never the user's first open.
  await Promise.all(
    [...vendorFiles].map(async ([file, expectedHash]) => {
      if (!/^[a-zA-Z0-9.-]+$/.test(file)) throw new Error(`Invalid Gen UI vendor file: ${file}`);
      const bytes = await readFile(new URL(`vendor/${file}`, source));
      if (createHash("sha256").update(bytes).digest("hex") !== expectedHash)
        throw new Error(`Gen UI vendor hash mismatch: ${file}`);
    }),
  );
  await mkdir(destination, { recursive: true });
  await mkdir(join(destination, "vendor"), { recursive: true });
  await Promise.all(
    [
      "visualize.css",
      "visualize.html",
      "calendar.js",
      "vendor/manifest.json",
      ...[...vendorFiles.keys()].map((file) => `vendor/${file}`),
    ].map((file) => copyFile(new URL(file, source), join(destination, file))),
  );
}
