import { getGenUiOutputDirectory } from "@zcode/shared/node";
import type { AgentRuntimeInternal } from "../internal.js";

export function resolveGenUiOutputDirectory(runtime: AgentRuntimeInternal): string | undefined {
  if (runtime.config.presentationSurface !== "zcode_desktop" || !runtime.config.genUiOutputRoot)
    return undefined;
  return getGenUiOutputDirectory(runtime.config.genUiOutputRoot, {
    workspacePath: runtime.config.workspacePath ?? runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity,
    sessionId: runtime.sessionId,
  });
}

export async function ensureGenUiOutputDirectory(runtime: AgentRuntimeInternal): Promise<void> {
  const path = resolveGenUiOutputDirectory(runtime);
  if (!path) return;
  if (!runtime.fileSystemPort) throw new Error("Gen UI output requires FileSystemPort");
  // Declare writable dirs to the model only after creation succeeds; a failure must not silently fall back to the Git workspace.
  await runtime.fileSystemPort.createDirectory({ path, trace: runtime.rootTraceContext });
}
