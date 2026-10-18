import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { takeCoverage } from "node:v8";

const COVERAGE_ENABLED_VALUE = "1";

export function buildHostE2ECoverageEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== COVERAGE_ENABLED_VALUE || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "host");
  mkdirSync(directory, { recursive: true });
  return { NODE_V8_COVERAGE: directory };
}

export function flushMainE2ECoverage(onError?: (error: unknown) => void): boolean {
  if (
    process.env.ZCODE_E2E_COVERAGE !== COVERAGE_ENABLED_VALUE ||
    !process.env.NODE_V8_COVERAGE?.trim()
  ) {
    return false;
  }
  try {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    // Desktop E2E main is finally reaped by an external SIGKILL, so Electron never reaches
    // Node's normal exit-time coverage write; flush explicitly before the hard kill.
    takeCoverage();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
