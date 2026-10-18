import { cn } from "@/components/lib/utils.js";
import zaiLogoUrl from "@/assets/provider-icons/logo-zai.svg";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn(
        // The Workspace tool group starts after the 1px panel border while the legacy Settings
        // header starts at the window origin. Workspace's logo sits in a 28px button with 4px
        // centering padding; Settings renders a bare 20px image, so the button container's
        // left 13px is not the image origin. With outer padding, border and inner padding
        // both images land at left 17px / top 19px.
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      <img
        src={zaiLogoUrl}
        alt="ZCode"
        className={cn("pointer-events-none size-5 select-none", imageClassName)}
        draggable={false}
      />
    </div>
  );
}
