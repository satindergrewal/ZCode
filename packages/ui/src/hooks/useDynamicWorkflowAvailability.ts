import { useEffect, useMemo } from "react";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
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
