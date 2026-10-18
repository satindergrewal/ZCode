import type { Readable } from "node:stream";

const TERMINATION_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
const DEFAULT_RPC_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS = 3_500;

type StdioShutdownPhase = "rpc-stop" | "service-dispose";

interface StdioProcessSignalSource {
  on(signal: (typeof TERMINATION_SIGNALS)[number], listener: () => void): unknown;
}

interface StdioProcessLifecycleOptions {
  stdin: Readable;
  signalSource: StdioProcessSignalSource;
  log: (...args: unknown[]) => void;
  stopRpc: () => Promise<void>;
  dispose: () => Promise<void>;
  exit: (code: number) => never | void;
  shutdownTimeoutMs?: number;
  rpcStopTimeoutMs?: number;
  serviceDisposeTimeoutMs?: number;
}

export function registerStdioProcessLifecycle(options: StdioProcessLifecycleOptions): void {
  const { stdin, signalSource, log, stopRpc, dispose, exit } = options;
  const rpcStopTimeoutMs = Math.max(
    options.rpcStopTimeoutMs ?? options.shutdownTimeoutMs ?? DEFAULT_RPC_STOP_TIMEOUT_MS,
    0,
  );
  const serviceDisposeTimeoutMs = Math.max(
    options.serviceDisposeTimeoutMs ??
      options.shutdownTimeoutMs ??
      DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS,
    0,
  );
  let shutdownStarted = false;
  let requestedExitCode = 0;

  const requestShutdown = (exitCode: number): void => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    void (async () => {
      const runPhase = async (
        phase: StdioShutdownPhase,
        operation: () => Promise<void>,
        failureMessage: string,
        timeoutMs: number,
      ): Promise<boolean> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const operationResult = operation().then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const timedOut = new Promise<{ kind: "timed-out" }>((resolve) => {
          // The timer must not be unref'd, or it could not guarantee the
          // settle on its own if the outer promise stays pending forever.
          timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
        });
        const result = await Promise.race([operationResult, timedOut]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result.kind === "timed-out") {
          log("stdio shutdown timed out", { phase, timeoutMs });
          return false;
        }
        if (result.kind === "failed") {
          log(failureMessage, result.error);
          return false;
        }
        return true;
      };

      // A single race is not enough for the whole cleanup: if stopRpc times out
      // we would exit immediately and service dispose would never get to stop
      // the Agent child process. Both external async boundaries must be bounded
      // and advance independently.
      if (
        !(await runPhase("rpc-stop", stopRpc, "stdio shutdown RPC stop failed", rpcStopTimeoutMs))
      ) {
        requestedExitCode = 1;
      }
      if (
        !(await runPhase(
          "service-dispose",
          dispose,
          "stdio shutdown cleanup failed",
          serviceDisposeTimeoutMs,
        ))
      ) {
        requestedExitCode = 1;
      }
      log("stdio shutdown completed", { exitCode: requestedExitCode });
      exit(requestedExitCode);
    })();
  };

  // An idle remote project can go long stretches without client->server RPC
  // input while the window stays open. Do not exit on idle anymore; end the
  // remote server only when stdio closes or errors, so the remote connection
  // lifetime follows the user closing the project/app or the underlying SSH
  // dropping.
  stdin.on("end", () => {
    log("stdin closed, shutting down");
    requestShutdown(0);
  });
  stdin.on("error", (error) => {
    log("stdin error, shutting down", error);
    requestShutdown(1);
  });
  for (const signal of TERMINATION_SIGNALS) {
    signalSource.on(signal, () => {
      // Depending on sshd/shell, an SSH drop surfaces either as stdin EOF or as
      // a signal to the foreground process first. Both entries must enter the
      // same idempotent cleanup path, or a detached Agent outlives the parent
      // and becomes an orphan.
      log("termination signal received, shutting down", signal);
      requestShutdown(1);
    });
  }
}
