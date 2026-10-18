import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  getProviderSettingsSnapshot,
  reloadProviderSettingsSnapshot,
  subscribeProviderSettingsSnapshot,
  type ProviderSettingsState,
} from "@/lib/providerSettingsSnapshot.js";

export interface ProviderSettingsRead {
  state: ProviderSettingsState;
  reload(): void;
}

export interface ProviderSettingsServiceRead extends ProviderSettingsRead {
  /** The mutation's authoritative View; never wait on async onDidChange to settle UI. */
  commit(view: ProviderSettingsView): void;
}

export function useProviderSettingsView(): ProviderSettingsRead {
  const state = useSyncExternalStore(
    subscribeProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
  );
  return {
    state,
    reload: useCallback(() => {
      void reloadProviderSettingsSnapshot().catch((error) => {
        logger.warn("[ProviderSettings] retry root Environment load failed", { error });
      });
    }, []),
  };
}

interface OwnedProviderSettingsState {
  service: IProviderSettingsService;
  state: ProviderSettingsState;
}

/** Reads the target Environment for the active ServiceProvider, with failure + retry. */
export function useProviderSettingsServiceView(
  service: IProviderSettingsService,
): ProviderSettingsServiceRead {
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedProviderSettingsState>({
    service,
    state: { status: "loading" },
  });
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const generationRef = useRef(0);
  const latestRevisionRef = useRef(-1);
  const visibleState = owned.service === service ? owned.state : ({ status: "loading" } as const);

  const commitView = useCallback(
    (view: ProviderSettingsView): boolean => {
      // Across attachment generations a stale mutation can return late;
      // only the current Service's latest revision commits.
      if (serviceRef.current !== service || ownedRef.current.service !== service) {
        return false;
      }
      const current = ownedRef.current.state;
      const currentRevision = current.status === "ready" ? current.view.revision : -1;
      const latestRevision = Math.max(currentRevision, latestRevisionRef.current);
      if (view.revision < latestRevision) {
        return false;
      }
      // Same-revision event/response are one Registry fact; dedupe renders.
      if (view.revision === latestRevision && current.status === "ready") {
        return false;
      }
      latestRevisionRef.current = view.revision;
      setOwned({ service, state: { status: "ready", view } });
      return true;
    },
    [service],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const retainedReady =
      previous.service === service && previous.state.status === "ready" ? previous.state : null;
    setOwned({ service, state: retainedReady ?? { status: "loading" } });
    latestRevisionRef.current = retainedReady?.view.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    const commit = (view: ProviderSettingsView): void => {
      if (generation !== generationRef.current) return;
      if (commitView(view)) {
        hasReadyView = true;
      }
    };
    const subscription = service.onDidChange(commit);
    void service.getView().then(commit, (cause) => {
      if (generation !== generationRef.current) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.warn("[ProviderSettings] failed to load target Environment", { error });
      if (!hasReadyView) setOwned({ service, state: { status: "error", error } });
    });
    return () => {
      generationRef.current += 1;
      subscription.dispose();
    };
  }, [commitView, reloadVersion, service]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    commit: useCallback(
      (view: ProviderSettingsView) => {
        commitView(view);
      },
      [commitView],
    ),
  };
}
