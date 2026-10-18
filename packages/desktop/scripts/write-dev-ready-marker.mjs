import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
const readyMarkerNames = {
  main: ".main-build-ready",
  host: ".host-build-ready",
  preload: ".preload-build-ready",
  // scheduler is now a standalone tsup target whose onSuccess calls this same marker script.
  // The old allowlist missed that target, so production builds failed with unknown target after a successful bundle.
  scheduler: ".scheduler-build-ready",
};

if (!Object.hasOwn(readyMarkerNames, target)) {
  throw new Error(`unknown ready marker target: ${target ?? "<empty>"}`);
}

const readyMarkerPath = resolve(root, "out", readyMarkerNames[target]);

mkdirSync(dirname(readyMarkerPath), { recursive: true });

// tsup's CLI-level onSuccess fires per sub-build and cannot represent overall desktop completion.
// main/host/preload now each write their own marker; dev.mjs starts Electron only once all three are ready.
writeFileSync(readyMarkerPath, `${new Date().toISOString()}\n`, "utf8");
