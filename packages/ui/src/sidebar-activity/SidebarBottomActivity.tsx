import { MarketingBanner } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { useMarketingBannerVisible } from "@/components/marketing-touch/useMarketingBannerVisible.js";
import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

/**
 * Arbiter for the bottom-left shared slot: the only place touching both marketing
 * and global notices, so the features never import each other.
 *
 * Read-only projection, no state: the token banner owns the slot while visible;
 * the highspeed card follows. Priority banner > notice.
 * With neither visible the surface renders null, no spare DOM.
 */
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  const bannerVisible = useMarketingBannerVisible();
  if (bannerVisible) return <MarketingBanner />;
  // Uninjected, GlobalNoticeSurface falls back to browserGlobalNoticeStore.
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
