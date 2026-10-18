import { create } from "zustand";
import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import { logger } from "@/logger.js";

// ============================================================
// The renderer's single copy of the dynamic-workflow rollout snapshot.
// ============================================================
//
// The host is the sole decision maker; only the one `{ mode, enabled, source }` it emits is cached:
//   - Fetched once per app session. The Root loader is the only requester (single owner);
//     the automations page and run panel only read, never firing their own requests;
//   - No forceRefresh. The host derives the CLI tool policy from the same 1h snapshot;
//     a renderer-side force could split "UI shows the entry / model has no tools";
//     call refresh() to force a re-fetch;
//   - Failures count as disabled (fail-closed, same ruling as resolveDynamicWorkflowClientConfig),
//     but failures are not memorized: a fresh service instance retries. Phone `/remote` gets an
//     unsupported proxy that throws until bridging completes; the swapped accessor must recover.

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** Always false while loading: unknown means not offered; a late entry beats flash-then-collapse. */
  readonly enabled: boolean;
  /**
   * Null while not ready or on fetch failure; `source` is observability only: "server off" vs "local override".
   * `offeredMode` is what the server offers (settings row, "default" badge); `mode` is the effective one.
   */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** First fetch; a no-op once this service has a result, and concurrent calls share one request. */
  ensureLoaded(service: ICodingPlanSubscriptionService): Promise<void>;
  /** Re-fetch bypassing the latch and the host's 1h snapshot cache (forceRefresh). */
  refresh(service: ICodingPlanSubscriptionService): Promise<void>;
  /**
   * Bypass the latch without forceRefresh: re-read the effective value after the user changes their
   * dynamic-workflow choice or the host re-pushes policy (launch.md "The user's choice"); no refetch.
   */
  reload(service: ICodingPlanSubscriptionService): Promise<void>;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

let inFlight: Promise<void> | null = null;
/** Service instances that already produced a result (success or failure); never requested again. */
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
      "[dynamic-workflow] rollout snapshot read failed; treating as no match",
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
        // The in-flight call may be a different service (phone `/remote` swaps accessors mid-bridge): queue behind it and re-check.
        // If it is this same instance, settledService already equals it and the recursion hits the no-op above.
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

    reload(service): Promise<void> {
      return loadDynamicWorkflowConfig(service, {}, set);
    },
  }),
);

/** Test-only: clear the snapshot and the produced-result latch. */
export function resetDynamicWorkflowAvailabilityStoreForTests(): void {
  inFlight = null;
  settledService = null;
  useDynamicWorkflowAvailabilityStore.setState({ ...INITIAL_SNAPSHOT });
}
