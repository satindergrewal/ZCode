import type { IFileService } from "@zcode/services";
import { WORKSPACE_FILE_ENTRIES_CHUNK_SIZE } from "@zcode/shared/workspaceFileEntriesCodec";

/**
 * Fetch the workspace file index as chunked columnar packed strings.
 * A single large RPC message (65MB) costs 4.6-6.3s of main-thread frame reassembly on the
 * renderer side and freezes typing. Chunking (~4MB per chunk) plus a setTimeout(0) yield between
 * chunks keeps each main-thread slice ~50ms so input events always interleave. Total time is
 * unchanged, but the UI never freezes.
 */
export async function fetchWorkspaceFileEntriesPacked(
  fileService: Pick<IFileService, "listWorkspaceFilesLength" | "listWorkspaceFilesRange">,
  rootPath: string,
): Promise<string> {
  const totalLength = await fileService.listWorkspaceFilesLength({ rootPath });
  let packed = "";
  for (let offset = 0; offset < totalLength; offset += WORKSPACE_FILE_ENTRIES_CHUNK_SIZE) {
    const chunk = await fileService.listWorkspaceFilesRange({
      rootPath,
      offset,
      length: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
    });
    packed += chunk;
    // Yield between chunks: let queued input/rendering run before the next slice.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return packed;
}
