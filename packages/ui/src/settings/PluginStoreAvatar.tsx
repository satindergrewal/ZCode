import type { ReactNode } from "react";
import { PluginIcon } from "@/components/PluginIcon.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/**
 * Store entry avatar: listing.icon (https only) first; on failure or absence, degrade to a neutral Blocks icon in a
 * rounded bg-surface square, avoiding decorative color noise for icon-less plugins
 * and matching the real icon's outer shape so a failed load never flips circle/square.
 * The design's icon asset is the glyph only; the semantic wrapper owns the themed surface. A blanket dark:invert
 * would negate brand colors (Android green), so assets keep their original colors.
 */
export function PluginStoreAvatar({
  item,
  className,
  iconClassName,
  fallbackIcon,
}: {
  item: Pick<StorePluginItem, "name" | "listing"> & Partial<Pick<StorePluginItem, "id">>;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  return (
    <PluginIcon
      src={item.listing?.icon}
      pluginId={item.id}
      className={className}
      iconClassName={iconClassName}
      fallbackIcon={fallbackIcon}
    />
  );
}
