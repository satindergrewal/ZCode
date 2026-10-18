/**
 * The protocol process has exactly one diagnostics outlet. Listen for the async error of the real stream, not just catch writes:
 * otherwise EPIPE -> uncaughtException -> writing stderr again becomes a high-CPU feedback loop.
 */
export function installProtocolStderrBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalWrite = stderr.write;
  let unavailable = false;
  const onError = () => {
    unavailable = true;
  };
  stderr.on("error", onError);
  stderr.on("close", onError);
  stderr.write = ((chunk, encodingOrCallback, callback): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (!unavailable) {
      try {
        return originalWrite.call(stderr, chunk, encoding, (error) => {
          if (error) unavailable = true;
          writeCallback?.();
        });
      } catch {
        unavailable = true;
      }
    }
    // Diagnostics are best effort; once the outlet is dead, finish the caller's flush without writing to a broken stream or reporting our own failure.
    if (writeCallback) queueMicrotask(() => writeCallback());
    return true;
  }) as typeof stderr.write;
  return () => {
    stderr.write = originalWrite;
    stderr.off("error", onError);
    stderr.off("close", onError);
  };
}
