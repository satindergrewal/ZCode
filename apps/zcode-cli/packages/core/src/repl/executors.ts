import { runInContext, type Context } from "node:vm";
import {
  instrumentForContextPersistence,
  parseReplCode,
  rewriteDynamicImportsForRepl,
} from "./instrument.js";

/**
 * ReplExecutor — the execute-plus-persist-across-calls strategy seam (A-ready).
 *
 * NodeReplSession.run only calls executor.run; swapping the implementation swaps the route:
 * - Route B (current): IifeContextExecutor — instrument top-level declarations → async-IIFE → runInContext.
 * - Route A (future, needs --experimental-vm-modules): SourceTextModuleExecutor — harvest-style instrument
 *   → SourceTextModule.evaluate → harvest namespaces. The host stays; only this implementation swaps.
 *
 * Contract: return the completion value; throw on error (normalized by NodeReplSession's try/catch).
 * signal supports cancellation (timeout/stop).
 */
export interface ReplExecutor {
  run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs?: number,
  ): Promise<unknown>;
}

/**
 * Route B executor: parse the user code, instrument top-level declarations to copy them into the persistent context (globalThis),
 * wrap in an async-IIFE for top-level await, and runInContext on the persistent context.
 *
 * On parse failure → fall back to the original code (an instrument crash must not break runs); top-level const/let then do not persist but still run.
 */
export class IifeContextExecutor implements ReplExecutor {
  async run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs = 5_000,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    // Instrument: inject globalThis assignments after top-level declarations; fall back verbatim on parse failure.
    const rewrittenCode = rewriteDynamicImportsForRepl(code);
    const rewrittenParsed = parseReplCode(rewrittenCode);
    const effectiveCode =
      "ast" in rewrittenParsed
        ? instrumentForContextPersistence(rewrittenCode, rewrittenParsed.ast)
        : rewrittenCode;

    // Async-IIFE wrapper for top-level await. Dynamic imports use the injected importModule (see NodeReplSession.buildContext);
    // do not pass importModuleDynamically, avoiding vm's --experimental-vm-modules requirement.
    const wrapped = `(async () => {\n${effectiveCode}\n})()`;
    // Promise.race cancels only async code that has returned control to the event loop; `while(true){}`
    // would pin the agent thread forever, leaving the outer timeout/AbortSignal timer no chance to run.
    // vm's own sync-execution budget rides V8 interrupts and truly breaks synchronous loops; it covers only
    // runInContext's synchronous segment; awaits afterwards remain governed by the AbortSignal race.
    const promise = runInContext(wrapped, context, {
      timeout: Math.max(1, Math.trunc(syncTimeoutMs)),
    }) as Promise<unknown>;

    return signal ? await raceAbort(promise, signal) : await promise;
  }
}

function abortReason(signal: AbortSignal): unknown {
  // AbortSignal.timeout's reason is TimeoutError. Rewriting it to AbortError across the board would make
  // MCP hard timeouts indistinguishable from user stops and the kernel-reset recovery guidance wrong.
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "name" in reason) return reason;
  return new DOMException(typeof reason === "string" ? reason : "aborted", "AbortError");
}

/** Race the promise against signal.abort: on abort reject with signal.reason, else pass the result through. */
function raceAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
