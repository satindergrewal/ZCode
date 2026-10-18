import { useEffect, useRef, useState } from "react";
import type { DesktopWindowChromeState, IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX = 136;

function readFinitePositivePx(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function resolveInitialWindowControlsPaddingPx({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
}) {
  const metrics = platform.getWindowControlsOverlayMetrics?.();
  const leftPaddingPx =
    isDesktop && isMacDesktop
      ? (readFinitePositivePx(metrics?.leftPaddingPx) ??
        MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX)
      : MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX;
  const rightPaddingPx =
    isDesktop && isWindowsDesktop
      ? (readFinitePositivePx(metrics?.rightPaddingPx) ??
        WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX)
      : WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX;

  return { leftPaddingPx, rightPaddingPx };
}

function resolveLegacyReadyVersionFromState(payload: UpdateStatePayload) {
  // The legacy UpdateReady event only said "some version is ready", never that the flow later
  // entered a non-installable state such as staging error. Once the new state stream is anything
  // other than update-downloaded, the stale ready flag must be cleared.
  return payload.kind === "update-downloaded" ? payload.version : null;
}

export function useAppChromeState({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
  workspaceAbsPath,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
  workspaceAbsPath: string;
}) {
  const initialWindowControlsPadding = resolveInitialWindowControlsPaddingPx({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
  });
  const [isMacFullscreen, setIsMacFullscreen] = useState(false);
  const [desktopWindowChromeState, setDesktopWindowChromeState] =
    useState<DesktopWindowChromeState | null>(null);
  const [macWindowControlsLeftPaddingPx, setMacWindowControlsLeftPaddingPx] = useState(
    () => initialWindowControlsPadding.leftPaddingPx,
  );
  const [windowsWindowControlsRightPaddingPx, setWindowsWindowControlsRightPaddingPx] = useState(
    () => initialWindowControlsPadding.rightPaddingPx,
  );
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const sidebarContainerRef = useRef<HTMLElement | null>(null);
  const hasShownUpdateToastRef = useRef(false);
  const updateStateEventRevisionRef = useRef(0);
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!isDesktop || !isMacDesktop) {
      setIsMacFullscreen(false);
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      return;
    }

    // After macOS fullscreen the traffic lights hug the top-left again. Keeping the windowed
    // pl-24 on the top overlay overstretches the left safe area, visually "losing" the three
    // buttons. Subscribe to desktop fullscreen and narrow the padding only for macOS fullscreen;
    // normal windowed state is untouched.
    return platform.onWindowFullscreenChanged((fullscreen) => {
      setIsMacFullscreen(fullscreen);
    });
  }, [isDesktop, isMacDesktop, platform]);

  useEffect(() => {
    // Excluding macOS would leave the version unknown forever, and Tahoe would wrongly take
    // Sequoia's 6px corner radius. All desktop platforms share the window-state query, keeping
    // event-first ordering and unmount cleanup; Web never reads native state.
    if (!isDesktop || !platform.getDesktopWindowChromeState) {
      setDesktopWindowChromeState(null);
      return;
    }

    let disposed = false;
    let eventRevision = 0;
    const dispose = platform.onDesktopWindowChromeStateChanged?.((state) => {
      eventRevision += 1;
      setDesktopWindowChromeState(state);
    });
    const requestRevision = eventRevision;

    // Listening only to maximize/unmaximize misses "window already maximized at app startup".
    // Subscribe first, then query, and use a revision so a slower query result cannot override a
    // newer window event.
    void platform.getDesktopWindowChromeState().then(
      (state) => {
        if (!disposed && eventRevision === requestRevision) setDesktopWindowChromeState(state);
      },
      (error) => logger.warn("[app-chrome] Failed to sync desktop window chrome state", { error }),
    );

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  useEffect(() => {
    const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
    const rootElement = document.documentElement;
    if (!rootElement) return;
    // The Linux frame is clipped by the renderer; rounded corners while maximized leave
    // transparent gaps at the screen corners. Reuse the main process's window state as the single
    // source so Workspace and settings pages switch together.
    rootElement.classList.toggle(
      "window-maximized",
      isLinuxDesktop && (desktopWindowChromeState?.isMaximized ?? false),
    );
    return () => rootElement.classList.remove("window-maximized");
  }, [desktopWindowChromeState?.isMaximized, isDesktop, isMacDesktop, isWindowsDesktop]);

  useEffect(() => {
    if (
      !isDesktop ||
      (!isMacDesktop && !isWindowsDesktop) ||
      !platform.onWindowControlsOverlayChanged
    ) {
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      setWindowsWindowControlsRightPaddingPx(WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX);
      return;
    }

    // Native window controls do not scale with renderer zoom.
    // macOS syncs the left traffic-light inset; Windows syncs the right caption-button inset.
    return platform.onWindowControlsOverlayChanged((metrics) => {
      const leftPaddingPx = readFinitePositivePx(metrics.leftPaddingPx);
      const rightPaddingPx = readFinitePositivePx(metrics.rightPaddingPx);
      logger.debug("[app-chrome] window controls overlay geometry changed", {
        isMacDesktop,
        isWindowsDesktop,
        leftPaddingPx,
        rightPaddingPx,
      });
      if (isMacDesktop && leftPaddingPx !== null) {
        setMacWindowControlsLeftPaddingPx(leftPaddingPx);
      }
      if (isWindowsDesktop && rightPaddingPx !== null) {
        setWindowsWindowControlsRightPaddingPx(rightPaddingPx);
      }
    });
  }, [isDesktop, isMacDesktop, isWindowsDesktop, platform]);

  useEffect(() => {
    if (!platform.onUpdateReady) {
      return;
    }

    // Update-ready state used to live inside button components, forcing each to subscribe to
    // platform events separately; WorkspaceHeader could not know whether an update was pending
    // and multiple entries forked their own state. Lift version into the App and distribute to
    // Header / Overlay on demand.
    return platform.onUpdateReady((version) => {
      logger.info("[App] installable update received", {
        workspaceAbsPath,
        version,
      });
      setUpdateReadyVersion(version);

      // Windows desktop shows a light toast on update-ready; never blocks the main UI.
      if (isWindowsDesktop && !hasShownUpdateToastRef.current) {
        hasShownUpdateToastRef.current = true;
        toast(intl.formatMessage({ id: "update.toast.ready" }, { version }), {
          durationMs: 4000,
          position: "bottom-left",
          variant: "update",
        });
      }
    });
  }, [platform, workspaceAbsPath, isWindowsDesktop, intl]);

  useEffect(() => {
    let cancelled = false;

    if (platform.getUpdateState) {
      const requestRevision = updateStateEventRevisionRef.current;
      void platform.getUpdateState().then(
        (payload) => {
          if (!cancelled && updateStateEventRevisionRef.current === requestRevision) {
            setUpdateState(payload);
            setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
          }
        },
        (error) => {
          logger.warn("[App] Failed to sync auto-update state", { error });
        },
      );
    }

    if (!platform.onUpdateStateChanged) {
      return () => {
        cancelled = true;
      };
    }

    const dispose = platform.onUpdateStateChanged((payload) => {
      updateStateEventRevisionRef.current += 1;
      setUpdateState(payload);
      setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [platform]);

  return {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  };
}
