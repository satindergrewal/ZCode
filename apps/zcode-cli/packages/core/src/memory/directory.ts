import {
  traceContextToLogContext,
  type FileSystemPort,
  type Logger,
  type TraceContext,
} from "@zcode/contracts";

export async function ensureMemoryDirectoryExists(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  traceContext?: TraceContext,
  logger?: Logger,
): Promise<void> {
  try {
    await fileSystemPort.createDirectory({ path: rootDir, trace: traceContext });
  } catch (error) {
    // Pre-creating the directory never blocks execution; the actual Write/Edit still surfaces the original file error.
    logger?.debug("Memory directory creation failed", {
      ...(traceContext ? traceContextToLogContext(traceContext) : {}),
      error: error instanceof Error ? error.message : String(error),
      event: "memory.directory.create_failed",
      module: "core.memory",
      status: "failed",
    });
  }
}
