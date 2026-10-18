import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Detect whether the installed `@zcode/zcode-cua` is the closed-source real producer or the OSS
 * placeholder package.
 *
 * Closed-source builds depend on the private-repo producer; the OSS export swaps in the
 * `packages/zcode-cua` placeholder, which declares `zcodeCuaPlaceholder: true` in package.json and
 * fails every capability closed. Every dev/build/package step serving only real Computer Use
 * (Helper build, native dep staging, Windows helper assets, post-pack verification) gates on this
 * check and skips when no real producer is found, so missing private artifacts never break OSS
 * entrypoints. Spec: docs/desktop/computer-use-producer-detection.md.
 *
 * Build config (electron-builder, tsup) evaluates synchronously; one small sync read here.
 */
export function readComputerUseProducer({ desktopPackageRoot }) {
  // Search upward from the desktop package for the nearest install: the closed-source hoisted
  // layout resolves at the repo root; the OSS placeholder links under the desktop package.
  for (let dir = resolve(desktopPackageRoot); ; dir = dirname(dir)) {
    const manifestPath = resolve(dir, "node_modules", "@zcode", "zcode-cua", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return {
        installed: true,
        placeholder: manifest.zcodeCuaPlaceholder === true,
        manifest,
        packageRoot: dirname(manifestPath),
      };
    }
    if (dirname(dir) === dir) return { installed: false, placeholder: false };
  }
}

export function isRealComputerUseProducerInstalled({ desktopPackageRoot }) {
  const producer = readComputerUseProducer({ desktopPackageRoot });
  return producer.installed && !producer.placeholder;
}
