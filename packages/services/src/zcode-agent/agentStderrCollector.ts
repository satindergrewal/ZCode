import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export const EXIT_STDERR_DRAIN_MS = 250;

/** stderr outlives the protocol: on child exit the pipe may still hold a final diagnostic line. */
export class AgentStderrCollector {
  private readonly reader;
  private readonly drained: Promise<void>;
  private resolveDrained!: () => void;
  private done = false;
  private deadlineAt = Infinity;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(input: Readable, onLine?: (line: string) => void) {
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve;
    });
    this.reader = createInterface({ input });
    this.reader.on("line", (line) => onLine?.(line));
    this.reader.once("close", this.finish);
    this.reader.on("error", this.finish);
    // Diagnostics only; never tear down a healthy stdin/stdout protocol because of it.
    input.on("error", this.finish);
    input.once("close", this.finish);
    if (input.destroyed || input.readableEnded) this.finish();
  }

  waitForDrain(timeoutMs = EXIT_STDERR_DRAIN_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (!this.done && deadline < this.deadlineAt) {
      this.deadlineAt = deadline;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(this.finish, Math.max(0, timeoutMs));
    }
    return this.drained;
  }

  private readonly finish = (): void => {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.reader.close();
    this.resolveDrained();
  };
}
