const SAMPLE_MS = 1000;
const MAX_PAUSE_MS = 5000;
const MAX_CLOCK_DRIFT_MS = 100;

/** Diagnostic sampling never participates in admission; created only for enabled input, and the timer never keeps the CLI alive. */
export class LocalTtftClockWatch {
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(now: () => number, sample: (unreliable: boolean) => void) {
    let previous = now();
    let wall = Date.now();
    this.timer = setInterval(() => {
      const current = now();
      const currentWall = Date.now();
      const elapsed = current - previous;
      const unreliable =
        elapsed > MAX_PAUSE_MS ||
        elapsed < 0 ||
        Math.abs(currentWall - wall - elapsed) > MAX_CLOCK_DRIFT_MS;
      previous = current;
      wall = currentWall;
      sample(unreliable);
    }, SAMPLE_MS);
    this.timer.unref();
  }
  dispose(): void {
    clearInterval(this.timer);
  }
}
