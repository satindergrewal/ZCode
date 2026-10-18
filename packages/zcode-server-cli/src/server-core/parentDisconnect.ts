interface ParentDisconnectSource {
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

/**
 * Registers the Core cleanup hook for Supervisor IPC disconnects.
 *
 * If the Supervisor is killed hard it will never send the shutdown command, so
 * Core must tear down its own HTTP/WebSocket and Agent resources; otherwise it
 * bypasses the data-root lock and lingers as an orphan process.
 */
export function installParentDisconnectHandler(
  onDisconnect: () => void | Promise<void>,
  source: ParentDisconnectSource = process,
): () => void {
  const handler = (): void => {
    void onDisconnect();
  };
  source.once("disconnect", handler);
  return () => source.off("disconnect", handler);
}
