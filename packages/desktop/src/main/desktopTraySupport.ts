import { execFile } from "node:child_process";

/**
 * Linux close-to-tray capability detection (spec: docs/desktop/linux-close-to-tray.md).
 *
 * The capability signal is whether org.kde.StatusNotifierWatcher has an owner on the session bus:
 * KDE/XFCE provide it natively; GNOME removed tray support by default and needs an
 * AppIndicator-style extension. Electron's new Tray() on hostless GNOME succeeds without
 * rendering or erroring (silent failure), so the toggle must not trust tray creation and must
 * probe this DBus name.
 */

export interface DesktopCloseToTrayCapability {
  /** Whether close-to-tray is available. */
  supported: boolean;
  /** GNOME-family desktop without a tray; only appends the install-extension hint to settings copy. */
  gnomeLikeWithoutTray: boolean;
}

export type TraySupportCommandExecutor = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

const STATUS_NOTIFIER_WATCHER_NAME = "org.kde.StatusNotifierWatcher";

const defaultExecutor: TraySupportCommandExecutor = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });

/** Probe tools in order: gdbus (GNOME stock) -> busctl (systemd stock) -> qdbus (Qt). */
const probeCommands: ReadonlyArray<{ command: string; args: string[] }> = [
  {
    command: "gdbus",
    args: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      STATUS_NOTIFIER_WATCHER_NAME,
    ],
  },
  {
    command: "busctl",
    args: [
      "--user",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      "s",
      STATUS_NOTIFIER_WATCHER_NAME,
    ],
  },
  {
    command: "qdbus",
    args: [
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.NameHasOwner",
      STATUS_NOTIFIER_WATCHER_NAME,
    ],
  },
];

/**
 * Parse NameHasOwner output from the three tools:
 * gdbus `(true,)` / busctl `b "true"` / qdbus `true`. Unrecognized shapes return null.
 */
export function parseStatusNotifierOwnerOutput(stdout: string): boolean | null {
  const text = stdout.trim();
  // busctl prints booleans unquoted (`b true` / `b false`; only strings get quotes); accept the
  // quoted variant too - the fallback chain must tolerate real tool output (CR-01).
  if (/^\(true,?\)$/.test(text) || /^b\s+"?true"?$/.test(text) || text === "true") {
    return true;
  }
  if (/^\(false,?\)$/.test(text) || /^b\s+"?false"?$/.test(text) || text === "false") {
    return false;
  }
  return null;
}

/** XDG_CURRENT_DESKTOP containing gnome (case-insensitive) means a GNOME-family desktop. */
export function isGnomeLikeDesktop(env: NodeJS.ProcessEnv): boolean {
  const desktop = env.XDG_CURRENT_DESKTOP ?? env.XDG_SESSION_DESKTOP ?? "";
  return desktop.toLowerCase().split(/[:;]/).includes("gnome");
}

export async function detectDesktopCloseToTrayCapability(options: {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execute?: TraySupportCommandExecutor;
  commandTimeoutMs?: number;
}): Promise<DesktopCloseToTrayCapability> {
  const execute = options.execute ?? defaultExecutor;
  const timeoutMs = options.commandTimeoutMs ?? 1500;
  const env = options.env ?? process.env;

  if (options.platform !== "linux") {
    // Windows trays are always available; macOS does not use trays (the Dock model owns close semantics).
    return { supported: true, gnomeLikeWithoutTray: false };
  }

  // Return on the first conclusive tool result; total failure means "unavailable" (safe default, never strands the user).
  for (const probe of probeCommands) {
    try {
      const { stdout } = await execute(probe.command, probe.args, timeoutMs);
      const hasOwner = parseStatusNotifierOwnerOutput(stdout);
      if (hasOwner !== null) {
        return { supported: hasOwner, gnomeLikeWithoutTray: !hasOwner && isGnomeLikeDesktop(env) };
      }
    } catch {
      // Missing tool / failure / timeout: try the next.
    }
  }
  return { supported: false, gnomeLikeWithoutTray: isGnomeLikeDesktop(env) };
}

/**
 * The window-close branch is a synchronous callback and cannot await a probe; this monitor keeps
 * the synchronous cache in main. Refresh points: first probe after app ready, settings IPC query
 * (re-probe when stale).
 */
export function createCloseToTrayCapabilityMonitor(options: {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execute?: TraySupportCommandExecutor;
  commandTimeoutMs?: number;
  staleMs?: number;
  now?: () => number;
}) {
  const staleMs = options.staleMs ?? 10_000;
  const now = options.now ?? Date.now;
  let cached: DesktopCloseToTrayCapability | null = null;
  let cachedAt = 0;
  let pending: Promise<DesktopCloseToTrayCapability> | null = null;

  const detect = () =>
    detectDesktopCloseToTrayCapability({
      platform: options.platform,
      env: options.env,
      execute: options.execute,
      commandTimeoutMs: options.commandTimeoutMs,
    });

  return {
    /** Sync cache; null until the first post-startup probe (callers default safely to "unavailable"). */
    getSync(): DesktopCloseToTrayCapability | null {
      return cached;
    },
    refresh(force = false): Promise<DesktopCloseToTrayCapability> {
      if (!force && cached && now() - cachedAt < staleMs) {
        return Promise.resolve(cached);
      }
      pending ??= detect()
        .then((result) => {
          cached = result;
          cachedAt = now();
          return result;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}

export type CloseToTrayCapabilityMonitor = ReturnType<typeof createCloseToTrayCapabilityMonitor>;

/**
 * Final can-hide verdict for the close branch (CR-01): a DBus watcher only proves the desktop
 * might have a tray host, not that the Electron Tray instance was created (missing icons or an
 * unready session make new Tray() throw). The final user entry point must be verified before
 * hiding, per the spec's no-stranding promise.
 * - Windows: tray instance created (no DBus concept).
 * - Linux: tray instance created AND DBus probe passed (creation implies the probe; the
 *   conjunction guards the watcher disappearing mid-session).
 * - Other platforms: cannot hide (darwin uses system behavior and never reaches here).
 */
export function resolveCloseToTraySupported(input: {
  platform: NodeJS.Platform;
  desktopTrayReady: boolean;
  capabilitySupported: boolean | undefined;
}): boolean {
  if (input.platform === "win32") {
    return input.desktopTrayReady;
  }
  if (input.platform === "linux") {
    return input.desktopTrayReady && input.capabilitySupported === true;
  }
  return false;
}

/**
 * Linux default normalization (spec: settings section). The shared
 * migrateCloseToTrayOnWindowsDefault has no platform concept and already marked legacy Linux
 * users true; Linux had no settings entry before, so legacy true cannot be a user choice - force
 * default-off on first launch.
 */
export function resolveCloseToTrayBootstrapValue(input: {
  platform: NodeJS.Platform;
  stored: boolean | undefined;
  linuxMigrationInitialized: boolean | undefined;
}): { value: boolean; needsLinuxMigration: boolean } {
  if (input.platform !== "linux") {
    return { value: input.stored ?? true, needsLinuxMigration: false };
  }
  if (input.linuxMigrationInitialized !== true) {
    return { value: false, needsLinuxMigration: true };
  }
  return { value: input.stored ?? false, needsLinuxMigration: false };
}

/**
 * Post-failure runtime verdict (CR-02): when the persistence layer is unwritable (full/read-only
 * disk), the in-memory value reverts to the persisted file's current value, keeping "the file is
 * the single source of truth" - otherwise main treats false while settings reads true from the
 * file, recreating dual sources. Migration retries next launch; until then Linux keeps the old
 * (unmigrated) behavior, acceptable.
 */
export function resolveCloseToTrayRuntimeValue(input: {
  platform: NodeJS.Platform;
  stored: boolean | undefined;
  linuxMigrationInitialized: boolean | undefined;
  migrationPersisted: boolean;
}): boolean {
  const bootstrap = resolveCloseToTrayBootstrapValue(input);
  if (bootstrap.needsLinuxMigration && !input.migrationPersisted) {
    return input.stored ?? true;
  }
  return bootstrap.value;
}
