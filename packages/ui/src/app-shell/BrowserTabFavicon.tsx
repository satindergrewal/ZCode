import { useState } from "react";
import { GlobeIcon } from "lucide-react";

function BrowserTabFaviconImage({ faviconUrl }: { faviconUrl: string }) {
  const [hasFailed, setHasFailed] = useState(false);

  if (hasFailed) return <GlobeIcon className="size-3.5" />;

  return (
    <img
      src={faviconUrl}
      alt=""
      className="size-3.5 rounded-sm object-contain"
      draggable={false}
      // Fetching a guest favicon from the renderer sends a localhost Referer, which
      // hotlink-protected CDNs answer with 403; no-referrer matches the in-page guest's
      // successful request.
      referrerPolicy="no-referrer"
      onError={() => setHasFailed(true)}
    />
  );
}

/** Favicon shared by Browser and Browser Use; stable globe placeholder when the request fails. */
export function BrowserTabFavicon({ faviconUrl }: { faviconUrl?: string | null }) {
  if (!faviconUrl) return <GlobeIcon className="size-3.5" />;

  return <BrowserTabFaviconImage key={faviconUrl} faviconUrl={faviconUrl} />;
}
