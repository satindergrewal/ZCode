/** Host-side in-flight send barrier; accepted-input and commandId idempotency stay with the CLI. */
export function createBotTopicAdmission() {
  const versions = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  const capture = (key: string) => versions.get(key) ?? 0;

  return {
    capture,
    async invalidate(key: string): Promise<void> {
      // Invalidate unsent preparation first, then let sent commands drain.
      // Returning early could let old connection/context waits fire after the cancel completes.
      versions.set(key, capture(key) + 1);
      await tails.get(key);
    },
    async run<T>(key: string, version: number, send: () => Promise<T>): Promise<T> {
      const previous = tails.get(key);
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, tail);
      try {
        await previous;
        if (version !== capture(key))
          throw new Error("Topic input was cancelled during preparation");
        return await send();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}
