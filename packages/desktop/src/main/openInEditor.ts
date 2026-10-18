import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { shell } from "electron";
import type { OpenInEditorOptions, OpenInEditorRemoteTarget } from "@zcode/shared";
import { listWSLDistros } from "@zcode/server/remote/wsl-detect.js";
import { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } from "./editors.js";
import { logger } from "./logger.js";
import { isDelegatedWindowsExplorerExit } from "./windowsExplorerDelegation.js";

type PathKind = "file" | "directory" | "unknown";

interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

const VSCODE_EDITOR_IDS = new Set(["vscode", "vscode-insiders"]);

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const execFileAsync = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
  });

async function openPathViaShell(path: string): Promise<OpenInEditorResult> {
  const error = await shell.openPath(path);
  return error ? { success: false, error } : { success: true };
}

function detectPathKind(path: string): PathKind {
  try {
    const stats = statSync(path);
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
  } catch {
    // // Keep unknown for non-local or missing paths; later fallbacks decide.
  }
  return "unknown";
}

function isVSCodeEditor(editorId: string): boolean {
  return VSCODE_EDITOR_IDS.has(editorId);
}

function normalizeRemotePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function encodeRemotePath(path: string): string {
  return normalizeRemotePath(path)
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
}

async function resolveWslDistroName(
  target: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
): Promise<string | null> {
  const explicitDistro = target.distro?.trim();
  if (explicitDistro) {
    return explicitDistro;
  }

  try {
    const distros = await listWSLDistros();
    return distros.find((distro) => distro.isDefault)?.name ?? distros[0]?.name ?? null;
  } catch (error) {
    logger.warn("[editors] failed to resolve default WSL distro", {
      error: stringifyError(error),
    });
    return null;
  }
}

function buildWslUncPathCandidates(path: string, distroName: string): string[] {
  const normalizedPath = normalizeRemotePath(path);
  const suffix = normalizedPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("\\");
  const pathSuffix = suffix ? `\\${suffix}` : "";

  return [`\\\\wsl.localhost\\${distroName}${pathSuffix}`, `\\\\wsl$\\${distroName}${pathSuffix}`];
}

function resolveVSCodeSshRemoteAuthority(
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
): string {
  const sshConfigAlias = target.sshConfigAlias?.trim();
  if (sshConfigAlias) {
    return sshConfigAlias;
  }

  const username = target.username.trim();
  const host = target.host.trim();
  const userHost = username ? `${username}@${host}` : host;
  return target.port && target.port !== 22 ? `${userHost}:${target.port}` : userHost;
}

function buildVSCodeSshFolderUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
) {
  // Hand-typed SSH targets without an alias can carry @ and : in the authority.
  // Naive URI joins parse as userinfo/host/port; encode the whole Remote-SSH authority component.
  const encodedAuthority = encodeURIComponent(resolveVSCodeSshRemoteAuthority(target));
  return `vscode-remote://ssh-remote+${encodedAuthority}${encodeRemotePath(path)}`;
}

async function buildVSCodeWslFolderUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
): Promise<{ uri?: string; error?: string }> {
  const distroName = await resolveWslDistroName(target);
  if (!distroName) {
    return { error: "missing WSL distro for VS Code Remote-WSL" };
  }

  return {
    uri: `vscode-remote://wsl+${encodeURIComponent(distroName)}${encodeRemotePath(path)}`,
  };
}

async function openVSCodeRemoteSshFolder(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  // Remote files and dirs once shared the folder URI, so VS Code treated file paths as folders;
  // pathKind only picks the CLI URI arg; remote path and workspace identity stay untouched.
  const args = [
    pathKind === "file" ? "--file-uri" : "--folder-uri",
    buildVSCodeSshFolderUri(path, remoteTarget),
  ];

  if (command) {
    try {
      await execFileAsync(command, args);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, args, error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, "--args", ...args]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] failed to open VS Code remote workspace", {
          editorId,
          path,
          args,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, args);
    } else {
      await execFileAsync("open", ["-a", appPath, "--args", ...args]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] failed to open VS Code remote workspace", {
      editorId,
      path,
      args,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

async function openVSCodeRemoteWslFolder(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  const folderUri = await buildVSCodeWslFolderUri(path, remoteTarget);
  if (!folderUri.uri) {
    return { success: false, error: folderUri.error ?? "invalid WSL folder URI" };
  }

  const args = [pathKind === "file" ? "--file-uri" : "--folder-uri", folderUri.uri];

  if (command) {
    try {
      await execFileAsync(command, args);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, args, error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, "--args", ...args]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] failed to open VS Code WSL workspace", {
          editorId,
          path,
          args,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, args);
    } else {
      await execFileAsync("open", ["-a", appPath, "--args", ...args]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] failed to open VS Code WSL workspace", {
      editorId,
      path,
      args,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

async function openWslPathInExplorer(
  appPath: string,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  const distroName = await resolveWslDistroName(remoteTarget);
  if (!distroName) {
    return { success: false, error: "missing WSL distro for Windows Explorer" };
  }

  const candidates = buildWslUncPathCandidates(path, distroName);
  let lastError = "";
  for (const candidate of candidates) {
    const args = pathKind === "file" ? ["/select,", candidate] : [candidate];
    try {
      await execFileAsync(appPath, args);
      return { success: true };
    } catch (error) {
      // explorer.exe delegates to the running shell; with the window already open the child
      // may still exit 1. Do not swallow errors by code alone: also check the Windows
      // platform, process state, stderr, and the full command, so path/permission/UNC errors still fall through.
      if (await isDelegatedWindowsExplorerExit(error, appPath, args, candidate)) {
        return { success: true };
      }
      lastError = stringifyError(error);
    }
  }

  logger.warn("[editors] failed to open WSL workspace in Explorer", {
    path,
    candidates,
    error: lastError,
  });
  return { success: false, error: lastError || "failed to open WSL path in Explorer" };
}

async function openWindowsEditor(
  editorId: string,
  appPath: string,
  args: string[],
  cliError?: unknown,
): Promise<OpenInEditorResult> {
  try {
    await execFileAsync(appPath, args);
    return { success: true };
  } catch (error) {
    logger.warn("[editors] failed to open Windows editor", {
      editorId,
      args,
      appPath,
      error: stringifyError(error),
      cliError: cliError === undefined ? undefined : stringifyError(cliError),
    });
    return { success: false, error: stringifyError(error) };
  }
}

/**
 * * Opens a path with the given editor.
 */
export async function openInEditor(
  editorId: string,
  path: string,
  options?: OpenInEditorOptions,
): Promise<OpenInEditorResult> {
  const def = getEditorDefsForCurrentPlatform().find((editor) => editor.id === editorId);
  if (!def) {
    return { success: false, error: `unknown editor: ${editorId}` };
  }

  const appPath = resolveEditorDefAppPath(def) ?? def.appPath;
  if (options?.remoteTarget?.kind === "ssh" && isVSCodeEditor(editorId)) {
    // An SSH workspacePath is a remote filesystem path; never run `code /root/...` locally.
    // VS Code Remote-SSH needs a folder URI to connect to the host and open the remote dir.
    return openVSCodeRemoteSshFolder(
      editorId,
      appPath,
      def.command,
      path,
      options.remoteTarget,
      options.pathKind,
    );
  }

  if (options?.remoteTarget?.kind === "wsl" && isVSCodeEditor(editorId)) {
    // A WSL workspacePath is a Linux path; the Windows-side `code` cannot consume it directly.
    // VS Code Remote-WSL needs a folder URI to open the same Linux dir in the chosen distro.
    return openVSCodeRemoteWslFolder(
      editorId,
      appPath,
      def.command,
      path,
      options.remoteTarget,
      options.pathKind,
    );
  }

  if (options?.remoteTarget?.kind === "wsl" && editorId === "explorer") {
    // Windows Explorer cannot read WSL-internal paths like /home/...
    // Convert to UNC only at the host-app boundary; remote host/agent keep Linux path semantics.
    return openWslPathInExplorer(appPath, path, options.remoteTarget, options.pathKind);
  }

  const pathKind = detectPathKind(path);

  if (editorId === "finder") {
    if (pathKind === "file") {
      shell.showItemInFolder(path);
      return { success: true };
    }
    return openPathViaShell(path);
  }

  if (editorId === "explorer") {
    if (pathKind !== "file") {
      return openPathViaShell(path);
    }

    // Explorer can exit non-zero after delegating the open; exiting on code alone would reopen windows.
    // For local files use the system reveal API once: open the folder with the file selected.
    shell.showItemInFolder(path);
    return { success: true };
  }

  if (def.command) {
    try {
      await execFileAsync(def.command, [path]);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, [path], error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, path]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] failed to open editor", {
          editorId,
          path,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, [path]);
    } else {
      await execFileAsync("open", ["-a", appPath, path]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] failed to open editor", {
      editorId,
      path,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}
