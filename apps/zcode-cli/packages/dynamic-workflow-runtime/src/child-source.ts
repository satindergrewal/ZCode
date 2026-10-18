/**
 * Sandbox child logic. One implementation, one entry file, two launch paths:
 *   - {@link renderChildEntry} renders {@link childMain} via `toString()` plus the payload as a
 *     self-contained ESM the harness writes to `<cwd>/.zcode/workflow-runs/<runId>.mjs` (child-entry-file.ts);
 *   - plain Node: `node --max-old-space-size=N <entry>`; the entry self-starts when it detects it is the process entry;
 *   - SEA single-file binary: the CLI's hidden `__zcode-dwf-child <entry>` subcommand imports this file and calls
 *     its `start(deps)` with the CLI process's vm/readline/stdio (the SEA binary does not interpret Node CLI
 *     flags, so --eval is a dead end).
 *
 * Windows caps the command line at 32,767 chars:
 * `--eval CHILD_SOURCE -- <base64url payload>` puts the whole lowered body on the command line, and past ~18KB
 * it is `spawn ENAMETOOLONG` -- every longer run failing to start on Windows.
 *
 * Structure:
 *   - The outer realm ({@link childMain} itself) is plain Node code: stdio, readline, vm; it does transport.
 *   - The evaluation unit is a separate realm from `vm.createContext(...)`: ES intrinsics plus the injected `__host` only.
 *     A bare vm context has no process/require/Buffer/fetch and no timers; we add only `__host`
 *     and the runtime bans. channel/future and stall detection (docs/dynamic-workflow/authoring.md, "Streams")
 *     live inside the cell: the former is pure promise machinery, the latter holds precisely because the cell has no other wakeup source.
 *
 * Cross-realm containment (against prototype leaks / pollution): everything the script touches (Promises, JSON-parsed
 * host results, Errors) is constructed inside the context. Only two values cross between outer realm and context: one `__send(string)`
 * outer function and inbound line strings (strings are primitives, realm-free). So `Array.isArray`/`instanceof`/
 * prototype chains are context-native from the script's view, with no outer-realm intrinsics mixed in.
 *
 * Dynamic import: runFn compiles via `vm.runInContext` (a Script with no importModuleDynamically callback), so
 * runtime `import()` throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING. `eval`/`Function` bind the same
 * context globals.
 *
 * WARNING: this file hand-mirrors protocol.ts's wire protocol -- childMain runs as an embedded string in the entry file and cannot import it.
 * Change either side only together. {@link childMain} may import types only (erased at compile time),
 * never runtime package deps; this module's only value import (the bootstrap string from child-cell-streams.ts) is
 * read by {@link renderChildEntry} and embedded into the entry file; childMain itself receives it via deps.
 */

import { CELL_STREAMS_BOOTSTRAP } from "./child-cell-streams.js";
import type { ChildPayload } from "./protocol.js";

/** The entire `node:vm` surface childMain uses (two functions -- the child's whole vm contract). */
export interface ChildVmModule {
  createContext(sandbox: object, options?: { name?: string }): object;
  runInContext(code: string, sandbox: object, options?: { filename?: string }): unknown;
}

/** The `readline.Interface` surface childMain uses. */
export interface ChildReadlineInterface {
  on(event: "line", listener: (line: string) => void): unknown;
  close(): void;
}

/**
 * Host capabilities injected into {@link childMain}. Each launch path supplies real implementations: the self-starting entry takes them from
 * node:vm / node:readline / process directly; the SEA subcommand takes them from the CLI process.
 */
export interface ChildMainDeps {
  vm: ChildVmModule;
  createInterface(options: { input: NodeJS.ReadableStream }): ChildReadlineInterface;
  /** Source of inbound responses (the parent's stdin pipe). Holding it also keeps the event loop alive. */
  stdin: NodeJS.ReadableStream;
  /** Destination for outbound NDJSON; {@link childMain} adds the newlines itself. */
  stdout: { write(chunk: string): unknown };
  /**
   * This run's payload ({@link import("./protocol.js").ChildPayload}). The entry file embeds it as a JSON
   * literal and hands it over verbatim -- no argv, no base64.
   */
  payload: ChildPayload;
  /**
   * The cell's second bootstrap: channel/future and stall detection (the CELL_STREAMS_BOOTSTRAP
   * from child-cell-streams.ts). Same road as the payload --
   * embedded as a string literal and handed over verbatim by `start` -- because childMain's self-containment rule
   * forbids module-scope references, and keeping it here would blow the file-length cap. It runs after BOOTSTRAP and
   * before the lowered body in the same context, reading/writing the context globals BOOTSTRAP declares via `var`.
   */
  streamsBootstrap: string;
}

/**
 * The sandbox child's single exit. The returned promise settles once script execution ends (complete sent, stdin closed).
 *
 * Why it must be awaitable: the SEA subcommand runs inside the CLI process, whose entry arms a 1s
 * exit watchdog after `run()` returns (scheduleCliExitWatchdog in shutdown.ts). If the child logic merely installs readline
 * and returns synchronously, the watchdog force-exits the child just as the run starts. The self-starting entry needs no such
 * promise (the event loop drains naturally), but both entries share one implementation, so childMain owns the termination signal.
 *
 * WARNING: the self-containment constraint is load-bearing, not style. {@link renderChildEntry} embeds this function
 * as source via `childMain.toString()`; the body must stand alone as a program. Two rules:
 *   1. Reference only parameters, language intrinsics, and Node globals like `Buffer` -- never any module-scope binding
 * (constants, helpers, imports). Hence the sandbox bootstrap is inlined in the body, not a module constant.
 *   2. Inner functions must never be named -- the why and the scar tissue live in the comment inside the body (esbuild's
 *      minify+keepNames wraps them in a module-scope `__name` helper).
 * Both constraints need verification against real bundled/minified artifacts; source-form tests cannot catch these regressions.
 */
export function childMain(deps: ChildMainDeps): Promise<void> {
  /**
   * Bootstrap running inside the vm context (plain JS, no backticks/${} so it embeds safely).
   * Defines `__host` (Boundary A shims), `__deliver` (consumes inbound responses), `__execute` (runs the lowered fn),
   * and applies the runtime bans (Date.now / argless new Date() / Math.random) -- the belt; compile-time checks are suspenders.
   */
  const BOOTSTRAP = String.raw`
"use strict";

var __nextLocal = 0;
var __nextReq = 0;
var __pending = new Map();
// Filled holes this incarnation: site id -> body text. A revisit (loops) evaluates locally, never crossing the wire again.
var __fills = new Map();

function __emit(obj) {
  __send(JSON.stringify(obj));
}

function __createActor(siteId, name, persona) {
  // Mint the child-local handle and fire-and-forget create-actor; the parent maps it via the stdio FIFO before any later ask.
  var localId = "local#" + (++__nextLocal);
  __emit({ kind: "create-actor", localId: localId, siteId: siteId, name: name, persona: persona });
  return localId;
}

function __ask(siteId, actor, instructions) {
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "ask", siteId: siteId, actor: actor, instructions: instructions });
  });
}

function __worldRead(siteId, op, args) {
  // args is the positional array lowering packed; this shim passes it verbatim -- no op reading, no arity checks (the driver's job).
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
  });
}

function __evaluateFill(evaluate, code) {
  // evaluate is the (__src) => eval(__src) lowering emits at the site: a direct eval closing over every binding the author's code
  // has at that point (__host included), yielding the (async () => {...}) function; call it and the result is the hole's value.
  // A fresh evaluate per arrival, so a hole in a loop sees each iteration's bindings. Evaluation failures (syntax) and body
  // rejections both surface on this promise, at the site, catchable by the script.
  return Promise.resolve().then(function () {
    return evaluate(code)();
  });
}

function __hole(siteId, name, prompt, evaluate, body) {
  // Already filled (the body is in the script): call it directly, no wire. Sync throws become rejections, same as future.
  if (body !== undefined) {
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  var remembered = __fills.get(siteId);
  if (remembered !== undefined) return __evaluateFill(evaluate, remembered);
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "hole", siteId: siteId, name: name, prompt: prompt });
  }).then(function (answer) {
    __fills.set(siteId, answer.code);
    return __evaluateFill(evaluate, answer.code);
  });
}

function __log(message) {
  __emit({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
  // Phase marker: no site, no journal row, just one engine event -- hence the event channel, like log.
  __emit({ kind: "event", type: "phase-entered", name: String(name) });
}

function __publishArtifact(siteId, op, args) {
  // Content artifacts are effects: the script awaits and must be able to catch rejections, so they ride request/response
  // like ask/world-read. args is the positional array lowering packed ([id, path|content, opts]), passed verbatim.
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: op, args: args });
  });
}

function __declareArtifact(siteId, op, args) {
  // Predeclared artifacts are declarations: synchronous void, nothing to await -- the event channel. They share the report's
  // FIFO: a tagged report must reach the parent after its declaration, and this is what guarantees the order.
  __emit({ kind: "event", type: "declare-artifact", siteId: siteId, op: op, args: args });
}

function __report(siteId, item, artifactId) {
  // Fire-and-forget: the script never awaits it, so the event channel, not request/response. The parent journals by siteId x
  // ordinal, so this message's arrival order is load-bearing (the stdio FIFO provides it).
  // A cyclic item makes this JSON.stringify throw, right at the report() call site: the script catches
  // or the run fails -- both better than silently emitting a broken item; the parent keeps the same guard.
  // With no artifactId, JSON.stringify drops the key: on the wire, simply unlabeled.
  __emit({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

// -- Run arguments (Boundary A args) -----------------------------------------------------------
// Like the budget, built inside the context via JSON.parse, so the script gets a context-native object with
// zero outer-realm intrinsics (the cross-realm containment rule at the top of this file).
// WARNING: Object.freeze is shallow -- nested objects stay mutable, args.foo.bar included. v1 accepts
// that boundary: it guards accidental args reassignment, not a security border (the caller supplied them).
var __args = Object.freeze(JSON.parse(__argsJson));

globalThis.__host = {
  args: __args,
  createActor: __createActor,
  ask: __ask,
  worldRead: __worldRead,
  publishArtifact: __publishArtifact,
  declareArtifact: __declareArtifact,
  report: __report,
  log: __log,
  enterPhase: __enterPhase,
  hole: __hole,
};

// -- Inbound response consumption (called by the outer realm with line strings) -----------------
globalThis.__deliver = function (line) {
  var msg = JSON.parse(line);
  if (msg.kind !== "response") return;
  var waiter = __pending.get(msg.id);
  if (!waiter) return;
  __pending.delete(msg.id);
  if (msg.ok) {
    waiter.resolve(msg.value);
    return;
  }
  // Rejections cross as a context-native Error carrying code/violations/finalText for structured try/catch.
  var e = msg.error || {};
  var err = new Error(e.message || "workflow host error");
  if (e.name) err.name = e.name;
  if (e.code !== undefined) err.code = e.code;
  if (e.violations !== undefined) err.violations = e.violations;
  if (e.finalText !== undefined) err.finalText = e.finalText;
  waiter.reject(err);
};

// Whether complete has been sent. The stall check (__checkStalled in deps.streamsBootstrap) reads and writes it too.
var __settled = false;

function __complete(ok, payload) {
  // Idempotent: once the stall check error-completes the run, a (theoretical) later script complete sends nothing.
  if (__settled) return;
  __settled = true;
  if (ok) {
    __emit({ kind: "complete", ok: true, value: payload });
    return;
  }
  var wire;
  if (payload instanceof Error) {
    wire = {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      code: payload.code,
      violations: payload.violations,
      finalText: payload.finalText,
    };
  } else {
    wire = { name: "Error", message: String(payload) };
  }
  __emit({ kind: "complete", ok: false, error: wire });
}

// Called by the outer realm to run the script; always resolves (errors became complete messages) so teardown is simple (close stdin).
globalThis.__execute = async function (runFn) {
  try {
    var value = await runFn(globalThis.__host);
    __complete(true, value);
  } catch (e) {
    __complete(false, e);
  }
};

// -- Runtime bans (belt; compile checks are suspenders): Date.now / argless new Date() / Math.random ---
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor() {
    if (arguments.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...arguments);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return __NativeDate.parse(value);
  }
  static UTC() {
    return __NativeDate.UTC.apply(__NativeDate, arguments);
  }
}
globalThis.Date = __WorkflowDate;
Math.random = function () {
  throw new Error("Math.random() is disabled in workflows");
};
`;

  // The second self-containment rule (see the note above the function), easier to trip than no-import: inner functions must never be named.
  // Root cause (bitten before this test existed): the CLI's desktop-agent build uses minify + keepNames,
  // under which esbuild rewrites name-inferable inner functions (const declarations, function declarations,
  // object-literal methods) to `__name(fn, "send")`, with __name a module-scope helper.
  // The moment it appears in the toString() text, the embedded child program ReferenceErrors -- broken only in
  // minified release artifacts, green in source tests. Member assignment (`sandbox.__send = ...`) and argument-position anonymous
  // functions are not rewritten, so only those two shapes appear below. Verify against real bundled, minified artifacts.

  const payload = deps.payload;

  // Separate realm: the bare context has ES intrinsics only; inject the __send transport plus the args JSON.
  // Absent args (inline runs, old journal rows) encode as "{}": args-always-defined is a script-side invariant,
  // and the sandbox is where it is made true.
  const sandbox = {
    __argsJson: JSON.stringify(payload.args ?? {}),
  } as {
    __send: (line: string) => void;
    __argsJson: string;
    __deliver: (line: string) => void;
    __execute: (runFn: unknown) => Promise<void>;
    __checkStalled: () => boolean;
  };
  sandbox.__send = (line) => {
    deps.stdout.write(`${line}\n`);
  };
  deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
  deps.vm.runInContext(BOOTSTRAP, sandbox, { filename: "workflow-bootstrap.js" });
  deps.vm.runInContext(deps.streamsBootstrap, sandbox, { filename: "workflow-streams.js" });

  // Compile the lowered body (a context-native async fn; awaits yield context Promises, and import() throws with no callback).
  let runFn: unknown;
  try {
    runFn = deps.vm.runInContext(`(async (__host) => {\n${payload.lowered}\n})`, sandbox, {
      filename: "workflow-script.js",
    });
  } catch (error) {
    // Lowered-body compile failure: emit error-complete, then finish. No process.exit on purpose -- stdout writes
    // to the pipe are async, and an immediate exit would truncate the complete just sent (the parent would see exited-without-complete
    // and lose the SyntaxError detail). No reader remains on the event loop; the child exits naturally once flushed.
    const err = error as { name?: string; message?: string; stack?: string } | undefined;
    deps.stdout.write(
      `${JSON.stringify({
        kind: "complete",
        ok: false,
        error: {
          name: err?.name ?? "SyntaxError",
          message: err?.message ?? String(error),
          stack: err?.stack,
        },
      })}\n`,
    );
    return Promise.resolve();
  }

  // stdin keeps the event loop alive; each line feeds the context's __deliver.
  const reader = deps.createInterface({ input: deps.stdin });
  // Stall detection (execution-engine.md, "The vm cell"): after each response delivery and once the script starts,
  // ask the cell once on setImmediate whether anything can still happen. setImmediate runs after this round's
  // microtasks (every continuation a response could spawn has run) and the cell has no timers or I/O, so
  // no-in-flight-request-and-incomplete, once true, stays true. On a hit the cell has already error-completed; here we only
  // retire the reader (__execute never settles; this path does the teardown). setImmediate is a Node global and
  // both launch paths run in Node, honoring this function's self-containment rule.
  // Both setImmediate call sites are inlined rather than extracted into `const scheduleStallCheck = ...`: a name-inferable
  // inner function gets wrapped in the module-scope __name helper under minify+keepNames (see the note above),
  // something tests/child-source-bundled.test.ts once caught.
  reader.on("line", (line: string) => {
    if (!line.trim()) return;
    sandbox.__deliver(line);
    setImmediate(() => {
      if (sandbox.__checkStalled()) reader.close();
    });
  });

  // Run the script; teardown closes stdin and the process exits on the idle loop (the parent also kills after complete).
  const execution = sandbox.__execute(runFn).then(
    () => reader.close(),
    () => reader.close(),
  );
  setImmediate(() => {
    if (sandbox.__checkStalled()) reader.close();
  });
  return execution;
}

/** Characters outside the runId filename safe-set become `_` (one sanitizer shared by filename and header comment). */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Renders the sandbox entry file: one self-contained ESM the harness writes to disk and starts via `node <entry>`.
 *
 * Contents: the payload as a JSON literal (JSON.stringify output is a legal JS expression), the `toString()`-
 * embedded {@link childMain}, an exported `start(deps)`, and two top-level behaviors:
 *   - best-effort heap cap: the default path relies on the real --max-old-space-size flag; the SEA re-exec cannot pass flags,
 *     so v8.setFlagsFromString runs only when execArgv lacks it (best effort, same as the atomic-command side);
 *   - self-start check: when realpath(argv[1]) equals this file (the `node <entry>` case) it self-starts with the process's
 *     vm/readline/stdio; under the SEA subcommand's import() it is false and the subcommand calls `start`.
 *     realpath, not the raw path: macOS tmpdir crosses the /var -> /private/var symlink,
 *     import.meta.url is the resolved real path, and a raw compare would silently never start the child.
 *
 * The only interpolations are childMain's source text and the payload JSON. childMain containing template literals is fine --
 * interpolation is runtime string concatenation and the embedded text is not re-parsed; the real risk lives on
 * childMain's self-containment side (see its comment). The generated top-level code avoids template literals so they cannot fight the outer ${}.
 */
export function renderChildEntry(payload: ChildPayload, meta: { runId: string }): string {
  const runId = safeRunId(meta.runId);
  return `// zcode dynamic workflow run ${runId}
// Generated by @zcode/dynamic-workflow-runtime before every launch; safe to delete once the run has settled.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import vm from "node:vm";

export const payload = ${JSON.stringify(payload)};

// The cell's second bootstrap (channel/future/stall detection), embedded as a literal like the payload.
export const streamsBootstrap = ${JSON.stringify(CELL_STREAMS_BOOTSTRAP)};

const main = ${childMain.toString()};

export const start = (deps) => main({ ...deps, payload, streamsBootstrap });

if (
  typeof payload.maxOldSpaceSizeMb === "number" &&
  Number.isFinite(payload.maxOldSpaceSizeMb) &&
  payload.maxOldSpaceSizeMb > 0 &&
  !process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))
) {
  try {
    setFlagsFromString("--max-old-space-size=" + Math.trunc(payload.maxOldSpaceSizeMb));
  } catch {
    // Best effort: V8 may ignore flags consumed during startup; failure must not touch the run.
  }
}

let isProcessEntry = false;
try {
  isProcessEntry =
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isProcessEntry = false;
}
if (isProcessEntry) {
  void start({ vm, createInterface, stdin: process.stdin, stdout: process.stdout });
}
`;
}
