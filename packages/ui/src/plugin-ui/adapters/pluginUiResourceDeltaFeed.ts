import { dispatchPluginUiResourceDelta } from "@/plugin-ui/app/pluginUiResourceNotificationBus.js";
import { buildPluginUiSessionKey, type PluginUiSessionScope } from "@/plugin-ui/contract.js";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { useEffect } from "react";

/**
 * Bridge one session projection store's live-only deltas into the resource-notice router.
 * One store may be held by SessionPane and several panes; refcount per store, single listener, no duplicate delivery.
 */
const feeds = new Map<ConversationProjectionStore, { count: number; off: () => void }>();

export function attachPluginUiResourceDeltaFeed(
  store: ConversationProjectionStore,
  scope: PluginUiSessionScope,
): () => void {
  let entry = feeds.get(store);
  if (!entry) {
    const sessionKey = buildPluginUiSessionKey(scope);
    const off = store.onLiveDeltas((deltas) => {
      for (const delta of deltas) {
        if (
          delta.op === "pluginUi.resourceUpdated" ||
          delta.op === "pluginUi.resourceListChanged" ||
          delta.op === "pluginUi.appToolCall" ||
          delta.op === "pluginUi.instanceClosed"
        ) {
          dispatchPluginUiResourceDelta(sessionKey, delta);
        }
      }
    });
    entry = { count: 0, off };
    feeds.set(store, entry);
  }
  const active = entry;
  active.count += 1;
  return () => {
    active.count -= 1;
    if (active.count === 0 && feeds.get(store) === active) {
      active.off();
      feeds.delete(store);
    }
  };
}

export function usePluginUiResourceDeltaFeed(
  store: ConversationProjectionStore | null | undefined,
  scope: PluginUiSessionScope | null,
): void {
  const sessionKey = scope ? buildPluginUiSessionKey(scope) : null;
  useEffect(() => {
    if (!store || !scope) return;
    return attachPluginUiResourceDeltaFeed(store, scope);
    // Compare scope by session key (SessionPane may rebuild objects per render); never put the object in deps.
  }, [store, sessionKey]);
}
