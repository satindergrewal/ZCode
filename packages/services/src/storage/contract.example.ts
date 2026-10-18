import type { IStorageService, StorageUsageSnapshot } from "./contract.js";

/**
 * Contract usage example: subscribe and scan on section enter, cancel on leave, rescan after cleanup.
 * Minimal UI-hook skeleton with no implementation details.
 */
export async function useStorageSection(
  storage: IStorageService,
  render: (snapshot: StorageUsageSnapshot) => void,
): Promise<{ leave: () => Promise<void>; cleanTrajectories: () => Promise<void> }> {
  let currentJobId: string | null = null;
  const subscription = storage.onScanProgress((snapshot) => {
    // Consume only the current job's snapshots; drop tail events of older jobs.
    if (snapshot.jobId === currentJobId) render(snapshot);
  });
  const start = async () => {
    currentJobId = (await storage.startScan()).jobId;
  };
  await start();
  return {
    leave: async () => {
      subscription.dispose();
      if (currentJobId) await storage.cancelScan(currentJobId);
    },
    cleanTrajectories: async () => {
      await storage.clean({ rootId: "home", categoryId: "modelTrajectory" });
      await start();
    },
  };
}
