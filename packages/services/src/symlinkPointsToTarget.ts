import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** True when linkPath is a directory symlink/junction resolving to targetPath (same realpath). */
export async function symlinkPointsToTarget(
  linkPath: string,
  targetPath: string,
): Promise<boolean> {
  const targetReal = await realpath(targetPath).catch(() => null);
  if (!targetReal) {
    return false;
  }
  try {
    const stat = await lstat(linkPath);
    let rawLinked: string;
    if (stat.isSymbolicLink()) {
      rawLinked = await readlink(linkPath);
    } else if (process.platform === "win32") {
      // On some Node versions directory junctions report isSymbolicLink() false yet still expose the target.
      try {
        rawLinked = await readlink(linkPath);
      } catch {
        return false;
      }
    } else {
      return false;
    }
    const linkedPath = isAbsolute(rawLinked) ? rawLinked : join(dirname(linkPath), rawLinked);
    const linkedReal = await realpath(linkedPath).catch(() => null);
    return linkedReal !== null && linkedReal === targetReal;
  } catch {
    return false;
  }
}
