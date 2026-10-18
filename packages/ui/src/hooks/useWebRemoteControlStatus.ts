import { useEffect, useState } from "react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileViewState?.activeWorkspaceKey === right.mobileViewState?.activeWorkspaceKey &&
    left.mobileViewState?.activeTaskId === right.mobileViewState?.activeTaskId &&
    left.mobileViewState?.updatedAt === right.mobileViewState?.updatedAt &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

export function useWebRemoteControlStatus({
  enabled = true,
  intervalMs = 1000,
}: {
  enabled?: boolean;
  intervalMs?: number;
} = {}): WebRemoteControlStatus {
  const platform = useOptionalPlatform();
  const [status, setStatus] = useState<WebRemoteControlStatus>({
    status: "idle",
  });

  useEffect(() => {
    if (!enabled || !platform) {
      setStatus({ status: "idle" });
      return;
    }

    let disposed = false;

    const applyStatus = (nextStatus: WebRemoteControlStatus) => {
      if (disposed) {
        return;
      }
      setStatus((currentStatus) =>
        isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
      );
    };

    const syncStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        applyStatus(nextStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Bugfix: connection state lives in main/relay; poll so desktop sees phone-opened tasks.
        // failures are high-frequency diagnostics: debug only, or logs grow with refresh rate.
        logger.debug("[useWebRemoteControlStatus] failed to sync web remote control state", {
          error: message,
        });
      }
    };

    void syncStatus();
    const disposeStatusChanged = platform.onWebRemoteControlStatusChanged?.((nextStatus) => {
      // Bugfix: a 1s poll after start/refresh races the just-scanned phone; main lacks the snapshot.
      // main owns session/transport truth: consume pushes first, polling is the legacy fallback.
      applyStatus(nextStatus);
    });
    const intervalId = window.setInterval(() => {
      void syncStatus();
    }, intervalMs);

    return () => {
      disposed = true;
      disposeStatusChanged?.();
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, platform]);

  return status;
}
