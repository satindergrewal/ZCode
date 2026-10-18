import { create } from "zustand";
import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import { logger } from "@/logger.js";

// ============================================================
// The renderer-side single copy of the dynamic-workflow rollout snapshot.
// ============================================================
//
// The host is the sole decision maker; this only caches the one { mode, enabled, source } it hands out:
//   - fetched once per app session. The Root loader is the only requester;
//     the automation page and the run pane only read and never request again;
//   - no forceRefresh: the host derives the tool policy sent to the CLI from that same 1h snapshot,
//     and a renderer-side force could split UI-has-entry from model-has-tool;
//     use refresh() to force a refetch;
//   - a failed request counts as disabled (fail-closed, same ruling as resolveDynamicWorkflowClientConfig),
//     but failures are not remembered: a fresh service instance retries. Before workspace bridging, phone /remote gets
//     an unsupported proxy that always throws; the accessor is swapped once bridged, and that round must be able to recover.

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** Always false while loading: unknown means not offered; the entry may appear late but never flashes. */
  readonly enabled: boolean;
  /** null while not ready or on fetch failure; source is observability only, separating server-off from a local override. */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** First fetch; a no-op once this service has a result, with concurrent calls sharing one request. */
  ensureLoaded(service: ICodingPlanSubscriptionService): Promise<void>;
  /** Refetch bypassing the latch and the host 1h snapshot cache (forceRefresh). */
  refresh(service: ICodingPlanSubscriptionService): Promise<void>;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

let inFlight: Promise<void> | null = null;
/** A service instance that already produced a result (success or failure); the same instance never requests again. */
let settledService: ICodingPlanSubscriptionService | null = null;

type PublishSnapshot = (snapshot: DynamicWorkflowAvailabilitySnapshot) => void;

async function loadDynamicWorkflowConfig(
  service: ICodingPlanSubscriptionService,
  options: { forceRefresh?: boolean },
  publish: PublishSnapshot,
): Promise<void> {
  try {
    const config = await service.getDynamicWorkflowClientConfig(options);
    publish({ status: "ready", enabled: config.enabled === true, config });
  } catch (error) {
    logger.warn(
      "[dynamic-workflow] Failed to read the rollout snapshot; treating as no-hit",
      error instanceof Error ? error.message : String(error),
    );
    publish({ status: "ready", enabled: false, config: null });
  } finally {
    settledService = service;
  }
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set, get) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(service): Promise<void> {
      if (settledService === service) return Promise.resolve();
      if (inFlight) {
        // The in-flight request may belong to another service (the accessor swaps during phone /remote bridging): queue behind it and decide again.
        // If it is this same service, settledService already equals it and the recursion hits the no-op above at once.
        return inFlight.then(() => get().ensureLoaded(service));
      }
      const run = loadDynamicWorkflowConfig(service, {}, set).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },

    refresh(service): Promise<void> {
      return loadDynamicWorkflowConfig(service, { forceRefresh: true }, set);
    },
  }),
);
