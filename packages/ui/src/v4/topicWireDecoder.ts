import {
  TopicWireFrameAssembler,
  type TopicWireAssemblyEvent,
  type TopicWireAssemblyFault,
  type TopicFrameDeliveryKind,
  type TopicWireFrameCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

interface TopicWireDecoder {
  accept(wire: TopicWireFrameCandidate): void;
  /** Same-sub recovery: clear the fail-closed flag only, keep the assembler ordinal tombstone. */
  recover(topic: string, subscriptionId: string): void;
  discard(topic: string, subscriptionId: string): void;
  clear(): void;
}

/**
 * Renderer-side physical-to-logical atomic boundary. The assembler emits a logical frame only when slices complete and validate;
 * the 30s timeout runs on one latest-deadline timer, never one timer per slice.
 */
export function createTopicWireDecoder<F extends { topic: string; subscriptionId: string }>(
  assembler: TopicWireFrameAssembler<F>,
  deliver: (frame: F, deliveryKind: TopicFrameDeliveryKind) => void,
  onFault?: (fault: TopicWireAssemblyFault) => void,
): TopicWireDecoder {
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const faultedRoutes = new Set<string>();
  const routeKey = (topic: string, subscriptionId: string) => `${topic}\0${subscriptionId}`;

  const handleEvents = (events: TopicWireAssemblyEvent<F>[]): void => {
    const faults = events.filter((event) => event.kind === "fault");
    const failedInBatch = new Set<string>();
    const healingRoutes = new Set<string>();
    for (const event of events) {
      if (event.kind === "complete" && event.deliveryKind === "recovery") {
        healingRoutes.add(routeKey(event.frame.topic, event.frame.subscriptionId));
      }
    }
    for (const { fault } of faults) {
      const key = routeKey(fault.topic, fault.subscriptionId);
      // assembler.accept expires the old assembly before handling the current wire. If that wire is
      // a fully validated higher-ordinal recovery, the older online timeout in the same batch is authoritatively superseded:
      // never report the fault and then drop the recovery.
      if (healingRoutes.has(key)) continue;
      failedInBatch.add(key);
      faultedRoutes.add(key);
      assembler.abort(fault.topic, fault.subscriptionId);
      logger.warn("[v4-topic-wire] physical assembly rejected", fault);
      onFault?.(fault);
    }
    for (const event of events) {
      if (event.kind !== "complete") continue;
      const key = routeKey(event.frame.topic, event.frame.subscriptionId);
      if (event.deliveryKind === "recovery") faultedRoutes.delete(key);
      // One accept may be [superseded fault(A), complete(A)]; the same route must
      // fail closed; but accept(B) also expires other routes A - never drop a healthy B because of that.
      if (failedInBatch.has(key) || faultedRoutes.has(key)) continue;
      deliver(event.frame, event.deliveryKind);
    }
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    const nextExpiryAt = assembler.nextExpiryAt;
    if (nextExpiryAt === null) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        handleEvents(assembler.expire(Date.now()));
        scheduleExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
  };

  return {
    accept(wire) {
      const key = routeKey(wire.topic, wire.subscriptionId);
      if (faultedRoutes.has(key)) {
        // While a resync is in flight, a late stale online fragment can still fault and close the route;
        // the real recovery would then be swallowed by the old gate forever. deliveryKind is publisher
        // authoritative envelope fact, so only an exact recovery opens the gate atomically - never guess from RPC timing.
        if (wire.deliveryKind !== "recovery") return;
        faultedRoutes.delete(key);
        assembler.abort(wire.topic, wire.subscriptionId);
      }
      handleEvents(assembler.accept(wire));
      scheduleExpiry();
    },
    recover(topic, subscriptionId) {
      // faultedRoutes cannot be cleared by unsubscribe/discard alone: the higher-ordinal same-sub
      // recovery would be swallowed forever. Only the fail-closed gate opens here; the assembler
      // settled ordinal stays, and late stale fragments still drop silently.
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.abort(topic, subscriptionId);
      scheduleExpiry();
    },
    discard(topic, subscriptionId) {
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.discard(topic, subscriptionId);
      scheduleExpiry();
    },
    clear() {
      faultedRoutes.clear();
      assembler.clear();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
    },
  };
}
