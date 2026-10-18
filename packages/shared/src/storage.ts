/**
 * Shared types of storage management (the resource manager's Storage tab).
 * Data comes from main's StorageService, via preload window.resourceManager.storage to the manager renderer;
 * the services storage module and the UI reference only these types.
 */
/** The two data roots: ~/.zcode under home, and .zcode under the configured data-storage path. */
export type StorageRootId = "home" | "dataBaseDir";

export const STORAGE_CATEGORY_IDS = [
  "sessionStore",
  "subagentTranscripts",
  "toolOutputs",
  "modelTrajectory",
  "devTraces",
  "logs",
  "backups",
  "exports",
  "runtimes",
  "config",
  "other",
] as const;

export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];

/** Placeholder path of the folded remainder once entries pass the cap; UI shows "N more". */
export const STORAGE_MORE_ENTRIES_PATH = "…";

/** none: no cleanup; safe: clean directly; confirm: needs a second confirmation. */
export type StorageCleanability = "none" | "safe" | "confirm";

/** Scan input: roots resolved by RootsResolverPort. */
export interface StorageRootSpec {
  id: StorageRootId;
  path: string;
  /// Whether a custom data path is enabled; then home's v2 counts as a legacy copy under Other.
  hasCustomDataBaseDir: boolean;
}

export interface StorageVolume {
  /// Stable key of one physical volume (stat().dev); same-key roots merge into one disk card.
  deviceId: string;
  /// Mount point on mac/Linux, drive root on Windows.
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageEntryUsage {
  /// Path relative to the root.
  relativePath: string;
  bytes: number;
  fileCount: number;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  cleanability: StorageCleanability;
  /// Drill-down: one level under the rule-hit path, bytes descending, capped.
  entries: StorageEntryUsage[];
}

export interface StorageRootUsage {
  id: StorageRootId;
  path: string;
  /// null when statfs fails: usage only, no disk capacity.
  volume: StorageVolume | null;
  bytes: number;
  fileCount: number;
  categories: StorageCategoryUsage[];
}

export type StorageScanStatus = "scanning" | "complete" | "cancelled" | "failed";

export interface StoragePathError {
  path: string;
  code: string;
}

export interface StorageUsageSnapshot {
  jobId: string;
  status: StorageScanStatus;
  startedAt: number;
  finishedAt?: number;
  roots: StorageRootUsage[];
  /// Local errors like EACCES/ENOENT never abort the scan.
  errors: StoragePathError[];
}

export interface StorageCleanRequest {
  rootId: StorageRootId;
  categoryId: StorageCategoryId;
}

export interface StorageCleanResult {
  freedBytes: number;
  deletedCount: number;
  /// Files skipped by protection rules (today's logs, session dirs < 24h old).
  skippedCount: number;
  failures: StoragePathError[];
}

/** Volume view: roots on one physical volume grouped for the disk card. */
export interface StorageVolumeGroup {
  /// volume.deviceId; failed probes group alone, keyed by root path.
  key: string;
  volume: StorageVolume | null;
  roots: StorageRootUsage[];
  bytes: number;
}

/**
 * Group roots by physical volume: same deviceId together; failed probes alone.
 * Pure; within a group root order follows input, groups ordered by bytes descending.
 */
export function groupStorageRootsByVolume(roots: StorageRootUsage[]): StorageVolumeGroup[] {
  const groups = new Map<string, StorageVolumeGroup>();
  for (const root of roots) {
    const key = root.volume ? `dev:${root.volume.deviceId}` : `path:${root.path}`;
    const group = groups.get(key);
    if (group) {
      group.roots.push(root);
      group.bytes += root.bytes;
      continue;
    }
    groups.set(key, { key, volume: root.volume, roots: [root], bytes: root.bytes });
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Command surface shared by the main-side storage service and the renderer bridge. */
export interface StorageManagementApi {
  /// Start a scan; cancels any running job first.
  startScan(): Promise<{ jobId: string }>;
  /// Cancel a job; non-current jobs no-op.
  cancelScan(jobId: string): Promise<void>;
  /// Latest snapshot (running or done); null before the first scan.
  getSnapshot(): Promise<StorageUsageSnapshot | null>;
  /// Clean by category; the caller owns confirmation. During a scan, cancels it first.
  clean(request: StorageCleanRequest): Promise<StorageCleanResult>;
}

/** Bridge exposed to the manager renderer: window.resourceManager.storage. */
export interface StorageManagementBridge extends StorageManagementApi {
  /// Progress events: throttled to one per >=300ms with the full snapshot; terminal states ride it too. Returns an unsubscribe.
  subscribeScanProgress(listener: (snapshot: StorageUsageSnapshot) => void): () => void;
  /// Reveal a path in the system file manager (must be inside a data root; validated main-side).
  revealPath(absolutePath: string): Promise<void>;
}
