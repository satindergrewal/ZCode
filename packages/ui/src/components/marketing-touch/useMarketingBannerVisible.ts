import { useContext, useSyncExternalStore } from "react";
import { isMarketingBannerRenderable } from "@/components/marketing-touch/marketingTouchController.js";
import { MarketingTouchContext } from "@/components/marketing-touch/MarketingTouchProvider.js";

// Without a controller: noop subscription, snapshot constant false — the same null-safe shape as GlobalNoticeSurface.
const subscribeNoop = () => () => {};

/**
 * The arbiter (SidebarBottomActivity) subscribes through this read-only hook to the bottom-left claim
 * banner's visibility; the source of truth stays controller.store — the hook holds no state.
 */
export function useMarketingBannerVisible(): boolean {
  const controller = useContext(MarketingTouchContext);
  return useSyncExternalStore(
    controller ? controller.store.subscribe : subscribeNoop,
    () => (controller ? isMarketingBannerRenderable(controller.store.getState().banner) : false),
    () => false,
  );
}
