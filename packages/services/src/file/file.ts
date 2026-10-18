import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
  FileTextSlice,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface WorkspaceFileSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  limit?: number;
  /** No-hit rescan: bypass the not-yet-expired file index. */
  refresh?: boolean;
}

export interface IFileService {
  /** The host matches and returns bounded candidates; the renderer never downloads the full index. */
  searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]>;
  readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  stat(params: { path: string }): Promise<FileStat>;
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  resolvePath(params: { path: string }): Promise<string>;
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  createDefaultWorkspace(): Promise<{ path: string }>;
  createScratchWorkspace(params: { name: string }): Promise<{ path: string }>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
  readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview>;
  /**
   * Read a raw byte range at an offset so large binaries (e.g. PDFs) can load incrementally.
   * The result must stay a top-level Uint8Array: RPC serialization only uses the raw-byte channel
   * for top-level binaries, while object fields degrade to JSON+base64. Returns a short array at EOF.
   */
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
  readBinaryPreview(params: { path: string; maxBytes?: number }): Promise<FileBinaryPreview>;
  /**
   * Packed length (in characters) of the workspace file index. Pairs with listWorkspaceFilesRange:
   * callers fetch in chunks by length (see fetchWorkspaceFileEntriesPacked).
   * Returns a number for the RPC Int fast path.
   */
  listWorkspaceFilesLength(params: { rootPath: string }): Promise<number>;
  /**
   * Returns the packed string chunk (workspaceFileEntriesCodec format, [offset, offset+length)).
   * Must be a bare top-level string for the RPC String fast path (length prefix + raw bytes); an
   * object wrapper JSON-escapes large strings (measured 6-9s main-thread stalls). Keep chunks
   * under ~4MB: reassembling oversized messages on the renderer side is a multi-second task
   * (measured 4.6-6.3s); with chunks and yields between them the main thread handles ~50ms slices
   * at a time and input never freezes. The host caches the full pack (60s TTL + .zcodeignore fingerprint).
   */
  listWorkspaceFilesRange(params: {
    rootPath: string;
    offset: number;
    length: number;
  }): Promise<string>;
  /**
   * Read/write access to workspace search ignore rules (.zcodeignore) for the settings page.
   * source "file": existing content; "template": preview before creation (persisted on save).
   */
  readWorkspaceFileSearchIgnore(params: {
    rootPath: string;
  }): Promise<{ content: string; source: "file" | "template" }>;
  /**
   * Settings section operations (return new editor content; persisted on save):
   * "sync-gitignore" rewrites only the gitignore section (keeps defaults and custom rules);
   * "reset-defaults" resets only the defaults section (keeps gitignore and custom rules).
   */
  applyWorkspaceFileSearchIgnoreTransform(params: {
    rootPath: string;
    transform: "sync-gitignore" | "reset-defaults";
  }): Promise<{ content: string }>;
  writeWorkspaceFileSearchIgnore(params: { rootPath: string; content: string }): Promise<void>;
}

export const IFileService = createServiceDescriptor<IFileService>(ServiceChannels.File);
