import type { Event } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * File system watcher service.
 *
 * Watcher instances are managed per path: non-recursive watch() when the UI expands a folder,
 * recursive watch() for workspace-wide consumers such as git. Events stream over RPC via onDynamicChange.
 */
export interface IFileWatcherService {
  /** Watch a path. Returns a watcherId used for unwatch and event subscription */
  watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }>;
  /** Stop watching. Releases the watcher and its resources */
  unwatch(params: { id: string }): Promise<void>;
  /** Stop all watchers. Used at host shutdown to release every underlying fs.watch handle */
  disposeAll(): void;
  /** Subscribe to change events by watcherId (onDynamic* pattern, auto-routed over RPC) */
  onDynamicChange(id: string): Event<FileWatchEvent>;
}

export const IFileWatcherService = createServiceDescriptor<IFileWatcherService>(
  ServiceChannels.FileWatcher,
);
