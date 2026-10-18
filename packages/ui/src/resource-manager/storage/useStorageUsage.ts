/**
 * useStorageUsage — data source for the resource manager's Storage tab, fed by the preload
 * StorageManagementBridge. Lifecycle binds to the tab: scan + progress subscription while
 * enabled, cancelled on unhide/unmount; scans cancel after 60s window blur and restart on
 * focus (perf constraint). Only the current jobId's snapshots are consumed — late packets from
 * older jobs are dropped — and the last completed snapshot shows immediately (stale-while-revalidate).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";
import { logger } from "@/logger.js";

const STORAGE_SCAN_BLUR_CANCEL_MS = 60_000;

interface StorageUsageState {
  snapshot: StorageUsageSnapshot | null;
  scanning: boolean;
  rescan: () => Promise<void>;
  clean: (request: StorageCleanRequest) => Promise<StorageCleanResult>;
}

export function useStorageUsage({
  bridge,
  enabled,
}: {
  bridge: StorageManagementBridge | undefined;
  enabled: boolean;
}): StorageUsageState {
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    if (!bridge) return;
    try {
      const { jobId } = await bridge.startScan();
      jobIdRef.current = jobId;
      setScanning(true);
    } catch (error) {
      logger.warn("[storage] startScan failed", { error });
      setScanning(false);
    }
  }, [bridge]);

  const cancel = useCallback(async () => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    setScanning(false);
    if (!jobId || !bridge) return;
    try {
      await bridge.cancelScan(jobId);
    } catch (error) {
      logger.warn("[storage] cancelScan failed", { error, jobId });
    }
  }, [bridge]);

  useEffect(() => {
    if (!enabled || !bridge) return;
    let disposed = false;
    const unsubscribe = bridge.subscribeScanProgress((next) => {
      if (disposed || next.jobId !== jobIdRef.current) return;
      setSnapshot(next);
      if (next.status !== "scanning") {
        jobIdRef.current = null;
        setScanning(false);
      }
    });
    void bridge
      .getSnapshot()
      .then((previous) => {
        if (!disposed && previous && !jobIdRef.current) setSnapshot(previous);
      })
      .catch(() => {});
    void start();
    return () => {
      disposed = true;
      unsubscribe();
      void cancel();
    };
  }, [enabled, bridge, start, cancel]);

  useEffect(() => {
    if (!enabled || !bridge || typeof window === "undefined") return;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelledByBlur = false;
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        if (!jobIdRef.current) return;
        cancelledByBlur = true;
        void cancel();
      }, STORAGE_SCAN_BLUR_CANCEL_MS);
    };
    const onFocus = () => {
      if (blurTimer) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
      if (cancelledByBlur) {
        cancelledByBlur = false;
        void start();
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, bridge, start, cancel]);

  const clean = useCallback(
    async (request: StorageCleanRequest) => {
      if (!bridge) throw new Error("storage bridge unavailable");
      jobIdRef.current = null;
      setScanning(false);
      const result = await bridge.clean(request);
      await start();
      return result;
    },
    [bridge, start],
  );

  return { snapshot, scanning, rescan: start, clean };
}
