/**
 * Sandbox child logic. **One implementation, one entry file, two launch modes**:
 *   - {@link renderChildEntry} renders {@link childMain} via `toString()` plus the payload into one self-contained
 *     ESM; the harness writes it to `<cwd>/.zcode/workflow-runs/<runId>.mjs` (child-entry-file.ts);
 *   - plain Node: `node --max-old-space-size=N <entry>`; the entry self-starts when it detects it IS the entry;
 *   - SEA single-binary: the CLI's hidden subcommand `__zcode-dwf-child <entry>` `import()`s the file and calls
 *     its exported `start(deps)`, injecting the CLI process's vm/readline/stdio (the SEA main does not parse Node
 *     CLI flags, so `--eval` is out).
 *
 * Windows caps command lines at 32,767 chars:
 * `--eval CHILD_SOURCE -- <base64url payload>` would put the whole lowered script on the command line; past ~18KB
 * it dies with `spawn ENAMETOOLONG` and every longer run fails to start on Windows.
 *
 * Structure:
 *   - the outer realm ({@link childMain} itself) is plain Node: owns stdio, readline, vm; handles transport.
 *   - the evaluation unit is a **separate realm** via `vm.createContext(...)`: ES intrinsics plus the injected
 *     `__host` only. A bare vm context has no `process`/`require`/`Buffer`/`fetch`; we add `__host` and runtime bans.
 *
 * Cross-realm hygiene (anti prototype pollution): everything the script touches (Promises, JSON-parsed host
 * results, Errors) is constructed **inside the context**; only two values cross between outer and context -- one
 * `__send(string)` outer function, and inbound line strings (strings are primitives, realm-free). So `Array.isArray`/
 * `instanceof`/prototype chains are context-native from the script's view, never mixed with outer intrinsics.
 *
 * Dynamic import: runFn is compiled via `vm.runInContext` (Script, no importModuleDynamically callback), so runtime
 * `import()` throws `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. `eval`/`Function` bind to the same context globals.
 *
 * This file is a **hand-written mirror** of protocol.ts's wire protocol: childMain inside the entry file runs as an
 * inline string and cannot import protocol.ts. Either side changed means both changed. So {@link childMain} may
 * only import **types** (erased at compile time) -- never runtime package dependencies.
 */

import type { ChildPayload } from "./protocol.js";

/** The entire `node:vm` surface {@link childMain} uses (two functions -- that is the child's whole vm contract). */
export interface ChildVmModule {
  createContext(sandbox: object, options?: { name?: string }): object;
  runInContext(code: string, sandbox: object, options?: { filename?: string }): unknown;
}

/** The `readline.Interface` surface {@link childMain} uses. */
export interface ChildReadlineInterface {
  on(event: "line", listener: (line: string) => void): unknown;
  close(): void;
}

/**
 * Host capabilities injected into {@link childMain}. **Each launch mode supplies the real implementation**: the
 * self-starting entry takes them from `node:vm` / `node:readline` / `process`; the SEA subcommand from the CLI process.
 */
export interface ChildMainDeps {
  vm: ChildVmModule;
  createInterface(options: { input: NodeJS.ReadableStream }): ChildReadlineInterface;
  /** Where inbound responses come from (the parent's stdin pipe). Holding it also keeps the event loop alive. */
  stdin: NodeJS.ReadableStream;
  /** Where outbound NDJSON goes; {@link childMain} adds the newlines itself. */
  stdout: { write(chunk: string): unknown };
  /**
   * This run's payload ({@link import("./protocol.js").ChildPayload}). The entry file embeds it as a JSON
   * literal and passes it through verbatim -- no argv, no base64.
   */
  payload: ChildPayload;
}

/**
 * The sandbox child's **only** exit. The returned promise settles once the script terminates (complete sent, stdin closed).
 *
 * Why awaitable: the SEA subcommand runs inside the CLI process, whose entry arms a 1s exit watchdog after `run()`
 * returns (`scheduleCliExitWatchdog` in shutdown.ts). If the child logic merely "sets up readline and returns
 * synchronously", the watchdog force-exits the child just as the run starts. The self-starting entry does not need
 * the promise (the loop drains naturally), but both entries share one implementation, so childMain owns the termination signal.
 *
 * Self-containment constraint (payload-ability, not style). {@link renderChildEntry} embeds this function as
 * **source** via `childMain.toString()`, so the body must be a standalone-valid program. Two rules:
 *   1. Reference only parameters, language intrinsics, and Node globals like `Buffer` -- **never any module-scope
 *      binding** (constants, helpers, imports). The sandbox bootstrap is therefore inlined in the body, not a module constant.
 *   2. **Inner functions must never be named** -- rationale and war story in the comment inside the body (esbuild's
 *      `minify + keepNames` wraps them in a module-scope `__name` helper).
 * Both constraints need verification against real bundled/minified output; source-level tests cannot catch these regressions.
 */
export function childMain(deps: ChildMainDeps): Promise<void> {
  /**
   * Bootstrap script running inside the vm context (plain JS, no backticks/${} so it embeds safely).
   * Defines `__host` (Boundary A shims), `__deliver` (consumes inbound responses), `__execute` (runs the lowered fn),
   * and installs the runtime bans (Date.now / argless new Date() / Math.random) -- the belt; compile-time checks are suspenders.
   */
  const BOOTSTRAP = String.raw`
"use strict";

var __nextLocal = 0;
var __nextReq = 0;
var __pending = new Map();

function __emit(obj) {
  __send(JSON.stringify(obj));
}

function __createActor(siteId, name, persona) {
  // Mint the child-local handle and fire-and-forget create-actor; the parent maps it via stdio FIFO before later asks.
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
  // args is the lowered positional array; forward verbatim -- no op inspection, no arity checks (the driver's job).
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
  });
}

function __log(message) {
  __emit({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
  // Phase marker: no site, not journaled, just one engine event -- hence the event channel, like log.
  __emit({ kind: "event", type: "phase-entered", name: String(name) });
}

function __publishArtifact(siteId, op, args) {
  // Content artifacts are effects: the script awaits and must catch rejections, so like ask/world-read they use
  // request/response. args is the lowered positional array ([id, path|content, opts]), forwarded verbatim.
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: op, args: args });
  });
}

function __declareArtifact(siteId, op, args) {
  // Declared artifacts are statements: sync void, nothing to await -- event channel. They share report's FIFO: a
  // labeled report must reach the parent after its declaration, and exactly this ordering guarantees that.
  __emit({ kind: "event", type: "declare-artifact", siteId: siteId, op: op, args: args });
}

function __report(siteId, item, artifactId) {
  // Fire-and-forget: the script never awaits it, so event channel, not request/response. The parent journals one row
  // per siteId x ordinal, so this message's **arrival order** is load-bearing (guaranteed by the stdio FIFO).
  // A cyclic item makes JSON.stringify throw -- right at the report() call site; the script either catches it or
  // the run fails. Both beat silently emitting a broken item; the parent has the same guard.
  // A missing artifactId is dropped by JSON.stringify, so on the wire it is simply "unlabeled".
  __emit({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

// -- run arguments (Boundary A's args) --
// Built inside the context via JSON.parse, like the budget, so the script gets context-native objects and none of
// the outer realm's intrinsics leak in (cross-realm hygiene, top of file).
// Object.freeze is **shallow**: nested objects stay mutable, the script can still change args.foo.bar. v1 accepts
// that -- it guards against accidental args reassignment, not a security boundary (the caller supplied them anyway).
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
};

// -- inbound response consumption (called by the outer realm with line strings) --
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

function __complete(ok, payload) {
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

// Called by the outer realm to run the script; always resolves (errors became complete messages) so the outer can finalize (close stdin).
globalThis.__execute = async function (runFn) {
  try {
    var value = await runFn(globalThis.__host);
    __complete(true, value);
  } catch (e) {
    __complete(false, e);
  }
};

// -- runtime bans (the belt; compile-time checks the suspenders): Date.now / argless new Date() / Math.random --
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

  // Second self-containment rule (see the comment above the function), easier to trip than "no imports": **inner
  // functions must never be named**. Root cause (really hit before this test existed): the CLI desktop-agent build
  // uses `minify + keepNames`, under which esbuild rewrites name-derivable inner functions (const bindings,
  // function declarations, object-literal methods) to `__name(fn, "send")`, and `__name` is a module-scope helper.
  // Once it appears in `toString()` output, the embedded child program ReferenceErrors -- broken **only in minified
  // release builds**, source tests all green. Member assignments (`sandbox.__send = ...`) and argument-position
  // arrows are not rewritten, so only those two shapes appear below. Verify against the real bundled artifact.

  const payload = deps.payload;

  // Separate realm: a bare context has ES intrinsics only; inject the __send transport and the args JSON.
  // Absent args (inline runs, legacy journal rows) encode as "{}": `args` always defined is a script-side invariant,
  // and the sandbox side is where it is enforced.
  const sandbox = {
    __argsJson: JSON.stringify(payload.args ?? {}),
  } as {
    __send: (line: string) => void;
    __argsJson: string;
    __deliver: (line: string) => void;
    __execute: (runFn: unknown) => Promise<void>;
  };
  sandbox.__send = (line) => {
    deps.stdout.write(`${line}\n`);
  };
  deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
  deps.vm.runInContext(BOOTSTRAP, sandbox, { filename: "workflow-bootstrap.js" });

  // Compile the lowered body (context-native async fn; its awaits create context Promises; import() without a callback throws).
  let runFn: unknown;
  try {
    runFn = deps.vm.runInContext(`(async (__host) => {\n${payload.lowered}\n})`, sandbox, {
      filename: "workflow-script.js",
    });
  } catch (error) {
    // Lowered-body compile failure: emit error-complete and finish. Deliberately **not** process.exit -- stdout
    // writes to the pipe are async, and an immediate exit would truncate the complete just written (the parent
    // would see "exited without completing", losing the SyntaxError detail). No reader is pending on the loop, so
    // the child exits naturally once flushed.
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
  reader.on("line", (line: string) => {
    if (!line.trim()) return;
    sandbox.__deliver(line);
  });

  // Run the script; on completion close stdin so the process exits on the idle loop (the parent also kills after complete).
  return sandbox.__execute(runFn).then(
    () => reader.close(),
    () => reader.close(),
  );
}

/** Anything outside the runId-safe charset becomes `_` (shared by file name and header comment). */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Render the sandbox entry file: one self-contained ESM the harness writes to disk and starts via `node <entry>`.
 *
 * Contents: the payload as a JSON literal (`JSON.stringify` output is a legal JS expression), {@link childMain}
 * embedded via `toString()`, the exported `start(deps)`, and two top-level blocks:
 *   - heap-cap best effort: the normal path relies on the real `--max-old-space-size` flag; SEA self re-exec cannot
 *     pass flags, so only when `execArgv` lacks it do we `v8.setFlagsFromString` (no effect guaranteed, same caveat
 *     as the atomic-command side);
 *   - self-start detection: when `realpath(argv[1])` resolves to this file (the `node <entry>` case) self-start with
 *     the process's vm/readline/stdio; when `import()`ed by the SEA subcommand the check is false and the subcommand
 *     calls `start`. Compare realpaths, not raw paths: macOS symlinks tmpdir `/var -> /private/var` while
 *     `import.meta.url` is already resolved, so a raw compare would leave the child silently unstarted.
 *
 * The only interpolations are childMain's source text and the payload JSON. childMain containing template literals
 * is fine -- interpolation is **runtime string concatenation**, the embedded text is not re-parsed; the real risk
 * lives on childMain's self-containment side (see its comment). The generated top-level code deliberately avoids
 * template literals so it never fights the outer `${}`.
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

const main = ${childMain.toString()};

export const start = (deps) => main({ ...deps, payload });

if (
  typeof payload.maxOldSpaceSizeMb === "number" &&
  Number.isFinite(payload.maxOldSpaceSizeMb) &&
  payload.maxOldSpaceSizeMb > 0 &&
  !process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))
) {
  try {
    setFlagsFromString("--max-old-space-size=" + Math.trunc(payload.maxOldSpaceSizeMb));
  } catch {
    // Best effort: V8 may ignore flags already consumed at startup; failure must never affect the run.

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
