/**
 * Shared integration harness: script text -> real schema synthesis + real validate + real lowering -> sandbox child
-> engine core -> AutoDriver. The whole phase-1 pipeline, minus a real model, runs here.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryJournalStore,
  buildAskSpecs,
  collectSites,
  createWorkflowProgram,
  synthesizeAskSchemas,
  validate,
  type AskSpec,
  type Caps,
  type JsonSchema,
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver, type AutoDriverConfig } from "./auto-driver.js";

/** Adapts the real validator to the engine's ValidateFn contract (schema: JsonSchema -> unknown widening). */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/**
 * Synthesizes ask specs from script text via the package's canonical {@link buildAskSpecs} (walking the site table,
 * recording untyped sites explicitly as {typed:false} -- the engine hard-fails missing sites as wiring errors).
 *
 * Also demonstrates compile-once: one ts.Program feeds both the site table and schema synthesis.
 */
export function askSpecsFor(scriptText: string): Map<string, AskSpec> {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  const { schemas } = synthesizeAskSchemas(workflow, table);
  return buildAskSpecs(table, schemas);
}

interface RunScriptResult {
  settlement: RunSettlement;
  journal: InMemoryJournalStore;
  driver: AutoDriver;
}

interface RunScriptOptions extends AutoDriverConfig {
  caps?: Caps;
  timeoutMs?: number;
  journal?: InMemoryJournalStore;
  runId?: string;
  /** External cancel (resume tests use it to break pass one mid-flight, leaving a running row). */
  signal?: AbortSignal;
}

const DEFAULT_CAPS: Caps = { maxConcurrency: 16 };

/**
 * One run cwd per test file. The harness writes the entry to <cwd>/.zcode/workflow-runs/<runId>.mjs
 * and keeps it; nearly every test uses runId "run", so a shared process.cwd() would have parallel files overwriting one
 * entry (a child running another file's script) and leave archives in the package dir. vitest isolates modules per file,
 * so this constant is per-file; within a file cases run serially and same-name overwrites are harmless.
 */
export const TEST_CWD: string = mkdtempSync(join(tmpdir(), "dwf-test-cwd-"));

/** Runs a script through the real pipeline; AutoDriver plays the model from opts.asks/worldReads. */
export async function runScript(
  scriptText: string,
  opts: RunScriptOptions = {},
): Promise<RunScriptResult> {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new AutoDriver(journal, {
    asks: opts.asks,
    worldReads: opts.worldReads,
    artifacts: opts.artifacts,
    onStartAsk: opts.onStartAsk,
  });
  const settlement = await runWorkflowScript({
    scriptText,
    cwd: TEST_CWD,
    runId: opts.runId ?? "run",
    caps: opts.caps ?? DEFAULT_CAPS,
    askSpecs: askSpecsFor(scriptText),
    validate: validateFn,
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: opts.timeoutMs ?? 20000,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  return { settlement, journal, driver };
}
