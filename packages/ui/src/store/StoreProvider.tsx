/**
 * StoreProvider - initializes the Zustand store and provides it via React Context.
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

// Export the Context so tests can inject a prebuilt store (e.g. cross-window broadcast suppression cases).
const StoreContext = createContext<ZCodeStore | null>(null);

export function StoreProvider({
  broadcastService,
  initialIsRestoringOAuthSession = false,
  children,
}: {
  broadcastService: IBroadcastService;
  initialIsRestoringOAuthSession?: boolean;
  children: ReactNode;
}) {
  // Create the store on first render only, avoiding duplicate HMR subscriptions.
  const storeRef = useRef<ZCodeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createZCodeStore(broadcastService, {
      initialIsRestoringOAuthSession,
    });
  }

  return <StoreContext.Provider value={storeRef.current}>{children}</StoreContext.Provider>;
}

/**
 * Hook consuming the Zustand store.
 *
 * Usage:
 *   const theme = useZCodeStore(s => s.theme);
 *   const setTheme = useZCodeStore(s => s.setTheme);
 */
export function useZCodeStore<T>(selector: (state: ZCodeState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useZCodeStore must be used within StoreProvider");
  }
  return useStore(store, selector);
}

/**
 * Fault-tolerant useZCodeStore with defaults (part of the store-decoupling effort).
 *
 * Host components (PermissionDialog, markdown dialogs) read theme/codePreviewSettings from the
 * store and inject them into pure display components via props. Those hosts are often rendered with
 * renderToStaticMarkup without a provider in unit tests; return defaultValue instead of throwing,
 * matching display-components-touch-no-store; the real app Root always mounts StoreProvider with real values.
 *
 * Note: selector results and defaultValue must be referentially stable, or this loops re-renders.
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
