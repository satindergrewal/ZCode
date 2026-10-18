import { useEffect, useState, useSyncExternalStore } from "react";
import {
  browserGlobalNoticeStore,
  type GlobalNoticeStore,
} from "@/global-notice/globalNoticeStore.js";
import { HighspeedShareNoticeCard } from "@/highspeed/HighspeedShareNoticeCard.js";

const subscribeNoop = () => () => undefined;
const getNullSnapshot = () => null;

export function GlobalNoticeSurface({
  store = browserGlobalNoticeStore,
}: {
  store?: GlobalNoticeStore | null;
} = {}) {
  const [, refreshAtExpiry] = useState(0);
  const notice = useSyncExternalStore(
    store?.subscribe ?? subscribeNoop,
    store ? () => store.getVisible() : getNullSnapshot,
    getNullSnapshot,
  );

  useEffect(() => {
    if (notice?.expiresAt === undefined) return;
    const delayMs = Math.max(0, notice.expiresAt - Date.now()) + 20;
    // Bug: expiresAt was computed on store events only, so stale cards lingered on long-lived pages.
    const timer = window.setTimeout(() => refreshAtExpiry((revision) => revision + 1), delayMs);
    return () => window.clearTimeout(timer);
  }, [notice?.expiresAt, notice?.noticeId]);

  if (!notice) return null;

  if (notice.type === "highspeed-share" && notice.schemaVersion === 1) {
    return (
      <HighspeedShareNoticeCard notice={notice} onDismiss={() => store?.dismiss(notice.noticeId)} />
    );
  }

  // Unregistered kinds are ignored safely; unknown payloads never break the sidebar.
  return null;
}
