import { memo, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

export const DesktopWindowFrame = memo(function DesktopWindowFrameComponent({
  title: _title,
  children,
  actions: _actions,
  tabBar: _tabBar,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  headerTestId: _headerTestId,
  showHeader: _showHeader = isDesktop,
}: {
  title: string;
  children: ReactNode;
  topBar?: ReactNode;
  actions?: ReactNode;
  /** Tab-bar slot, rendered after the title inside the header. */
  tabBar?: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  headerTestId?: string;
  showHeader?: boolean;
}) {
  const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
  const usesOpaqueRootSurface = !isDesktop || isWindowsDesktop || isLinuxDesktop;

  return (
    <div
      className={cn(
        // Mobile 100vh counts the URL bar as page height, pushing the remote-control composer
        // below the fold. Dynamic viewport height tracks browser chrome; desktop visuals are
        // unchanged.
        "flex h-dvh flex-col overflow-hidden border-border text-foreground",
        // Linux BrowserWindow's opaque background squares off the outermost corners. The 16px
        // shell, 12px inner panel and 4px inset form concentric radii; the Linux compositor can
        // drop overflow rounding during native drag/resize, so a same-radius clip-path pins the
        // composited crop. Both collapse to zero when maximized.
        isLinuxDesktop &&
          "rounded-[16px] [clip-path:inset(0_round_16px)] platform-linux-window-maximized:rounded-none platform-linux-window-maximized:[clip-path:inset(0)]",
        // Web/Windows/Linux lack macOS vibrancy as the translucent fallback; keeping the
        // semi-transparent alt background muddles into gray against browser or system chrome.
        usesOpaqueRootSurface ? "bg-background-win-alt" : "bg-background-alt",
      )}
      data-desktop-window-frame="true"
    >
      <div className="relative flex-1 min-h-0 w-full">{children}</div>
    </div>
  );
});
