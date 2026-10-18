import {
  MCP_APPS_SAMPLING_MAX_OPERATIONS,
  MCP_APPS_SAMPLING_MAX_PER_AGENT,
  MCP_APPS_SAMPLING_MAX_PER_SESSION,
  MCP_APPS_SAMPLING_TIMEOUT_MS,
} from "@zcode/shared/mcp-apps";
import { ProtocolRequestError } from "../server-types.js";

type Scope = { token: string; sessionId: string; signal: AbortSignal };
type Ledger = { scope: Scope; calls: Map<string, AbortController | null> };
const cancelled = () => new ProtocolRequestError(-32000, "Sampling cancelled");

/** Single owner of the terminal ledger and concurrency slots; the ledger clears only on credential invalidation, old operationIds never replay. */
export class McpUiSamplingCalls {
  private readonly instances = new Map<string, Ledger>();
  private readonly sessions = new Map<string, number>();
  private active = 0;

  private ledger(scope: Scope): Ledger {
    scope.signal.throwIfAborted();
    let ledger = this.instances.get(scope.token);
    if (ledger) return ledger;
    ledger = { scope, calls: new Map() };
    this.instances.set(scope.token, ledger);
    const captured = ledger;
    scope.signal.addEventListener(
      "abort",
      () => {
        this.instances.delete(scope.token);
        for (const controller of captured.calls.values()) controller?.abort(cancelled());
        captured.calls.clear();
      },
      { once: true },
    );
    return ledger;
  }

  cancel(scope: Scope, operationId: string): { cancelled: boolean } {
    const ledger = this.ledger(scope);
    const controller = ledger.calls.get(operationId);
    if (!ledger.calls.has(operationId)) this.checkLedgerCapacity(ledger);
    // A cancel preceding the sample still records a terminal state; a later old request never executes.
    ledger.calls.set(operationId, null);
    controller?.abort(cancelled());
    return { cancelled: Boolean(controller) };
  }

  async execute<T>(
    scope: Scope,
    operationId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ledger = this.ledger(scope);
    if (ledger.calls.has(operationId))
      throw new ProtocolRequestError(-32602, "Duplicate sampling operationId");
    this.checkLedgerCapacity(ledger);
    if (
      this.active >= MCP_APPS_SAMPLING_MAX_PER_AGENT ||
      (this.sessions.get(scope.sessionId) ?? 0) >= MCP_APPS_SAMPLING_MAX_PER_SESSION ||
      [...ledger.calls.values()].some(Boolean)
    )
      throw new ProtocolRequestError(-32000, "Sampling busy");
    const controller = new AbortController();
    ledger.calls.set(operationId, controller);
    this.active++;
    this.sessions.set(scope.sessionId, (this.sessions.get(scope.sessionId) ?? 0) + 1);
    const timer = setTimeout(
      () => controller.abort(new ProtocolRequestError(-32000, "Sampling timed out")),
      MCP_APPS_SAMPLING_TIMEOUT_MS,
    );
    const signal = controller.signal;
    let off = () => {};
    try {
      // Attach the cancel listener before running, so cancel never waits on an uncooperative underlying Promise; late successes are dropped for good.
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(signal.reason ?? cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
        off = () => signal.removeEventListener("abort", onAbort);
      });
      const result = await Promise.race([run(signal), aborted]);
      signal.throwIfAborted();
      scope.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      off();
      // Late cleanup never recreates instances/ledgers already removed by close.
      if (this.instances.get(scope.token) === ledger) ledger.calls.set(operationId, null);
      this.active--;
      const count = (this.sessions.get(scope.sessionId) ?? 1) - 1;
      if (count) this.sessions.set(scope.sessionId, count);
      else this.sessions.delete(scope.sessionId);
    }
  }
  private checkLedgerCapacity(ledger: Ledger): void {
    if (ledger.calls.size >= MCP_APPS_SAMPLING_MAX_OPERATIONS)
      throw new ProtocolRequestError(-32000, "Sampling operation limit reached; reopen the App");
  }
}
