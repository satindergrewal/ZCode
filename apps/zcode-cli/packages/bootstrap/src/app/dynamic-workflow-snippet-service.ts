// ============================================================
// Dynamic Workflow Snippet Service (the production DynamicWorkflowSnippetPort)
// ============================================================
// The execution side of EvalWorkflowSnippet: compile once against the scratch facade ->
// the same lowering / sandbox / world-read execution face -> in-memory journal -> synchronous settle.
//
// Three invariants:
//   1. **The same execution face**. Compilation via createWorkflowProgram (the scratch facade injects under the same
//      FACADE_FILE_NAME -- facade identity keys on the declaration file name; a rename silently empties site collection);
//      world read via the production executeWorldRead (real fs / real git, production caps). The snippet's
//      reason to exist is fidelity; any "close enough" second implementation is what it exists to kill.
//   2. **Fully transient**. InMemoryJournalStore, random runId, no dwf_* rows, no background-task tracker.
//      Vanishing at process exit is the contract, not a flaw.
//   3. **asks excluded at compile time**. The scratch facade has no agent(), so the driver's ask-family methods
//      are unreachable; their DriverError throws are defense in depth -- reaching them at runtime is a wiring bug: fail loudly.

import { randomUUID } from "node:crypto";
import type {
  DynamicWorkflowSnippetEvalOptions,
  DynamicWorkflowSnippetEvalRequest,
  DynamicWorkflowSnippetEvalResult,
  DynamicWorkflowSnippetPort,
  ExecutionPort,
  FileSystemPort,
  Logger,
} from "@zcode/contracts";
import {
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  InMemoryJournalStore,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  validate,
  WorkflowError,
  type Caps,
  type JsonSchema,
  type RunEvent,
  type ValidateFn,
  type WorkflowDriver,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { dynamicWorkflowChildSpawn } from "./dynamic-workflow-run-launch.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import { executeWorldRead, type WorldReadDeps } from "./workflow-world-read.js";

/** The logs bound (contract constant in @zcode/contracts' eval-workflow-snippet.ts; avoids a back-dependency on the tool layer). */
const MAX_LOGS = 100;
const MAX_LOG_CHARS = 2_048;
/** Cap on top-level return-value serialization. The harness does not measure artifact size (RunSettlement passes through); this bound lives here. */
const MAX_ARTIFACT_BYTES = 256 * 1024;

const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

interface DynamicWorkflowSnippetServiceDeps {
    /** The filesystem port backing files.glob / files.read / files.grep. */
  fileSystemPort: FileSystemPort;
    /** The subprocess execution port backing git.* world-read. */
  executionPort: ExecutionPort;
  logger?: Logger;
    /** Injected concurrency probe for tests (floor must be 1: on dual-core, parallelism-2 == 0). */
  availableParallelism?: () => number;
}

/** Builds the snippet service; returns the {@link DynamicWorkflowSnippetPort} implementation. */
export function createDynamicWorkflowSnippetService(
  deps: DynamicWorkflowSnippetServiceDeps,
): DynamicWorkflowSnippetPort {
  const caps = (): Caps => {
    return {
            // Same concurrency-bound implementation as the run service / governor. Snippets have no asks -- no governor.
      maxConcurrency: resolveWorkflowConcurrencyCeiling(deps.availableParallelism),
    };
  };

  return {
    async evalSnippet(
      request: DynamicWorkflowSnippetEvalRequest,
      options?: DynamicWorkflowSnippetEvalOptions,
    ): Promise<DynamicWorkflowSnippetEvalResult> {
            // Compile once: one ts.Program feeds diagnostics, the site table, and lowering (the snippet version of run-service invariant 2).
            // Diagnostics include TS1184 / index-access rewrites -- the self-fix loop reads the same as CreateWorkflow's.
      const workflow = createWorkflowProgram(request.code, { facadeDts: SNIPPET_FACADE_DTS });
      const diagnostics = collectDiagnostics(workflow.program);
      if (diagnostics.length > 0) {
        return { kind: "diagnostics", diagnostics };
      }

      const table = collectSites(workflow);
            // world.run: snippets are the workbench for these calls (prove the gate logic against real commands before submitting).
            // Non-literal cmds get the production diagnostics (the authorization surface closes at compile time); the command list goes to the driver for re-check.
      const worldRun = collectWorldRunCommands(workflow, table);
      if (worldRun.diagnostics.length > 0) {
        return { kind: "diagnostics", diagnostics: worldRun.diagnostics };
      }
      const lowered = lowerWorkflow(workflow, table);
            // The scratch facade has no agent(), so the site table cannot contain ask sites; the empty schema record makes
            // buildAskSpecs return empty askSpecs (the engine's hard-fail-on-missing-spec guard holds trivially here).
      const askSpecs = buildAskSpecs(table, {});

      const logs: string[] = [];
      let logsTruncated = false;
      const captureLog = (event: RunEvent): void => {
        if (event.type !== "log") return;
        if (logs.length >= MAX_LOGS) {
          logsTruncated = true;
          return;
        }
        const message = event.message;
        if (message.length > MAX_LOG_CHARS) {
          logs.push(message.slice(0, MAX_LOG_CHARS));
          logsTruncated = true;
          return;
        }
        logs.push(message);
      };

      const worldReadDeps: WorldReadDeps = {
        fileSystemPort: deps.fileSystemPort,
        executionPort: deps.executionPort,
        cwd: request.cwd,
        declaredRunCommands: new Set(worldRun.commands),
      };
      const runId = `dwfeval-${randomUUID()}`;
      const childSpawn = dynamicWorkflowChildSpawn();

      const settlement = await runWorkflowScript({
        askSpecs,
        caps: caps(),
        ...(childSpawn === undefined ? {} : { childSpawn }),
        cwd: request.cwd,
        lowered: lowered.code,
        makeDriver: () => createSnippetDriver(worldReadDeps, captureLog),
                // As in run-launch: warn when the entry file falls back to the OS temp dir.
        onWarning: (warning) => {
          deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
            event: "dynamic_workflow.entry_file.fallback",
            module: "bootstrap.app",
            runId,
            ...warning,
          });
        },
        runId,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: request.timeoutMs,
        validate: validateFn,
      });

      deps.logger?.debug?.("Dynamic workflow snippet settled", {
        event: "dynamic_workflow.snippet.settled",
        module: "bootstrap.app",
        runId,
                // The log context's `status` key is generic task vocabulary; the run's three terminal states get their own key.
        runStatus: settlement.status,
        traceId: request.trace.traceId,
      });

      if (settlement.status === "completed") {
        const oversize = artifactOversize(settlement.artifact);
        if (oversize !== undefined) {
          return {
            kind: "failed",
            error: {
              code: "ArtifactTooLarge",
              message:
                `The snippet's return value serializes to ${oversize} bytes, over the cap of ` +
                `${MAX_ARTIFACT_BYTES} bytes. Return a summary (a count, the first few items) and ` +
                `leave the full data to log() or to the real run.`,
            },
            logs,
            logsTruncated,
          };
        }
        return {
          kind: "completed",
          ...(settlement.artifact === undefined ? {} : { artifact: settlement.artifact }),
          logs,
          logsTruncated,
        };
      }

      if (settlement.status === "errored") {
        return {
          kind: "failed",
          error: { code: settlement.error.code, message: settlement.error.message },
          logs,
          logsTruncated,
        };
      }

            // stopped: the tool call was cancelled (abort signal) or the sandbox failed. Normalize to a structured failure for the caller -- snippets
            // have no resume semantics; a stopped experiment and a failed experiment have the same next step (edit, run again).
            // A stop carrying failure (sandbox crash / timeout) surfaces its code; otherwise Cancelled.
      return {
        kind: "failed",
        error:
          settlement.error === undefined
            ? { code: "Cancelled", message: "snippet evaluation was cancelled" }
            : { code: settlement.error.code, message: settlement.error.message },
        logs,
        logsTruncated,
      };
    },
  };
}

/** On return-value serialization overflow, the byte count; else undefined. The value has crossed the NDJSON boundary, hence JSON-safe. */
function artifactOversize(artifact: unknown): number | undefined {
  if (artifact === undefined) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(artifact), "utf8");
  return bytes > MAX_ARTIFACT_BYTES ? bytes : undefined;
}

/**
  * The snippet's session-less driver: world read on the production face, in-memory journal, ask family unreachable
  * (the scratch facade has no agent()) -- reaching it is a wiring bug: throw a structured DriverError, loudly.
 */
function createSnippetDriver(
  worldReadDeps: WorldReadDeps,
  onEvent: (event: RunEvent) => void,
): WorkflowDriver {
  const askUnreachable = (member: string): WorkflowError =>
    new WorkflowError(
      "DriverError",
      `Snippet driver received ${member}, but the scratch facade has no agent(), so the ask ` +
        `path must be unreachable. This is a wiring bug.`,
    );
  return {
    createActorSession: () => Promise.reject(askUnreachable("createActorSession")),
    startAsk: () => {
      throw askUnreachable("startAsk");
    },
    respondToSubmit: () => {
      throw askUnreachable("respondToSubmit");
    },
    cancelAsk: () => {
            // Idempotent sweep on the cancellation wind-down (the engine broadcasts cancel to in-flight asks); snippets have none, nothing to do.
    },
    executeWorldRead: (op, args) => executeWorldRead(worldReadDeps, op, args),
    journal: new InMemoryJournalStore(),
    emit: onEvent,
  };
}
