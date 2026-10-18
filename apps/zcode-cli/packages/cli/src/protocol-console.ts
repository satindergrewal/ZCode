import { Console } from "node:console";

/**
 * Installs the console output boundary for CLIs that own stdout (stdio protocol / TUI).
 *
 * The stdout of app-server/agent-server must carry only ZCode Protocol NDJSON frames, yet third-party
 * SDKs may write plain text via console.*. Without separating output before those dependencies load,
 * any log line would be parsed as JSON by the Host or overwrite the TUI's frame at the current cursor.
 */
export function installStderrConsoleBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalConsole = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    globalThis.console = originalConsole;
  };
}
