/**
 * StoreProvider: creates the Zustand store and provides it via React Context.
 *
 * Mounted at the app root; connects broadcastService for cross-window state sync.
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { IBroadcastService } from "@zcode/services";
import { createZCodeStore, type ZCodeStore, type ZCodeState } from "./index.js";

// Exported so tests can inject a prebuilt store instance (cross-window broadcast-suppression cases).
export const StoreContext = createContext<ZCodeStore | null>(null);

export function StoreProvider({
  broadcastService,
  initialIsRestoringOAuthSession = false,
  children,
}: {
  broadcastService: IBroadcastService;
  initialIsRestoringOAuthSession?: boolean;
  children: ReactNode;
}) {
  // Create the store on first render only; avoids duplicate subscriptions under HMR.
  const storeRef = useRef<ZCodeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createZCodeStore(broadcastService, {
      initialIsRestoringOAuthSession,
    });
  }

  return <StoreContext.Provider value={storeRef.current}>{children}</StoreContext.Provider>;
}

/**
 * Hook that reads from the Zustand store.
 *
 * Usage:
 *   const theme = useZCodeStore(s => s.theme);
 *   const setTheme = useZCodeStore(s => s.setTheme);
 */
export function useZCodeStore<T>(selector: (state: ZCodeState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useZCodeStore must be used within a StoreProvider");
  }
  return useStore(store, selector);
}

/**
 * Fault-tolerant useZCodeStore with a default (part of the store-decoupling split).
 *
 * Host components (PermissionDialog / markdown dialogs) read theme/codePreviewSettings from the
 * store and inject them into presentational children. In unit tests those hosts are often
 * rendered via renderToStaticMarkup with no provider; return defaultValue instead of throwing,
 * matching "presentational components never touch the store" (real Root always mounts the provider).
 *
 * Note: selector results and defaultValue must be reference-stable, or this loops forever.
 */
export function useZCodeStoreWithDefault<T>(
  selector: (state: ZCodeState) => T,
  defaultValue: T,
): T {
  const store = useContext(StoreContext);
  const subscribe = useCallback(
    (onStoreChange: () => void) => (store ? store.subscribe(onStoreChange) : () => {}),
    [store],
  );
  const getSnapshot = () => (store ? selector(store.getState()) : defaultValue);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
