export interface ConfigCommandBarrier {
  enqueue<T>(command: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

export const CONFIG_COMMAND_SUPERSEDED = Symbol("config-command-superseded");

export interface LatestConfigCommandScheduler<T> {
  /**
   * Coalesce not-yet-started config commands of the same kind; displaced calls settle as superseded.
   */
  schedule(command: () => Promise<T>): Promise<T | typeof CONFIG_COMMAND_SUPERSEDED>;
  /**
   * Seal the current wait slot. Call before enqueueing the send so sealed config orders before it,
   * while later config opens a new slot after the send.
   */
  seal(): void;
}

/**
 * The ordering barrier between config commands and send commands.
 *
 * Mode/model selection updates the UI optimistically, then commits CAS async; when the user sends right away,
 * sendText may finish before the CAS retry, showing new config while the runtime still runs the old.
 */
export function createConfigCommandBarrier(): ConfigCommandBarrier {
  let pending: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(command: () => Promise<T>): Promise<T> {
      const result = pending.then(command, command);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    wait(): Promise<void> {
      return pending;
    },
  };
}

/**
 * Coalesce not-yet-started same-kind config commands onto one ordering barrier.
 *
 * Cause: rapid model/reasoning clicks queued every intermediate value into the stdio CAS pipeline; even with the UI
 * already on the final choice the runtime chewed through stale intents. Replace only unstarted slots, never cancel
 * dispatched ones; after the pre-send seal, the config->send user ordering still holds exactly.
 */
export function createLatestConfigCommandScheduler<T>(
  barrier: ConfigCommandBarrier,
): LatestConfigCommandScheduler<T> {
  interface Waiter {
    reject: (reason?: unknown) => void;
    resolve: (value: T | typeof CONFIG_COMMAND_SUPERSEDED) => void;
  }
  interface Slot {
    command: () => Promise<T>;
    waiter: Waiter;
  }

  let replaceableSlot: Slot | null = null;

  return {
    schedule(command) {
      return new Promise<T | typeof CONFIG_COMMAND_SUPERSEDED>((resolve, reject) => {
        if (replaceableSlot) {
          replaceableSlot.waiter.resolve(CONFIG_COMMAND_SUPERSEDED);
          replaceableSlot.command = command;
          replaceableSlot.waiter = { reject, resolve };
          return;
        }

        const slot: Slot = {
          command,
          waiter: { reject, resolve },
        };
        replaceableSlot = slot;
        void barrier.enqueue(async () => {
          if (replaceableSlot === slot) {
            replaceableSlot = null;
          }
          const scheduledCommand = slot.command;
          const scheduledWaiter = slot.waiter;
          try {
            scheduledWaiter.resolve(await scheduledCommand());
          } catch (error) {
            scheduledWaiter.reject(error);
          }
        });
      });
    },
    seal() {
      replaceableSlot = null;
    },
  };
}
