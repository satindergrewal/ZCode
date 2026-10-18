import { isBuiltinModelProviderId, isStartPlanModelProviderId } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";

export interface AccountConnectionLoss {
  readonly providerId: string;
  readonly connectionKey: string;
  /** A new account/connection or recovered availability invalidates the old suggestion at once, in-flight query included. */
  readonly isCurrent: () => boolean;
}

/** Compares only confirmed states of the same connection; manually picking an unenabled plan never auto-falls-back. */
export function createAccountConnectionRefreshObserver(
  notify: (event: AccountConnectionLoss) => void | Promise<void>,
) {
  let disposed = false;
  let latestRevision = -1;
  let key: string | undefined;
  let previous: string | undefined;
  let generation = 0;
  return {
    async accept(view: ProviderSettingsView) {
      if (disposed || view.revision < latestRevision) return;
      latestRevision = view.revision;
      const current = view.providers.find(
        (p) =>
          p.accountState?.current === true &&
          isBuiltinModelProviderId(p.providerId) &&
          !isStartPlanModelProviderId(p.providerId),
      );
      const nextKey = current?.accountState?.connectionKey;
      const next = current?.accountState?.availability;
      if (nextKey !== key) {
        key = nextKey;
        previous = undefined;
        generation++;
      }
      // With no identity facts from the old host, guess nothing; unknown never erases a confirmed baseline.
      if (!key || !current || !next || next === "unknown") return;
      const lost = (previous === "available" || previous === "pending") && next === "unavailable";
      if (next !== previous) generation++;
      previous = next;
      if (!lost) return;
      const eventGeneration = generation;
      try {
        await notify({
          providerId: current.providerId,
          connectionKey: key,
          isCurrent: () =>
            !disposed && generation === eventGeneration && previous === "unavailable",
        });
      } catch (error) {
        // A failed notice query is not a new invalidation; repeated Views must not spawn endless notify/retry.
        logger.lifecycle.warn(
          "[AccountConnection] Failed to build the plan-invalidation notice; keeping the current selection",
          { error },
        );
      }
    },
    invalidate() {
      key = undefined;
      previous = undefined;
      generation++;
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
