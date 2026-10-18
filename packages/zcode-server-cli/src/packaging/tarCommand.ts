import { existsSync } from "node:fs";
import { join } from "node:path";

// Windows: Git Bash may put GNU tar ahead on PATH; it treats `C:` in archive args as a remote
// host and cannot write zip by suffix, so resolve the System32 bsdtar explicitly and fail fast
// instead of falling back to PATH. Non-Windows hosts return PATH-resolved "tar"; System32 is a
// Windows-only detail.
export function resolveHostTarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const system32Tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (!existsSync(system32Tar)) {
    throw new Error(
      `System32 tar.exe missing (${system32Tar}); Windows staging requires the OS-bundled bsdtar`,
    );
  }
  return system32Tar;
}

/** The COPYFILE_DISABLE check must match both bare `tar` and absolute System32 tar.exe paths. */
export function isTarCommand(command: string): boolean {
  return command === "tar" || command.endsWith("\\tar.exe") || command.endsWith("/tar");
}
