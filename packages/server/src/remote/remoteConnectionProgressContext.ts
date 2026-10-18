import { AsyncLocalStorage } from "node:async_hooks";

export type RemoteConnectionProgressLevel = "info" | "warn" | "error";

export interface RemoteConnectionProgressEvent {
  requestId: string;
  level: RemoteConnectionProgressLevel;
  args: unknown[];
}

interface RemoteConnectionProgressStore {
  requestId: string;
  active: boolean;
}

/**
 * Binds remote-connection logs produced concurrently inside the shared Host to
 * their own requestId.
 *
 * Since remote connections merged into the window-scoped Host, the process label
 * no longer identifies a single connection and Main cannot tell from shared
 * stdout which connection a log belongs to. AsyncLocalStorage preserves the async
 * call-chain context, and reporting closes once the connection Promise settles so
 * late logs from long-lived streams stop polluting the connection panel.
 */
export function createRemoteConnectionProgressContext(options: {
  emit: (event: RemoteConnectionProgressEvent) => void;
}) {
  const storage = new AsyncLocalStorage<RemoteConnectionProgressStore>();

  return {
    async run<T>(requestId: string, task: () => Promise<T>): Promise<T> {
      const store: RemoteConnectionProgressStore = { requestId, active: true };
      return storage.run(store, async () => {
        try {
          return await task();
        } finally {
          store.active = false;
        }
      });
    },

    report(level: RemoteConnectionProgressLevel, args: unknown[]): void {
      const store = storage.getStore();
      if (!store?.active) {
        return;
      }
      options.emit({ requestId: store.requestId, level, args });
    },
  };
}
