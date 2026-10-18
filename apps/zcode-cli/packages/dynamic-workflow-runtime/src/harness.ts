/**
 * The parent-process harness (Boundary A host side plus sandbox process orchestration).
 *
 * Duty: run a workflow script (or lowered body) in a controlled child process, bridging the child's
 * `__host.*` calls over NDJSON to a {@link WorkflowEngine}, returning the engine's {@link RunSettlement}.
 * This package depends only on `@zcode/dynamic-workflow` and node builtins -- proof the whole pipeline runs app-free,
 * never importing @zcode/core/contracts/bootstrap/adapters.
 *
 * Sequence (happy path):
 *
 *   parent                         child(vm)
 *     │  write <cwd>/.zcode/workflow-runs/<runId>.mjs (payload: lowered + args embedded)
 *     │  spawn(node <entry>)
 *     │──────────────────────────▶│  build __host in context
 *     │◀── create-actor(local#1) ──│  createActor returns local#1 synchronously
 *     │  map local#1 → ActorId     │
 *     │◀── request ask(local#1) ───│  await __host.ask(...)
 *     │  engine.ask → driver.startAsk … settle
 *     │── response(value) ────────▶│  resolve
 *     │◀────── complete(ok,value) ──│  script return
 *     │  engine.complete(value) → settled=completed
 *
 * Failure/cancel: the run's verdict belongs to the engine. Terminal failures (script error-complete, child crash/nonzero exit,
 * wall-clock timeout, child line-JSON corruption) all call `engine.fail(error)` (settles failed + journal failure_json);
 * the abort signal is the only true cancel, calling `engine.stop(initiator)` (settles stopped; `signal.reason`
 * `"model"` is the main agent's TaskStop, `"interrupted"` the host App stopping its own run on close, else user). The engine's own run-level
 * failures (reportCap/inputHash/unknownActor) surface via engine.settled too. The harness's first-wins
 * finalize only cleans up the child (timer, stdin close, kill) and never manufactures a settlement.
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

/** Driver factory: the harness builds the sink (the engine's upward report surface), hands it to the factory, then builds the engine with that driver. */
export type DriverFactory = (sink: WorkflowReportSink) => WorkflowDriver;

/**
 * The run's live control plane: once the engine is constructed the harness hands it this incarnation, so whichever side
 * holds the handle (the run service) can reach the living engine. Two commands -- retune this run's concurrency bound in place
 * (docs/dynamic-workflow/concurrency.md, "Two bounds on a run") and filling a hole
 * （docs/execution-engine.md「Holes」）。
 *
 * plus two read-only surfaces `openHoles` / `filledHoles`: a run snapshot's `holes[].state === "waiting"` must be projected from the
 * engine's parked table (docs/execution-engine.md, "The run snapshot" -- once the process has died no promise is waiting, and
 * reading events alone would report unasked holes as waiting); this binding is the run service's only seam to the living engine.
 *
 * Narrowed to a `Pick<...>` rather than the whole engine: the control plane is a command channel, not a
 * back door for the host to drive the run lifecycle around the harness (settlement still only via complete/stop/fail).
 *
 * Same rules as `signal`: the harness only wires; it does not interpret, validate, or fall back. Liveness and no-op semantics
 * live in the engine (a false from `setMaxConcurrency` means nothing happened).
 */
export interface RunControlBinding {
  bind(
    engine: Pick<WorkflowEngine, "setMaxConcurrency" | "fillHole" | "openHoles" | "filledHoles">,
  ): void;
}

/**
 * Arguments to {@link runWorkflowScript}. The executed body comes from `scriptText` or `lowered` (the latter wins);
 * passing both is the compile-once shape -- the caller compiles `lowered` itself and also hands down the
 * author's `scriptText` for the record.
 *
 * The harness never validates that the pair is coherent: it cannot (checking that `lowered` truly derives from `scriptText`
 * means compiling again -- exactly what compile-once avoids). A mismatched pair makes the recorded `script_text`
 * diverge from the executed code and skews the resume comparison baseline --
 * coherence is the caller's to own.
 */
export interface RunWorkflowOptions {
  /**
   * The author's workflow script source, two uses:
   * 1. when `lowered` is absent, the harness lowers it to get the executed body;
   * 2. always recorded as run metadata `dwf_run.script_text` (resume compares against the author's text,
   *    not the lowered body).
   */
  scriptText?: string;
  /**
   * An already-lowered async function body (free identifier: `__host` only). Bypasses the compiler, straight into the sandbox --
   * security tests feed handwritten bodies (the vm contract is the subject under test) and the compile-once path
   * delivers its own compilation. When present it wins over `scriptText` as the executed body.
   */
  lowered?: string;
  runId?: string;
  /** Driver factory (see {@link DriverFactory}). The driver owns journal and emit. */
  makeDriver: DriverFactory;
  caps: Caps;
  /** Per-ask-site static spec. Must cover every ask site in the script -- the engine hard-fails absence as a wiring error. */
  askSpecs: ReadonlyMap<string, AskSpec>;
  /**
   * site -> lexical birth phase name (`collectSitePhases`); verbatim into `EngineConfig.sitePhases`.
   * Absent means empty: the engine falls back to the dynamic current phase per site (older compiled artifacts, snippets, hand-fed lowered bodies).
   */
  sitePhases?: ReadonlyMap<string, string>;
  /** Injected schema validator (the engine imports no schema implementation). */
  validate: ValidateFn;
  /** External cancel: aborts in-flight asks, kills the child, settles the run cancelled. */
  signal?: AbortSignal;
  /**
   * Binding port for the live control plane (see {@link RunControlBinding}). Delivered through the same seam as `signal`:
   * that one stops the run, this one changes a setting. Absent means this launch has
   * no control plane (integration tests, snippet runs).
   */
  control?: RunControlBinding;
  /** Wall-clock timeout (ms): kill the child when it elapses; the run settles failed. Unlimited by default. */
  timeoutMs?: number;
  /** Child heap cap (MB), mapped to `--max-old-space-size`. Default 256. */
  maxOldSpaceSizeMb?: number;
  /**
   * Alternative spawn strategy: when present, spawn `process.execPath [...argsPrefix, <entry path>]`
   * with no Node CLI flags at all.
   *
   * Why it exists: the SEA single-file binary does not interpret Node CLI flags, so the default path's `--max-old-space-size` lands as
   * a plain token in the CLI's strict parseArgs and exits with an error (every workflow run failing under SEA). Under SEA,
   * bootstrap passes the hidden subcommand name as argsPrefix; the child re-execs this binary and, before parseArgs,
   * imports the entry file and calls its `start`.
   *
   * Cost: the heap cap becomes a best-effort `v8.setFlagsFromString` inside the entry file.
   */
  childSpawn?: { argsPrefix: readonly string[] };
  /**
   * Report channel for nonfatal conditions (today exactly one: the entry file could not be written into the project `.zcode/` and fell back to the OS tmpdir).
   * The harness is app-free with no logger; bootstrap wires this into its warn log.
   */
  onWarning?: (warning: HarnessWarning) => void;
  /** Child working dir, default process.cwd(); also recorded as run metadata dwf_run.cwd. */
  cwd?: string;
  /**
   * Run metadata, passed verbatim into `EngineConfig` (createRun records dwf_run). All optional; the harness
   * neither reworks nor infers: `scriptHash` is the caller's to compute. If the hashed "text it sees" on the
   * lowered path were the lowered body, resume validation would silently compare against the wrong thing.
   * The author's text travels via `scriptText` above.
   */
  scriptHash?: string;
  parentSessionId?: string;
  /** The run's display name (label source for host enumeration). Same path as `scriptText`; the harness only forwards. */
  name?: string;
  /**
   * This run's arguments (the saved workflow's declared params, validated and defaulted by the caller).
   *
   * Two destinations, unlike the rest of the metadata: recorded via `EngineConfig` as `dwf_run.args_json`
   * (resume reads it back for replay) and into the spawn payload, injected as the frozen `args` global. The harness
   * neither validates nor reworks -- declaration and validation live in the caller (the tool side). Absent means `{}`.
   */
  args?: Record<string, unknown>;
  /** The originating CreateWorkflow tool-call id (post-restart join/notification anchor); verbatim into EngineConfig. */
  toolCallId?: string;
  /**
   * The amend-resume pair, under the same rule as the rest of the metadata: verbatim into EngineConfig,
   * the harness neither reads nor reworks. `resumedFrom` is the lineage pointer recorded as `dwf_run.resumed_from`,
   * and `importedCache` the pure-data cache table injected into the engine.
   *
   * Same split as the `scriptText`/`lowered` pair: their coherence is the caller's. The harness cannot tell
   * whether this table truly came from that predecessor (that would mean reading the journal, and this package knows no store).
   * A mismatched table yields a run treating someone else's answers as its cache. Construction and gating live in the run
   * service (bootstrap's dynamic-workflow-import.ts).
   */
  resumedFrom?: string;
  /**
   * Anchor of the turn that launched the run; verbatim into EngineConfig.
   * `subagentModel` rides with the anchor and phase table: the canonical picker string for this run's subagents
   * (`providerId/modelId[$reasoningLevel]`); the neither-reads-nor-parses rule applies -- it lives zero-SQL
   * inside the `run-launched` event; parsing and precedence are host-side (bootstrap's workflow-actor-model.ts).
   * `phaseAlongside` aligns with `phaseNames` by index (same table); same ride, same rules.
   */
  launch?: {
    inputId: string;
    phaseNames?: string[];
    subagentModel?: string;
    /** Script-named model -> canonical string (docs/dynamic-workflow/launch.md, "Models the script names"); same ride, same rules. */
    modelBindings?: Record<string, string>;
    phaseAlongside?: number[][];
    /** Indexes in `phaseNames` left as open holes (docs/execution-engine.md, "Holes"); same ride, same rules. */
    holes?: number[];
  };
  importedCache?: ImportedRunCache;
  /**
   * Usage baseline at run creation (the predecessor's `spentTokens`); same rule as the rest: verbatim into
   * EngineConfig; the harness never reads it. Reading the predecessor's row happens in the run service.
   */
  inheritedTokens?: number;
}

const DEFAULT_MAX_OLD_SPACE_MB = 256;
const STDERR_LIMIT = 64 * 1024;

/**
 * Runs a workflow script to settlement. Returns the engine's {@link RunSettlement}.
 * Failure is first-class, in two classes: a script throw is the script's fault,
 * normalized to `{status:"errored", error}`; a child that cannot start / crashes / times out / corrupts the protocol is a host-side fault,
 * likely fine on retry, normalized to `{status:"stopped", reason:"interrupted", error}` (resumable).
 * Neither is ever swallowed silently.
 */
export async function runWorkflowScript(options: RunWorkflowOptions): Promise<RunSettlement> {
  const lowered = resolveLowered(options);
  const runId = options.runId ?? "run";

  // Late-bound sink: the engine is constructed after the driver, which needs the sink to report -- a forwarding proxy breaks the cycle.
  let engine!: WorkflowEngine;
  const sink: WorkflowReportSink = {
    askSubmitAttempted: (instance, payload) => engine.askSubmitAttempted(instance, payload),
    askTurnEnded: (instance, finalText) => engine.askTurnEnded(instance, finalText),
    askProgress: (instance, progress) => engine.askProgress(instance, progress),
    askStats: (instance, stats) => engine.askStats(instance, stats),
    askFailed: (instance, error) => engine.askFailed(instance, error),
    // Deterministic model-side errors stop the whole run; forwarding only, again.
    stopRun: (error) => engine.stopRun(error),
    // The three adaptive-concurrency observations and the run-stall observation: forwarding only.
    askWaiting: (instance, info) => engine.askWaiting(instance, info),
    askExecuting: (instance) => engine.askExecuting(instance),
    // The one observation the engine acts on (drop the imported cache): forwarding only.
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
    ...(options.sitePhases === undefined ? {} : { sitePhases: options.sitePhases }),
    // Metadata verbatim, absent stays absent (no undefined keys). cwd equals what the child actually uses,
    // so the process.cwd() fallback is recorded here too -- the stored cwd is the directory the run really executes in.
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
  // Bind the control plane as soon as it exists: settings are changeable from the first event, no need to wait for the child --
  // the spawn-failure path below also settles via the engine, and the handle stays safe afterwards (each command's settled check closes it out).
  options.control?.bind(engine);

  const maxOldSpaceSizeMb = options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_MB;
  const cwd = options.cwd ?? process.cwd();
  const payload: ChildPayload = {
    lowered,
    // Arguments cross once, at spawn (constant for the run's lifetime).
    ...(options.args === undefined ? {} : { args: options.args }),
    // The heap cap rides the payload into the entry file, serving only the argsPrefix path: no Node flag survives there,
    // so the entry file best-efforts it. The default path relies on the real flag; the entry skips when it sees one.
    maxOldSpaceSizeMb,
  };

  // The payload never rides the command line: Windows caps it at 32,767 chars, and a full lowered script past ~18KB there means
  // `spawn ENAMETOOLONG`. Written as an entry file,
  // argv is a single path, independent of script size.
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
        // The desktop agent runs under the Electron Helper (process.execPath points at it), and the CLI
        // sanitizes ELECTRON_RUN_AS_NODE out of its own env at startup. Without it explicitly set, the child boots as a full
        // Electron/Chromium app and stalls in GPU init -- silent forever, run stuck at run-started.
        // Under a plain-Node execPath the variable is inert (same handling as official-plugin-runtime.ts).
        // Both spawn strategies carry it: the packaged desktop can take the argsPrefix path too.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
  } catch (cause) {
    // Node converts only EACCES/EAGAIN/EMFILE/ENFILE/ENOENT into error
    // events; other spawn failures (ENAMETOOLONG, E2BIG, ...) throw synchronously. By then the engine exists and the journal row is
    // running; letting the exception escape would bypass engine settlement -- the registry records a terminal state while the journal row
    // stays running forever, and a later resume_from is rejected with has-not-settled-yet. An unwritable entry file (both
    // dirs failing) behaves the same. Always settle via the engine as stopped(interrupted): host-side fault, resumable.
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

/** Resolve the lowered body: prefer `lowered`, else lower `scriptText` (a dirty script throws; no child is started). */
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
  /** Error text for abort normalization only (the interrupted branch names the run being shut down). */
  runId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * NDJSON bridge plus lifecycle convergence. Single-writer finalize: whether reached via engine settlement, child exit, timeout, or
 * abort, first arrival wins; the child is killed and the result honored.
 */
function bridge(deps: BridgeDeps): Promise<RunSettlement> {
  const { child, engine, runId, signal, timeoutMs } = deps;

  // local#N (child-local handle) -> engine ActorId map; the stdio FIFO plus synchronous create-actor handling guarantees
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

    // Terminal failures (script throw / child crash / timeout / protocol corruption) are run failures: the engine's public fail(),
    // which settles first-wins, cancels in-flight asks driver-side, and journals failed + failure_json -- the run's verdict
    // belongs to the engine, so journal and caller never diverge. Child cleanup is finalize's job (via engine.settled).
    const failRun = (error: WorkflowError): void => {
      if (finalized) return;
      engine.fail(error);
    };
    // Host-side faults (sandbox crash / timeout / protocol corruption): stopped(interrupted), resumable.
    const interruptRun = (message: string, cause?: unknown): void => {
      if (finalized) return;
      engine.stop(
        "interrupted",
        new WorkflowError("Interrupted", message, cause === undefined ? undefined : { cause }),
      );
    };

    // Abort is the only true cancel: engine.stop(initiator), settling stopped. The initiator arrives via
    // `AbortController.abort(reason)`: the literal "model", the amend path's
    // `{ superseded: newRunId }` (successor id recorded in the same write as the reason), the literal "interrupted" (host App
    // shutdown, below); everything else is "user".
    function onAbort(): void {
      if (finalized) return;
      const reason: unknown = signal?.reason;
      const supersededBy = readSupersededBy(reason);
      if (supersededBy !== undefined) {
        engine.stop("superseded", undefined, supersededBy);
        return;
      }
      // The host stopping a run it owns (the run service's close()). Not a user cancel: recorded with the Interrupted failure code, kin to
      // timeouts and sandbox crashes -- stopped(interrupted) is resumable, while stopped(user) reads as
      // user-pressed-stop in the UI. The error text names run and cause; the detail page uses it to explain the row on next open.
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

    // Every settlement (complete / fail / stop / engine-internal cap failure) surfaces to finalize via engine.settled.
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
    // A response may still be pending after the child exits: an error listener on stdin keeps EPIPE from surfacing uncaught.
    child.stdin?.on("error", () => undefined);

    reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: ChildMessage;
      try {
        message = JSON.parse(line) as ChildMessage;
      } catch (cause) {
        // Corrupt child line JSON: surface it, never swallow.
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
      // Child exited with no engine settlement: crashed or killed before complete. Attributed via stderr.
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

/** Dispatches one child->parent message. Asks/world-reads bridge to the engine asynchronously and answer with the latest budget attached. */
function handleChildMessage(message: ChildMessage, deps: MessageDeps): void {
  const { engine, actorMap, child, failRun } = deps;

  switch (message.kind) {
    case "create-actor": {
      // Handled synchronously: the mapping exists before any ask naming the handle (the stdio FIFO premise). createActor is purely synchronous and
      // throws synchronously once settled -- no response channel then, so catch and count it a run failure (usually a harmless teardown race).
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
      // Dispatch synchronously, like log: the event channel's FIFO order is load-bearing for report and declare-artifact
      // (the parent journals what arrives, and a tagged report must be recorded after its declaration),
      // and going async would decouple arrival order from journal order.
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
        // Script threw: run failure (details from the sandbox).
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

/** Bridges one reply-required host call (ask / world-read / publish-artifact / hole) to the engine, answering after settlement. */
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
    // The child may already be gone (cancel/failure teardown): write only when writable; EPIPE-class races die at this boundary (the run is settling).
    const stdin = child.stdin;
    if (stdin === null || !stdin.writable) return;
    stdin.write(`${JSON.stringify(response)}\n`, () => undefined);
  };

  let promise: Promise<unknown>;
  if (message.type === "ask") {
    const actorId = actorMap.get(message.actor ?? "");
    if (actorId === undefined) {
      // Missing mapping (should not happen: the FIFO guarantees it) -- normalized to a structured UnknownActor refusal, never silent.
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
      // A missing op is a wiring error (lowering always sets it). No invented default: a markdown publish
      // mishandled as a file fails far from the cause. Normalized to a structured refusal the script can see.
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
  } else if (message.type === "hole") {
    // Holes: the engine parks the promise at the site; only after the main agent's fillHole via the control plane is there a `{code}` to answer;
    // until then it is an in-flight request (docs/execution-engine.md, "The vm cell").
    promise = engine.hole(message.siteId, message.name ?? "", message.prompt);
  } else {
    // op/args pass through verbatim: this layer reads no op and validates no arity (the driver's job). Missing args become an empty array so
    // the driver's argument validation rejects loudly instead of a quiet default here.
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

/** WorkflowError -> wire shape (keeps code/violations/finalText for structured try/catch in sandbox scripts). */
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

/** Keeps the last `limit` bytes of a string (stderr truncation). */
function trimTail(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return value.slice(-limit);
}

/** Extractes the successor id when the abort reason is `{ superseded: <runId> }`; undefined otherwise. */
function readSupersededBy(reason: unknown): string | undefined {
  if (typeof reason !== "object" || reason === null) return undefined;
  const value = (reason as { superseded?: unknown }).superseded;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
