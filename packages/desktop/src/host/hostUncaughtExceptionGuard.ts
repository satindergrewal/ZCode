interface HostUncaughtExceptionGuardOptions {
  onRecovered: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
  onFatal: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
}

function isRecoverableHostAllocationError(error: unknown): error is RangeError {
  return error instanceof RangeError && error.message === "Failed to allocate memory";
}

export function createHostUncaughtExceptionHandler({
  onRecovered,
  onFatal,
}: HostUncaughtExceptionGuardOptions): (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void {
  return (error, origin) => {
    if (!isRecoverableHostAllocationError(error)) {
      onFatal(error, origin);
      return;
    }

    try {
      // While projecting a peer certificate into a JS object during the TLS handshake, Electron's bundled Node
      // can let a native Buffer allocation failure escape the socket callback; utilityProcess aborts by default.
      // The same allocation error inside a normal promise chain is reclaimed by request timeout/retry, so isolate only this exact error;
      // a failed log upload must not escalate into a process-level uncaught exception again.
      onRecovered(error, origin);
    } catch {
      // Under memory pressure the diagnostic logger itself may fail to allocate; this guard must stay throw-free.
    }
  };
}
