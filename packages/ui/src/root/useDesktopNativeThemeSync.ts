import { useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveTheme, type Theme } from "@/useTheme.js";

export function useDesktopNativeThemeSync({
  enabled,
  isDesktop,
  platform,
  theme,
}: {
  enabled: boolean;
  isDesktop?: boolean;
  platform: IPlatformService;
  theme: Theme;
}) {
  useEffect(() => {
    if (!enabled || !isDesktop) {
      return;
    }

    let disposed = false;
    const titleBarTheme = theme === "system" ? "system" : resolveTheme(theme);

    // The native window theme affects macOS vibrancy; during the startup loading phase skip nativeTheme writes
    // so RootStartupLoading observing the window shell is not pre-empted by the app theme; sync after the main UI shows.
    platform.setTitleBarTheme(titleBarTheme).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] Failed to sync the title-bar theme", { titleBarTheme, error });
    });

    return () => {
      disposed = true;
    };
  }, [enabled, isDesktop, platform, theme]);
}
