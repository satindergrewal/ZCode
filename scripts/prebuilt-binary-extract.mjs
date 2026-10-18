import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { runCommand } from "./spawn-command.mjs";

// Bugfix: on Windows, GNU tar (Git Bash) treats the drive-letter colon in absolute paths (C:)
// as a remote host name, and backslash paths get mangled by MSYS argument conversion. Normalize
// tar arguments to forward slashes and prefer a cwd-relative archive path to avoid the colon;
// no impact on bsdtar or Linux/macOS CI.
function toTarPosixPath(pathValue) {
  return pathValue.replaceAll("\\", "/");
}

function resolveTarArchiveArg(archivePath, cwd) {
  if (process.platform === "win32") {
    try {
      const relativeArchivePath = relative(cwd, archivePath);
      if (relativeArchivePath && !relativeArchivePath.startsWith("..")) {
        return toTarPosixPath(relativeArchivePath);
      }
    } catch {
      // path.relative throws across drive letters; fall back to a forward-slash absolute path (fine for bsdtar).
    }
  }

  return toTarPosixPath(archivePath);
}

export function extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd }) {
  mkdirSync(extractDir, { recursive: true });
  if (archiveExt === "zip") {
    if (process.platform === "win32") {
      runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
      ]);
      return;
    }

    runCommand("unzip", ["-q", archivePath, "-d", extractDir], { cwd });
    return;
  }

  const tarCwd = cwd ?? process.cwd();
  runCommand(
    "tar",
    ["-xzf", resolveTarArchiveArg(archivePath, tarCwd), "-C", toTarPosixPath(extractDir)],
    { cwd: tarCwd },
  );
}

export function findPrebuiltBinary(rootDir, binaryName) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findPrebuiltBinary(fullPath, binaryName);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && entry.name === binaryName) return fullPath;
  }

  return undefined;
}

export function assertPrebuiltArchiveSha256(expectedSha256) {
  const normalizedExpectedSha256 = String(expectedSha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpectedSha256)) {
    throw new Error("missing prebuilt archive SHA-256");
  }
  return normalizedExpectedSha256;
}

export function verifyPrebuiltArchiveSha256(archivePath, expectedSha256) {
  const normalizedExpectedSha256 = assertPrebuiltArchiveSha256(expectedSha256);
  const actualSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actualSha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Archive SHA-256 mismatch: expected ${normalizedExpectedSha256}, received ${actualSha256}`,
    );
  }
}

export async function extractPrebuiltBinary({
  archiveExt,
  archivePath,
  archiveSha256,
  binaryName,
  binaryPath,
  cwd,
  targetPlatform,
  validateBinary,
}) {
  verifyPrebuiltArchiveSha256(archivePath, archiveSha256);
  mkdirSync(dirname(binaryPath), { recursive: true });
  mkdirSync(tmpdir(), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-prebuilt-binary-"));
  const extractDir = join(tempDir, "extract");

  try {
    extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd });
    const extractedBinaryPath = findPrebuiltBinary(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Failed to locate ${binaryName} in extracted archive`);
    }

    // A foreign target cannot be verified by executing it; validate the temp artifact before
    // it overwrites the final path.
    await validateBinary?.(extractedBinaryPath);
    copyFileSync(extractedBinaryPath, binaryPath);
    if (targetPlatform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    // Bugfix: on Windows, extracted files can be briefly held by antivirus/indexers or extract
    // children that have not exited; rmSync right away hits EPERM, and an exception thrown in
    // finally masks the real extraction error. Retry the deletion, warn only on failure, and let
    // the original error propagate.
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[warn] failed to remove temp dir (ignorable): ${tempDir}`);
      console.warn(`[warn] ${String(error)}`);
    }
  }
}
