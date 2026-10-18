/**
 * App-layer ports: storageService depends only on these; adapters implement IO, injected by the host.
 */
import type { StorageCleanCandidate } from "../domain/cleanPlan.js";
import type { StorageCleanScope } from "../domain/storageCatalog.js";
import type {
  StoragePathError,
  StorageRootSpec,
  StorageRootUsage,
  StorageVolume,
} from "@zcode/shared";

export interface RootsResolverPort {
  resolveRoots(): Promise<StorageRootSpec[]>;
}

export interface StorageScanProgress {
  roots: StorageRootUsage[];
  errors: StoragePathError[];
}

export interface StorageScanRunRequest {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  /** The runner reports at its own pace; throttling is the app-layer job's concern. */
  onProgress: (progress: StorageScanProgress) => void;
}

export interface ScanRunnerPort {
  /** On cancel, reject with AbortError (name === "AbortError"). */
  run(request: StorageScanRunRequest): Promise<StorageScanProgress>;
}

export interface VolumeProbePort {
  probe(path: string): Promise<StorageVolume | null>;
}

export interface StorageDeleteResult {
  deletedCount: number;
  freedBytes: number;
  failures: StoragePathError[];
}

export interface FsCleanerPort {
  listCandidates(rootPath: string, scopes: StorageCleanScope[]): Promise<StorageCleanCandidate[]>;
  deleteFiles(
    rootPath: string,
    targets: StorageCleanCandidate[],
    options: { keepDirectories: string[] },
  ): Promise<StorageDeleteResult>;
}
