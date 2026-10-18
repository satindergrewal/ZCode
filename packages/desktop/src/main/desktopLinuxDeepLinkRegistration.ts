import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installLinuxAppImageDesktopIconBestEffort } from "./desktopLinuxAppImageIcon.js";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

const LINUX_DEEP_LINK_DESKTOP_FILE = "zcode.desktop";
const LINUX_DEEP_LINK_MIME_TYPE = "x-scheme-handler/zcode";
// Ownership marker: detects user-level zcode.desktop written by this app (every historical release carries this Comment).
const LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER = "Comment=ZCode Desktop App";

type LinuxDesktopEnv = {
  APPIMAGE?: string;
  XDG_DATA_HOME?: string;
  XDG_DATA_DIRS?: string;
};

interface RegisterLinuxDeepLinkProtocolOptions {
  executablePath: string;
  homeDir: string;
  productName?: string;
  iconSourcePath?: string;
  env?: LinuxDesktopEnv;
  argv?: string[];
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
  systemApplicationDirs?: string[];
}

interface LinuxDeepLinkCommand {
  executablePath: string;
  args: string[];
}

const APPIMAGE_DEEP_LINK_ARG_NAMES = new Set([
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
]);

const APPIMAGE_DEEP_LINK_ARG_PREFIXES = [
  "--use-gl=",
  "--use-angle=",
  "--disable-features=",
  "--enable-features=",
];

function resolveLinuxDeepLinkCommand(params: {
  env?: { APPIMAGE?: string };
  executablePath: string;
  argv?: string[];
}): LinuxDeepLinkCommand {
  const appImagePath = params.env?.APPIMAGE?.trim();
  if (!appImagePath) {
    return { executablePath: params.executablePath, args: [] };
  }

  return {
    executablePath: appImagePath,
    // AppImage zcode:// callbacks re-exec via xdg-open per the .desktop Exec line.
    // Manual flags (sandbox/GPU) are not inherited, so the second launch can crash before Electron init.
    // Persist only launch-critical allowlisted flags; never bake in deep-link URLs, debug ports, or workspace paths.
    args: resolveAppImageDeepLinkArgs(params.argv ?? []),
  };
}

function quoteDesktopExecPath(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (match) => `\\${match}`)}"`;
}

function isAllowedAppImageDeepLinkArg(arg: string): boolean {
  return (
    APPIMAGE_DEEP_LINK_ARG_NAMES.has(arg) ||
    APPIMAGE_DEEP_LINK_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

function resolveAppImageDeepLinkArgs(argv: string[]): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!isAllowedAppImageDeepLinkArg(arg) || seen.has(arg)) {
      continue;
    }
    seen.add(arg);
    args.push(arg);
  }
  return args;
}

function quoteDesktopExecToken(value: string): string {
  return quoteDesktopExecPath(value);
}

function formatDesktopExec(command: LinuxDeepLinkCommand): string {
  return [command.executablePath, ...command.args]
    .map(quoteDesktopExecToken)
    .concat("%U")
    .join(" ");
}

function createLinuxDeepLinkDesktopEntry(params: {
  executablePath: string;
  args?: string[];
  productName?: string;
  iconName?: string;
}): string {
  const productName = params.productName ?? "ZCode";
  const iconName = params.iconName ?? "zcode";
  const command = {
    executablePath: params.executablePath,
    args: params.args ?? [],
  };
  return [
    "[Desktop Entry]",
    `Name=${productName}`,
    LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER,
    `Exec=${formatDesktopExec(command)}`,
    "Terminal=false",
    "Type=Application",
    `Icon=${iconName}`,
    "Categories=Development;",
    `MimeType=${LINUX_DEEP_LINK_MIME_TYPE};`,
    `StartupWMClass=${productName}`,
    "",
  ].join("\n");
}

function resolveLinuxUserDataDir(params: {
  env?: { XDG_DATA_HOME?: string };
  homeDir: string;
}): string {
  const xdgDataHome = params.env?.XDG_DATA_HOME?.trim();
  return xdgDataHome || join(params.homeDir, ".local", "share");
}

function resolveLinuxSystemApplicationDirs(env?: { XDG_DATA_DIRS?: string }): string[] {
  const raw = env?.XDG_DATA_DIRS?.trim();
  const entries = raw
    ? raw
        .split(":")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  // XDG default is /usr/local/share:/usr/share; an all-empty XDG_DATA_DIRS falls back to it too.
  const dataDirs = entries.length > 0 ? entries : ["/usr/local/share", "/usr/share"];
  return dataDirs.map((dir) => join(dir, "applications"));
}

function findSystemLevelDesktopEntryPath(systemApplicationDirs: string[]): string | undefined {
  for (const dir of systemApplicationDirs) {
    const candidate = join(dir, LINUX_DEEP_LINK_DESKTOP_FILE);
    // Edge: dirs or broken paths are not valid system entries, or a pure-AppImage user's
    // user-level registration gets suppressed by pathological paths. Only regular files count as shadows.
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Skip candidate dirs that are missing or unstatable (permissions).
    }
  }
  return undefined;
}

function isOwnedDesktopEntry(path: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    // Strip \r and outer whitespace, tolerating CRLF or hand-editor padding,
    // so cleanable legacy entries are not mistaken for user customization and kept forever.
    return content
      .split("\n")
      .some((line) => line.replaceAll("\r", "").trim() === LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER);
  } catch {
    return false;
  }
}

function removeOwnedUserDesktopEntry(
  desktopFilePath: string,
  logger: LinuxDeepLinkRegistrationLogger,
): void {
  if (!existsSync(desktopFilePath)) {
    return;
  }
  if (!isOwnedDesktopEntry(desktopFilePath)) {
    logger.warn("[deep-link] user-level zcode.desktop not owned by this app; kept", {
      desktopFilePath,
    });
    return;
  }
  try {
    rmSync(desktopFilePath);
    logger.info("[deep-link] removed legacy user-level zcode.desktop; system entry restored", {
      desktopFilePath,
    });
  } catch (error) {
    logger.warn("[deep-link] failed to clean legacy user-level zcode.desktop", {
      desktopFilePath,
      error,
    });
  }
}

function resolveLinuxDeepLinkDesktopFilePath(dataDir: string): string {
  return join(dataDir, "applications", LINUX_DEEP_LINK_DESKTOP_FILE);
}

function writeFileIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

export function registerLinuxDeepLinkProtocol(options: RegisterLinuxDeepLinkProtocolOptions): void {
  const command = resolveLinuxDeepLinkCommand({
    env: options.env,
    executablePath: options.executablePath,
    argv: options.argv,
  });
  const dataDir = resolveLinuxUserDataDir({ env: options.env, homeDir: options.homeDir });
  const desktopFilePath = resolveLinuxDeepLinkDesktopFilePath(dataDir);
  const applicationsDir = dirname(desktopFilePath);
  const desktopEntry = createLinuxDeepLinkDesktopEntry({
    ...command,
    productName: options.productName,
  });
  let protocolRegistered = false;
  const runCommand = options.runCommand ?? runXdgCommand;
  // zcode:// deep links keep targeting the old AppImage (while it exists) or die (once deleted) until a manual new run rewrites them.
  // (continuation)
  // Now, whenever a same-ID system entry exists:
  // - installed (rpm/deb) runs: remove our legacy user-level entry and stop writing user-level data;
  // - AppImage runs: write no user-level entry or icon, so the old AppImage cannot shadow the system install again.
  // Hand-written zcode.desktop files (no ownership marker) are untouched and never cleaned.
  //
  //
  //
  const systemDesktopEntryPath = findSystemLevelDesktopEntryPath(
    options.systemApplicationDirs ?? resolveLinuxSystemApplicationDirs(options.env),
  );

  try {
    let changed = false;
    if (systemDesktopEntryPath) {
      options.logger.info("[deep-link] Linux system-level desktop entry already present", {
        systemDesktopEntryPath,
        desktopFilePath,
      });
      removeOwnedUserDesktopEntry(desktopFilePath, options.logger);
    } else {
      changed = writeFileIfChanged(desktopFilePath, desktopEntry);
    }
    //
    //
    //
    const updateResult = runCommand("update-desktop-database", [applicationsDir]);
    const defaultResult = runCommand("xdg-mime", [
      "default",
      LINUX_DEEP_LINK_DESKTOP_FILE,
      LINUX_DEEP_LINK_MIME_TYPE,
    ]);
    // options.logger.info("[deep-link] Linux user-level protocol registered", {
    if (defaultResult.status === 0) {
      protocolRegistered = true;
      options.logger.info("[deep-link] Linux user-level protocol registered", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        changed,
        systemDesktopEntryPath,
      });
    } else {
      options.logger.warn("[deep-link] Linux user-level protocol registration failed", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        status: defaultResult.status,
        signal: defaultResult.signal,
        timeoutMs: defaultResult.signal === "SIGTERM" ? XDG_COMMAND_TIMEOUT_MS : undefined,
        error: defaultResult.error?.message,
        stderr: defaultResult.stderr?.trim(),
      });
    }

    if (updateResult.error) {
      options.logger.warn("[deep-link] update-desktop-database unavailable; skipped", {
        desktopFilePath,
        message: updateResult.error.message,
      });
    } else if (updateResult.signal === "SIGTERM") {
      options.logger.warn("[deep-link] update-desktop-database timed out; skipped", {
        desktopFilePath,
        timeoutMs: XDG_COMMAND_TIMEOUT_MS,
      });
    } else if (updateResult.status !== 0) {
      options.logger.warn("[deep-link] update-desktop-database failed; skipped", {
        desktopFilePath,
        status: updateResult.status,
        signal: updateResult.signal,
        stderr: updateResult.stderr?.trim(),
      });
    }
  } catch (error) {
    options.logger.warn("[deep-link] Linux user-level protocol registration threw", {
      desktopFilePath,
      executablePath: command.executablePath,
      args: command.args,
      error,
    });
  }

  const iconInstallResult = systemDesktopEntryPath
    ? null
    : installLinuxAppImageDesktopIconBestEffort({
        dataDir,
        env: options.env,
        iconSourcePath: options.iconSourcePath,
        logger: options.logger,
        runCommand,
      });
  if (iconInstallResult) {
    options.logger.info("[deep-link] Linux AppImage user-level icon installed", {
      protocolRegistered,
      iconFilePath: iconInstallResult.iconFilePath,
      iconInstalled: iconInstallResult.installed,
      iconChanged: iconInstallResult.changed,
    });
  }
}
