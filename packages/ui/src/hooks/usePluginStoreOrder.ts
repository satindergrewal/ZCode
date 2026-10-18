import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginStoreOrder } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/** Holds the current page projection only; request merging and TTL belong to the Host configuration service. */
export function usePluginStoreOrder(enabled = true) {
  const { clientConfigService: service } = useServices();
  const [snapshot, setSnapshot] = useState<{
    service: typeof service;
    order: PluginStoreOrder | null;
  }>();
  const generation = useRef(0);
  const refresh = useCallback(
    async (forceRefresh = false) => {
      const current = ++generation.current;
      try {
        const { pluginStoreOrder: order } = await service.getSnapshot({ forceRefresh });
        if (generation.current === current) setSnapshot({ service, order });
      } catch {
        if (generation.current === current) {
          logger.warn("[PluginStoreOrder] Failed to read the config; keeping the current order");
        }
      }
    },
    [service],
  );

  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [enabled, refresh]);

  return { order: snapshot?.service === service ? snapshot.order : null, refresh };
}
