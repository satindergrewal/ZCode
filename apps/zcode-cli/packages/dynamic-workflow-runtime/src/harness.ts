/**
 * Parent harness (Boundary A host side plus sandbox process orchestration).
 *
 * Responsibility: run a workflow script (or an already-lowered body) in a controlled child process, bridging the
 * child's `__host.*` calls over NDJSON to one {@link WorkflowEngine} instance, and return the engine's
 * {@link RunSettlement}. This package depends **only** on `@zcode/dynamic-workflow` and node builtins -- proof the
 * whole pipeline runs app-free; it never imports core/contracts/bootstrap/adapters.
 *
 * Timeline (happy path):
 *
 *   parent                         child(vm)
 *     |  write <cwd>/.zcode/workflow-runs/<runId>.mjs (payload: lowered+args embedded)
 *     |  spawn(node <entry>)
 *     |-------------------------->|  build __host in context
 *     |<-- create-actor(local#1) --|  createActor returns local#1 synchronously
 *     |  map local#1 -> ActorId    |
 *     |<-- request ask(local#1) ---|  await __host.ask(...)
 *     |  engine.ask -> driver.startAsk ... settle
 *     |-- response(value) -------->|  resolve
 *     |<----- complete(ok,value) --|  script returns
 *     |  engine.complete(value) -> settled=completed
 *     │  engine.complete(value) → settled=completed
 *
 * Failure/cancel: the run verdict belongs to the engine. Terminal failures (script error-complete, child crash /
 * nonzero exit, wall-clock timeout, child line JSON parse failure) all call `engine.fail(error)` (settles failed +
 * journals failure_json); the abort signal is the only "true cancel", calling `engine.stop(initiator)` (settles
 * stopped; `reason` "model" = main-agent TaskStop, "interrupted" = host app shutdown stopping its own run, else
 * user). The engine's own run-level failures (reportCap/inputHash/unknownActor) surface via engine.settled too.
 * The harness's first-wins finalize only handles child cleanup (clear timer, close stdin, kill child); it never
 * mints verdicts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  lowerWorkflowScript,
  WorkflowEngine,
  WorkflowError,
  type ActorId,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type RunSettlement,
  type ValidateFn,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { type ChildMessage, type ChildPayload, type ResponseMessage } from "./protocol.js";
import { renderChildEntry } from "./child-source.js";
import { writeChildEntryFile, type HarnessWarning } from "./child-entry-file.js";

/** Driver factory: the harness builds the sink (the engine's upward report surface), lets the factory build the driver, then builds the engine on that driver. */
export type DriverFactory = (sink: WorkflowReportSink) => WorkflowDriver;

/**
 * The run's **live control surface**: once the engine exists, the harness hands this incarnation to the holder (the
 * run service) so it can reach the living engine. Today exactly one command -- change this run's concurrency cap in place.
 *
 * Narrowed to `Pick<..., "setMaxConcurrency">` rather than the whole engine: the control surface is a **command**
 * channel, not a back door for the host to drive the run lifecycle around the harness (settlement still only via
 * the complete/stop/fail paths).
 *
 * Same contract as `signal`: the harness only wires; interpretation, validation, and fallback live in the engine
 * (`setMaxConcurrency` returning false means nothing happened this time).
 */
export interface RunControlBinding {
  bind(engine: Pick<WorkflowEngine, "setMaxConcurrency">): void;
}

/**
 * Inputs to {@link runWorkflowScript}. The body comes from `scriptText` or `lowered` (latter wins);
 * supplying both is the "compile once" shape -- the caller compiles to `lowered` and also hands down the authored
 * `scriptText` for persistence.
 *
 * The harness **never validates that the pair is consistent**: it cannot (checking `lowered` derives from
 * `scriptText` means recompiling -- exactly the compile "compile once" saves). A mismatched pair persists a
 * `script_text` that differs from the executed code and silently corrupts the resume comparison baseline.
 * That consistency is the caller's responsibility.
 */
export interface RunWorkflowOptions {
  /**
   * The authored workflow script source, two uses:
   * 1. when `lowered` is absent the harness lowers it to get the executed body;
   * 2. **always** persisted as run metadata `dwf_run.script_text` (the resume baseline is the author's source,
   *    not the lowered body).
   */
  scriptText?: string;
  /**
   * Already-lowered async function body (free identifier: `__host` only). Bypasses the compiler, feeding the sandbox
   * directly -- security tests use it to feed hand-written bodies (the vm contract is the thing under test), and the
   * compile-once path uses it to hand over that one compilation. When present it wins over `scriptText` as the executed body.
   */
  lowered?: string;
  runId?: string;
  /** Driver factory (see {@link DriverFactory}). The driver owns journal and emit. */
  makeDriver: DriverFactory;
  caps: Caps;
  /** Static spec per ask site. **Must cover every ask site in the script** -- the engine hard-fails absence as a wiring error. */
  askSpecs: ReadonlyMap<string, AskSpec>;
  /** Injected schema validator (the engine does not import schema implementations). */
  validate: ValidateFn;
  /** External cancel signal: abort in-flight asks and kill the child; the run settles cancelled. */
  signal?: AbortSignal;
  /**
   * Binding point for the live control surface (see {@link RunControlBinding}). Handed over through the same seam as
   * `signal`: that one is "stop this run", this one is "change a setting of this run". Absent means this launch has
   * no control surface (e.g. snippet execution).
   */
  control?: RunControlBinding;
  /** Wall-clock timeout (ms): kill the child at the deadline, run settles failed. Unlimited by default. */
  timeoutMs?: number;
  /** Child heap cap (MB), mapped to `--max-old-space-size`. Default 256. */
  maxOldSpaceSizeMb?: number;
  /**
   * Alternative spawn strategy: when present, spawn `process.execPath [...argsPrefix, <entry path>]` with
   * **no Node CLI flags at all**.
   *
   * Why: the SEA single binary does not parse Node CLI flags, so the default path's `--max-old-space-size` would
   * land in the CLI's strict parseArgs as a plain token and exit with an error (every workflow run would fail under
   * SEA). Under SEA, bootstrap passes the hidden subcommand name as argsPrefix; the child re-execs this binary and,
   * before parseArgs, `import()`s the entry file and calls its `start`.
   *
   * Cost: the heap cap can only be applied by the entry file's own best-effort `v8.setFlagsFromString`.
   */
  childSpawn?: { argsPrefix: readonly string[] };
  /**
   * Non-fatal condition reporter (today exactly one: the project `.zcode/` was unwritable and we fell back to the OS
   * temp dir). The harness is app-free with no logger; bootstrap wires this to its warn log.
   */
  onWarning?: (warning: HarnessWarning) => void;
  /** Child working directory, default process.cwd(); also persisted as run metadata dwf_run.cwd. */
  cwd?: string;
  /**
   * Run metadata, **verbatim** into `EngineConfig` (createRun persists dwf_run). All optional; the harness neither
   * transforms nor infers: `scriptHash` is **computed by the caller**. If the hashed "the text it saw", the lowered
   * path would persist the lowered body's hash and resume validation would silently compare against the wrong
   * baseline. The authored source travels via `scriptText` above.
   */
  scriptHash?: string;
  parentSessionId?: string;
  /** Display name of the run (label source for host enumeration surfaces). Same path as `scriptText`; forwarded only. */
  name?: string;
  /**
   * This run's arguments (the saved workflow's declared params, already validated with defaults backfilled).
   *
   * **Two destinations**, unlike the rest of the metadata: persisted via `EngineConfig` as `dwf_run.args_json`
   * (resume reads it back for replay) and injected into the spawn payload as the sandbox's frozen `args` global.
   * No validation, no transformation here -- declaration and validation belong to the caller (tool side). Absent means `{}`.
   */
  args?: Record<string, unknown>;
  /** The originating CreateWorkflow tool-call id (post-restart join/notify anchor); verbatim into EngineConfig. */
  toolCallId?: string;
  /**
   * The amend-resume pair, same contract as the rest of the metadata: **verbatim into EngineConfig**; the harness
   * does not read, transform, or infer. `resumedFrom` is the lineage pointer persisted as `dwf_run.resumed_from`;
   * `importedCache` is the pure-data cache table injected into the engine.
   *
   * Same division of labor as `scriptText`/`lowered`: **consistency is the caller's responsibility**. The harness
   * cannot tell whether this table was really built from that predecessor (that would mean reading the journal, and
   * this package knows nothing about storage). A mismatched table yields a run that treats someone else's answers as
   * its cache. Building and gating live in the run service (bootstrap's dynamic-workflow-import.ts).
   */
  resumedFrom?: string;
  /**
   * Anchor of the launching turn; verbatim into EngineConfig.
   * `subagentModel` rides along with the anchor and phase table: the canonical picker string for this run's subagents
   * (`providerId/modelId[$reasoningLevel]`); again unread/unparsed by the harness -- it lives zero-SQL inside the
   * `run-launched` event; parsing and priority belong to the host (bootstrap's workflow-actor-model.ts).
   * `phaseAlongside` and `phaseNames` align positionally (indices into the same table), same rules.
   */
  launch?: {
    inputId: string;
    phaseNames?: string[];
    subagentModel?: string;
    phaseAlongside?: number[][];
  };
  importedCache?: ImportedRunCache;
  /**
   * Usage baseline when the run was created (the predecessor's `spentTokens`); like all metadata: **verbatim into
   * EngineConfig**, unread by the harness. Reading the predecessor's row happens in the run service.
   */
  inheritedTokens?: number;
}

const DEFAULT_MAX_OLD_SPACE_MB = 256;
const STDERR_LIMIT = 64 * 1024;

/**
 * Run a workflow script to settlement. Returns the engine's {@link RunSettlement}.
 * Failure is first-class, in two classes: a script throw is the script's fault, normalized to
 * `{status:"errored", error}`; child unstartable/crashed/wall-clock-timeout/corrupt-protocol is a host-side fault,
 * likely fine on retry, normalized to `{status:"stopped", reason:"interrupted", error}` (resumable).
 * Neither is ever swallowed silently.
 */
export async function runWorkflowScript(options: RunWorkflowOptions): Promise<RunSettlement> {
  const lowered = resolveLowered(options);
  const runId = options.runId ?? "run";

  // Late-bound sink: the engine is constructed after the driver, but the driver needs the sink to report -- break the cycle with a forwarding proxy.
  let engine!: WorkflowEngine;
  const sink: WorkflowReportSink = {
    askSubmitAttempted: (instance, payload) => engine.askSubmitAttempted(instance, payload),
    askTurnEnded: (instance, finalText) => engine.askTurnEnded(instance, finalText),
    askProgress: (instance, progress) => engine.askProgress(instance, progress),
    askStats: (instance, stats) => engine.askStats(instance, stats),
    askFailed: (instance, error) => engine.askFailed(instance, error),
    // Deterministic model-side error -> stop the whole run; forwarding only, as everywhere.
    stopRun: (error) => engine.stopRun(error),
    // The three adaptive-concurrency observations plus the run-level stall observation: forwarding only.
    askWaiting: (instance, info) => engine.askWaiting(instance, info),
    askExecuting: (instance) => engine.askExecuting(instance),
    // The one observation that drives an engine decision (import-cache close): forwarding only.
    askMutating: (instance) => engine.askMutating(instance),
    concurrencyChanged: (change) => engine.concurrencyChanged(change),
    runStalled: (info) => engine.runStalled(info),
  };
  const driver = options.makeDriver(sink);
  engine = new WorkflowEngine({
    runId,
    driver,
    caps: options.caps,
    askSpecs: options.askSpecs,
    validate: options.validate,
    // Metadata forwarded verbatim; absent stays absent (no undefined keys). cwd equals what the child actually
    // uses, so the process.cwd() fallback is recorded here too -- the persisted cwd is the dir the run really ran in.
    ...(options.scriptText === undefined ? {} : { scriptText: options.scriptText }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.scriptHash === undefined ? {} : { scriptHash: options.scriptHash }),
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
    ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
    ...(options.resumedFrom === undefined ? {} : { resumedFrom: options.resumedFrom }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    ...(options.importedCache === undefined ? {} : { importedCache: options.importedCache }),
    ...(options.inheritedTokens === undefined ? {} : { inheritedTokens: options.inheritedTokens }),
    cwd: options.cwd ?? process.cwd(),
  });
  // Bind the control surface as soon as it exists: the run is configurable from the first event, **without** waiting
  // for the child; the spawn-failure path below also settles through the engine, so the handle stays safe afterwards
  // (the command's own settled check closes it out).
  options.control?.bind(engine);

  const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_MB;
  const cwd = options.cwd ?? process.cwd();
  const payload: ChildPayload = {
    lowered,
    // Arguments cross the boundary once, at start (constant for the run's lifetime).
    ...(options.args === undefined ? {} : { args: options.args }),
    // The heap cap rides in the payload only for the argsPrefix path: no Node flags can be passed there, so the
    // entry file best-efforts it itself. The default path relies on the real flag; the entry skips when it sees one.
    maxOldSpaceSizeMb,
  };

  // The payload never rides the command line: Windows caps at 32,767 chars and the whole lowered script on it dies
  // past ~18KB with `spawn ENAMETOOLONG`. Written as an entry file,
  // argv carries one path, independent of script size.
  let child: ChildProcess;
  try {
    const entry = writeChildEntryFile({
      cwd,
      runId,
      source: renderChildEntry(payload, { runId }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
    child = spawn(
      process.execPath,
      options.childSpawn === undefined
        ? [`--max-old-space-size=${maxOldSpaceSizeMb}`, entry.path]
        : [...options.childSpawn.argsPrefix, entry.path],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        // The desktop agent runs under the Electron Helper (process.execPath points at the Helper), and the CLI
        // sanitizes ELECTRON_RUN_AS_NODE out of its own env at startup. Without it explicitly set, the child boots
        // as a full Electron/Chromium app and hangs in GPU init -- silent, never exits, run stuck in run-started.
        // Harmless under a plain-Node execPath (same handling as official-plugin-runtime.ts).
        // Both spawn strategies must set it: packaged desktop can take the argsPrefix path too.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
  } catch (cause) {
    // Node surfaces only EACCES/EAGAIN/EMFILE/ENFILE/ENOENT as error
    // events; other spawn failures (ENAMETOOLONG, E2BIG...) throw **synchronously**. By then the engine exists and
    // the journal row is already running; letting the exception escape would bypass engine settlement -- the registry
    // records a terminal state while the journal row stays running forever, and a later resume_from is rejected with
    // "has not settled yet". Same for an unwritable entry file (both dirs failing). Always settle via the engine as
    // stopped(interrupted): host-side fault, resumable.
    const message = cause instanceof Error ? cause.message : String(cause);
    engine.stop(
      "interrupted",
      new WorkflowError("Interrupted", `Could not start the workflow sandbox process: ${message}`, {
        cause,
      }),
    );
    return engine.settled;
  }

  return bridge({ child, engine, runId, signal: options.signal, timeoutMs: options.timeoutMs });
}

/** Resolve the lowered body: prefer `lowered`, else lower `scriptText` (a dirty script throws, no child starts). */
function resolveLowered(options: RunWorkflowOptions): string {
  if (options.lowered !== undefined) return options.lowered;
  if (options.scriptText === undefined) {
    throw new Error("runWorkflowScript: pass either scriptText or lowered");
  }
  const result = lowerWorkflowScript(options.scriptText);
  if (!result.ok || result.lowered === undefined) {
    const detail = result.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join("; ");
    throw new Error(
      `runWorkflowScript: the script failed compilation/analysis and is not run degraded: ${detail}`,
    );
  }
  return result.lowered.code;
}

interface BridgeDeps {
  child: ChildProcess;
  engine: WorkflowEngine;
  /** Error text for the abort normalization only (the "interrupted" branch names which run was shut down). */
  runId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * NDJSON bridge plus lifecycle convergence. Single-writer finalize: whoever arrives first -- engine settlement,
 * child exit, timeout, or abort -- wins, then kills the child and settles the promise.
 */
function bridge(deps: BridgeDeps): Promise<RunSettlement> {
  const { child, engine, runId, signal, timeoutMs } = deps;

  // local#N (child-local handle) -> engine ActorId map; stdio FIFO plus synchronous create-actor handling guarantee
  // the mapping exists before any ask referencing the handle arrives.
  const actorMap = new Map<string, ActorId>();
  let stderr = "";
  let finalized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: Interface | undefined;

  return new Promise<RunSettlement>((resolve) => {
    const finalize = (settlement: RunSettlement): void => {
      if (finalized) return;
      finalized = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      reader?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve(settlement);
    };

    // Terminal failures (script throw / child crash / timeout / corrupt protocol) are run failures: hand to the
    // engine's public fail(), which settles first-wins, cancels in-flight driver asks, and journals failed +
    // failure_json -- the verdict belongs to the engine, so journal and caller result cannot diverge. Child cleanup
    // is finalize's job (via engine.settled).
    const failRun = (error: WorkflowError): void => {
      if (finalized) return;
      engine.fail(error);
    };
    // Host-side fault (sandbox crash / timeout / corrupt protocol): stopped(interrupted), resumable.
    const interruptRun = (message: string, cause?: unknown): void => {
      if (finalized) return;
      engine.stop(
        "interrupted",
        new WorkflowError("Interrupted", message, cause === undefined ? undefined : { cause }),
      );
    };

    // Abort is the only "true cancel": engine.stop(initiator), settling stopped. The initiator arrives via
    // `AbortController.abort(reason)`: literal "model", the amend path's
    // `{ superseded: newRunId }` (successor id persisted with the reason), literal "interrupted" (host app
    // shutdown, below); anything else counts as "user".
    function onAbort(): void {
      if (finalized) return;
      const reason: unknown = signal?.reason;
      const supersededBy = readSupersededBy(reason);
      if (supersededBy !== undefined) {
        engine.stop("superseded", undefined, supersededBy);
        return;
      }
      // The host deliberately stops a run it owns (run service close()). Not a user cancel: persisted with the
      // Interrupted failure code, same family as timeout / sandbox crash -- stopped(interrupted) is resumable, while
      // stopped(user) reads as "user pressed stop" in the UI. The error text names run and cause; the detail page
      // uses it to explain the row on next activation.
      if (reason === "interrupted") {
        engine.stop(
          "interrupted",
          new WorkflowError(
            "Interrupted",
            `dynamic workflow run ${runId} was interrupted: the owning session closed before the run settled`,
          ),
        );
        return;
      }
      engine.stop(reason === "model" ? "model" : "user");
    }

    // Every settlement (complete / fail / stop / engine-internal cap failure) surfaces here via engine.settled.
    void engine.settled.then(finalize);

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        interruptRun(
          `The workflow sandbox process exceeded its wall-clock timeout of ${timeoutMs}ms`,
        );
      }, timeoutMs);
      timer.unref?.();
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = trimTail(stderr + chunk.toString("utf8"), STDERR_LIMIT);
    });
    // The child may exit with responses still to write: attach an error listener on stdin so EPIPE does not become an uncaught exception.
    child.stdin?.on("error", () => undefined);

    reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: ChildMessage;
      try {
        message = JSON.parse(line) as ChildMessage;
      } catch (cause) {
        // Corrupt line JSON from the child: surface it, never swallow.
        interruptRun(
          `The workflow sandbox process emitted a line that is not valid NDJSON: ${line}`,
          cause,
        );
        return;
      }
      handleChildMessage(message, { engine, actorMap, child, failRun });
    });

    child.on("error", (error) => {
      interruptRun(`Could not start the workflow sandbox process: ${error.message}`, error);
    });

    child.on("close", (code, sig) => {
      if (finalized) return;
      // Child exited with no engine settlement: crashed/killed without complete. Attribute via stderr.
      const reason =
        stderr.trim().length > 0
          ? stderr.trim()
          : `The workflow sandbox process exited (code=${code}, signal=${sig}) before completing`;
      interruptRun(reason);
    });
  });
}

interface MessageDeps {
  engine: WorkflowEngine;
  actorMap: Map<string, ActorId>;
  child: ChildProcess;
  failRun: (error: WorkflowError) => void;
}

/** Dispatch one child->parent message. ask/world-read bridge to the engine asynchronously and answer with a response (latest budget attached). */
function handleChildMessage(message: ChildMessage, deps: MessageDeps): void {
  const { engine, actorMap, child, failRun } = deps;

  switch (message.kind) {
    case "create-actor": {
      // Handle synchronously: the mapping must exist before any ask referencing the handle (guaranteed by stdio
      // FIFO). createActor is purely synchronous and throws synchronously if the run settled -- no response channel
      // then, so catch and record as a run failure (usually a harmless finalization race).
      try {
        const actorId = engine.createActor(
          message.siteId,
          message.name,
          message.persona as string | undefined,
        );
        actorMap.set(message.localId, actorId);
      } catch (cause) {
        failRun(
          cause instanceof WorkflowError
            ? cause
            : new WorkflowError("DriverError", `createActor failed at site ${message.siteId}`, {
                cause,
              }),
        );
      }
      return;
    }
    case "event":
      // Synchronous dispatch, like log: event-channel FIFO order is load-bearing for report and declare-artifact
      // (what arrives is what is journaled, and a labeled report must journal after its declaration);
      // going async would decouple arrival order from journal order.
      if (message.type === "report") {
        engine.report(message.siteId, message.item, message.artifactId);
      } else if (message.type === "declare-artifact") {
        engine.declareArtifact(message.siteId, message.op, message.args);
      } else if (message.type === "phase-entered") {
        engine.enterPhase(message.name);
      } else {
        engine.log(message.message);
      }
      return;
    case "complete":
      if (message.ok) {
        engine.complete(message.value);
      } else {
        // Script threw: run failure (error detail comes from the sandbox).
        const err = message.error;
        failRun(
          new WorkflowError("DriverError", err?.message ?? "The workflow script threw an error", {
            cause: err?.stack ?? err?.name,
          }),
        );
      }
      return;
    case "request":
      handleRequest(message, { engine, actorMap, child, failRun });
      return;
    default: {
      const _exhaustive: never = message;
      void _exhaustive;
    }
  }
}

/** Bridge one answerable host call (ask / world-read) to the engine; answer with a response once settled. */
function handleRequest(
  message: Extract<ChildMessage, { kind: "request" }>,
  deps: MessageDeps,
): void {
  const { engine, actorMap, child } = deps;

  const respond = (ok: boolean, value: unknown, error?: WorkflowError): void => {
    const response: ResponseMessage = {
      kind: "response",
      id: message.id,
      ok,
      ...(ok ? { value } : { error: toWireError(error) }),
    };
    // The child may already be gone (cancel/failure finalization): write only when writable; EPIPE-class races are
    // swallowed at this boundary (the run is already settling).
    const stdin = child.stdin;
    if (stdin === null || !stdin.writable) return;
    stdin.write(`${JSON.stringify(response)}\n`, () => undefined);
  };

  let promise: Promise<unknown>;
  if (message.type === "ask") {
    const actorId = actorMap.get(message.actor ?? "");
    if (actorId === undefined) {
      // Missing mapping (should not happen: FIFO guarantees) -- normalize to a structured UnknownActor rejection, never silent.
      respond(
        false,
        undefined,
        new WorkflowError("UnknownActor", `Unknown subagent handle: ${message.actor}`),
      );
      return;
    }
    promise = engine.ask(message.siteId, actorId, message.instructions ?? "");
  } else if (message.type === "publish-artifact") {
    const op = message.artifactOp;
    if (op === undefined) {
      // Missing op is a wiring error (lowering always sets it). **Never invent a default**: a markdown publication
      // handled as a file surfaces the error far from the fault. Normalize to a structured rejection the script sees.
      respond(
        false,
        undefined,
        new WorkflowError(
          "DriverError",
          `publish-artifact request is missing artifactOp (site ${message.siteId})`,
        ),
      );
      return;
    }
    promise = engine.publishArtifact(message.siteId, op, message.args ?? []);
  } else {
    // op/args forwarded verbatim: this layer does not inspect op or check arity (the driver's job). Missing args
    // normalize to [] so the driver's arity validation rejects loudly instead of a quiet default here.
    promise = engine.worldRead(message.siteId, message.op ?? "read", message.args ?? []);
  }

  promise.then(
    (value) => respond(true, value),
    (cause: unknown) => {
      const error =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError(
              "DriverError",
              cause instanceof Error ? cause.message : String(cause),
              { cause },
            );
      respond(false, undefined, error);
    },
  );
}

/** WorkflowError -> wire shape (keeps code/violations/finalText for the sandbox script's structured try/catch). */
function toWireError(error: WorkflowError | undefined): ResponseMessage["error"] {
  if (error === undefined) return { name: "Error", message: "unknown error" };
  const wire: NonNullable<ResponseMessage["error"]> = {
    name: error.name,
    message: error.message,
    code: error.code,
  };
  if (error.violations !== undefined) wire.violations = error.violations;
  if (error.finalText !== undefined) wire.finalText = error.finalText;
  return wire;
}

/** Keep at most the trailing `limit` bytes of a string (stderr truncation). */
function trimTail(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return value.slice(-limit);
}

/** When the abort reason is `{ superseded: <runId> }`, extract the successor id; other shapes return undefined. */

function readSupersededBy(reason: unknown): string | undefined {
  if (typeof reason !== "object" || reason === null) return undefined;
  const value = (reason as { superseded?: unknown }).superseded;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
