/**
 * storage module public contract: service interfaces and type re-exports for the explorer's storage tab.
 * Import only from here; internals (Worker, fs, catalog rules) stay module-private.
 */
import type { Event } from "@zcode/rpc";
import type { StorageManagementApi, StorageUsageSnapshot } from "@zcode/shared";

// Type truth lives in @zcode/shared (renderer bridge + main); re-exported for services-internal use.
export type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanRequest,
  StorageCleanResult,
  StorageCleanability,
  StorageEntryUsage,
  StorageManagementApi,
  StoragePathError,
  StorageRootId,
  StorageRootSpec,
  StorageRootUsage,
  StorageScanStatus,
  StorageUsageSnapshot,
  StorageVolume,
  StorageVolumeGroup,
} from "@zcode/shared";

/**
 * Storage service instance. desktop main holds one instance (explorer window)
 * and no longer registers as a host RPC service, hence no ServiceDescriptor/channel.
 */
export interface IStorageService extends StorageManagementApi {
  onScanProgress: Event<StorageUsageSnapshot>;
  /** Cancel the running scan and release event sources. */
  dispose(): void;
}
