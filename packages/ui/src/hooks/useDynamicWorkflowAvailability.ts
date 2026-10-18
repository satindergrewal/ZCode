import { useEffect, useMemo, useRef } from "react";
import type { ICodingPlanSubscriptionService, IZCodeAgentService } from "@zcode/services";
import type { DynamicWorkflowMode } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  useDynamicWorkflowAvailabilityStore,
  type DynamicWorkflowAvailabilitySnapshot,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

/**
 * Reads the dynamic-workflow rollout snapshot.
 * Read-only, never fetches: the Root-level loader is the sole fetcher. Consumers (automation page, run pane) may sit inside
 * a workspace-level ServiceProvider (remote-host accessor); fetching per consumer would clobber the app-level snapshot.
 */
export function useDynamicWorkflowAvailability(): DynamicWorkflowAvailabilitySnapshot {
  // Per-field subscriptions: an object-literal selector returns a new reference every time and useSyncExternalStore would flag a change.
  const status = useDynamicWorkflowAvailabilityStore((state) => state.status);
  const enabled = useDynamicWorkflowAvailabilityStore((state) => state.enabled);
  const config = useDynamicWorkflowAvailabilityStore((state) => state.config);
  return useMemo(() => ({ status, enabled, config }), [config, enabled, status]);
}

/**
 * App-session fetch, mounted once in Root. Retries when the service is swapped (phone /remote completes workspace bridging).
 * Fetch and failure-retry rules: see dynamicWorkflowAvailabilityStore.
 */
export function useDynamicWorkflowAvailabilityLoader(
  service: ICodingPlanSubscriptionService,
): void {
  const ensureLoaded = useDynamicWorkflowAvailabilityStore((state) => state.ensureLoaded);
  useEffect(() => {
    void ensureLoaded(service);
  }, [ensureLoaded, service]);
}

/**
 * Sync after user-choice changes (docs/dynamic-workflow/launch.md), once in Root.
 * The settings file is the only source: any window's write broadcasts, every Root re-reads,
 * notifies its Host (policy re-push/remote forward), then re-reads the snapshot.
 * - The first read is a baseline: Host reads settings at startup anyway.
 * - Serial rounds: signal->reread completes before the next; slow reads never mask.
 * - Host sync failure still rereads: the snapshot is whatever Host computes now.
 */
export function useDynamicWorkflowUserModeSync(params: {
  settingsLoaded: boolean;
  userMode: DynamicWorkflowMode | undefined;
  zcodeAgentService: Pick<IZCodeAgentService, "syncDynamicWorkflowUserMode">;
  codingPlanSubscriptionService: ICodingPlanSubscriptionService;
}): void {
  const { settingsLoaded, userMode, zcodeAgentService, codingPlanSubscriptionService } = params;
  const reload = useDynamicWorkflowAvailabilityStore((state) => state.reload);
  const observedRef = useRef<{ userMode: DynamicWorkflowMode | undefined } | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!settingsLoaded) return;
    const observed = observedRef.current;
    observedRef.current = { userMode };
    if (observed === null || observed.userMode === userMode) return;
    chainRef.current = chainRef.current.then(async () => {
      try {
        await zcodeAgentService.syncDynamicWorkflowUserMode(userMode ? { mode: userMode } : {});
      } catch (error) {
        logger.warn("[dynamic-workflow] failed to sync user choice to host", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await reload(codingPlanSubscriptionService);
    });
  }, [codingPlanSubscriptionService, reload, settingsLoaded, userMode, zcodeAgentService]);
}
