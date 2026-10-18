import { stat } from "node:fs/promises";

/** Picks the exec dir only; never captures DB errors - keep the original path for the real failure. */
export async function resolveZCodeAgentSpawnCwd(
  options: { requestedCwd: string; workspacePath: string; spawnFallbackCwd?: string },
  probe: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<{ cwd: string; usedFallback: boolean; cwdExists: boolean }> {
  const usable = async (path: string | undefined) => {
    if (!path) return false;
    try {
      return (await probe(path)).isDirectory();
    } catch {
      // Legacy agents fall back to a spare cwd for dead history dirs; ENOTDIR/EACCES keep that.
      return false;
    }
  };
  const cwdExists = await usable(options.requestedCwd);
  if (
    options.requestedCwd === options.workspacePath &&
    !cwdExists &&
    (await usable(options.spawnFallbackCwd))
  )
    return { cwd: options.spawnFallbackCwd!, usedFallback: true, cwdExists: true };
  return { cwd: options.requestedCwd, usedFallback: false, cwdExists };
}
