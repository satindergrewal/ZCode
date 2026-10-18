import type { ImgHTMLAttributes } from "react";
import glmDarkIcon from "@/assets/cli-icons/icon-glm-for-dark.png";
import glmLightIcon from "@/assets/cli-icons/icon-glm-for-light.png";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";

type GlmMonochromeIconProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src">;

export function GlmMonochromeIcon({
  className,
  alt = "",
  style,
  ...props
}: GlmMonochromeIconProps) {
  const theme = useZCodeStore((state) => state.theme);
  const isDark = resolveTheme(theme) === "dark";
  const src = isDark ? glmDarkIcon : glmLightIcon;

  // A line-art variant hurts the logo's recognizability and reads too light. Keep the
  // original bitmap; only desaturate and compress luminance — grayish on light themes,
  // lifted toward white on dark — muting the built-in blue, keeping the silhouette.
  const filter = isDark
    ? "grayscale(1) brightness(1.9) contrast(0.8)"
    : "grayscale(1) brightness(0.74) contrast(1.05)";

  return (
    <img
      src={src}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={cn("shrink-0 object-contain", className)}
      style={{ filter, ...style }}
      {...props}
    />
  );
}
