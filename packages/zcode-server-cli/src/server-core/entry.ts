import { runServerCore } from "./core.js";

const generation = Number(process.argv[2] ?? 0);
void runServerCore(generation).catch((error: unknown) => {
  // Same as the shutdown path in core.ts: startup often fails after partial initialization
  // (SQLite, intervals, etc. still hold event-loop handles), so only setting exitCode leaves the
  // process hanging; the Supervisor never sees exit and crash backoff never runs, wedging state
  // in starting. Exit explicitly after the fatal message is sent (or no IPC channel exists).
  const exit = (): void => process.exit(1);
  if (typeof process.send !== "function" || process.connected === false) {
    exit();
    return;
  }
  try {
    process.send(
      { type: "fatal", message: error instanceof Error ? error.message : String(error) },
      exit,
    );
  } catch {
    // The parent may drop IPC during the same startup failure; do not wait for a fatal callback that never arrives.
    exit();
  }
});
