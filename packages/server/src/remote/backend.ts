import type { IDisposable, Event } from "@zcode/rpc";

export interface RemoteEnvironment {
  platform: string; // "linux" | "darwin"
  arch: string; // "x64" | "arm64"
}

export interface StdioStream {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onClose: Event<number>; // exit code
}

export type RemoteDisconnectReason = "error" | "close" | "end";

export interface RemoteDisconnectEvent {
  reason: RemoteDisconnectReason;
  error?: Error;
}

export interface RemoteUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface RemoteUploadOptions {
  onProgress?: (progress: RemoteUploadProgress) => void;
  signal?: AbortSignal;
}

export interface IRemoteBackend extends IDisposable {
  /** Optional WSL runtime proxy resolution; other remote types leave it unset. */
  resolveRuntimeProxy?(proxyUrl: string): Promise<string>;
  /** Await reclamation of the underlying process/connection this backend created; never extend to shared runtimes. */
  disposeAndWait?(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void>;
  /** Underlying remote connection dropped; compensates for half-open connections when the stdio channel fails to close in time. */
  onDidDisconnect?: Event<RemoteDisconnectEvent>;
  /** Detect remote environment (no Node.js required) */
  detect(): Promise<RemoteEnvironment>;
  /** Upload a file to the remote machine */
  upload(localPath: string, remotePath: string, options?: RemoteUploadOptions): Promise<void>;
  /** Execute a command on the remote machine, returning stdio streams */
  exec(command: string): Promise<StdioStream>;
  /** Check if a remote file exists */
  exists(remotePath: string): Promise<boolean>;
  /** Read a small remote file (e.g. version string) */
  readFile(remotePath: string): Promise<string>;
}
