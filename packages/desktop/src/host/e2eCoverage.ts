import { mkdirSync } from "node:fs";
import { takeCoverage } from "node:v8";

export function flushHostE2ECoverage(onError?: (error: unknown) => void): boolean {
  if (process.env.ZCODE_E2E_COVERAGE !== "1" || !process.env.NODE_V8_COVERAGE?.trim()) {
    return false;
  }
  try {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    // main owns host exit; on exceptions or forced teardown Node may never flush counters on its own,
    // so flush explicitly once resources are released, persisting this isolate's V8 counters.
    takeCoverage();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
