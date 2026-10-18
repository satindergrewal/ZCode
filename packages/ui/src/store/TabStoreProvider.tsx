/**
 * TabStoreProvider -- creates the Tab Zustand store and provides it via React Context.
 *
 * Mounted independently per window; tab state is not broadcast across windows.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { createTabStore, type TabStore, type TabStoreState } from "./tabStore.js";

declare global {
  interface Window {
    __zcodeTabStoreE2E?: TabStore;
  }
}

const TabStoreContext = createContext<TabStore | null>(null);
const fallbackTabStore = createTabStore(null);

export function TabStoreProvider({ children }: { children: ReactNode }) {
  // Create the store on first render only; avoids duplicate stores across HMR.
  const storeRef = useRef<TabStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTabStore();
  }

  useEffect(() => {
    if (!shouldExposeE2EStoreBridge() || !storeRef.current) {
      return;
    }

    const store = storeRef.current;
    // V4 drafts have no taskId; if E2E looks a workspace up by activeTaskId=null across
    // multiple workspaces it can hit any draft bucket. Expose this window's navigation store
    // in E2E builds only, so helpers can read the exact draft by
    // workspaceIdentity?.trim() || workspacePath.
    window.__zcodeTabStoreE2E = store;
    return () => {
      if (window.__zcodeTabStoreE2E === store) {
        delete window.__zcodeTabStoreE2E;
      }
    };
  }, []);

  return <TabStoreContext.Provider value={storeRef.current}>{children}</TabStoreContext.Provider>;
}

/**
 * Hook to consume the Tab store.
 *
 * Usage:
 *   const tabs = useTabStore(s => s.tabs);
 *   const addTab = useTabStore(s => s.addTab);
 */
export function useTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStore must be used within TabStoreProvider");
  }
  return useStore(store, selector);
}

/** For standalone presentational components; falls back to empty tab state without a Root provider. */
export function useOptionalTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  return useStore(store ?? fallbackTabStore, selector);
}

/**
 * Raw store handle (for non-React contexts, e.g. subscribing inside useEffect)
 */
export function useTabStoreApi(): TabStore {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStoreApi must be used within TabStoreProvider");
  }
  return store;
}
